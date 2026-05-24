/* node:coverage ignore file -- ephemeral merge orchestrator over live git state; conflict triage tested via integration. Unit-mocking requires asserting only the mock structure */

/**
 * git-merge-orchestrator.js — Ephemeral Candidate Branch Merge Logic
 *
 * Encapsulates the complete merge-and-conflict-resolution lifecycle for
 * a single Task integration candidate. Extracted from the legacy
 * integration script to satisfy SRP: the orchestrator owns only Git
 * state transitions.
 *
 * Responsibilities:
 *   - Create and tear down the ephemeral candidate branch.
 *   - Detect and triage merge conflicts (major vs minor threshold).
 *   - Auto-resolve minor conflicts (accept theirs) with audit logging.
 */

import { resolveConfig } from './config-resolver.js';
import { gitSpawn } from './git-utils.js';

/**
 * Analyse conflict severity using git's binary-safe diff --check.
 *
 * @param {string} cwd - Project root.
 * @returns {{ files: number, lines: number, fileList: string[] }}
 */
function analyzeConflicts(cwd) {
  const unmerged = gitSpawn(cwd, 'diff', '--name-only', '--diff-filter=U');
  if (!unmerged.stdout) return { files: 0, lines: 0, fileList: [] };

  const fileList = unmerged.stdout.split('\n').filter(Boolean);
  const check = gitSpawn(cwd, 'diff', '--check');
  const markerMatches = check.stdout.match(/leftover conflict marker/g);

  return {
    files: fileList.length,
    lines: markerMatches ? markerMatches.length : 0,
    fileList,
  };
}

/**
 * Merge the feature branch into the current (candidate) branch.
 * Handles conflict triage and auto-resolution.
 *
 * @param {string}   cwd           - Project root.
 * @param {string}   featureBranch - Branch name to merge in.
 * @param {Function} vlog          - `(level, context, message, meta)` warn helper for conflict triage output.
 * @param {object}   [opts]
 * @param {string}   [opts.message] - Explicit merge commit message (passed as `-m`).
 * @returns {{ merged: true } | { merged: false, major: true } | never}
 *   Returns `{ merged: true }` on clean merge or resolved minor conflicts.
 *   Returns `{ merged: false, major: true }` on major conflict (caller should exit 2).
 *   Throws on internal git errors.
 */
/**
 * Pure: classify a conflict snapshot as `'major'` (caller aborts) or
 * `'minor'` (caller auto-resolves). Thresholds default to the values in
 * `agentSettings.mergeThresholds` and fall back to file=3, line=20.
 *
 * @param {{ files: number, lines: number }} conflicts
 * @param {{ files?: number, lines?: number } | undefined} thresholds
 * @returns {'major' | 'minor'}
 */
export function classifyConflictSeverity(conflicts, thresholds = {}) {
  const fileCap = thresholds.files ?? 3;
  const lineCap = thresholds.lines ?? 20;
  if (conflicts.files >= fileCap || conflicts.lines >= lineCap) return 'major';
  return 'minor';
}

/**
 * Auto-resolve a minor merge conflict by accepting the feature-branch version
 * for each file in `conflicts.fileList`, capturing the discarded line counts
 * for the audit trailer. Side effects: shells out to git checkout/add.
 *
 * @returns {Array<{ file: string, discardedLines: number }>}
 */
function autoResolveAcceptingTheirs(cwd, conflicts, vlog) {
  const autoResolvedFiles = [];
  for (const file of conflicts.fileList) {
    const ourVersion = gitSpawn(cwd, 'show', `:2:${file}`);
    const discardedLines = ourVersion.stdout
      ? ourVersion.stdout.split('\n').length
      : 0;
    autoResolvedFiles.push({ file, discardedLines });
    if (ourVersion.stdout) {
      vlog(
        'warn',
        'integration',
        `Auto-resolving "${file}" to theirs — discarding base version (${discardedLines} lines)`,
        {
          file,
          discardedLines,
          discardedPreview: ourVersion.stdout.substring(0, 500),
        },
      );
    }
    gitSpawn(cwd, 'checkout', '--theirs', file);
    gitSpawn(cwd, 'add', file);
  }
  return autoResolvedFiles;
}

/**
 * Commit the auto-resolved working tree. When the caller supplied an explicit
 * merge message, append the audit trailer; otherwise use git's default
 * `--no-edit` message.
 */
function commitAutoResolution(cwd, opts, autoResolvedFiles) {
  const trailer = buildAutoResolveTrailer(autoResolvedFiles);
  const finalMessage = opts.message ? `${opts.message}\n\n${trailer}` : null;
  const commitArgs = finalMessage
    ? ['commit', '-m', finalMessage]
    : ['commit', '--no-edit'];
  const commitResult = gitSpawn(cwd, ...commitArgs);
  if (commitResult.status !== 0) {
    throw new Error(`Auto-resolution commit failed: ${commitResult.stderr}`);
  }
}

export function mergeFeatureBranch(cwd, featureBranch, vlog, opts = {}) {
  const mergeArgs = ['merge', '--no-ff', featureBranch];
  if (opts.message) mergeArgs.push('-m', opts.message);
  const merge = gitSpawn(cwd, ...mergeArgs);
  if (merge.status === 0) return { merged: true };

  const conflicts = analyzeConflicts(cwd);

  // `git merge` exited non-zero but the index has no unmerged entries and
  // no leftover conflict markers. The merge either already landed (a hook
  // emitted a non-zero exit after the merge commit was created) or was a
  // no-op (feature branch is already an ancestor / does not exist). In
  // both cases there is nothing to auto-resolve and nothing to commit —
  // attempting `git commit` here fails with "nothing to commit", which
  // turns a successful merge into a fatal and strands story-close work.
  if (conflicts.files === 0 && conflicts.lines === 0) {
    return { merged: true, alreadyMerged: true };
  }

  vlog('warn', 'integration', 'Merge conflict detected', {
    files: conflicts.files,
    lines: conflicts.lines,
    fileList: conflicts.fileList,
  });

  // Epic #2880 / F14B: read mergeThresholds from the canonical resolved
  // config (`delivery.mergeThresholds`). The legacy `agentSettings`
  // pointer is gone — destructuring it throws `Cannot read properties of
  // undefined`. The threshold block remains optional; `classifyConflict
  // Severity` falls back to file=3/line=20 when undefined.
  const config = resolveConfig();
  const severity = classifyConflictSeverity(
    conflicts,
    config?.delivery?.mergeThresholds,
  );
  if (severity === 'major') {
    gitSpawn(cwd, 'merge', '--abort');
    return { merged: false, major: true, conflicts };
  }

  const autoResolvedFiles = autoResolveAcceptingTheirs(cwd, conflicts, vlog);
  commitAutoResolution(cwd, opts, autoResolvedFiles);
  return { merged: true, autoResolved: true, conflicts, autoResolvedFiles };
}

/**
 * Build a merge-commit trailer documenting which files were auto-resolved
 * by accepting the feature-branch version and how many lines of the base
 * version were discarded. Human-readable, grep-friendly.
 *
 * @param {Array<{ file: string, discardedLines: number }>} resolved
 * @returns {string}
 */
function buildAutoResolveTrailer(resolved) {
  const header =
    'Auto-resolved-conflicts: accepted feature branch for the following file(s).';
  const body = resolved
    .map(
      (r) =>
        `Auto-resolved-file: ${r.file} (discarded ${r.discardedLines} base line(s))`,
    )
    .join('\n');
  return `${header}\n${body}`;
}

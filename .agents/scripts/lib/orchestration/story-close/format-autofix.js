/**
 * format-autofix.js — self-healing biome-format step for story-close.
 *
 * Story #4017 collapsed the historical three-module split (a whole-tree
 * fork, a scoped changed-file fork, and a shared plumbing module) into
 * this single module. Story #5383 then deleted the whole-tree entry point,
 * which had no production caller left; the scoped entry point and the
 * git/formatter plumbing it shares with `baseline-upward-writeback.js`
 * remain.
 *
 * Background. The pre-merge `biome format` gate is check-only — it fails
 * the close when the working tree has any format drift. In practice
 * upstream waves frequently leave drift in files that lint-staged does
 * not glob (JSON/JSON5/YAML), so the *next* wave's close hits the gate,
 * fails, and forces an operator-driven `npx biome format --write` plus a
 * `style:` commit before the close can resume. That manual loop is
 * trivially automatable.
 *
 * Entry point:
 *
 *   - {@link runScopedFormatAutofix} — Story #2533: scopes the formatter to
 *     the changed-file set between the Epic branch and the Story branch and
 *     folds auto-fixed paths into a dedicated `fix(story-close):` commit,
 *     emitting `Logger.warn` naming the files. Carries the worktree-cwd fix
 *     and branch assert from Story #3907.
 *
 * Dependencies are injected so unit tests pin behaviour without spawning
 * git or biome.
 */

import { execFileSync } from 'node:child_process';

import { diffNameOnly } from '../../changed-files.js';
import { resolveFormatWriteCommand } from '../../close-validation/commands.js';
import { Logger as DefaultLogger } from '../../Logger.js';

const SCOPED_TAG = '[format-autofix-scoped]';

/**
 * Run `git status --porcelain` and return the list of changed paths.
 *
 * Porcelain lines are `XY <path>` — exactly two status chars, one space,
 * then the path. Leading whitespace inside the status pair is significant
 * (e.g. ` M file` for unstaged-modified) so we slice a fixed 3 chars off
 * the front rather than trimming.
 *
 * Exported since Story #5277: `baseline-upward-writeback.js` needs the same
 * "is this path already dirty?" test before it rewrites a baseline row, and a
 * second porcelain parser is exactly the near-duplicate the duplication gate
 * exists to refuse.
 *
 * @param {string} cwd
 * @param {(args: string[], opts: object) => string} git
 * @returns {string[]}
 */
export function listDirtyPaths(cwd, git) {
  const out = git(['status', '--porcelain'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return out
    .split('\n')
    .filter((line) => line.length >= 4)
    .map((line) => line.slice(3));
}

/**
 * Resolve the formatter write command from `project.commands.formatWrite`
 * (falling back to the historical `npx biome format --write .`) and split
 * it into an executable + argv pair ready for `execFileSync`.
 *
 * The scoped entry point appends an explicit changed-file set, so a trailing
 * `.` (the whole-tree target) is stripped before its file list.
 *
 * @param {{ commands?: object }} [opts]
 * @returns {{ writeCmdString: string, writeCmd: string, writeArgs: string[] }}
 */
function resolveFormatterCmd({ commands } = {}) {
  // `resolveFormatWriteCommand` reads `config.project.commands`; wrap the
  // caller-supplied `commands` map into that canonical shape.
  const writeCmdString = resolveFormatWriteCommand({ project: { commands } });
  const parts = writeCmdString.split(/\s+/).filter(Boolean);
  if (parts[parts.length - 1] === '.') parts.pop();
  const [writeCmd, ...writeArgs] = parts;
  return { writeCmdString, writeCmd, writeArgs };
}

/**
 * Resolve the branch currently checked out at `cwd` via
 * `git rev-parse --abbrev-ref HEAD`. Returns the trimmed branch name, or
 * `null` when the call fails or the tree is in a detached-HEAD state
 * (`HEAD`). Used as the commit-target guard before
 * {@link commitDirtyPaths} writes a scoped-autofix commit, so the commit
 * can never land on the wrong branch (e.g. the main checkout's `main`).
 *
 * @param {string} cwd
 * @param {(args: string[], opts: object) => string} git
 * @returns {string|null}
 */
export function currentBranch(cwd, git) {
  try {
    const out = git(['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const branch = (out ?? '').toString().trim();
    if (!branch || branch === 'HEAD') return null;
    return branch;
  } catch {
    return null;
  }
}

/**
 * Stage every modified path (`git add -u`), commit with the caller-supplied
 * `subject`, and return the short HEAD SHA. Hooks must run; we never pass
 * `--no-verify` (project policy: never skip git hooks).
 *
 * @param {{
 *   cwd: string,
 *   git: (args: string[], opts: object) => string,
 *   subject: string,
 * }} opts
 * @returns {string} short HEAD SHA of the new commit
 */
export function commitDirtyPaths({ cwd, git, subject }) {
  git(['add', '-u'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  git(['commit', '-m', subject], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return git(['rev-parse', '--short', 'HEAD'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

/**
 * List the files changed between `baseBranch` and `storyBranch` using the
 * three-dot merge-base diff. Delegates parsing to `diffNameOnly` from
 * `changed-files.js` so the stdout → path-list conversion lives in one place.
 *
 * The `git` parameter uses the caller's local interface:
 * `(args: string[], opts: object) => string`. A bridge adapter wraps it into
 * the `gitSpawn(cwd, ...args)` shape that `diffNameOnly` expects.
 *
 * Exported since Story #5224: the sibling `baseline-upward-writeback.js` step
 * scopes to the same branch changed-file set, and a second copy of this
 * `(args, opts)` → `gitSpawn` bridge is exactly the kind of near-duplicate the
 * duplication gate exists to refuse.
 *
 * @param {{ cwd: string, baseBranch: string, storyBranch: string, git: Function }} opts
 * @returns {string[]}
 */
export function listChangedFiles({ cwd, baseBranch, storyBranch, git }) {
  // Bridge the (args, opts) → string interface into gitSpawn(cwd, ...args).
  const gitSpawn = (_cwd, ...args) => {
    try {
      const stdout = git(args, {
        cwd: _cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return { status: 0, stdout: stdout ?? '', stderr: '' };
    } catch (err) {
      return {
        status: err.status ?? 1,
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? err.message,
      };
    }
  };
  return diffNameOnly({
    range: `${baseBranch}...${storyBranch}`,
    cwd,
    gitSpawn,
  });
}

/**
 * Story #2533 — run `biome format --write <changedFiles>` on the Epic→Story
 * diff. If any file is modified, stage and commit the changes on the Story
 * branch with a conventional `fix(story-close):` subject and emit a
 * `Logger.warn` naming the auto-fixed files. Returns a structured
 * envelope so callers can log a single line.
 *
 * Why scoped + warn-level. The Tech Spec (Epic #2527, Story 5) calls out
 * that format diffs introduced by Story commits should never surface to
 * Phase 3 close-validation. The whole-tree autofix already covers that,
 * but emits `info` so operators routinely miss it. This entry point emits
 * `Logger.warn` naming the auto-fixed files so the signal is visible in
 * the close transcript and downstream ledger.
 *
 * No-op envelopes:
 *   - `{ ran: false, reason: 'no-changed-files' }`        — empty diff.
 *   - `{ ran: false, reason: 'dirty-tree' }`              — refused to
 *     absorb pre-existing edits.
 *   - `{ ran: true, committed: false }`                   — formatter
 *     was clean.
 *
 * **Worktree scope (Story #3907).** All git + formatter operations run in
 * `worktreePath` (the Story worktree where `story-<id>` is checked out), not
 * `cwd` (the main checkout). The earlier implementation ran every step
 * against `cwd`, so the `git add -u` + `git commit` could land an unreviewed
 * `fix(story-close):` commit on whatever branch the main checkout happened to
 * have out — including `main`. Before committing, the worktree's checked-out
 * branch is asserted to equal `storyBranch`; a mismatch refuses to commit and
 * returns `{ ran: true, committed: false, reason: 'wrong-branch' }` so a
 * stale-state checkout can never absorb the autofix into the wrong history.
 * `worktreePath` defaults to `cwd` for the resume/legacy callers that have no
 * separate worktree.
 *
 * @param {{
 *   cwd: string,
 *   worktreePath?: string,
 *   storyId: number|string,
 *   baseBranch: string,
 *   storyBranch: string,
 *   config?: object,
 *   logger?: object,
 *   spawnSync?: typeof execFileSync,
 *   gitSync?: (args: string[], opts: object) => string,
 * }} opts
 * @returns {{
 *   ran: boolean,
 *   committed: boolean,
 *   sha?: string,
 *   modifiedPaths?: string[],
 *   reason?: string,
 * }}
 */
export function runScopedFormatAutofix({
  cwd,
  worktreePath,
  storyId,
  baseBranch,
  storyBranch,
  config,
  logger = DefaultLogger,
  spawnSync = execFileSync,
  gitSync,
} = {}) {
  if (!cwd) throw new Error('runScopedFormatAutofix: cwd is required');
  if (!baseBranch)
    throw new Error('runScopedFormatAutofix: baseBranch is required');
  if (!storyBranch)
    throw new Error('runScopedFormatAutofix: storyBranch is required');

  // Story #3907 — the formatter writes + the commit must land in the Story
  // worktree, never the main checkout. Fall back to `cwd` only for callers
  // that do not run under worktree isolation.
  const workTree = worktreePath || cwd;

  const git = gitSync ?? ((args, opts) => spawnSync('git', args, opts));

  // Resolve the formatter base command (e.g. `npx biome format --write`).
  // We drop a trailing `.` so we can append the changed-file set explicitly.
  const { writeCmdString, writeCmd, writeArgs } = resolveFormatterCmd({
    commands: config?.project?.commands,
  });

  const changed = listChangedFiles({
    cwd: workTree,
    baseBranch,
    storyBranch,
    git,
  });
  if (changed.length === 0) {
    logger.info?.(
      `${SCOPED_TAG} skipped — no changed files between ${baseBranch} and ${storyBranch}.`,
    );
    return { ran: false, committed: false, reason: 'no-changed-files' };
  }

  const dirtyBefore = listDirtyPaths(workTree, git);
  if (dirtyBefore.length) {
    logger.info?.(
      `${SCOPED_TAG} skipped — working tree dirty before scoped autofix (${dirtyBefore.length} paths).`,
    );
    return { ran: false, committed: false, reason: 'dirty-tree' };
  }

  // Run the formatter against the changed-file set. We tolerate non-zero
  // exit because the downstream check gate is the source of truth for
  // "did formatting succeed".
  try {
    spawnSync(writeCmd, [...writeArgs, ...changed], {
      cwd: workTree,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
  } catch (err) {
    logger.warn?.(
      `${SCOPED_TAG} \`${writeCmdString}\` on ${changed.length} changed file(s) exited non-zero (${err?.status ?? 'unknown'}); falling through to the format check gate.`,
    );
  }

  const dirtyAfter = listDirtyPaths(workTree, git);
  if (!dirtyAfter.length) {
    logger.info?.(
      `${SCOPED_TAG} no format drift on ${changed.length} changed file(s).`,
    );
    return { ran: true, committed: false };
  }

  // Story #3907 — assert the worktree is actually on `storyBranch` before we
  // stage + commit. Without this guard a stale-state checkout (or a
  // mis-wired `cwd`) could absorb the autofix onto the wrong branch (incl.
  // `main`). A mismatch refuses to commit and leaves the format drift for the
  // downstream check gate to surface.
  const onBranch = currentBranch(workTree, git);
  if (onBranch !== storyBranch) {
    logger.warn?.(
      `${SCOPED_TAG} refusing to commit — worktree ${workTree} is on "${onBranch ?? 'unknown'}", expected "${storyBranch}". ` +
        `${dirtyAfter.length} format-drift path(s) left for the check gate.`,
    );
    return { ran: true, committed: false, reason: 'wrong-branch' };
  }

  // Stage every modified path and commit. Hooks must run; do not pass
  // --no-verify (project policy: never skip git hooks).
  const subject = `fix(story-close): auto-apply biome format in scoped lint (story #${storyId})`;
  const sha = commitDirtyPaths({ cwd: workTree, git, subject });

  // The warn-level emission is the Tech Spec contract — operators read
  // this line in the close transcript to know auto-fix landed in the
  // close commit, and downstream ledger inspectors filter on it.
  logger.warn?.(
    `${SCOPED_TAG} auto-applied biome format to ${dirtyAfter.length} path(s) on story #${storyId}: ${dirtyAfter.join(', ')}; committed as ${sha}.`,
  );
  return { ran: true, committed: true, sha, modifiedPaths: dirtyAfter };
}

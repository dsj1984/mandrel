/**
 * phases/wrong-tree-guard.js — detect worktree/main-checkout edit divergence.
 *
 * Story #3364 — `/single-story-deliver` (and `/deliver`) materializes a
 * per-Story worktree and instructs the agent to `cd` into it before editing.
 * On Windows that guidance is silently insufficient: `cd <workCwd>` steers the
 * Bash tool's working directory, but the path-based Edit/Write tools operate on
 * absolute paths and ignore cwd. An agent whose shell is correctly inside the
 * worktree can still resolve a main-checkout absolute path and edit the wrong
 * tree — the two surfaces disagree and nothing detects it.
 *
 * Failure mode this guards: the worktree is the intended work tree, but the
 * agent's edits landed under the main checkout instead. `single-story-close.js`
 * runs its gates against the worktree only, so it would commit an unchanged /
 * partial worktree (gates pass on the clean tree) while leaving the main
 * checkout dirty — a silent empty-diff PR.
 *
 * Detection: when a worktree is the active work tree (it exists on disk and is
 * distinct from `cwd`), inspect `git -C <mainCheckout> status --porcelain`. Any
 * **tracked-path** change (modified, staged, deleted, renamed) in the main
 * checkout is the candidate wrong-tree signal. Untracked files (`??`) are
 * ignored — they are scratch artifacts, not relocated Story work, and flagging
 * them would produce false positives on every run.
 *
 * Story #4424 — the raw "main checkout is dirty" signal is too coarse for
 * multi-session operation: uncommitted tracked-path changes in the main
 * checkout can belong to a **different concurrent session** and have nothing to
 * do with the Story being closed (framework-gap #4420). The guard therefore
 * intersects the main-checkout stray tracked paths with the **Story's own
 * diff-path set** (paths changed on the worktree branch vs the base branch,
 * plus the worktree's uncommitted tracked changes):
 *   - **Overlap non-empty** → genuine wrong-tree signal: post a `friction`
 *     comment and throw (abort close), exactly as before.
 *   - **Disjoint** (Story diff-path set non-empty, no shared path) → another
 *     session's business: post a `friction` comment whose wording states close
 *     PROCEEDED and names the disjoint stray files (telemetry for
 *     concurrent-session hygiene), then return without throwing.
 *   - **Empty Story diff-path set** with stray paths → keep the abort (the
 *     #3364 silent empty-diff backstop; an empty set makes every stray path
 *     disjoint-by-definition, which must not downgrade the guard).
 *   - **Story-diff probe failure** with stray paths present → fall back to the
 *     coarse abort rather than fail-open, so a probe hiccup never converts a
 *     would-be abort into a silent pass.
 *
 * The main-checkout status probe keeps its fail-open semantics: a probe failure
 * downgrades to a warning and skips the guard — it never blocks an otherwise
 * valid close.
 */

import path from 'node:path';
import { postStructuredComment } from '../../ticketing/state.js';

/**
 * Parse `git status --porcelain` output into structured status entries.
 *
 * Porcelain v1 format: a two-character status field, a space, then the path
 * (renames use `orig -> dest`, which we collapse to the destination path).
 * Untracked entries carry the `??` status field.
 *
 * @param {string} raw - Raw `git status --porcelain` stdout (may be empty).
 * @returns {Array<{ status: string, path: string, untracked: boolean }>}
 */
export function parsePorcelainStatus(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  const unquote = (p) =>
    p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p;
  return raw
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      // First two chars are the status code; path begins at column 3.
      const status = line.slice(0, 2);
      const rawPath = line.slice(3).trim();
      // Renames/copies render as "orig -> dest". Keep BOTH sides: the
      // Story-diff intersection downstream must match a rename whose
      // ORIGIN path is in the Story's footprint — collapsing to the
      // destination only made such a stray downgrade to proceed.
      const arrowIdx = rawPath.indexOf(' -> ');
      if (arrowIdx !== -1) {
        const origin = unquote(rawPath.slice(0, arrowIdx).trim());
        const dest = unquote(rawPath.slice(arrowIdx + 4).trim());
        return [
          { status, path: origin, untracked: status === '??' },
          { status, path: dest, untracked: status === '??' },
        ];
      }
      // Porcelain may quote paths containing special chars; strip the quotes.
      return [{ status, path: unquote(rawPath), untracked: status === '??' }];
    });
}

/**
 * Filter porcelain status entries down to the tracked-path changes that
 * indicate stray Story work landed in the main checkout.
 *
 * Untracked files (`??`) are excluded — they are scratch artifacts, not
 * relocated tracked-file edits, and the issue's contract scopes the signal to
 * "uncommitted changes under tracked paths".
 *
 * @param {Array<{ status: string, path: string, untracked: boolean }>} entries
 * @returns {string[]} sorted list of stray tracked-file paths.
 */
export function collectStrayTrackedPaths(entries) {
  return entries
    .filter((e) => !e.untracked)
    .map((e) => e.path)
    .filter(Boolean)
    .sort();
}

/**
 * Parse `git diff --name-only` output into a list of repo-relative paths.
 *
 * @param {string} raw - Raw `git diff --name-only` stdout (may be empty).
 * @returns {string[]}
 */
export function parseDiffNameOnly(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  return raw
    .split('\n')
    .map((line) => line.replace(/\r$/, '').trim())
    .filter(Boolean);
}

/**
 * Decide whether the wrong-tree guard applies for this close.
 *
 * The guard only makes sense when a worktree is the active work tree: it must
 * exist on disk (`worktreePath` is non-null) and be a distinct directory from
 * the main checkout (`cwd`). In single-tree mode the worktree IS the main
 * checkout, so there is no divergence to detect.
 *
 * @param {{ cwd: string, worktreePath: string|null }} opts
 * @returns {boolean}
 */
export function guardApplies({ cwd, worktreePath }) {
  if (!worktreePath) return false;
  return path.resolve(cwd) !== path.resolve(worktreePath);
}

/**
 * Compute the Story's own diff-path set from the worktree: the union of paths
 * changed on the worktree branch vs the base branch (committed diff) and the
 * worktree's uncommitted tracked changes.
 *
 * Both probes are keyed off the worktree, so the returned paths are
 * repo-relative and directly comparable to the main-checkout porcelain paths.
 * A probe failure (thrown error or non-zero git exit) returns `{ ok: false }`
 * so the caller can fall back to the coarse abort rather than fail-open.
 *
 * @param {{ worktreePath: string, baseBranch: string, gitSpawnFn: Function }} opts
 * @returns {{ ok: boolean, paths: string[], error?: string }}
 */
export function collectStoryDiffPaths({
  worktreePath,
  baseBranch,
  gitSpawnFn,
}) {
  let diffResult;
  try {
    diffResult = gitSpawnFn(
      worktreePath,
      'diff',
      '--name-only',
      `${baseBranch}...HEAD`,
    );
  } catch (err) {
    return { ok: false, paths: [], error: err?.message ?? String(err) };
  }
  if (!diffResult || diffResult.status !== 0) {
    return { ok: false, paths: [], error: diffResult?.stderr || '(no stderr)' };
  }

  let statusResult;
  try {
    statusResult = gitSpawnFn(worktreePath, 'status', '--porcelain');
  } catch (err) {
    return { ok: false, paths: [], error: err?.message ?? String(err) };
  }
  if (!statusResult || statusResult.status !== 0) {
    return {
      ok: false,
      paths: [],
      error: statusResult?.stderr || '(no stderr)',
    };
  }

  const committed = parseDiffNameOnly(diffResult.stdout ?? '');
  const uncommitted = collectStrayTrackedPaths(
    parsePorcelainStatus(statusResult.stdout ?? ''),
  );
  const union = Array.from(new Set([...committed, ...uncommitted])).sort();
  return { ok: true, paths: union };
}

/**
 * Repo-relative path intersection. Both sides are git-emitted repo-relative
 * paths (forward-slash separated on every platform), so plain string equality
 * is correct regardless of which tree the probe ran in.
 *
 * @param {string[]} mainStray
 * @param {string[]} storyPaths
 * @returns {string[]} sorted intersection.
 */
export function intersectPaths(mainStray, storyPaths) {
  const set = new Set(storyPaths);
  return mainStray.filter((p) => set.has(p)).sort();
}

/**
 * Format the `friction` finding body for an ABORT (overlap, empty-diff
 * backstop, or diff-probe-failure fallback) naming the stray files.
 *
 * @param {{ storyId: number, strayFiles: string[], worktreePath: string }} opts
 * @returns {string}
 */
export function formatWrongTreeFinding({ storyId, strayFiles, worktreePath }) {
  const list = strayFiles.map((f) => `- \`${f}\``).join('\n');
  return (
    `### wrong-tree edit detected (close aborted)\n\n` +
    `Story #${storyId}: the main checkout has uncommitted changes under ` +
    `tracked paths that intersect the Story's own diff-path set while the ` +
    `active work tree is the per-Story worktree:\n\n` +
    `\`${worktreePath}\`\n\n` +
    `This is the wrong-tree failure mode: edits intended for the worktree ` +
    `landed in the main checkout instead (on Windows, \`cd\` steers the Bash ` +
    `cwd but path-based Edit/Write tools resolve absolute paths and ignore ` +
    `it). Close was **aborted** to prevent committing an unchanged worktree ` +
    `and opening an empty-diff PR.\n\n` +
    `**Stray files in the main checkout:**\n\n${list}\n\n` +
    `**Recovery:** relocate these edits into the worktree (re-apply them under ` +
    `\`${worktreePath}\`), restore the main checkout ` +
    `(\`git -C <main-repo> checkout -- <files>\`), then re-run ` +
    `\`/single-story-deliver\`.`
  );
}

/**
 * Format the `friction` finding body for the DOWNGRADE outcome — the main
 * checkout has stray tracked paths, but they are fully disjoint from the
 * Story's non-empty diff-path set (another concurrent session's work). Close
 * proceeds; this comment is telemetry for concurrent-session hygiene.
 *
 * @param {{ storyId: number, strayFiles: string[], worktreePath: string }} opts
 * @returns {string}
 */
export function formatWrongTreeDowngradeFinding({
  storyId,
  strayFiles,
  worktreePath,
}) {
  const list = strayFiles.map((f) => `- \`${f}\``).join('\n');
  return (
    `### wrong-tree probe: disjoint main-checkout dirt (close proceeded)\n\n` +
    `Story #${storyId}: the main checkout has uncommitted changes under ` +
    `tracked paths while the active work tree is the per-Story worktree:\n\n` +
    `\`${worktreePath}\`\n\n` +
    `These stray paths are **fully disjoint** from the Story's own diff-path ` +
    `set (committed diff vs base + uncommitted worktree changes), so they ` +
    `belong to another concurrent session rather than this Story's work. ` +
    `Close **proceeded** — this comment is telemetry for concurrent-session ` +
    `hygiene, not an abort.\n\n` +
    `**Disjoint stray files in the main checkout:**\n\n${list}\n`
  );
}

/**
 * Post the ABORT friction comment and throw to abort close. Shared by the
 * overlap, empty-diff-backstop, and diff-probe-failure-fallback paths.
 *
 * @param {{
 *   storyId: number,
 *   strayFiles: string[],
 *   worktreePath: string,
 *   provider: object,
 *   progress: (tag: string, msg: string) => void,
 *   reasonTag: string,
 * }} opts
 * @throws {Error} always.
 */
async function abortWrongTree({
  storyId,
  strayFiles,
  worktreePath,
  provider,
  progress,
  reasonTag,
}) {
  const body = formatWrongTreeFinding({ storyId, strayFiles, worktreePath });
  try {
    await postStructuredComment(provider, storyId, 'friction', body);
    progress(
      'WRONG-TREE',
      `🛑 Wrong-tree edits detected (${reasonTag}): ${strayFiles.length} stray file(s). Posted friction comment to Story #${storyId}.`,
    );
  } catch (err) {
    progress(
      'WRONG-TREE',
      `⚠️ Failed to post wrong-tree friction comment: ${err?.message ?? err}`,
    );
  }

  throw new Error(
    `[single-story-close] Wrong-tree edits detected (${reasonTag}): the main ` +
      `checkout has uncommitted tracked-path changes intersecting the Story's ` +
      `diff-path set while the worktree (${worktreePath}) is the active work ` +
      `tree. Close aborted to avoid an empty-diff PR. Stray files: ` +
      `${strayFiles.join(', ')}. Relocate the edits into the worktree, ` +
      `restore the main checkout, then re-run /single-story-deliver.`,
  );
}

/**
 * Post the DOWNGRADE friction comment (telemetry) without throwing. Best-effort:
 * a post failure is logged but never converts the proceed into an abort.
 *
 * @param {{
 *   storyId: number,
 *   strayFiles: string[],
 *   worktreePath: string,
 *   provider: object,
 *   progress: (tag: string, msg: string) => void,
 * }} opts
 * @returns {Promise<void>}
 */
async function reportDisjointDirt({
  storyId,
  strayFiles,
  worktreePath,
  provider,
  progress,
}) {
  const body = formatWrongTreeDowngradeFinding({
    storyId,
    strayFiles,
    worktreePath,
  });
  try {
    await postStructuredComment(provider, storyId, 'friction', body);
    progress(
      'WRONG-TREE',
      `⚠️ Main-checkout dirt disjoint from Story diff (${strayFiles.length} stray file(s) belong to another session). Close proceeds; posted telemetry friction comment to Story #${storyId}.`,
    );
  } catch (err) {
    progress(
      'WRONG-TREE',
      `⚠️ Failed to post disjoint-dirt friction comment: ${err?.message ?? err}`,
    );
  }
}

/**
 * Probe the main checkout for stray tracked-path changes.
 *
 * Fail-open on the probe: a thrown error or non-zero git exit returns
 * `{ ok: false }` so the caller skips the guard rather than blocking a valid
 * close on a git hiccup.
 *
 * @param {{ cwd: string, gitSpawnFn: Function, progress: Function }} opts
 * @returns {{ ok: boolean, strayFiles: string[] }}
 */
function probeMainCheckoutStray({ cwd, gitSpawnFn, progress }) {
  let result;
  try {
    result = gitSpawnFn(cwd, 'status', '--porcelain');
  } catch (err) {
    progress(
      'WRONG-TREE',
      `⚠️ Could not probe main checkout status: ${err?.message ?? err}. Skipping guard.`,
    );
    return { ok: false, strayFiles: [] };
  }

  if (!result || result.status !== 0) {
    progress(
      'WRONG-TREE',
      `⚠️ git status probe exited non-zero: ${result?.stderr || '(no stderr)'}. Skipping guard.`,
    );
    return { ok: false, strayFiles: [] };
  }

  const strayFiles = collectStrayTrackedPaths(
    parsePorcelainStatus(result.stdout ?? ''),
  );
  return { ok: true, strayFiles };
}

/**
 * Run the wrong-tree detection guard for `single-story-close`.
 *
 * When a worktree is the active work tree and the main checkout has stray
 * tracked-path changes, the guard intersects those paths with the Story's own
 * diff-path set (Story #4424): overlap aborts close (throws), a disjoint set
 * downgrades to a proceed-with-telemetry `friction` comment, an empty Story
 * diff-path set keeps the abort (empty-diff backstop), and a Story-diff probe
 * failure falls back to the coarse abort. A main-checkout status probe failure
 * skips the guard (fail-open on the probe, fail-closed on a confirmed positive).
 *
 * @param {{
 *   cwd: string,
 *   worktreePath: string|null,
 *   baseBranch: string,
 *   storyId: number,
 *   provider: object,
 *   progress: (tag: string, msg: string) => void,
 *   gitSpawn?: Function,
 * }} args
 * @returns {Promise<{ applied: boolean, strayFiles: string[], overlap?: string[] }>}
 * @throws {Error} when overlapping stray edits are detected in the main checkout.
 */
export async function runWrongTreeGuardPhase({
  cwd,
  worktreePath,
  baseBranch = 'main',
  storyId,
  provider,
  progress,
  gitSpawn: injectedGitSpawn,
}) {
  if (!guardApplies({ cwd, worktreePath })) {
    return { applied: false, strayFiles: [] };
  }

  // Dynamic import keeps the default git binding out of the module top-level so
  // unit tests can inject a fake without module-URL mocking.
  const { gitSpawn: defaultGitSpawn } = await import('../../../git-utils.js');
  const gitSpawnFn = injectedGitSpawn ?? defaultGitSpawn;

  progress(
    'WRONG-TREE',
    `Checking main checkout for stray edits (worktree-isolated Story #${storyId})...`,
  );

  const mainProbe = probeMainCheckoutStray({ cwd, gitSpawnFn, progress });
  if (!mainProbe.ok) {
    return { applied: false, strayFiles: [] };
  }

  const strayFiles = mainProbe.strayFiles;
  if (strayFiles.length === 0) {
    progress('WRONG-TREE', '✅ Main checkout clean — no wrong-tree edits.');
    return { applied: true, strayFiles: [], overlap: [] };
  }

  // Stray paths present — intersect with the Story's own diff-path set to tell
  // this Story's misplaced work apart from a concurrent session's dirt.
  const storyDiff = collectStoryDiffPaths({
    worktreePath,
    baseBranch,
    gitSpawnFn,
  });

  if (!storyDiff.ok) {
    // A failed Story-diff probe must NOT silently convert a would-be abort into
    // a pass — fall back to the coarse (#3364) abort behavior.
    progress(
      'WRONG-TREE',
      `⚠️ Could not probe Story diff paths (${storyDiff.error}); falling back to coarse abort.`,
    );
    await abortWrongTree({
      storyId,
      strayFiles,
      worktreePath,
      provider,
      progress,
      reasonTag: 'diff-probe-failed',
    });
  }

  if (storyDiff.paths.length === 0) {
    // Empty-diff backstop: an empty Story diff-path set makes every stray path
    // disjoint-by-definition; that is exactly the #3364 silent empty-diff
    // failure mode, so keep the abort.
    await abortWrongTree({
      storyId,
      strayFiles,
      worktreePath,
      provider,
      progress,
      reasonTag: 'empty-diff-backstop',
    });
  }

  const overlap = intersectPaths(strayFiles, storyDiff.paths);

  if (overlap.length > 0) {
    await abortWrongTree({
      storyId,
      strayFiles,
      worktreePath,
      provider,
      progress,
      reasonTag: 'overlap',
    });
  }

  // Disjoint: the stray paths belong to another session. Post a proceed-wording
  // friction comment (telemetry) and return without throwing.
  await reportDisjointDirt({
    storyId,
    strayFiles,
    worktreePath,
    provider,
    progress,
  });

  return { applied: true, strayFiles, overlap: [] };
}

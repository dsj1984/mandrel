/**
 * phases/wrong-tree-guard.js — detect Story edits that landed in the main
 * checkout instead of the worktree (path-based Edit/Write tools ignore the
 * shell cwd, notably on Windows). The gates run on the worktree only, so
 * such a close would ship a silent empty-diff PR.
 *
 * Main-checkout tracked-path dirt (untracked files ignored) is intersected
 * with the Story's own diff paths, because it may belong to another
 * concurrent session: overlap aborts; disjoint proceeds with a telemetry
 * comment; an empty Story diff or a failed Story-diff probe still aborts.
 * A failed main-checkout probe skips the guard (fail-open).
 */

import path from 'node:path';
import { postStructuredComment } from '../../ticketing/state.js';

/**
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
      const status = line.slice(0, 2);
      const rawPath = line.slice(3).trim();
      // Keep BOTH sides of a rename: the intersection must match an origin
      // path in the Story's footprint.
      const arrowIdx = rawPath.indexOf(' -> ');
      if (arrowIdx !== -1) {
        const origin = unquote(rawPath.slice(0, arrowIdx).trim());
        const dest = unquote(rawPath.slice(arrowIdx + 4).trim());
        return [
          { status, path: origin, untracked: status === '??' },
          { status, path: dest, untracked: status === '??' },
        ];
      }
      return [{ status, path: unquote(rawPath), untracked: status === '??' }];
    });
}

/**
 * Untracked (`??`) entries are scratch, not relocated Story work.
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
 * Applies only when a worktree exists and is distinct from the main checkout.
 *
 * @param {{ cwd: string, worktreePath: string|null }} opts
 * @returns {boolean}
 */
export function guardApplies({ cwd, worktreePath }) {
  if (!worktreePath) return false;
  return path.resolve(cwd) !== path.resolve(worktreePath);
}

/**
 * The Story's diff paths: committed vs base, plus uncommitted tracked
 * changes in the worktree. Any probe failure returns `{ ok: false }`.
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
 * Both sides are git-emitted forward-slash repo-relative paths, so string
 * equality is correct on every platform.
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
    `\`/mandrel-deliver ${storyId}\`.`
  );
}

/**
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
      `restore the main checkout, then re-run /mandrel-deliver ${storyId}.`,
  );
}

/**
 * Best-effort; a post failure never turns the proceed into an abort.
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
 * Fail-open: a probe failure returns `{ ok: false }` and the guard is skipped.
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

  // Dynamic so tests can inject a fake without module mocking.
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

  const storyDiff = collectStoryDiffPaths({
    worktreePath,
    baseBranch,
    gitSpawnFn,
  });

  if (!storyDiff.ok) {
    // Never let a probe hiccup turn a would-be abort into a pass.
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
    // An empty diff makes every stray path "disjoint" — the empty-diff PR case.
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

  // Disjoint: another session's dirt.
  await reportDisjointDirt({
    storyId,
    strayFiles,
    worktreePath,
    provider,
    progress,
  });

  return { applied: true, strayFiles, overlap: [] };
}

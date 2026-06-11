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
 * checkout is the wrong-tree signal. Untracked files (`??`) are ignored — they
 * are scratch artifacts, not relocated Story work, and flagging them would
 * produce false positives on every run.
 *
 * The guard runs before the gate chain. On detection it posts a `friction`
 * structured comment naming the stray files and throws, so the operator/agent
 * relocates the edits into the worktree before close proceeds. This is the
 * load-bearing, detection-based fix: it fires regardless of whether the agent
 * ever realized it edited the wrong tree.
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
  return raw
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.length > 0)
    .map((line) => {
      // First two chars are the status code; path begins at column 3.
      const status = line.slice(0, 2);
      let filePath = line.slice(3).trim();
      // Renames/copies render as "orig -> dest"; keep the destination.
      const arrowIdx = filePath.indexOf(' -> ');
      if (arrowIdx !== -1) {
        filePath = filePath.slice(arrowIdx + 4).trim();
      }
      // Porcelain may quote paths containing special chars; strip the quotes.
      if (filePath.startsWith('"') && filePath.endsWith('"')) {
        filePath = filePath.slice(1, -1);
      }
      return { status, path: filePath, untracked: status === '??' };
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
 * Format the `friction` finding body naming the stray files.
 *
 * @param {{ storyId: number, strayFiles: string[], worktreePath: string }} opts
 * @returns {string}
 */
export function formatWrongTreeFinding({ storyId, strayFiles, worktreePath }) {
  const list = strayFiles.map((f) => `- \`${f}\``).join('\n');
  return (
    `### wrong-tree edit detected (close aborted)\n\n` +
    `Story #${storyId}: the main checkout has uncommitted changes under ` +
    `tracked paths while the active work tree is the per-Story worktree:\n\n` +
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
 * Run the wrong-tree detection guard for `single-story-close`.
 *
 * When a worktree is the active work tree and the main checkout has uncommitted
 * tracked-path changes, posts a `friction` comment naming the stray files and
 * throws to abort close. Otherwise returns a clean result.
 *
 * Unlike the soft drift-detection phase, this guard is **load-bearing**: a
 * positive detection aborts close (throws). Failures to run git, however, are
 * swallowed as warnings — a probe failure must not block an otherwise valid
 * close (fail-open on the probe, fail-closed on a confirmed positive).
 *
 * @param {{
 *   cwd: string,
 *   worktreePath: string|null,
 *   storyId: number,
 *   provider: object,
 *   progress: (tag: string, msg: string) => void,
 *   gitSpawn?: Function,
 * }} args
 * @returns {Promise<{ applied: boolean, strayFiles: string[] }>}
 * @throws {Error} when stray tracked-path edits are detected in the main checkout.
 */
export async function runWrongTreeGuardPhase({
  cwd,
  worktreePath,
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

  let result;
  try {
    result = gitSpawnFn(cwd, 'status', '--porcelain');
  } catch (err) {
    // Probe failure is non-fatal — never block a valid close on a git hiccup.
    progress(
      'WRONG-TREE',
      `⚠️ Could not probe main checkout status: ${err?.message ?? err}. Skipping guard.`,
    );
    return { applied: false, strayFiles: [] };
  }

  if (!result || result.status !== 0) {
    progress(
      'WRONG-TREE',
      `⚠️ git status probe exited non-zero: ${result?.stderr || '(no stderr)'}. Skipping guard.`,
    );
    return { applied: false, strayFiles: [] };
  }

  const strayFiles = collectStrayTrackedPaths(
    parsePorcelainStatus(result.stdout ?? ''),
  );

  if (strayFiles.length === 0) {
    progress('WRONG-TREE', '✅ Main checkout clean — no wrong-tree edits.');
    return { applied: true, strayFiles: [] };
  }

  // Confirmed positive: post a friction comment and abort close.
  const body = formatWrongTreeFinding({ storyId, strayFiles, worktreePath });
  try {
    await postStructuredComment(provider, storyId, 'friction', body);
    progress(
      'WRONG-TREE',
      `🛑 Wrong-tree edits detected: ${strayFiles.length} stray file(s). Posted friction comment to Story #${storyId}.`,
    );
  } catch (err) {
    progress(
      'WRONG-TREE',
      `⚠️ Failed to post wrong-tree friction comment: ${err?.message ?? err}`,
    );
  }

  throw new Error(
    `[single-story-close] Wrong-tree edits detected: the main checkout has ` +
      `uncommitted tracked-path changes while the worktree (${worktreePath}) is ` +
      `the active work tree. Close aborted to avoid an empty-diff PR. Stray ` +
      `files: ${strayFiles.join(', ')}. Relocate the edits into the worktree, ` +
      `restore the main checkout, then re-run /single-story-deliver.`,
  );
}

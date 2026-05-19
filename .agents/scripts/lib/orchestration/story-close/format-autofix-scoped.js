/**
 * format-autofix-scoped.js — Story #2533: scoped biome-format auto-apply
 * inside story-close's pre-merge gate chain.
 *
 * Background. The whole-tree `runFormatAutofix` (sibling module) heals
 * drift across `.` before the gate chain runs. That step is intentionally
 * broad because it covers files (JSON / YAML / config) that lint-staged
 * does not glob. This module is the narrower companion: it scopes
 * `biome format --write` to the **changed-file set** between the Epic
 * branch and the Story branch and folds any auto-fixed paths into a
 * dedicated commit on the Story branch *before* `biome ci` runs in the
 * gate chain.
 *
 * Why scoped + warn-level. The Tech Spec (Epic #2527, Story 5) calls out
 * that format diffs introduced by Story commits should never surface to
 * Phase 3 close-validation. The whole-tree autofix already covers that,
 * but emits `info` so operators routinely miss it. This module emits
 * `Logger.warn` naming the auto-fixed files so the signal is visible in
 * the close transcript and downstream ledger.
 *
 * Dependencies are injected so unit tests pin behaviour without spawning
 * git or biome.
 */

import { execFileSync } from 'node:child_process';

import { resolveFormatWriteCommand } from '../../close-validation.js';
import { Logger as DefaultLogger } from '../../Logger.js';

const TAG = '[format-autofix-scoped]';

/**
 * List the files changed between `epicBranch` and `storyBranch` using the
 * three-dot merge-base diff. Matches the semantics of `lib/changed-files.js`
 * but consumes the local `git` interface so callers can inject a stub.
 *
 * @param {{ cwd: string, epicBranch: string, storyBranch: string, git: Function }} opts
 * @returns {string[]}
 */
function listChangedFiles({ cwd, epicBranch, storyBranch, git }) {
  const out = git(['diff', '--name-only', `${epicBranch}...${storyBranch}`], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/\\/g, '/'));
}

/**
 * Return the porcelain status after the formatter ran so the caller can
 * tell whether anything needs staging.
 *
 * @param {{ cwd: string, git: Function }} opts
 * @returns {string[]}
 */
function listDirtyPaths({ cwd, git }) {
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
 * Run `biome format --write <changedFiles>` on the Epic→Story diff. If
 * any file is modified, stage and commit the changes on the Story branch
 * with a conventional `fix(story-close):` subject and emit a
 * `Logger.warn` naming the auto-fixed files. Returns a structured
 * envelope so callers can log a single line.
 *
 * No-op envelopes:
 *   - `{ ran: false, reason: 'no-changed-files' }`        — empty diff.
 *   - `{ ran: false, reason: 'dirty-tree' }`              — refused to
 *     absorb pre-existing edits.
 *   - `{ ran: true, committed: false }`                   — formatter
 *     was clean.
 *
 * @param {{
 *   cwd: string,
 *   storyId: number|string,
 *   epicBranch: string,
 *   storyBranch: string,
 *   agentSettings?: object,
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
  storyId,
  epicBranch,
  storyBranch,
  agentSettings,
  logger = DefaultLogger,
  spawnSync = execFileSync,
  gitSync,
} = {}) {
  if (!cwd) throw new Error('runScopedFormatAutofix: cwd is required');
  if (!epicBranch)
    throw new Error('runScopedFormatAutofix: epicBranch is required');
  if (!storyBranch)
    throw new Error('runScopedFormatAutofix: storyBranch is required');

  const git = gitSync ?? ((args, opts) => spawnSync('git', args, opts));

  // Resolve the formatter base command (e.g. `npx biome format --write`).
  // We drop a trailing `.` so we can append the changed-file set explicitly.
  const writeCmdString = resolveFormatWriteCommand(agentSettings);
  const writeParts = writeCmdString.split(/\s+/).filter(Boolean);
  if (writeParts[writeParts.length - 1] === '.') writeParts.pop();
  const [writeCmd, ...writeArgs] = writeParts;

  const changed = listChangedFiles({ cwd, epicBranch, storyBranch, git });
  if (changed.length === 0) {
    logger.info?.(
      `${TAG} skipped — no changed files between ${epicBranch} and ${storyBranch}.`,
    );
    return { ran: false, committed: false, reason: 'no-changed-files' };
  }

  const dirtyBefore = listDirtyPaths({ cwd, git });
  if (dirtyBefore.length) {
    logger.info?.(
      `${TAG} skipped — working tree dirty before scoped autofix (${dirtyBefore.length} paths).`,
    );
    return { ran: false, committed: false, reason: 'dirty-tree' };
  }

  // Run the formatter against the changed-file set. We tolerate non-zero
  // exit because the downstream check gate is the source of truth for
  // "did formatting succeed".
  try {
    spawnSync(writeCmd, [...writeArgs, ...changed], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
  } catch (err) {
    logger.warn?.(
      `${TAG} \`${writeCmdString}\` on ${changed.length} changed file(s) exited non-zero (${err?.status ?? 'unknown'}); falling through to the format check gate.`,
    );
  }

  const dirtyAfter = listDirtyPaths({ cwd, git });
  if (!dirtyAfter.length) {
    logger.info?.(
      `${TAG} no format drift on ${changed.length} changed file(s).`,
    );
    return { ran: true, committed: false };
  }

  // Stage every modified path and commit. Hooks must run; do not pass
  // --no-verify (project policy: never skip git hooks).
  git(['add', '-u'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const subject = `fix(story-close): auto-apply biome format in scoped lint (story #${storyId})`;
  git(['commit', '-m', subject], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const sha = git(['rev-parse', '--short', 'HEAD'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();

  // The warn-level emission is the Tech Spec contract — operators read
  // this line in the close transcript to know auto-fix landed in the
  // close commit, and downstream ledger inspectors filter on it.
  logger.warn?.(
    `${TAG} auto-applied biome format to ${dirtyAfter.length} path(s) on story #${storyId}: ${dirtyAfter.join(', ')}; committed as ${sha}.`,
  );
  return { ran: true, committed: true, sha, modifiedPaths: dirtyAfter };
}

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

import { diffNameOnly } from '../../changed-files.js';
import { Logger as DefaultLogger } from '../../Logger.js';
import {
  commitDirtyPaths,
  currentBranch,
  listDirtyPaths,
  resolveFormatterCmd,
} from './format-autofix-shared.js';

const TAG = '[format-autofix-scoped]';

/**
 * List the files changed between `epicBranch` and `storyBranch` using the
 * three-dot merge-base diff. Delegates parsing to `diffNameOnly` from
 * `changed-files.js` so the stdout → path-list conversion lives in one place.
 *
 * The `git` parameter uses the caller's local interface:
 * `(args: string[], opts: object) => string`. A bridge adapter wraps it into
 * the `gitSpawn(cwd, ...args)` shape that `diffNameOnly` expects.
 *
 * @param {{ cwd: string, epicBranch: string, storyBranch: string, git: Function }} opts
 * @returns {string[]}
 */
function listChangedFiles({ cwd, epicBranch, storyBranch, git }) {
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
    range: `${epicBranch}...${storyBranch}`,
    cwd,
    gitSpawn,
  });
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
 *   epicBranch: string,
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
  epicBranch,
  storyBranch,
  config,
  logger = DefaultLogger,
  spawnSync = execFileSync,
  gitSync,
} = {}) {
  if (!cwd) throw new Error('runScopedFormatAutofix: cwd is required');
  if (!epicBranch)
    throw new Error('runScopedFormatAutofix: epicBranch is required');
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
    dropTrailingDot: true,
  });

  const changed = listChangedFiles({
    cwd: workTree,
    epicBranch,
    storyBranch,
    git,
  });
  if (changed.length === 0) {
    logger.info?.(
      `${TAG} skipped — no changed files between ${epicBranch} and ${storyBranch}.`,
    );
    return { ran: false, committed: false, reason: 'no-changed-files' };
  }

  const dirtyBefore = listDirtyPaths(workTree, git);
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
      cwd: workTree,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
  } catch (err) {
    logger.warn?.(
      `${TAG} \`${writeCmdString}\` on ${changed.length} changed file(s) exited non-zero (${err?.status ?? 'unknown'}); falling through to the format check gate.`,
    );
  }

  const dirtyAfter = listDirtyPaths(workTree, git);
  if (!dirtyAfter.length) {
    logger.info?.(
      `${TAG} no format drift on ${changed.length} changed file(s).`,
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
      `${TAG} refusing to commit — worktree ${workTree} is on "${onBranch ?? 'unknown'}", expected "${storyBranch}". ` +
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
    `${TAG} auto-applied biome format to ${dirtyAfter.length} path(s) on story #${storyId}: ${dirtyAfter.join(', ')}; committed as ${sha}.`,
  );
  return { ran: true, committed: true, sha, modifiedPaths: dirtyAfter };
}

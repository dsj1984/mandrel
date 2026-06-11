/**
 * format-autofix.js — self-healing biome-format step for story-close.
 *
 * Story #4017 collapsed the historical three-module split (a whole-tree
 * fork, a scoped changed-file fork, and a shared plumbing module) into
 * this single module. The two entry points differ only in file-scope,
 * commit subject, and log level; the git/formatter plumbing is shared
 * below.
 *
 * Background. The pre-merge `biome format` gate is check-only — it fails
 * the close when the working tree has any format drift. In practice
 * upstream waves frequently leave drift in files that lint-staged does
 * not glob (JSON/JSON5/YAML), so the *next* wave's close hits the gate,
 * fails, and forces an operator-driven `npx biome format --write` plus a
 * `style:` commit before the close can resume. That manual loop is
 * trivially automatable.
 *
 * Entry points:
 *
 *   - {@link runFormatAutofix} — whole-tree heal (`biome format --write .`)
 *     before the pre-merge gate chain, for resume/legacy callers that have
 *     no Epic→Story diff anchor. Bounded by a wall-clock timeout
 *     (Story #2165).
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
import { getQuality } from '../../config-resolver.js';
import { Logger as DefaultLogger } from '../../Logger.js';

const TAG = '[format-autofix]';
const SCOPED_TAG = '[format-autofix-scoped]';

/**
 * Story #2165 — exit code surfaced when the bounded `npx biome format
 * --write` spawn is killed by the timeout watchdog. Matches the GNU
 * `timeout(1)` convention so the close orchestrator can branch on "hang"
 * (124) vs. "formatter exited non-zero" (any other status) without
 * inspecting signal names. Mirrors `COVERAGE_TIMEOUT_EXIT_CODE` from
 * `coverage-capture.js` (Story #2142).
 */
export const FORMAT_AUTOFIX_TIMEOUT_EXIT_CODE = 124;

/**
 * Run `git status --porcelain` and return the list of changed paths.
 *
 * Porcelain lines are `XY <path>` — exactly two status chars, one space,
 * then the path. Leading whitespace inside the status pair is significant
 * (e.g. ` M file` for unstaged-modified) so we slice a fixed 3 chars off
 * the front rather than trimming.
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
 * The whole-tree entry point runs the command verbatim (keeping the
 * trailing `.` so biome formats the entire tree). The scoped entry point
 * appends an explicit changed-file set, so it passes
 * `dropTrailingDot: true` to strip the `.` before its file list.
 *
 * @param {{
 *   commands?: object,
 *   dropTrailingDot?: boolean,
 * }} [opts]
 * @returns {{ writeCmdString: string, writeCmd: string, writeArgs: string[] }}
 */
export function resolveFormatterCmd({
  commands,
  dropTrailingDot = false,
} = {}) {
  // `resolveFormatWriteCommand` reads `config.project.commands`; wrap the
  // caller-supplied `commands` map into that canonical shape.
  const writeCmdString = resolveFormatWriteCommand({ project: { commands } });
  const parts = writeCmdString.split(/\s+/).filter(Boolean);
  if (dropTrailingDot && parts[parts.length - 1] === '.') parts.pop();
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
 * Story #2165 — resolve the format-autofix spawn timeout. An explicit
 * caller-supplied positive integer wins over both
 * `delivery.quality.formatAutofix.timeoutMs` and the framework default
 * (60 s). Any resolver failure surfaces as `null`; the caller treats that
 * as "no timeout" and the spawn runs unbounded — same fail-open contract
 * coverage-capture uses.
 */
function resolveFormatTimeoutMs({ timeoutMs, config }) {
  if (
    typeof timeoutMs === 'number' &&
    Number.isInteger(timeoutMs) &&
    timeoutMs > 0
  ) {
    return timeoutMs;
  }
  try {
    const resolved = getQuality(config)?.formatAutofix?.timeoutMs;
    if (
      typeof resolved === 'number' &&
      Number.isInteger(resolved) &&
      resolved > 0
    ) {
      return resolved;
    }
  } catch {
    // resolver failure → fall through to "no timeout"
  }
  return null;
}

/**
 * Run `npx biome format --write .` then, if anything changed, commit
 * the result on the Story branch with a `style:` subject. Returns a
 * structured envelope so callers can log a single line.
 *
 * Story #2165: the formatter spawn is bounded by a wall-clock timeout
 * (resolved from `delivery.quality.formatAutofix.timeoutMs`, default
 * 60 s). A SIGKILL fired at the budget boundary is translated to the
 * `timedOut: true` envelope below so the close orchestrator can flip the
 * Story to `agent::blocked` with a friction comment naming the spawn,
 * mirroring the coverage-capture pattern from Story #2142.
 *
 * The step is a no-op when:
 *   - biome rewrites nothing (clean tree),
 *   - the working tree is dirty for unrelated reasons (we refuse to
 *     opportunistically commit those — operator intent is unclear), or
 *   - `npx biome format --write` exits non-zero (we surface the error
 *     and let the existing format gate report it with the canonical
 *     hint).
 *
 * @param {{
 *   cwd: string,
 *   storyId: number|string,
 *   config?: object,
 *   timeoutMs?: number,
 *   logger?: object,
 *   spawnSync?: typeof execFileSync,
 *   gitSync?: (args: string[], opts: object) => string,
 * }} opts
 * @returns {{
 *   ran: boolean,
 *   committed: boolean,
 *   sha?: string,
 *   dirtyPathsBefore?: string[],
 *   timedOut?: boolean,
 *   timeoutMs?: number,
 *   exitCode?: number,
 *   writeCmdString?: string,
 * }}
 */
export function runFormatAutofix({
  cwd,
  storyId,
  config,
  timeoutMs,
  logger = DefaultLogger,
  spawnSync = execFileSync,
  gitSync,
} = {}) {
  if (!cwd) throw new Error('runFormatAutofix: cwd is required');

  const git = gitSync ?? ((args, opts) => spawnSync('git', args, opts));
  // Resolve the formatter command from `project.commands.formatWrite` so
  // Prettier / dprint repos use their own formatter. Falls back to the
  // historical `npx biome format --write .` for repos that haven't opted in.
  // The whole-tree entry point keeps the trailing `.` (formats the tree).
  const { writeCmdString, writeCmd, writeArgs } = resolveFormatterCmd({
    commands: config?.project?.commands,
  });

  // Refuse to act when the tree is already dirty for unrelated reasons —
  // we don't want to absorb stray edits into a `style:` commit.
  const dirtyBefore = listDirtyPaths(cwd, git);
  if (dirtyBefore.length) {
    logger.info?.(
      `${TAG} skipped — working tree dirty before autofix (${dirtyBefore.length} paths). ` +
        'The format check gate will report any drift with the canonical hint.',
    );
    return { ran: false, committed: false, dirtyPathsBefore: dirtyBefore };
  }

  // Story #2165 — bounded wall-clock for the formatter spawn.
  // execFileSync's contract: on a SIGKILL trip the thrown error carries
  // `err.signal === 'SIGKILL'` and `err.status === null`, so we branch on
  // that to surface the 124 envelope below — same shape coverage-capture
  // returns to its caller (Story #2142).
  const resolvedTimeoutMs = resolveFormatTimeoutMs({
    timeoutMs,
    config,
  });
  const spawnOpts = {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    killSignal: 'SIGKILL',
  };
  if (Number.isInteger(resolvedTimeoutMs) && resolvedTimeoutMs > 0) {
    spawnOpts.timeout = resolvedTimeoutMs;
  }
  // Run the configured formatter in write mode. We tolerate a non-zero exit
  // because the existing format gate downstream is the source of truth for
  // "did formatting succeed" — our job is only to opportunistically heal
  // drift that *would* have failed the gate.
  let writeFailed = false;
  try {
    spawnSync(writeCmd, writeArgs, spawnOpts);
  } catch (err) {
    if (err?.signal === 'SIGKILL') {
      logger.warn?.(
        `${TAG} ⏱ \`${writeCmdString}\` exceeded ${resolvedTimeoutMs}ms — killed (SIGKILL). ` +
          `Returning exit ${FORMAT_AUTOFIX_TIMEOUT_EXIT_CODE}; story-close will flip Story #${storyId} to agent::blocked.`,
      );
      return {
        ran: true,
        committed: false,
        timedOut: true,
        timeoutMs: resolvedTimeoutMs,
        exitCode: FORMAT_AUTOFIX_TIMEOUT_EXIT_CODE,
        writeCmdString,
      };
    }
    writeFailed = true;
    logger.warn?.(
      `${TAG} \`${writeCmdString}\` exited non-zero (${err?.status ?? 'unknown'}); ` +
        'falling through to the format check gate to report drift.',
    );
  }

  const dirtyAfter = listDirtyPaths(cwd, git);
  if (!dirtyAfter.length) {
    logger.info?.(
      writeFailed
        ? `${TAG} no autofix changes produced (formatter write failed).`
        : `${TAG} no format drift — tree clean after \`${writeCmdString}\`.`,
    );
    return { ran: true, committed: false };
  }

  // Stage every modified path and commit. Hooks must run; do not pass
  // --no-verify (project policy: never skip git hooks).
  const subject = `style: biome format autofix on story-close (story #${storyId})`;
  const sha = commitDirtyPaths({ cwd, git, subject });

  logger.info?.(
    `${TAG} healed ${dirtyAfter.length} path(s) with \`${writeCmdString}\`; ` +
      `committed as ${sha} on story branch.`,
  );
  return { ran: true, committed: true, sha };
}

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
      `${SCOPED_TAG} skipped — no changed files between ${epicBranch} and ${storyBranch}.`,
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

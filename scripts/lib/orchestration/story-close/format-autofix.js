/**
 * format-autofix.js — self-healing biome-format step for story-close.
 *
 * Background. The pre-merge `biome format` gate is check-only — it fails
 * the close when the working tree has any format drift. In practice
 * upstream waves frequently leave drift in files that lint-staged does
 * not glob (JSON/JSON5/YAML), so the *next* wave's close hits the gate,
 * fails, and forces an operator-driven `npx biome format --write` plus a
 * `style:` commit before the close can resume. That manual loop is
 * trivially automatable.
 *
 * This module runs `npx biome format --write .` *before* the pre-merge
 * gate chain. If it rewrites files, we stage and commit them on the
 * Story branch with a `style:` subject so the merge into `epic/<id>`
 * carries the fix forward atomically. The subsequent `biome format`
 * check gate then passes deterministically.
 *
 * The step is a no-op when:
 *   - biome rewrites nothing (clean tree),
 *   - the working tree is dirty for unrelated reasons (we refuse to
 *     opportunistically commit those — operator intent is unclear), or
 *   - `npx biome format --write` exits non-zero (we surface the error
 *     and let the existing format gate report it with the canonical
 *     hint).
 *
 * Dependencies are injected so unit tests pin behaviour without
 * spawning git or biome.
 */

import { execFileSync } from 'node:child_process';

import { resolveFormatWriteCommand } from '../../close-validation.js';
import { Logger as DefaultLogger } from '../../Logger.js';

const TAG = '[format-autofix]';

/**
 * Run `git status --porcelain` and return the list of changed paths.
 * @param {string} cwd
 * @param {(args: string[], opts: object) => string} run
 * @returns {string[]}
 */
function listDirtyPaths(cwd, run) {
  const out = run(['status', '--porcelain'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  // Porcelain lines are `XY <path>` — exactly two status chars, one
  // space, then the path. Leading whitespace inside the status pair is
  // significant (e.g. ` M file` for unstaged-modified) so do not trim
  // before slicing.
  return out
    .split('\n')
    .filter((line) => line.length >= 4)
    .map((line) => line.slice(3));
}

/**
 * Run `npx biome format --write .` then, if anything changed, commit
 * the result on the Story branch with a `style:` subject. Returns a
 * structured envelope so callers can log a single line.
 *
 * @param {{
 *   cwd: string,
 *   storyId: number|string,
 *   logger?: object,
 *   spawnSync?: typeof execFileSync,
 *   gitSync?: (args: string[], opts: object) => string,
 * }} opts
 * @returns {{ ran: boolean, committed: boolean, sha?: string, dirtyPathsBefore?: string[] }}
 */
export function runFormatAutofix({
  cwd,
  storyId,
  settings,
  logger = DefaultLogger,
  spawnSync = execFileSync,
  gitSync,
} = {}) {
  if (!cwd) throw new Error('runFormatAutofix: cwd is required');

  const git = gitSync ?? ((args, opts) => spawnSync('git', args, opts));
  // Resolve the formatter command from `agentSettings.commands.formatWrite`
  // so Prettier / dprint repos use their own formatter. Falls back to the
  // historical `npx biome format --write .` for repos that haven't opted in.
  const writeCmdString = resolveFormatWriteCommand(settings);
  const [writeCmd, ...writeArgs] = writeCmdString.split(/\s+/).filter(Boolean);

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

  // Run the configured formatter in write mode. We tolerate a non-zero exit
  // because the existing format gate downstream is the source of truth for
  // "did formatting succeed" — our job is only to opportunistically heal
  // drift that *would* have failed the gate.
  let writeFailed = false;
  try {
    spawnSync(writeCmd, writeArgs, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
  } catch (err) {
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
  git(['add', '-u'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const subject = `style: biome format autofix on story-close (story #${storyId})`;
  git(['commit', '-m', subject], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const sha = git(['rev-parse', '--short', 'HEAD'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();

  logger.info?.(
    `${TAG} healed ${dirtyAfter.length} path(s) with \`${writeCmdString}\`; ` +
      `committed as ${sha} on story branch.`,
  );
  return { ran: true, committed: true, sha };
}

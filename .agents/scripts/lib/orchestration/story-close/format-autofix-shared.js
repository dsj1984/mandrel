/**
 * format-autofix-shared.js — Story #3332 (Epic #3316): single-source the
 * git/formatter plumbing shared by the two format-autofix forks.
 *
 * `format-autofix.js` (whole-tree heal) and `format-autofix-scoped.js`
 * (Epic→Story changed-file heal) historically each carried their own copy
 * of the porcelain-status parse, the formatter-command resolution, and the
 * stage→commit→rev-parse sequence. The three forked helpers are
 * byte-for-byte equivalent apart from cosmetics, so a fix to (say) the
 * porcelain-line slice had to land twice. This module is the single home
 * for all three; the two forks now differ only in file-scope, commit
 * subject, and log level.
 *
 * Every helper takes an injected `git` runner (`(args, opts) => string`) so
 * unit tests pin behaviour without spawning git.
 */

import { resolveFormatWriteCommand } from '../../close-validation.js';

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
 * The whole-tree fork runs the command verbatim (keeping the trailing `.`
 * so biome formats the entire tree). The scoped fork appends an explicit
 * changed-file set, so it passes `dropTrailingDot: true` to strip the `.`
 * before its file list.
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
  const writeCmdString = resolveFormatWriteCommand({ commands });
  const parts = writeCmdString.split(/\s+/).filter(Boolean);
  if (dropTrailingDot && parts[parts.length - 1] === '.') parts.pop();
  const [writeCmd, ...writeArgs] = parts;
  return { writeCmdString, writeCmd, writeArgs };
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

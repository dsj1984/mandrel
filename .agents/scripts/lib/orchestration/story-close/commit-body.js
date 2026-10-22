/**
 * commit-body.js — the git every close-time baseline write-back commits with.
 *
 * {@link closeGitSync} is a drop-in `gitSync` whose `git commit` bounds each
 * body line to commitlint `config-conventional`'s `body-max-line-length`
 * (100). A consumer's `commit-msg` hook is the authority, so a deep path is
 * re-flowed rather than the hook bypassed. A commit the hook still refuses
 * throws with {@link COMMIT_REFUSED} and the rule, which {@link refusalMark}
 * reports as a warning rather than a quiet skip.
 */

import { gitSync } from '../../git-utils.js';
import { Logger } from '../../Logger.js';

const BODY_LINE_MAX = 100;

/**
 * Leads a refused commit's message, so it survives each writer's own
 * `<label>: <message>` skip reason for the close step to recognise.
 */
const COMMIT_REFUSED = 'commit-refused:';

const ROW_PREFIX = '- ';
const CONTINUATION = '  ';
const LEFT_ELLIPSIS = '…/';

/**
 * Keep the tail of a path (the file name is what a reader needs), cut at a
 * segment boundary when one falls inside the kept span.
 *
 * @param {string} rowPath
 * @param {number} max
 * @returns {string}
 */
function truncatePathLeft(rowPath, max) {
  if (rowPath.length <= max) return rowPath;
  const tail = rowPath.slice(rowPath.length - (max - LEFT_ELLIPSIS.length));
  const cut = tail.indexOf('/');
  const kept = cut >= 0 && cut < tail.length - 1 ? tail.slice(cut + 1) : tail;
  return `${LEFT_ELLIPSIS}${kept}`;
}

/**
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function truncateRight(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * One body row, `- <path>: <detail>`, as one line when it fits; otherwise the
 * path on its own line (left-truncated past 98 chars) and the detail on an
 * indented continuation line. Every returned line is ≤ {@link BODY_LINE_MAX}.
 *
 * @param {string} rowPath
 * @param {string} detail
 * @returns {string[]}
 */
function formatBodyRow(rowPath, detail) {
  const oneLine = `${ROW_PREFIX}${rowPath}: ${detail}`;
  if (oneLine.length <= BODY_LINE_MAX) return [oneLine];
  return [
    `${ROW_PREFIX}${truncatePathLeft(rowPath, BODY_LINE_MAX - ROW_PREFIX.length)}`,
    `${CONTINUATION}${truncateRight(detail, BODY_LINE_MAX - CONTINUATION.length)}`,
  ];
}

/**
 * Bound every line of a body: an over-long `- <path>: <detail>` row is
 * re-flowed by {@link formatBodyRow} (split at its last `: `, since a detail
 * never carries one); any other over-long line is cut on the right. Rows that
 * fit pass through unchanged.
 *
 * @param {string} body
 * @returns {string}
 */
function boundBody(body) {
  return body
    .split('\n')
    .flatMap((line) => {
      if (line.length <= BODY_LINE_MAX) return [line];
      const split = line.lastIndexOf(': ');
      if (!line.startsWith(ROW_PREFIX) || split < 0) {
        return [truncateRight(line, BODY_LINE_MAX)];
      }
      return formatBodyRow(
        line.slice(ROW_PREFIX.length, split),
        line.slice(split + 2),
      );
    })
    .join('\n');
}

/**
 * Name why `git commit` was refused: the bracketed commitlint rule(s) when the
 * hook printed any, else the last line it printed (husky's summary). Reads the
 * hook's stderr, not the error message, which echoes the commit argv — a
 * `[slug]` route segment in a body path is not a rule.
 *
 * @param {unknown} err
 * @returns {string}
 */
function describeCommitRefusal(err) {
  const text = String(err?.stderr || err?.message || err || '');
  const rules = [
    ...new Set([...text.matchAll(/\[([a-z][a-z0-9-]*)\]/g)].map((m) => m[1])),
  ];
  if (rules.length > 0)
    return `commit-msg hook refused it [${rules.join(', ')}]`;
  const lines = text.split('\n').map((l) => l.trim());
  return truncateRight(lines.filter(Boolean).at(-1) ?? 'unknown', 200);
}

/** `git commit` itself failed (a hook refused it), not a write or `git add`. */
class CommitRefusedError extends Error {
  /** @param {unknown} cause */
  constructor(cause) {
    super(`${COMMIT_REFUSED} ${describeCommitRefusal(cause)}`, { cause });
    this.name = 'CommitRefusedError';
  }
}

/**
 * `gitSync` for close-time write-backs. A `git commit` (hooks enabled) gets
 * every `-m` paragraph bounded by {@link boundBody} — a subject already fits —
 * and a failure throws {@link CommitRefusedError}; any other command passes
 * straight through.
 *
 * @param {string} cwd
 * @param {...string} args
 * @returns {string} trimmed stdout
 */
export function closeGitSync(cwd, ...args) {
  if (args[0] !== 'commit') return gitSync(cwd, ...args);
  const bounded = args.map((arg, i) =>
    args[i - 1] === '-m' ? boundBody(arg) : arg,
  );
  try {
    return gitSync(cwd, ...bounded);
  } catch (err) {
    throw new CommitRefusedError(err);
  }
}

/**
 * The close step's mark for a write-back that did not commit: `⚠️`, logged at
 * warning level, when a hook refused the commit (its rows stay stale — the
 * drift the write-back exists to prevent), else the plain `⏭` skip.
 *
 * @param {string} tag the close step's log tag
 * @param {string|undefined} reason the write-back's skip reason or error
 * @returns {'⚠️'|'⏭'}
 */
export function refusalMark(tag, reason) {
  if (!String(reason ?? '').includes(COMMIT_REFUSED)) return '⏭';
  Logger.warn(
    `[${tag}] baseline commit refused; its rows stay stale: ${reason}`,
  );
  return '⚠️';
}

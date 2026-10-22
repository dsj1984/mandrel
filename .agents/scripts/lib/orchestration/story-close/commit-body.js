/**
 * commit-body.js — the git close-time baseline write-backs commit with: each
 * body line bounded to commitlint's `body-max-line-length` (100), never by
 * bypassing the consumer's hook; a refusal names the rule and warns.
 */

import { gitSync } from '../../git-utils.js';
import { Logger } from '../../Logger.js';

const BODY_LINE_MAX = 100;

/** Survives each writer's own `<label>: <message>` skip reason. */
const COMMIT_REFUSED = 'commit-refused:';

const ROW_PREFIX = '- ';
const CONTINUATION = '  ';
const LEFT_ELLIPSIS = '…/';

/** Keep the path's tail, cut at a segment boundary. */
function truncatePathLeft(rowPath, max) {
  if (rowPath.length <= max) return rowPath;
  const tail = rowPath.slice(rowPath.length - (max - LEFT_ELLIPSIS.length));
  const cut = tail.indexOf('/');
  const kept = cut >= 0 && cut < tail.length - 1 ? tail.slice(cut + 1) : tail;
  return `${LEFT_ELLIPSIS}${kept}`;
}

function truncateRight(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** `- <path>: <detail>`, or the path then an indented detail line. */
function formatBodyRow(rowPath, detail) {
  const oneLine = `${ROW_PREFIX}${rowPath}: ${detail}`;
  if (oneLine.length <= BODY_LINE_MAX) return [oneLine];
  return [
    `${ROW_PREFIX}${truncatePathLeft(rowPath, BODY_LINE_MAX - ROW_PREFIX.length)}`,
    `${CONTINUATION}${truncateRight(detail, BODY_LINE_MAX - CONTINUATION.length)}`,
  ];
}

/** Re-flow over-long rows (split at the last `: `); cut other long lines. */
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

/** The commitlint rule(s) from hook stderr — not the message, which echoes argv. */
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
  constructor(cause) {
    super(`${COMMIT_REFUSED} ${describeCommitRefusal(cause)}`, { cause });
    this.name = 'CommitRefusedError';
  }
}

/** Drop-in `gitSync`: a `git commit` gets bounded `-m` paragraphs. */
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

/** `⚠️` plus a warn-level log for a refused commit, else `⏭`. */
export function refusalMark(tag, reason) {
  if (!String(reason ?? '').includes(COMMIT_REFUSED)) return '⏭';
  Logger.warn(
    `[${tag}] baseline commit refused; its rows stay stale: ${reason}`,
  );
  return '⚠️';
}

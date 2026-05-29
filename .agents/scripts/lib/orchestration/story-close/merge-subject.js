/**
 * merge-subject.js — assemble the conventional-commit subject used by
 * `runFinalizeMerge` and `runResumeMerge` and auto-truncate it on a
 * word boundary when it would exceed commitlint's `header-max-length`.
 *
 * Story #2466 (Epic #2453) auto-generated a 102-char merge subject that
 * commitlint rejected; `story-close.js`'s merge step silently rolled
 * back to staged-only on each retry. This helper prevents the rejection
 * by shaping the subject pre-commit:
 *
 *   - The Conventional-Commits prefix (`<type>(<scope>): ` if scope is
 *     provided, otherwise `<type>: `) is preserved verbatim.
 *   - The ` (resolves #N)` suffix is preserved verbatim.
 *   - The title segment is truncated on a word boundary (whitespace),
 *     never mid-word, until the assembled subject's byte length fits
 *     within the cap.
 *   - On truncation, an operator-facing `Logger.warn` fires once and a
 *     `truncated-from: <original>` body trailer is returned so the
 *     caller can append it to the commit body.
 *
 * The cap is loaded from commitlint config via `@commitlint/load`,
 * cached per-cwd, and falls back to 100 (the
 * `@commitlint/config-conventional` default) when load fails.
 *
 * Pure (the shape function) + cached async loader. No I/O at shape time.
 */

import path from 'node:path';
import { Logger as DefaultLogger } from '../../Logger.js';
import { resolvesToken } from '../resolves-token.js';

const COMMITLINT_DEFAULT_HEADER_MAX_LENGTH = 100;
const headerCapCache = new Map();

/**
 * Load commitlint's `header-max-length` rule value for the given cwd.
 * Caches the resolved cap per absolute cwd so repeated close-path calls
 * inside a single process do not re-read commitlint config.
 *
 * Returns the default (100) when commitlint is not installed, the
 * config is missing, or the rule is absent / disabled.
 *
 * @param {string} cwd
 * @param {{ logger?: { warn?: Function } }} [opts]
 * @returns {Promise<number>}
 */
export async function loadHeaderMaxLength(cwd, opts = {}) {
  const logger = opts.logger ?? DefaultLogger;
  const key = path.resolve(cwd);
  if (headerCapCache.has(key)) return headerCapCache.get(key);
  let cap = COMMITLINT_DEFAULT_HEADER_MAX_LENGTH;
  try {
    const mod = await import('@commitlint/load');
    const load = mod.default ?? mod.load ?? mod;
    const loaded = await load({}, { cwd: key });
    const rule = loaded?.rules?.['header-max-length'];
    if (Array.isArray(rule) && rule.length >= 3) {
      const [level, _applicable, value] = rule;
      if (level > 0 && Number.isFinite(value) && value > 0) {
        cap = value;
      }
    }
  } catch (err) {
    logger?.warn?.(
      `[merge-subject] commitlint header-max-length load failed; ` +
        `using default ${COMMITLINT_DEFAULT_HEADER_MAX_LENGTH}: ${err?.message ?? err}`,
    );
  }
  headerCapCache.set(key, cap);
  return cap;
}

/**
 * Test-only: clear the per-cwd cap cache.
 */
export function _resetHeaderMaxLengthCache() {
  headerCapCache.clear();
}

function buildPrefix(type, scope) {
  return scope ? `${type}(${scope}): ` : `${type}: `;
}

// Caps the `truncated-from: <subject>` trailer at `cap` bytes so it
// satisfies commitlint's `footer-max-line-length` rule. Without this
// cap, an original subject near the header cap (100) produces a
// ~116-char trailer line.
function buildTruncatedFromTrailer(originalSubject, cap) {
  const prefix = 'truncated-from: ';
  const budget = Math.max(0, cap - Buffer.byteLength(prefix, 'utf8'));
  if (Buffer.byteLength(originalSubject, 'utf8') <= budget) {
    return `${prefix}${originalSubject}`;
  }
  const ellipsisBytes = Buffer.byteLength('…', 'utf8');
  let value = originalSubject;
  while (Buffer.byteLength(value, 'utf8') + ellipsisBytes > budget) {
    value = value.slice(0, -1);
  }
  return `${prefix}${value}…`;
}

function truncateTitleOnWordBoundary(title, budget) {
  if (budget <= 0) return '';
  if (Buffer.byteLength(title, 'utf8') <= budget) return title;
  // Greedy: drop trailing tokens until the title fits the byte budget.
  let truncated = title;
  while (Buffer.byteLength(truncated, 'utf8') > budget) {
    const lastWs = truncated.search(/\s+\S*$/u);
    if (lastWs <= 0) {
      // No earlier whitespace — fall back to byte-safe slice.
      truncated = truncated.slice(0, Math.max(0, truncated.length - 1));
      continue;
    }
    truncated = truncated.slice(0, lastWs);
  }
  return truncated.replace(/\s+$/u, '');
}

/**
 * Shape a Conventional-Commits subject so it fits within `headerMaxLength`.
 *
 * Returns `{ subject, original, truncated, bodyTrailer }`:
 *   - `subject`     — the (possibly truncated) one-line subject.
 *   - `original`    — the un-truncated subject (always populated).
 *   - `truncated`   — boolean, true iff truncation fired.
 *   - `bodyTrailer` — `truncated-from: <original>` when truncated, else null.
 *
 * Side effects: on truncation, emits a single `Logger.warn` line naming
 * the original and truncated subjects.
 *
 * @param {{
 *   type: string,
 *   scope?: string|null,
 *   title: string,
 *   storyId: number|string,
 *   headerMaxLength?: number,
 *   logger?: { warn?: Function },
 * }} args
 * @returns {{ subject: string, original: string, truncated: boolean, bodyTrailer: string|null }}
 */
export function shapeMergeSubject({
  type,
  scope = null,
  title,
  storyId,
  headerMaxLength = COMMITLINT_DEFAULT_HEADER_MAX_LENGTH,
  logger = DefaultLogger,
}) {
  const lcTitle = title.charAt(0).toLowerCase() + title.slice(1);
  const prefix = buildPrefix(type, scope);
  const suffix = resolvesToken(storyId);
  const originalSubject = `${prefix}${lcTitle}${suffix}`;
  if (Buffer.byteLength(originalSubject, 'utf8') <= headerMaxLength) {
    return {
      subject: originalSubject,
      original: originalSubject,
      truncated: false,
      bodyTrailer: null,
    };
  }
  const fixedBytes =
    Buffer.byteLength(prefix, 'utf8') + Buffer.byteLength(suffix, 'utf8');
  const titleBudget = headerMaxLength - fixedBytes;
  const truncatedTitle = truncateTitleOnWordBoundary(lcTitle, titleBudget);
  const subject = `${prefix}${truncatedTitle}${suffix}`;
  logger?.warn?.(
    `[merge-subject] subject exceeded commitlint cap (${headerMaxLength}); ` +
      `truncated on word boundary. original="${originalSubject}" ` +
      `truncated="${subject}"`,
  );
  return {
    subject,
    original: originalSubject,
    truncated: true,
    bodyTrailer: buildTruncatedFromTrailer(originalSubject, headerMaxLength),
  };
}

/**
 * Convenience: shape a subject and assemble the final commit message
 * (subject plus optional trailer block). Returns a single string suitable
 * for passing as the `-m` argument to `git commit` / `git merge`.
 *
 * @param {Parameters<typeof shapeMergeSubject>[0]} args
 * @returns {{ message: string, subject: string, original: string, truncated: boolean }}
 */
export function buildMergeMessageWithCap(args) {
  const shaped = shapeMergeSubject(args);
  const message = shaped.bodyTrailer
    ? `${shaped.subject}\n\n${shaped.bodyTrailer}`
    : shaped.subject;
  return {
    message,
    subject: shaped.subject,
    original: shaped.original,
    truncated: shaped.truncated,
  };
}

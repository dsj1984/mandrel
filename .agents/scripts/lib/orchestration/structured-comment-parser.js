/**
 * structured-comment-parser.js — shared parser for fenced-JSON structured
 * comments.
 *
 * Several callers (epic-runner Checkpointer, ProgressReporter
 * `parseStoryRunProgressComment` / `parsePhaseTimingsComment`, wave-gate's
 * local `extractJsonBlock`) need to extract the `{...}` payload from the
 * fenced ```json``` block of a structured comment body. They had each open-
 * coded the same `/```json\s*\n([\s\S]*?)\n```/` regex + `JSON.parse` +
 * try/catch dance — small enough to copy, large enough to drift.
 *
 * This helper centralizes that single regex so a future change to the
 * fence format (e.g. tolerating CRLF, surrounding whitespace, alternate
 * fence languages) lives in exactly one place. The functions are
 * deliberately permissive about input shape: anything that isn't the
 * expected type returns `null` rather than throwing, matching what the
 * existing callers already do — they all treat parse failure as "no
 * payload available" and fall back to a default state.
 *
 * Acceptance contract for this helper:
 *   - returns the parsed JSON value when the body contains a valid fenced
 *     ```json``` block;
 *   - returns `null` for missing comment, missing body, missing fence, or
 *     malformed JSON inside the fence;
 *   - never throws.
 */

const JSON_FENCE_RE = /```json\s*\n([\s\S]*?)\n```/;

/**
 * Extract the parsed JSON object from the first fenced ```json``` block in
 * a raw string. Returns `null` for any malformed or missing input — callers
 * treat that as "no payload" and fall back.
 *
 * Use this variant when the caller already holds the raw comment body as a
 * string (e.g. after extracting `.body` themselves). Use
 * `parseFencedJsonComment` when working with a comment-like object.
 *
 * @param {unknown} text — the raw string to scan.
 * @returns {unknown | null} the parsed JSON value (typically an object),
 *   or `null` when extraction fails.
 */
export function parseFencedJson(text) {
  if (typeof text !== 'string') return null;
  const match = text.match(JSON_FENCE_RE);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

/**
 * Extract the parsed JSON object from the first fenced ```json``` block in
 * a structured comment's `body`. Returns `null` for any malformed or
 * missing input — callers treat that as "no payload" and fall back.
 *
 * @param {{ body?: unknown } | null | undefined} comment — a comment-like
 *   object. Only the string `body` field is consulted.
 * @returns {unknown | null} the parsed JSON value (typically an object),
 *   or `null` when extraction fails.
 */
export function parseFencedJsonComment(comment) {
  if (!comment || typeof comment.body !== 'string') return null;
  return parseFencedJson(comment.body);
}

/**
 * detectors/common.js — shared helpers for the signals layer.
 *
 * Hoisted out of three detector modules (hotspot, retry, rework) plus
 * `signals/read.js` and `signals/schema.js`, all of which shipped
 * byte-equivalent copies of these predicates. See Story #2464.
 */

/**
 * Return true when `v` is a positive (strictly > 0) integer. Used by every
 * signal writer and reader as the canonical numeric-id guard.
 *
 * @param {unknown} v
 * @returns {boolean}
 */
export function isPositiveInt(v) {
  return Number.isInteger(v) && v > 0;
}

/**
 * Pull the tool name from a trace record. The hook writes the tool name
 * into `source.tool` and (defensively) into `details.tool` — we accept
 * either so older traces still classify correctly.
 *
 * @param {object} rec
 * @returns {string|null}
 */
export function extractTool(rec) {
  if (typeof rec?.source?.tool === 'string' && rec.source.tool.length > 0) {
    return rec.source.tool;
  }
  if (typeof rec?.details?.tool === 'string' && rec.details.tool.length > 0) {
    return rec.details.tool;
  }
  return null;
}

/**
 * The one baseline layout codec: every path that turns baseline JSON into
 * rows, or rows into JSON, goes through here. CRAP persists rows grouped by
 * path under `files`; every other kind persists `rows[]` verbatim.
 *
 * @module lib/baselines/codec
 */

import { decodeCrapFiles, encodeCrapFiles } from './kinds/_crap-codec.js';

/** Fixed top-level order; a stamp reaches disk only if named here. */
const STAMP_KEYS = Object.freeze([
  '$schema',
  'kernelVersion',
  'scoringSemantics',
  'tsTranspilerVersion',
]);

function isCrapEnvelope(value) {
  return (
    typeof value?.$schema === 'string' &&
    /(?:^|\/)crap\.schema\.json$/.test(value.$schema)
  );
}

/**
 * In-memory envelope to its on-disk object. Unset stamps stay undefined, so
 * JSON omits them.
 *
 * @param {{rows: Array<object>}} envelope
 * @returns {object}
 */
export function encodeEnvelope(envelope) {
  const out = {};
  for (const key of STAMP_KEYS) out[key] = envelope[key];
  if (isCrapEnvelope(envelope)) out.files = encodeCrapFiles(envelope.rows);
  else out.rows = envelope.rows;
  return out;
}

/**
 * Parsed baseline JSON to the in-memory `rows` envelope. Anything that is
 * not a grouped CRAP envelope — another kind, the previous CRAP `rows[]`
 * layout, unparseable junk — is returned unchanged, so an old layout reaches
 * the compat axes rather than a shape error.
 *
 * @param {unknown} parsed
 * @returns {unknown}
 */
export function decodeEnvelope(parsed) {
  if (!isCrapEnvelope(parsed)) return parsed;
  const { files, ...stamps } = parsed;
  if (!files || typeof files !== 'object' || Array.isArray(files)) {
    return parsed;
  }
  return { ...stamps, rows: decodeCrapFiles(files) };
}

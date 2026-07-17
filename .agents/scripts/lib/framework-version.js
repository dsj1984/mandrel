// .agents/scripts/lib/framework-version.js
/**
 * framework-version.js — the visible authoring-marker surface for the legacy
 * ticket-body provenance stamp.
 *
 * Tickets authored under v1 carry a hybrid stamp: a hidden
 * `<!-- meta: {"mandrel_version":"…","authored_at":"…"} -->` block plus a
 * single visible footer line
 * `> 🏷️ Authored with Mandrel v<version> · <YYYY-MM-DD>`. The producer of
 * new stamps was retired with the Epic write surface (#4574) — nothing stamps
 * a new ticket — but bodies already stamped are live in the backlog, so the
 * Story-body serializer/parser must keep round-tripping them:
 *
 * - {@link AUTHORED_MARKER_LINE_RE} lets the parser skip the marker line during
 *   section parsing so it never pollutes the last structured section.
 * - {@link authoredMarkerLine} lets the serializer re-emit a byte-identical
 *   marker line for a stamp it parsed, preserving provenance verbatim.
 *
 * This module imports nothing so it can be pulled in from the story-body
 * serializer without risking an import cycle.
 */

/**
 * The visible authoring marker line. A blockquote so GitHub renders it as a
 * callout. Used in the Story-body parser to skip the line during section
 * parsing so it never pollutes the last structured section.
 */
export const AUTHORED_MARKER_LINE_RE = /^\s*>\s*🏷️\s+Authored with Mandrel\b/;

/**
 * Build the visible authoring marker line for a given stamp. The Story-body
 * serializer uses this to re-emit a legacy stamp it parsed, byte-identically.
 *
 * @param {{ version: string, authoredAt: string }} stamp
 * @returns {string}
 */
export function authoredMarkerLine({ version, authoredAt }) {
  return `> 🏷️ Authored with Mandrel v${version} · ${authoredAt}`;
}

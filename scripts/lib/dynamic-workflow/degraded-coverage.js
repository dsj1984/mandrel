// scripts/lib/dynamic-workflow/degraded-coverage.js
/**
 * Degraded-coverage annotation for audit-lens reports (Story #4783).
 *
 * An audit lens fans out one sub-agent per analysis dimension. When one of
 * those dimensions rejects — a sub-agent that ran out of context, a
 * measurement command that failed, a transient runtime error — the run used to
 * discard every sibling dimension's completed work along with it.
 *
 * The engine now partitions instead: the fulfilled dimensions flow on to
 * synthesis, and the rejected ones are recorded here as an explicit note in
 * the report's Executive Summary. A lens that covers four of five dimensions
 * *and says which one is missing* is strictly more useful than one that yields
 * nothing — but only if the gap is visible. An unannotated partial report is
 * worse than no report, because it reads as complete coverage.
 *
 * The annotation is applied by the engine, not requested of the synthesis
 * agent: a coverage disclaimer that depends on an LLM remembering to write it
 * is not a disclaimer.
 *
 * @module dynamic-workflow/degraded-coverage
 */

/**
 * A dimension that did not complete.
 *
 * @typedef {object} DimensionFailure
 * @property {string} dimension The analysis dimension that failed.
 * @property {string} phase     The phase it failed in (`analyze` / `cross-check`).
 * @property {string} reason    The rejection's message.
 */

/** Matches the Executive Summary heading at any heading level. */
const EXECUTIVE_SUMMARY_HEADING = /^#{1,6}\s+Executive Summary\b/i;

/**
 * Render the degraded-coverage note. Names every failed dimension, the phase
 * it failed in, and the reason, so a reader can tell coverage loss apart from
 * an absence of findings.
 *
 * @param {readonly DimensionFailure[]} failures
 * @param {number} totalDimensions Dimensions the run set out to cover.
 * @returns {string} A markdown blockquote.
 */
function formatDegradedCoverageNote(failures, totalDimensions) {
  const detail = failures
    .map((f) => `**${f.dimension}** (${f.phase}: ${f.reason})`)
    .join('; ');
  const noun = failures.length === 1 ? 'dimension' : 'dimensions';
  return [
    `> ⚠️ **Degraded coverage** — ${failures.length} of ${totalDimensions} analysis ${noun} did not complete`,
    `> and ${failures.length === 1 ? 'is' : 'are'} unrepresented in this report: ${detail}.`,
    '> Findings for the remaining dimensions are complete; the gap above is not evidence of their absence.',
  ].join('\n');
}

/**
 * Annotate a synthesised report with the degraded-coverage note, inserted
 * directly beneath the `## Executive Summary` heading (every lens report
 * contract requires that section). A report without the heading is prefixed
 * instead, so the note can never be silently dropped.
 *
 * Returns the report unchanged when nothing failed — a full-coverage run must
 * not carry a coverage caveat.
 *
 * @param {string} report
 * @param {readonly DimensionFailure[]} failures
 * @param {number} totalDimensions
 * @returns {string}
 */
export function withDegradedCoverageNote(report, failures, totalDimensions) {
  if (!Array.isArray(failures) || failures.length === 0) return report;
  const note = formatDegradedCoverageNote(failures, totalDimensions);
  const lines = String(report).split('\n');
  const headingIndex = lines.findIndex((line) =>
    EXECUTIVE_SUMMARY_HEADING.test(line.trim()),
  );
  if (headingIndex === -1) return `${note}\n\n${report}`;
  lines.splice(headingIndex + 1, 0, '', note);
  return lines.join('\n');
}

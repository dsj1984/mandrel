/**
 * Parse PRD / Tech-Spec / Acceptance-Spec references from a GitHub epic body.
 * Extracted from providers/github.js so link-parsing is not mixed with HTTP
 * transport.
 *
 * Expected markdown conventions in an epic body (case-insensitive, tolerant
 * of the `- [ ]` / `- [x]` checkbox prefix that `epic-plan-spec.js` emits in
 * the `## Planning Artifacts` section):
 *   - "PRD: #42"  or  "prd #42"
 *   - "Tech Spec: #43"  /  "Technical Spec: #43"  /  "tech-spec: #43"
 *   - "Acceptance Spec: #44"  /  "acceptance-spec: #44"  /  "accept spec: #44"
 *
 * Story #2091 added the `acceptanceSpec` slot so the
 * `closePlanningArtifacts()` cascade in `epic-deliver-finalize.js` can close
 * the `context::acceptance-spec` ticket Epic #2001 introduces alongside the
 * existing PRD / Tech-Spec pair.
 *
 * Story #3848: regexes are now scoped to the `## Planning Artifacts` section
 * only. Prose elsewhere in the body (e.g. bundled-follow-up notes that
 * mention a foreign Epic's spec ticket by number) can no longer collide with
 * the machine-managed list items.
 */

const PRD_RE = /(?:PRD|prd)[:\s]+#(\d+)/;
const TECH_SPEC_RE = /(?:Tech Spec|tech.?spec|technical.?spec)[:\s]+#(\d+)/i;
const ACCEPTANCE_SPEC_RE =
  /(?:Acceptance Spec|acceptance.?spec|accept.?spec)[:\s]+#(\d+)/i;

/**
 * Extract the `## Planning Artifacts` section text from an Epic body.
 * Returns the slice from just after the heading line to the next `##`-level
 * heading (exclusive), or to end-of-string when no following heading is
 * present. Returns an empty string when the section is absent.
 *
 * @param {string} body
 * @returns {string}
 */
function extractPlanningArtifactsSection(body) {
  // Step 1: locate the heading.
  const startMatch = body.match(/^##\s+Planning Artifacts[^\n]*/m);
  if (!startMatch) return '';
  // Step 2: slice from just after the heading to the next ## heading (or EOB).
  const afterHeading = body.slice(startMatch.index + startMatch[0].length);
  const nextHeadingMatch = afterHeading.match(/\n##\s/);
  return nextHeadingMatch
    ? afterHeading.slice(0, nextHeadingMatch.index)
    : afterHeading;
}

/**
 * @param {string|null|undefined} body
 * @returns {{ prd: number|null, techSpec: number|null, acceptanceSpec: number|null }}
 */
export function parseLinkedIssues(body) {
  const result = { prd: null, techSpec: null, acceptanceSpec: null };
  if (typeof body !== 'string' || body.length === 0) return result;

  // Scope all regex matching to the canonical Planning Artifacts section so
  // prose references elsewhere in the body do not shadow the machine-managed
  // list items. When the section is absent every slot stays null — the caller
  // (plan-epic.js) treats null as "not yet linked" and creates fresh tickets.
  const section = extractPlanningArtifactsSection(body);
  if (section.length === 0) return result;

  const prdMatch = section.match(PRD_RE);
  if (prdMatch) result.prd = Number.parseInt(prdMatch[1], 10);
  const specMatch = section.match(TECH_SPEC_RE);
  if (specMatch) result.techSpec = Number.parseInt(specMatch[1], 10);
  const acceptanceMatch = section.match(ACCEPTANCE_SPEC_RE);
  if (acceptanceMatch) {
    result.acceptanceSpec = Number.parseInt(acceptanceMatch[1], 10);
  }
  return result;
}

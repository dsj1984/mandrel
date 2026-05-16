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
 */

const PRD_RE = /(?:PRD|prd)[:\s]+#(\d+)/;
const TECH_SPEC_RE = /(?:Tech Spec|tech.?spec|technical.?spec)[:\s]+#(\d+)/i;
const ACCEPTANCE_SPEC_RE =
  /(?:Acceptance Spec|acceptance.?spec|accept.?spec)[:\s]+#(\d+)/i;

/**
 * @param {string|null|undefined} body
 * @returns {{ prd: number|null, techSpec: number|null, acceptanceSpec: number|null }}
 */
export function parseLinkedIssues(body) {
  const result = { prd: null, techSpec: null, acceptanceSpec: null };
  if (typeof body !== 'string' || body.length === 0) return result;
  const prdMatch = body.match(PRD_RE);
  if (prdMatch) result.prd = Number.parseInt(prdMatch[1], 10);
  const specMatch = body.match(TECH_SPEC_RE);
  if (specMatch) result.techSpec = Number.parseInt(specMatch[1], 10);
  const acceptanceMatch = body.match(ACCEPTANCE_SPEC_RE);
  if (acceptanceMatch) {
    result.acceptanceSpec = Number.parseInt(acceptanceMatch[1], 10);
  }
  return result;
}

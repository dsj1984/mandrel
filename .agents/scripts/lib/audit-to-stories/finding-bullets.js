/**
 * Per-finding markdown bullets shared by the standalone Story body and the
 * `/mandrel-plan` seed, so both render a finding's fields identically. Pure.
 */

/** `[label, finding key]` pairs, in the order each surface lists them. */
export const STORY_FINDING_FIELDS = Object.freeze([
  ['Severity', 'severity'],
  ['Location', 'location'],
  ['Current State', 'currentState'],
  ['Recommendation', 'recommendation'],
]);

export const SEED_FINDING_FIELDS = Object.freeze([
  ['Location', 'location'],
  ['Recommendation', 'recommendation'],
  ['Acceptance signal', 'acceptanceSignal'],
]);

/**
 * Parsed fields are already trimmed; an empty or absent one is omitted rather
 * than rendered as a placeholder.
 *
 * @param {object} finding
 * @param {ReadonlyArray<readonly [string, string]>} fields
 * @param {string} [indent='']
 * @returns {string[]} one `- **Label:** value` line per present field.
 */
export function findingBullets(finding, fields, indent = '') {
  return fields
    .filter(([, key]) => finding[key])
    .map(([label, key]) => `${indent}- **${label}:** ${finding[key]}`);
}

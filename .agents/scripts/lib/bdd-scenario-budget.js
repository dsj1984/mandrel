/**
 * Byte cap for the `bddScenarios` plan-envelope field. The scanner stays
 * uncapped (other callers need the full set); the cap lives at the envelope
 * boundary, since a mature corpus can crowd out the whole envelope. A fixed
 * constant, not a config knob: a cap an operator can raise past what the
 * model reads fails silently.
 */

/**
 * One field's share of the 256 KB envelope ceiling: about 70 scenarios.
 * Module-private so it is not a test-only export.
 */
const BDD_SCENARIOS_BYTE_BUDGET = 24_000;

/**
 * Truncate in scan order (never re-sorted) and report what was dropped.
 *
 * @param {Array<object>} scenarios
 * @param {{ byteBudget?: number }} [opts]
 * @returns {{
 *   scenarios: Array<object>,
 *   totalScenarios: number,
 *   includedScenarios: number,
 *   truncated: null | { droppedScenarios: number, note: string },
 * }}
 */
export function capBddScenarios(scenarios, opts = {}) {
  const byteBudget = opts.byteBudget ?? BDD_SCENARIOS_BYTE_BUDGET;
  const list = Array.isArray(scenarios) ? scenarios : [];
  let bytes = 0;
  let cut = list.length;
  for (let i = 0; i < list.length; i += 1) {
    bytes += Buffer.byteLength(JSON.stringify(list[i]), 'utf-8');
    if (bytes > byteBudget) {
      cut = i;
      break;
    }
  }
  return {
    scenarios: list.slice(0, cut),
    totalScenarios: list.length,
    includedScenarios: cut,
    truncated: describeTruncation(list, cut, byteBudget),
  };
}

/**
 * @param {Array<object>} list
 * @param {number} cut
 * @param {number} byteBudget
 * @returns {null | { droppedScenarios: number, note: string }}
 */
function describeTruncation(list, cut, byteBudget) {
  if (cut === list.length) return null;
  return {
    droppedScenarios: list.length - cut,
    note: `bddScenarios cut to ${cut} of ${list.length} scenarios to fit the ${byteBudget}-byte envelope budget`,
  };
}

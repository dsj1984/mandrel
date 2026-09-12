/**
 * bdd-scenario-budget.js — envelope byte budget for the `bddScenarios`
 * `/mandrel-plan` context-envelope field (Story #4977).
 *
 * `bdd-scenario-scanner.js`'s `scanBddScenarios` stays a faithful, uncapped
 * index of the project's `.feature` corpus — that scan is also used
 * directly by `lib/qa/resolve-selection.js`, which needs the full set. The
 * cap belongs at the envelope boundary instead, in its own module: on a
 * consumer with a mature Gherkin corpus, `bddScenarios` grew to 118 KB —
 * larger than `docsContext` and `systemPrompts` combined — consuming
 * nearly the entire `PLAN_CONTEXT_ENVELOPE_BYTE_CEILING` headroom on its
 * own and blocking `/audit-to-stories`' single-plan path entirely.
 *
 * Deliberately a fixed framework constant rather than an `.agentrc.json`
 * knob: Story #4541 retired the one operator-tunable planner-context budget
 * (`planning.context.maxBytes`) because a cap the operator can raise past
 * what the model can read fails silently again, and the same reasoning
 * applies here.
 */

/**
 * Byte budget for the capped `bddScenarios` envelope field. Sized well
 * under `PLAN_CONTEXT_ENVELOPE_BYTE_CEILING` (256 KB) — this is one of
 * several envelope fields, not the whole budget. At the measured ~337
 * bytes/scenario average (Story #4977 evidence, a mature Gherkin corpus),
 * 24 KB holds roughly 70 scenarios before truncating.
 *
 * Deliberately module-private: the only production consumer is
 * {@link capBddScenarios} below via the `opts.byteBudget` default. Tests
 * assert the resulting behavior (truncation, order, fit) rather than
 * importing this value directly, so it carries no public export the
 * `--production` dead-exports ratchet would otherwise flag as test-only.
 */
const BDD_SCENARIOS_BYTE_BUDGET = 24_000;

/**
 * Truncate a scenario index to a byte budget, deterministically (scan
 * order — file walk order, then in-file order — never re-sorted), and
 * report what was dropped rather than truncating silently: `truncated` is
 * `null` when everything fit, else a note naming how many scenarios were
 * cut (Story #5312).
 *
 * @param {Array<object>} scenarios Full scan output (order preserved).
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
 * The `truncated` note: `null` when everything fit, else what was cut.
 *
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

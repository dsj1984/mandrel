import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { capBddScenarios } from '../.agents/scripts/lib/bdd-scenario-budget.js';

/**
 * Story #4977 — `bddScenarios` grew to 118 KB on a consumer with a mature
 * Gherkin corpus, consuming nearly the entire `/mandrel-plan` context-envelope
 * ceiling on its own and blocking `/audit-to-stories`' single-plan path
 * entirely. `capBddScenarios` truncates the scan to a fixed byte budget,
 * deterministically and with the drop reported rather than silent.
 */

function makeScenario(i) {
  return {
    file: `/repo/tests/features/area-${i}.feature`,
    line: i,
    scenarioTitle: `Scenario number ${i} does the thing`,
    tags: ['@area', `@case-${i}`],
    outcomeKeywords: ['thing', 'done', 'result', `keyword${i}`],
  };
}

describe('capBddScenarios — envelope byte budget', () => {
  it('passes an under-budget list through untouched and reports no truncation', () => {
    const scenarios = [makeScenario(1), makeScenario(2), makeScenario(3)];
    const result = capBddScenarios(scenarios);
    assert.deepEqual(result.scenarios, scenarios);
    assert.equal(result.totalScenarios, 3);
    assert.equal(result.includedScenarios, 3);
    assert.equal(result.truncated, null);
  });

  it('truncates a large corpus, preserving scan order, and reports what was dropped', () => {
    // Story #4977 evidence: ~337 bytes/scenario on a mature Gherkin corpus.
    // 500 synthetic scenarios comfortably exceeds the default byte budget.
    const scenarios = Array.from({ length: 500 }, (_, i) => makeScenario(i));
    const result = capBddScenarios(scenarios);

    assert.equal(result.totalScenarios, 500);
    assert.ok(
      result.includedScenarios < 500,
      'expected the oversized corpus to be truncated',
    );
    // Story #5312: the note names what was cut, never a bare boolean.
    assert.equal(
      result.truncated.droppedScenarios,
      500 - result.includedScenarios,
    );
    assert.match(result.truncated.note, /cut to \d+ of 500 scenarios/);
    assert.deepEqual(
      result.scenarios,
      scenarios.slice(0, result.includedScenarios),
      'truncation must preserve scan order (deterministic), not re-sort',
    );
  });

  it('respects an explicit byteBudget override', () => {
    const scenarios = [makeScenario(1), makeScenario(2), makeScenario(3)];
    const result = capBddScenarios(scenarios, { byteBudget: 1 });
    assert.equal(result.includedScenarios, 0);
    assert.equal(result.truncated.droppedScenarios, 3);
    assert.match(result.truncated.note, /1-byte envelope budget/);
    assert.deepEqual(result.scenarios, []);
  });

  it("treats a non-array input as empty, matching the scanner's empty-corpus contract", () => {
    const result = capBddScenarios(undefined);
    assert.deepEqual(result, {
      scenarios: [],
      totalScenarios: 0,
      includedScenarios: 0,
      truncated: null,
    });
  });

  it('keeps the capped output a small fraction of the /mandrel-plan envelope ceiling', async () => {
    // Story #4977: the cap must leave the envelope's other fixed-floor
    // fields (docsContext, systemPrompts) their historical headroom rather
    // than merely resetting the countdown at a new, still-dominant size.
    // Measured against the actual capped output (not the internal budget
    // constant, which is module-private) so this stays a behavioral
    // assertion rather than an implementation-detail import.
    const { PLAN_CONTEXT_ENVELOPE_BYTE_CEILING } = await import(
      '../.agents/scripts/lib/orchestration/plan-context.js'
    );
    const scenarios = Array.from({ length: 1000 }, (_, i) => makeScenario(i));
    const result = capBddScenarios(scenarios);
    const cappedBytes = Buffer.byteLength(
      JSON.stringify(result.scenarios),
      'utf-8',
    );
    assert.ok(
      cappedBytes <= PLAN_CONTEXT_ENVELOPE_BYTE_CEILING * 0.15,
      `capped bddScenarios (${cappedBytes}B) must stay a small fraction of the envelope ceiling`,
    );
  });
});

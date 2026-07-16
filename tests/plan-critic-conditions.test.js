/**
 * plan-critic-conditions.test.js — table-driven condition matrix for the
 * #4474 PR6 conditional-critic dispatch layer:
 *
 *   - consolidation (8.3): precondition AND (>5 stories OR confirmed
 *     divergence) — a fail-open precondition on a small draft skips;
 *   - pre-mortem (8.5): ticket count ≥ ½ maxTickets, OR a
 *     planning.riskHeuristics phrase match (case-insensitive). Story #4542
 *     retired the third condition — the authored risk verdict's overall level —
 *     with the verdict itself, so both surviving conditions read the plan's own
 *     observable shape and text;
 *   - the additive `cause` field on the underlying consolidation
 *     precondition ('match' | 'divergence' | 'fail-open').
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { evaluateConsolidationPrecondition } from '../.agents/scripts/lib/orchestration/consolidation-precondition.js';
import {
  CONSOLIDATION_STORY_THRESHOLD,
  evaluateConsolidationDispatch,
  evaluatePremortemDispatch,
} from '../.agents/scripts/lib/orchestration/plan-critic-conditions.js';

/** Build a minimal draft story. */
function story(slug, dependsOn = []) {
  return { slug, depends_on: dependsOn, body: `## Goal\n${slug}.` };
}

/** Build a Delivery Slicing table matching `stories` 1:1. */
function slicingTableFor(stories) {
  const rows = stories.map(
    (s) =>
      `| ${s.slug} | ships ${s.slug} | ${s.depends_on.length > 0 ? 'No' : 'Yes'} |`,
  );
  return [
    '## Delivery Slicing',
    '',
    '| Slice | What ships | Independent? |',
    '| --- | --- | --- |',
    ...rows,
  ].join('\n');
}

function stories(n, { chained = false } = {}) {
  return Array.from({ length: n }, (_, i) =>
    story(`s${i + 1}`, chained && i > 0 ? [`s${i}`] : []),
  );
}

describe('consolidation precondition — additive cause field', () => {
  it("reports 'match' on a 1:1 draft", () => {
    const draft = stories(3);
    const result = evaluateConsolidationPrecondition({
      draftStories: draft,
      epicBody: slicingTableFor(draft),
    });
    assert.equal(result.dispatch, false);
    assert.equal(result.cause, 'match');
  });

  it("reports 'divergence' on a count mismatch", () => {
    const result = evaluateConsolidationPrecondition({
      draftStories: stories(4),
      epicBody: slicingTableFor(stories(3)),
    });
    assert.equal(result.dispatch, true);
    assert.equal(result.cause, 'divergence');
  });

  it("reports 'divergence' on a dependency-shape mismatch", () => {
    const draft = stories(2, { chained: true });
    const result = evaluateConsolidationPrecondition({
      draftStories: draft,
      // Table says every slice is independent; s2 declares depends_on.
      epicBody: slicingTableFor(stories(2)),
    });
    assert.equal(result.dispatch, true);
    assert.equal(result.cause, 'divergence');
  });

  it("reports 'fail-open' when the table is missing", () => {
    const result = evaluateConsolidationPrecondition({
      draftStories: stories(2),
      epicBody: '## Context\nNo slicing table here.',
    });
    assert.equal(result.dispatch, true);
    assert.equal(result.cause, 'fail-open');
  });
});

describe('consolidation dispatch — condition matrix (PR6)', () => {
  it('pins the design §6 size threshold at 5 stories', () => {
    assert.equal(CONSOLIDATION_STORY_THRESHOLD, 5);
  });

  const smallMatched = stories(3);
  const largeMatched = stories(7);
  const noTable = '## Context\nNo slicing table.';

  const matrix = [
    {
      name: '1:1 match, small draft → skip (precondition wins)',
      draft: smallMatched,
      spec: slicingTableFor(smallMatched),
      dispatch: false,
    },
    {
      name: '1:1 match, large draft (>5) → still skip (precondition is an AND)',
      draft: largeMatched,
      spec: slicingTableFor(largeMatched),
      dispatch: false,
    },
    {
      name: 'confirmed divergence, small draft → dispatch',
      draft: stories(4),
      spec: slicingTableFor(stories(3)),
      dispatch: true,
    },
    {
      name: 'confirmed divergence, large draft → dispatch',
      draft: stories(8),
      spec: slicingTableFor(stories(3)),
      dispatch: true,
    },
    {
      name: 'fail-open (no table), small draft (≤5) → skip',
      draft: stories(5),
      spec: noTable,
      dispatch: false,
    },
    {
      name: 'fail-open (no table), large draft (>5) → dispatch',
      draft: stories(6),
      spec: noTable,
      dispatch: true,
    },
    {
      name: 'dependency-shape divergence, small draft → dispatch',
      draft: stories(2, { chained: true }),
      spec: slicingTableFor(stories(2)),
      dispatch: true,
    },
  ];

  for (const row of matrix) {
    it(row.name, () => {
      const decision = evaluateConsolidationDispatch({
        draftStories: row.draft,
        specText: row.spec,
      });
      assert.equal(decision.critic, 'consolidation');
      assert.equal(decision.dispatch, row.dispatch);
      assert.ok(
        decision.reasons.length > 0,
        'every decision carries at least one reason (the skip audit trail)',
      );
    });
  }
});

describe('pre-mortem dispatch — condition matrix (PR6)', () => {
  const matrix = [
    {
      name: 'no condition fires → skip',
      input: {
        ticketCount: 3,
        maxTickets: 80,
      },
      dispatch: false,
    },
    {
      // Story #4542: with the verdict gone, a small plan touching an obviously
      // sensitive surface fires ONLY if a configured heuristic phrase catches
      // it — the planner can no longer self-assert its way into (or out of) the
      // critic. This is the regression guard for that intent.
      name: 'a small plan with no heuristic match → skip, whatever it claims',
      input: {
        ticketCount: 1,
        maxTickets: 80,
        planText: 'This plan is extremely high risk, honestly.',
      },
      dispatch: false,
    },
    {
      name: 'ticket count exactly half maxTickets → dispatch (boundary)',
      input: {
        ticketCount: 40,
        maxTickets: 80,
      },
      dispatch: true,
      reasonMatch: /at least half the reviewability budget/i,
    },
    {
      name: 'odd budget: ceil boundary (5 of 10 fires, 4 of 9 skips)',
      input: {
        ticketCount: 4,
        maxTickets: 9,
      },
      dispatch: false,
    },
    {
      name: 'odd budget: 5 of 9 fires',
      input: {
        ticketCount: 5,
        maxTickets: 9,
      },
      dispatch: true,
    },
    {
      name: 'one under the half-budget boundary → skip',
      input: {
        ticketCount: 39,
        maxTickets: 80,
      },
      dispatch: false,
    },
    {
      name: 'risk-heuristic phrase match (case-insensitive) → dispatch',
      input: {
        ticketCount: 2,
        maxTickets: 80,
        riskHeuristics: ['Destructive Schema Migration'],
        planText: 'This plan includes a destructive schema migration step.',
      },
      dispatch: true,
      reasonMatch: /riskHeuristics match/i,
    },
    {
      name: 'heuristic configured but absent from the plan text → skip',
      input: {
        ticketCount: 2,
        maxTickets: 80,
        riskHeuristics: ['billing'],
        planText: 'Nothing risky in here.',
      },
      dispatch: false,
    },
    {
      name: 'both conditions at once → dispatch with both reasons',
      input: {
        ticketCount: 40,
        maxTickets: 80,
        riskHeuristics: ['auth'],
        planText: 'Touches the auth boundary.',
      },
      dispatch: true,
      minReasons: 2,
    },
  ];

  for (const row of matrix) {
    it(row.name, () => {
      const decision = evaluatePremortemDispatch(row.input);
      assert.equal(decision.critic, 'pre-mortem');
      assert.equal(decision.dispatch, row.dispatch);
      assert.ok(decision.reasons.length > 0, 'reasons are never empty');
      if (row.reasonMatch) {
        assert.ok(
          decision.reasons.some((r) => row.reasonMatch.test(r)),
          `expected a reason matching ${row.reasonMatch}: ${JSON.stringify(decision.reasons)}`,
        );
      }
      if (row.minReasons) {
        assert.ok(
          decision.reasons.length >= row.minReasons,
          `expected ≥ ${row.minReasons} reasons, got ${decision.reasons.length}`,
        );
      }
    });
  }

  it('rejects a non-positive maxTickets', () => {
    assert.throws(
      () =>
        evaluatePremortemDispatch({
          ticketCount: 1,
          maxTickets: 0,
        }),
      TypeError,
    );
  });
});

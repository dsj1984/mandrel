/**
 * tests/scripts/plan-persist.summary.test.js
 *
 * Unit coverage for the `plan-summary` comment body.
 *
 * Story #4542 retired the risk/routing receipts this file used to pin (the
 * `- Risk: <level> · <gateDecision> (review routing: …)` line and the
 * acceptance auto-waiver line, #4496 fix 2). Nothing computes a risk level, a
 * gate decision, or an acceptance disposition at plan time any more, so
 * printing one would document a mechanism that does not run — the regression
 * guard below asserts exactly that. `--force-review` is the one review gate the
 * planner still carries, and the summary reports it as an explicit operator
 * receipt.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildPlanSummaryCommentBody } from '../../.agents/scripts/lib/orchestration/plan-persist/summary.js';

const BASE = {
  epicId: 4242,
  ticketCount: 2,
  freshness: { stale: 0, ambiguous: 0 },
  healthcheck: { ok: true },
  waveTable: [
    { wave: 0, stories: [{ slug: 'a', title: 'A' }] },
    { wave: 1, stories: [{ slug: 'b', title: 'B' }] },
  ],
};

describe('plan-summary — review receipt (Story #4542)', () => {
  it('reports an operator-forced review stop', () => {
    const body = buildPlanSummaryCommentBody({ ...BASE, forceReview: true });
    const line = body.split('\n').find((l) => l.startsWith('- ⚠️ Review:'));
    assert.ok(line, `expected a review line:\n${body}`);
    assert.match(line, /--force-review/);
  });

  it('says nothing about review when the operator did not force one', () => {
    for (const args of [{ ...BASE }, { ...BASE, forceReview: false }]) {
      const body = buildPlanSummaryCommentBody(args);
      assert.doesNotMatch(body, /Review:/);
    }
  });

  it('never reports a risk level, gate decision, or acceptance disposition', () => {
    // The retired chain's receipts. Persist derives none of them, so the
    // summary must not claim any — a stale line here is exactly the
    // "documents a mechanism that does not run" defect #4542 removed.
    const body = buildPlanSummaryCommentBody({ ...BASE, forceReview: true });
    assert.doesNotMatch(body, /- Risk:/);
    assert.doesNotMatch(body, /gateDecision|review routing/i);
    assert.doesNotMatch(body, /acceptance disposition/i);
    assert.doesNotMatch(body, /auto-waived/i);
  });
});

describe('plan summary — names the exact deliver command (Story #4540)', () => {
  const base = {
    epicId: 101,
    ticketCount: 1,
    freshness: {},
    healthcheck: {},
    waveTable: [],
  };

  it('prints the literal ids for a multi-Story plan', () => {
    // This comment is posted to GitHub on every plan run, so it is the
    // operator's primary instruction. It used to end with
    // "/deliver --run <planRunId> (N>1)" — a flag that no longer exists —
    // and to claim "Plan-run: single Story (default)" even for N=3.
    const body = buildPlanSummaryCommentBody({
      ...base,
      ticketCount: 3,
      stories: [
        { id: 4540, slug: 'a' },
        { id: 4541, slug: 'b' },
        { id: 4542, slug: 'c' },
      ],
    });
    assert.match(body, /\/deliver 4540 4541 4542/);
  });

  it('never advertises the retired --run flag or a plan-run label', () => {
    const body = buildPlanSummaryCommentBody({
      ...base,
      stories: [{ id: 4540, slug: 'a' }],
    });
    assert.doesNotMatch(body, /--run/);
    assert.doesNotMatch(body, /plan-run/i);
    assert.doesNotMatch(body, /Plan-run: single Story/);
    assert.match(body, /\/deliver 4540/);
  });

  it('falls back to a generic form when no story ids are supplied', () => {
    const body = buildPlanSummaryCommentBody(base);
    assert.match(body, /\/deliver <storyId>/);
    assert.doesNotMatch(body, /--run/);
  });
});

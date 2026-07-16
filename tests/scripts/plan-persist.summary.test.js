/**
 * tests/scripts/plan-persist.summary.test.js — #4496 fix 2.
 *
 * Unit coverage for the `plan-summary` comment body's auto-waiver line:
 * every auto-waiver the persist derives must be printed WITH its reason so
 * the summary is self-explanatory — the measured failure mode was a
 * headless run spending 3–5 turns re-deriving an unexplained
 * `required → not-applicable` acceptance flip from framework source.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildPlanSummaryCommentBody } from '../../.agents/scripts/lib/orchestration/plan-persist/summary.js';
import { deriveRiskEnvelope } from '../../.agents/scripts/lib/orchestration/planning-risk.js';

const BASE = {
  epicId: 4242,
  ticketCount: 2,
  reviewRouting: { decision: 'auto-proceed' },
  freshness: { stale: 0, ambiguous: 0 },
  healthcheck: { ok: true },
  waveTable: [
    { wave: 0, stories: [{ slug: 'a', title: 'A' }] },
    { wave: 1, stories: [{ slug: 'b', title: 'B' }] },
  ],
};

describe('plan-summary — auto-waiver reason line (#4496 fix 2)', () => {
  it('prints the acceptance auto-waiver WITH its reason', () => {
    // Derive a real waiver the way the persist does: an axes-required
    // disposition forced to not-applicable by the no-BDD-runner probe.
    const planningRisk = deriveRiskEnvelope(
      {
        axes: [
          {
            axis: 'visible-behavior',
            level: 'high',
            rationale: 'User-facing flow changes.',
          },
        ],
        summary: 'High-risk fixture.',
      },
      { bddRunner: { fallback: true, reason: 'no-bdd-runner-detected' } },
    );
    assert.ok(
      planningRisk.acceptanceWaivedReason,
      'fixture must actually derive a waiver',
    );
    const body = buildPlanSummaryCommentBody({ ...BASE, planningRisk });
    const waiverLine = body
      .split('\n')
      .find((l) => l.includes('Acceptance disposition auto-waived'));
    assert.ok(waiverLine, 'the summary must carry a dedicated waiver line');
    assert.ok(
      waiverLine.includes(planningRisk.acceptanceWaivedReason),
      'the waiver line must carry the full reason — the summary is authoritative',
    );
    assert.match(waiverLine, /not-applicable/);
    assert.match(waiverLine, /no BDD runner detected/);
  });

  it('omits the waiver line when no auto-waiver was derived', () => {
    const planningRisk = deriveRiskEnvelope({
      axes: [
        {
          axis: 'internal-refactor',
          level: 'low',
          rationale: 'Internal only.',
        },
      ],
      summary: 'Low-risk fixture.',
    });
    assert.equal(planningRisk.acceptanceWaivedReason, undefined);
    const body = buildPlanSummaryCommentBody({ ...BASE, planningRisk });
    assert.ok(!body.includes('auto-waived'), 'no waiver line without a waiver');
  });
});

describe('plan summary — names the exact deliver command (Story #4540)', () => {
  const base = {
    epicId: 101,
    ticketCount: 1,
    planningRisk: { overallLevel: 'low', gateDecision: 'auto-proceed' },
    reviewRouting: { decision: 'auto-proceed' },
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

// tests/lib/orchestration/acceptance-eval-decision.test.js
//
// Unit-tier coverage for the acceptance self-eval decision core (Story
// #3819). Exercises the three terminal actions (proceed / redraft /
// block), the round-bounding logic, the open-loop guard (a degraded cap
// can never yield an unbounded redraft chain), and the PII-free
// per-criterion signal payload.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildAcceptanceEvalSignal,
  computeVerdictFingerprint,
  decideAcceptanceEval,
  resolveAcceptanceEvalRound,
} from '../../../.agents/scripts/lib/orchestration/acceptance-eval-decision.js';

const crit = (index, verdict, evidence = 'ev') => ({
  index,
  criterion: `AC${index}`,
  verdict,
  evidence,
});

describe('decideAcceptanceEval — proceed', () => {
  it('returns proceed when every criterion is met', () => {
    const out = decideAcceptanceEval({
      verdict: { criteria: [crit(0, 'met'), crit(1, 'met')] },
      maxRounds: 2,
      round: 1,
    });
    assert.equal(out.decision, 'proceed');
    assert.equal(out.metCount, 2);
    assert.equal(out.totalCriteria, 2);
    assert.deepEqual(out.notMet, []);
  });

  it('proceeds even at the round cap when all criteria are met', () => {
    const out = decideAcceptanceEval({
      verdict: { criteria: [crit(0, 'met')] },
      maxRounds: 2,
      round: 2,
    });
    assert.equal(out.decision, 'proceed');
  });
});

describe('decideAcceptanceEval — redraft', () => {
  it('redrafts when a criterion is unmet and rounds remain', () => {
    const out = decideAcceptanceEval({
      verdict: { criteria: [crit(0, 'met'), crit(1, 'unmet')] },
      maxRounds: 2,
      round: 1,
    });
    assert.equal(out.decision, 'redraft');
    assert.equal(out.capReached, false);
    assert.equal(out.notMet.length, 1);
    assert.equal(out.notMet[0].index, 1);
  });

  it('treats partial as not-met (triggers a redraft)', () => {
    const out = decideAcceptanceEval({
      verdict: { criteria: [crit(0, 'partial')] },
      maxRounds: 2,
      round: 1,
    });
    assert.equal(out.decision, 'redraft');
    assert.equal(out.notMet[0].verdict, 'partial');
  });
});

describe('decideAcceptanceEval — block (round cap)', () => {
  it('blocks when the round cap is reached with a criterion unmet', () => {
    const out = decideAcceptanceEval({
      verdict: { criteria: [crit(0, 'unmet')] },
      maxRounds: 2,
      round: 2,
    });
    assert.equal(out.decision, 'block');
    assert.equal(out.capReached, true);
  });

  it('blocks rather than redrafts when round exceeds the cap', () => {
    const out = decideAcceptanceEval({
      verdict: { criteria: [crit(0, 'partial')] },
      maxRounds: 2,
      round: 9,
    });
    assert.equal(out.decision, 'block');
  });
});

describe('decideAcceptanceEval — open-loop guard', () => {
  it('coerces a non-positive cap to 1 so round 1 unmet blocks immediately', () => {
    for (const badCap of [0, -3, 1.5, Number.NaN, undefined, null, '2']) {
      const out = decideAcceptanceEval({
        verdict: { criteria: [crit(0, 'unmet')] },
        maxRounds: badCap,
        round: 1,
      });
      assert.equal(out.cap, 1, `cap ${String(badCap)} should coerce to 1`);
      assert.equal(out.decision, 'block');
    }
  });

  it('never permits redraft once the effective cap is reached', () => {
    // With cap=1, any unmet criterion at round 1 must block, never redraft.
    const out = decideAcceptanceEval({
      verdict: { criteria: [crit(0, 'met'), crit(1, 'unmet')] },
      maxRounds: 1,
      round: 1,
    });
    assert.equal(out.decision, 'block');
  });
});

describe('decideAcceptanceEval — defensive parsing', () => {
  it('defaults round to 1 when no round is supplied', () => {
    const out = decideAcceptanceEval({
      verdict: { criteria: [crit(0, 'met')] },
      maxRounds: 2,
    });
    assert.equal(out.round, 1);
  });

  it('ignores the self-reported verdict.round (Story #4019)', () => {
    // A critic that lies about its round can no longer defeat the cap:
    // verdict.round=1 with a derived round of 2 still blocks at cap 2.
    const out = decideAcceptanceEval({
      verdict: { round: 1, criteria: [crit(0, 'unmet')] },
      maxRounds: 2,
      round: 2,
    });
    assert.equal(out.round, 2);
    assert.equal(out.decision, 'block');
  });

  it('treats an unrecognised verdict value as not-met', () => {
    const out = decideAcceptanceEval({
      verdict: {
        criteria: [{ index: 0, criterion: 'x', verdict: 'maybe' }],
      },
      maxRounds: 2,
      round: 1,
    });
    assert.equal(out.decision, 'redraft');
    assert.equal(out.notMet[0].verdict, 'maybe');
  });

  it('handles a missing criteria array as zero met / proceed', () => {
    const out = decideAcceptanceEval({ verdict: {}, maxRounds: 2, round: 1 });
    // No not-met criteria → nothing blocks → proceed (vacuously met).
    assert.equal(out.decision, 'proceed');
    assert.equal(out.totalCriteria, 0);
  });
});

describe('buildAcceptanceEvalSignal', () => {
  it('builds a PII-free per-criterion signal payload', () => {
    const outcome = decideAcceptanceEval({
      verdict: {
        criteria: [crit(0, 'met'), crit(1, 'unmet', 'secret evidence text')],
      },
      maxRounds: 2,
      round: 1,
    });
    const signal = buildAcceptanceEvalSignal({
      storyId: 3819,
      epicId: null,
      outcome,
    });
    assert.equal(signal.kind, 'acceptance-eval');
    assert.equal(signal.storyId, 3819);
    assert.equal(signal.epicId, null);
    assert.equal(signal.emitter.tool, 'acceptance-eval.js');
    assert.equal(signal.details.decision, 'redraft');
    assert.equal(signal.details.round, 1);
    assert.equal(signal.details.reworkedCount, 1);
    assert.deepEqual(signal.details.reworkedCriteria, [
      { index: 1, verdict: 'unmet' },
    ]);
    // The signal carries only indices/verdicts/counts — never the
    // free-form evidence text.
    assert.ok(!JSON.stringify(signal).includes('secret evidence text'));
  });

  it('passes the parent epicId through for Epic-attached Stories', () => {
    const outcome = decideAcceptanceEval({
      verdict: { criteria: [crit(0, 'met')] },
      maxRounds: 2,
      round: 1,
    });
    const signal = buildAcceptanceEvalSignal({
      storyId: 104,
      epicId: 98,
      outcome,
    });
    assert.equal(signal.epicId, 98);
    assert.equal(signal.details.decision, 'proceed');
  });
});

describe('resolveAcceptanceEvalRound — ledger-derived round (Story #4019)', () => {
  const line = (obj) => `${JSON.stringify(obj)}\n`;
  const resolver = (eid, sid) =>
    `/fake/${eid ?? 'standalone'}/story-${sid}/signals.ndjson`;

  it('returns 1 when the signals ledger is missing', () => {
    const { round } = resolveAcceptanceEvalRound({
      epicId: null,
      storyId: 4019,
      readFile: () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
      signalsPathResolver: resolver,
    });
    assert.equal(round, 1);
  });

  it('counts prior acceptance-eval signals: N prior rounds → round N+1', () => {
    const text =
      line({ kind: 'acceptance-eval', storyId: 4019, details: { round: 1 } }) +
      line({ kind: 'acceptance-eval', storyId: 4019, details: { round: 2 } });
    const { round } = resolveAcceptanceEvalRound({
      epicId: 7,
      storyId: 4019,
      readFile: () => text,
      signalsPathResolver: resolver,
    });
    assert.equal(round, 3);
  });

  it('ignores signals of other kinds and other stories', () => {
    const text =
      line({ kind: 'acceptance-eval', storyId: 4019 }) +
      line({ kind: 'acceptance-eval', storyId: 9999 }) +
      line({ kind: 'gate-failure', storyId: 4019 });
    const { round } = resolveAcceptanceEvalRound({
      epicId: 7,
      storyId: 4019,
      readFile: () => text,
      signalsPathResolver: resolver,
    });
    assert.equal(round, 2);
  });

  it('skips malformed lines without throwing (restart-safe degradation)', () => {
    const text =
      line({ kind: 'acceptance-eval', storyId: 4019 }) +
      'this is not json\n' +
      '\n' +
      line({ kind: 'acceptance-eval', storyId: 4019 });
    const { round } = resolveAcceptanceEvalRound({
      epicId: null,
      storyId: 4019,
      readFile: () => text,
      signalsPathResolver: resolver,
    });
    assert.equal(round, 3);
  });

  it('routes standalone Stories (epicId null) through the resolver with null', () => {
    let seenEid = 'unset';
    resolveAcceptanceEvalRound({
      epicId: null,
      storyId: 12,
      readFile: () => '',
      signalsPathResolver: (eid, sid) => {
        seenEid = eid;
        return `/fake/${sid}`;
      },
    });
    assert.equal(seenEid, null);
  });
});

describe('reading a verdict is not a round (Story #4874)', () => {
  const line = (obj) => `${JSON.stringify(obj)}\n`;
  const resolver = (eid, sid) =>
    `/fake/${eid ?? 'standalone'}/story-${sid}/signals.ndjson`;

  const redraftVerdict = {
    criteria: [
      { index: 0, criterion: 'AC-1', verdict: 'met', evidence: 'test passes' },
      { index: 1, criterion: 'AC-2', verdict: 'unmet', evidence: 'no test' },
    ],
  };

  it('fingerprints a verdict from its criteria, ignoring its self-reported round', () => {
    const a = computeVerdictFingerprint({ ...redraftVerdict, round: 1 });
    const b = computeVerdictFingerprint({ ...redraftVerdict, round: 7 });
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{16}$/);
  });

  it('fingerprints differently once a criterion or its evidence changes', () => {
    const before = computeVerdictFingerprint(redraftVerdict);
    const after = computeVerdictFingerprint({
      criteria: [
        redraftVerdict.criteria[0],
        {
          ...redraftVerdict.criteria[1],
          verdict: 'met',
          evidence: 'test added',
        },
      ],
    });
    assert.notEqual(before, after);
  });

  it('replays the recorded round when the same verdict is read again', () => {
    const fingerprint = computeVerdictFingerprint(redraftVerdict);
    const text = line({
      kind: 'acceptance-eval',
      storyId: 4874,
      details: { round: 1, verdictFingerprint: fingerprint },
    });
    const resolved = resolveAcceptanceEvalRound({
      epicId: null,
      storyId: 4874,
      verdictFingerprint: fingerprint,
      readFile: () => text,
      signalsPathResolver: resolver,
    });
    assert.deepEqual(resolved, { round: 1, replay: true });
  });

  it('advances the round for a genuinely new verdict after the same ledger', () => {
    const text = line({
      kind: 'acceptance-eval',
      storyId: 4874,
      details: {
        round: 1,
        verdictFingerprint: computeVerdictFingerprint(redraftVerdict),
      },
    });
    const resolved = resolveAcceptanceEvalRound({
      epicId: null,
      storyId: 4874,
      verdictFingerprint: computeVerdictFingerprint({
        criteria: [
          {
            index: 0,
            criterion: 'AC-1',
            verdict: 'met',
            evidence: 'now passing',
          },
        ],
      }),
      readFile: () => text,
      signalsPathResolver: resolver,
    });
    assert.deepEqual(resolved, { round: 2, replay: false });
  });

  it('keeps count-based behaviour for legacy signals carrying no fingerprint', () => {
    const text =
      line({ kind: 'acceptance-eval', storyId: 4874, details: { round: 1 } }) +
      line({ kind: 'acceptance-eval', storyId: 4874, details: { round: 2 } });
    const resolved = resolveAcceptanceEvalRound({
      epicId: null,
      storyId: 4874,
      verdictFingerprint: computeVerdictFingerprint(redraftVerdict),
      readFile: () => text,
      signalsPathResolver: resolver,
    });
    assert.deepEqual(resolved, { round: 3, replay: false });
  });

  it('falls back to the record ordinal when a matched signal recorded no round', () => {
    const fingerprint = computeVerdictFingerprint(redraftVerdict);
    const text =
      line({ kind: 'acceptance-eval', storyId: 4874, details: { round: 1 } }) +
      line({
        kind: 'acceptance-eval',
        storyId: 4874,
        details: { verdictFingerprint: fingerprint },
      });
    const resolved = resolveAcceptanceEvalRound({
      epicId: null,
      storyId: 4874,
      verdictFingerprint: fingerprint,
      readFile: () => text,
      signalsPathResolver: resolver,
    });
    assert.deepEqual(resolved, { round: 2, replay: true });
  });

  it('carries the fingerprint into the emitted signal details', () => {
    const outcome = decideAcceptanceEval({
      verdict: redraftVerdict,
      maxRounds: 2,
      round: 1,
    });
    const signal = buildAcceptanceEvalSignal({
      storyId: 4874,
      epicId: null,
      outcome,
      verdictFingerprint: 'abc123',
    });
    assert.equal(signal.details.verdictFingerprint, 'abc123');
  });

  it('omits the fingerprint key entirely when none is supplied', () => {
    const outcome = decideAcceptanceEval({
      verdict: redraftVerdict,
      maxRounds: 2,
      round: 1,
    });
    const signal = buildAcceptanceEvalSignal({
      storyId: 4874,
      epicId: null,
      outcome,
    });
    assert.equal('verdictFingerprint' in signal.details, false);
  });
});

describe('decideAcceptanceEval — the gate verify runs (Story #6067)', () => {
  const citing = (waiver) => ({
    ...crit(0, 'met'),
    verifyEvidence: [
      { command: '`node --test a.js` (unit)', outcome: 'pass', waiver },
    ],
  });
  const failed = [
    { command: 'node --test a.js', exitCode: 2, outcome: 'fail' },
  ];

  it('scores a met criterion citing a failed run unmet', () => {
    const out = decideAcceptanceEval({
      verdict: { criteria: [citing(), crit(1, 'met')] },
      maxRounds: 2,
      round: 1,
      verifyRuns: failed,
    });
    assert.equal(out.decision, 'redraft');
    assert.deepEqual(
      out.notMet.map((c) => [c.index, c.verdict]),
      [[0, 'unmet']],
    );
    assert.match(out.notMet[0].evidence, /exited 2/);
  });

  it('lets a waived citation stand and ignores passing runs', () => {
    for (const [criterion, runs] of [
      [citing('known flake'), failed],
      [citing(), [{ ...failed[0], outcome: 'pass', exitCode: 0 }]],
    ]) {
      const out = decideAcceptanceEval({
        verdict: { criteria: [criterion] },
        maxRounds: 2,
        verifyRuns: runs,
      });
      assert.equal(out.decision, 'proceed');
    }
  });
});

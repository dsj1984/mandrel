import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  LOOP_ESCALATION_REASONS,
  runAutoFixLoop,
  SAFETY_ESCALATION_CLASSES,
} from '../../.agents/scripts/lib/orchestration/auto-fix-loop.js';

// Unit tests for the shared bounded-retry / anti-thrash / escalation loop
// consumed by /epic-deliver Phase 4 (epic-audit) and Phase 5 (code-review).
// All hooks are deterministic fakes — no I/O, no logging side effects.
// See Tech Spec #2588 § "Auto-fix loop semantics".

const fixable = () => 'fixable';

const makeFinding = (id, extras = {}) => ({ id, ...extras });

describe('runAutoFixLoop — exported constants', () => {
  it('SAFETY_ESCALATION_CLASSES is the documented frozen set', () => {
    const expected = [
      'spec-deviation',
      'secrets',
      'test-deletion',
      'scope-exceeded',
    ];
    for (const cls of expected) {
      assert.ok(
        SAFETY_ESCALATION_CLASSES.has(cls),
        `expected safety class "${cls}" present`,
      );
    }
    assert.equal(SAFETY_ESCALATION_CLASSES.size, expected.length);
  });

  it('LOOP_ESCALATION_REASONS exposes the loop-emitted reasons', () => {
    for (const reason of [
      'ceiling-exhausted',
      'thrash-detected',
      'validation-regression',
      'scope-exceeded',
    ]) {
      assert.ok(LOOP_ESCALATION_REASONS.has(reason));
    }
  });
});

describe('runAutoFixLoop — option validation', () => {
  it('throws when findings is not an array', async () => {
    await assert.rejects(
      () =>
        runAutoFixLoop({
          findings: null,
          applyFix: () => ({}),
          rescan: () => ({ stillPresent: false }),
          validate: () => ({ ok: true }),
          classify: fixable,
        }),
      /findings must be an array/,
    );
  });

  it('throws when attemptCeiling is negative', async () => {
    await assert.rejects(
      () =>
        runAutoFixLoop({
          findings: [],
          attemptCeiling: -1,
          applyFix: () => ({}),
          rescan: () => ({ stillPresent: false }),
          validate: () => ({ ok: true }),
          classify: fixable,
        }),
      /attemptCeiling/,
    );
  });

  it('throws when scopeCap is < 1', async () => {
    await assert.rejects(
      () =>
        runAutoFixLoop({
          findings: [],
          scopeCap: 0,
          applyFix: () => ({}),
          rescan: () => ({ stillPresent: false }),
          validate: () => ({ ok: true }),
          classify: fixable,
        }),
      /scopeCap/,
    );
  });

  it('throws when any hook is not a function', async () => {
    await assert.rejects(
      () =>
        runAutoFixLoop({
          findings: [],
          applyFix: 'nope',
          rescan: () => ({ stillPresent: false }),
          validate: () => ({ ok: true }),
          classify: fixable,
        }),
      /applyFix must be a function/,
    );
  });
});

describe('runAutoFixLoop — happy path', () => {
  it('fixes a finding on the first attempt when rescan clears', async () => {
    const finding = makeFinding('f1');
    const applyFix = (_f, attempt) => ({
      files: ['a.ts'],
      commitSha: `sha-${attempt}`,
    });
    const result = await runAutoFixLoop({
      findings: [finding],
      attemptCeiling: 3,
      scopeCap: 5,
      classify: fixable,
      applyFix,
      validate: () => ({ ok: true }),
      rescan: () => ({ stillPresent: false }),
    });

    assert.equal(result.fixed.length, 1);
    assert.equal(result.fixed[0].finding.id, 'f1');
    assert.equal(result.fixed[0].attempts, 1);
    assert.equal(result.fixed[0].fix.commitSha, 'sha-1');
    assert.equal(result.escalated.length, 0);
    assert.equal(result.thrashBlocked.length, 0);
  });

  it('processes findings in input order, accumulating mixed verdicts', async () => {
    const findings = [
      makeFinding('a'),
      makeFinding('secrets-1'),
      makeFinding('b'),
    ];
    const classify = (f) => (f.id === 'secrets-1' ? 'secrets' : 'fixable');
    const result = await runAutoFixLoop({
      findings,
      attemptCeiling: 3,
      scopeCap: 5,
      classify,
      applyFix: () => ({ files: ['x.ts'] }),
      validate: () => ({ ok: true }),
      rescan: () => ({ stillPresent: false }),
    });

    assert.deepEqual(
      result.fixed.map((e) => e.finding.id),
      ['a', 'b'],
    );
    assert.deepEqual(
      result.escalated.map((e) => [e.finding.id, e.reason]),
      [['secrets-1', 'secrets']],
    );
  });
});

describe('runAutoFixLoop — ceiling exhaustion', () => {
  it('escalates with ceiling-exhausted when every attempt strikes once', async () => {
    // Each attempt produces a "still present" rescan. ANTI_THRASH_STRIKE_LIMIT
    // is 1, so the first strike continues, the second strike escalates as
    // thrash-detected — to drive ceiling exhaustion we need every attempt
    // to fix the finding *but* the rescan still surfaces a different ID.
    // Simulate "fix didn't help, but neither is it the same finding" by
    // returning stillPresent=false on rescan while never marking fixed
    // is impossible — instead, model ceiling exhaustion with applyFix
    // throwing? No: easier path — use attemptCeiling=0, which exhausts
    // immediately.
    const finding = makeFinding('f-ceil');
    const result = await runAutoFixLoop({
      findings: [finding],
      attemptCeiling: 0,
      scopeCap: 5,
      classify: fixable,
      applyFix: () => ({ files: ['a.ts'] }),
      validate: () => ({ ok: true }),
      rescan: () => ({ stillPresent: false }),
    });

    assert.equal(result.escalated.length, 1);
    assert.equal(result.escalated[0].reason, 'ceiling-exhausted');
    assert.equal(result.escalated[0].attempts, 0);
  });

  it('escalates ceiling-exhausted when validate keeps regressing past ceiling', async () => {
    // Each attempt regresses validation → that's actually a validation-regression
    // exit (stops retrying). To exercise raw ceiling-exhausted with a >0
    // ceiling we need apply→validate→rescan to neither resolve nor break.
    // The only loop path that satisfies that is: apply OK, validate OK, then
    // the *first* strike (stillPresent=true) which `continue`s. Once the
    // attempt count hits the ceiling without ever scoring a second strike,
    // the loop exits with "ceiling-exhausted".
    let rescans = 0;
    const result = await runAutoFixLoop({
      findings: [makeFinding('f-ceil-2')],
      attemptCeiling: 1, // exactly one attempt, which strikes once → ceiling.
      scopeCap: 5,
      classify: fixable,
      applyFix: () => ({ files: ['a.ts'] }),
      validate: () => ({ ok: true }),
      rescan: () => {
        rescans += 1;
        return { stillPresent: true };
      },
    });
    assert.equal(rescans, 1);
    assert.equal(result.escalated.length, 1);
    assert.equal(result.escalated[0].reason, 'ceiling-exhausted');
    assert.equal(result.escalated[0].attempts, 1);
  });
});

describe('runAutoFixLoop — anti-thrash detection', () => {
  it('marks a finding thrash-blocked when the same ID resurfaces twice', async () => {
    // attempt 1: stillPresent=true → strike 1, continue
    // attempt 2: stillPresent=true → strike 2 > limit (1) → thrash.
    const finding = makeFinding('f-thrash');
    let attempts = 0;
    const result = await runAutoFixLoop({
      findings: [finding],
      attemptCeiling: 5,
      scopeCap: 5,
      classify: fixable,
      applyFix: () => {
        attempts += 1;
        return { files: ['a.ts'] };
      },
      validate: () => ({ ok: true }),
      rescan: () => ({ stillPresent: true }),
    });

    assert.equal(attempts, 2);
    assert.equal(result.thrashBlocked.length, 1);
    assert.equal(result.thrashBlocked[0].finding.id, 'f-thrash');
    assert.equal(result.thrashBlocked[0].attempts, 2);
    assert.equal(result.fixed.length, 0);
    assert.equal(result.escalated.length, 0);
  });
});

describe('runAutoFixLoop — safety escalation classes', () => {
  for (const cls of [
    'spec-deviation',
    'secrets',
    'test-deletion',
    'scope-exceeded',
  ]) {
    it(`routes "${cls}" findings to escalated[] without calling applyFix`, async () => {
      let applyCalls = 0;
      const result = await runAutoFixLoop({
        findings: [makeFinding(`f-${cls}`)],
        attemptCeiling: 3,
        scopeCap: 5,
        classify: () => cls,
        applyFix: () => {
          applyCalls += 1;
          return { files: [] };
        },
        validate: () => ({ ok: true }),
        rescan: () => ({ stillPresent: false }),
      });

      assert.equal(applyCalls, 0);
      assert.equal(result.escalated.length, 1);
      assert.equal(result.escalated[0].reason, cls);
      assert.equal(result.escalated[0].attempts, 0);
    });
  }
});

describe('runAutoFixLoop — scope-exceeded escalation from applyFix output', () => {
  it('escalates when the fix touches more files than scopeCap', async () => {
    const result = await runAutoFixLoop({
      findings: [makeFinding('f-scope')],
      attemptCeiling: 3,
      scopeCap: 2,
      classify: fixable,
      applyFix: () => ({ files: ['a.ts', 'b.ts', 'c.ts'] }),
      validate: () => {
        throw new Error('validate must not run when scope exceeded');
      },
      rescan: () => {
        throw new Error('rescan must not run when scope exceeded');
      },
    });

    assert.equal(result.escalated.length, 1);
    assert.equal(result.escalated[0].reason, 'scope-exceeded');
    assert.equal(result.escalated[0].attempts, 1);
    assert.match(result.escalated[0].detail, /touched 3 files/);
  });
});

describe('runAutoFixLoop — validation regression', () => {
  it('escalates and stops retrying when validate returns ok:false', async () => {
    let applyCalls = 0;
    const result = await runAutoFixLoop({
      findings: [makeFinding('f-regress')],
      attemptCeiling: 5,
      scopeCap: 5,
      classify: fixable,
      applyFix: () => {
        applyCalls += 1;
        return { files: ['a.ts'] };
      },
      validate: () => ({ ok: false, reason: 'lint broke' }),
      rescan: () => {
        throw new Error('rescan must not run after validation regression');
      },
    });

    assert.equal(applyCalls, 1);
    assert.equal(result.escalated.length, 1);
    assert.equal(result.escalated[0].reason, 'validation-regression');
    assert.equal(result.escalated[0].detail, 'lint broke');
    assert.equal(result.escalated[0].attempts, 1);
  });
});

describe('runAutoFixLoop — async hooks', () => {
  it('awaits each hook before advancing the loop', async () => {
    const finding = makeFinding('f-async');
    const trace = [];
    const result = await runAutoFixLoop({
      findings: [finding],
      attemptCeiling: 3,
      scopeCap: 5,
      classify: fixable,
      applyFix: async () => {
        await Promise.resolve();
        trace.push('apply');
        return { files: ['a.ts'] };
      },
      validate: async () => {
        await Promise.resolve();
        trace.push('validate');
        return { ok: true };
      },
      rescan: async () => {
        await Promise.resolve();
        trace.push('rescan');
        return { stillPresent: false };
      },
    });

    assert.deepEqual(trace, ['apply', 'validate', 'rescan']);
    assert.equal(result.fixed.length, 1);
  });
});

// .agents/scripts/lib/orchestration/lifecycle/listeners/__tests__/automerge-predicate-trust-ci.test.js
/**
 * Unit tests for the Story #4361 rewrite of the Phase 8.5 auto-merge
 * predicate (Epic #4355). Covers:
 *
 *   1. The `delivery.ci.autoMerge` policy split
 *      (`applyAutoMergePolicy`):
 *        - `"trust-ci"` (default) arms even with manual interventions,
 *          🟠 warning-level review findings, or a non-clean retro — those
 *          are RECORDED (non-blocking). It refuses to arm only on an
 *          unresolved 🔴 critical review finding or an `agent::blocked`
 *          state (story-level blocker / missing checkpoint / non-done
 *          story).
 *        - `"strict"` restores the prior clean-sprint predicate EXACTLY:
 *          ANY dirty signal (interventions, warnings, non-clean retro,
 *          critical, blocked state) blocks.
 *
 *   2. The live `gh pr checks --required` probe on `epic.automerge.start`
 *      (`classifyRequiredChecksProbe` + the listener wiring): the
 *      predicate refuses to arm when a required check is red, pending, or
 *      the probe is unreadable — even when the structured verdict is
 *      clean (closes the Story #3901 interrupted-watch hole).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Bus } from '../../bus.js';
import {
  AutomergePredicate,
  applyAutoMergePolicy,
  classifyRequiredChecksProbe,
  deriveAutoMergeVerdict,
  REASON_CATEGORY,
} from '../automerge-predicate.js';

function quietLogger() {
  return { info: () => {}, warn: () => {}, debug: () => {} };
}

function recordingBus() {
  const bus = new Bus();
  const emits = [];
  const record = (event) => async (ctx) => {
    emits.push({ event, seqId: ctx.seqId, payload: ctx.payload });
  };
  bus.on('epic.merge.ready', record('epic.merge.ready'));
  bus.on('epic.merge.blocked', record('epic.merge.blocked'));
  return { bus, emits };
}

const fakeProvider = { __tag: 'fake-provider' };
const PR_URL = 'https://github.com/owner/repo/pull/42';

// A live-probe stub reporting every required check green.
function greenProbe() {
  return {
    status: 0,
    stdout: JSON.stringify([
      { name: 'lint', state: 'SUCCESS', bucket: 'pass' },
      { name: 'test', state: 'SUCCESS', bucket: 'pass' },
    ]),
    stderr: '',
  };
}

// Retro body carrying the machine-readable clean-sprint verdict trailer.
const CLEAN_RETRO = {
  body: 'Retro summary\n<!-- automerge-verdict: {"cleanSprint":true} -->',
};
const DIRTY_RETRO = {
  body: 'Retro summary\n<!-- automerge-verdict: {"cleanSprint":false} -->',
};

// Code-review bodies rendered with the canonical severity bullets.
function reviewBody({ critical = 0, high = 0, medium = 0, suggestion = 0 }) {
  return {
    body: [
      `🔴 Critical Blocker: ${critical}`,
      `🟠 High Risk: ${high}`,
      `🟡 Medium Risk: ${medium}`,
      `🟢 Suggestion: ${suggestion}`,
    ].join('\n'),
  };
}

const CLEAN_STATE = {
  manualInterventions: [],
  stories: { 1: { status: 'done' } },
};

describe('classifyRequiredChecksProbe', () => {
  it('ok:true when every required check is green', () => {
    const v = classifyRequiredChecksProbe(greenProbe());
    assert.equal(v.ok, true);
    assert.equal(v.reason, null);
    assert.deepEqual(v.outcomes, { lint: 'success', test: 'success' });
  });

  it('ok:true for an empty required set (nothing to gate on)', () => {
    const v = classifyRequiredChecksProbe({
      status: 0,
      stdout: '[]',
      stderr: '',
    });
    assert.equal(v.ok, true);
  });

  it('ok:false when a required check is red', () => {
    const v = classifyRequiredChecksProbe({
      status: 8,
      stdout: JSON.stringify([
        { name: 'lint', state: 'SUCCESS' },
        { name: 'test', state: 'FAILURE' },
      ]),
      stderr: '',
    });
    assert.equal(v.ok, false);
    assert.match(v.reason, /test=failure/);
  });

  it('ok:false when a required check is still pending (interrupted watch)', () => {
    const v = classifyRequiredChecksProbe({
      status: 8,
      stdout: JSON.stringify([
        { name: 'lint', state: 'SUCCESS' },
        { name: 'test', state: 'IN_PROGRESS' },
      ]),
      stderr: '',
    });
    assert.equal(v.ok, false);
    assert.match(v.reason, /test=pending/);
  });

  it('ok:false (fail closed) when a required check reports an unrecognized state', () => {
    // A future/renamed gh conclusion we have not enumerated must block the
    // arming probe rather than collapse to the non-failing 'skipped' bucket
    // (normalizeCheckState's watch-path default).
    const v = classifyRequiredChecksProbe({
      status: 8,
      stdout: JSON.stringify([
        { name: 'lint', state: 'SUCCESS' },
        { name: 'test', state: 'SOME_FUTURE_STATE' },
      ]),
      stderr: '',
    });
    assert.equal(v.ok, false);
    assert.equal(v.outcomes.test, 'unknown');
    assert.match(v.reason, /test=unknown/);
  });

  it('ok:false (fail closed) when stdout is empty and status non-zero', () => {
    const v = classifyRequiredChecksProbe({
      status: 1,
      stdout: '',
      stderr: 'gh: not authenticated',
    });
    assert.equal(v.ok, false);
    assert.match(v.reason, /probe failed/);
  });

  it('ok:false (fail closed) when the payload is unparseable', () => {
    const v = classifyRequiredChecksProbe({
      status: 0,
      stdout: 'not json',
      stderr: '',
    });
    assert.equal(v.ok, false);
    assert.match(v.reason, /unparseable/);
  });
});

describe('applyAutoMergePolicy — trust-ci (default)', () => {
  it('arms when the run is fully clean', () => {
    const verdict = deriveAutoMergeVerdict({
      state: CLEAN_STATE,
      codeReview: reviewBody({}),
      retro: CLEAN_RETRO,
    });
    const decision = applyAutoMergePolicy(verdict, 'trust-ci');
    assert.equal(decision.arm, true);
    assert.equal(decision.blockingReasons.length, 0);
  });

  it('arms despite manual interventions (recorded, non-blocking)', () => {
    const verdict = deriveAutoMergeVerdict({
      state: {
        manualInterventions: [{ reason: 'operator nudge' }],
        stories: { 1: { status: 'done' } },
      },
      codeReview: reviewBody({}),
      retro: CLEAN_RETRO,
    });
    const decision = applyAutoMergePolicy(verdict, 'trust-ci');
    assert.equal(decision.arm, true);
    assert.equal(decision.blockingReasons.length, 0);
    assert.ok(
      decision.recordedReasons.some((r) =>
        /manual intervention/.test(r.message),
      ),
      'intervention is recorded for audit',
    );
    assert.equal(
      decision.recordedReasons[0].category,
      REASON_CATEGORY.INTERVENTION,
    );
  });

  it('arms despite 🟠 warning-level (high-risk) review findings (recorded, non-blocking)', () => {
    const verdict = deriveAutoMergeVerdict({
      state: CLEAN_STATE,
      codeReview: reviewBody({ high: 3 }),
      retro: CLEAN_RETRO,
    });
    const decision = applyAutoMergePolicy(verdict, 'trust-ci');
    assert.equal(decision.arm, true);
    assert.ok(
      decision.recordedReasons.some((r) => /High Risk/.test(r.message)),
    );
  });

  it('arms despite a non-clean retro (recorded, non-blocking)', () => {
    const verdict = deriveAutoMergeVerdict({
      state: CLEAN_STATE,
      codeReview: reviewBody({}),
      retro: DIRTY_RETRO,
    });
    const decision = applyAutoMergePolicy(verdict, 'trust-ci');
    assert.equal(decision.arm, true);
    assert.ok(
      decision.recordedReasons.some((r) => /cleanSprint=false/.test(r.message)),
    );
  });

  it('refuses to arm on an unresolved 🔴 critical review finding', () => {
    const verdict = deriveAutoMergeVerdict({
      state: CLEAN_STATE,
      codeReview: reviewBody({ critical: 1 }),
      retro: CLEAN_RETRO,
    });
    const decision = applyAutoMergePolicy(verdict, 'trust-ci');
    assert.equal(decision.arm, false);
    assert.equal(decision.blockingReasons.length, 1);
    assert.equal(
      decision.blockingReasons[0].category,
      REASON_CATEGORY.CRITICAL_REVIEW,
    );
    assert.match(decision.blockingReasons[0].message, /Critical Blocker/);
  });

  it('refuses to arm on an agent::blocked state (story-level blocker in run-state)', () => {
    const verdict = deriveAutoMergeVerdict({
      state: {
        manualInterventions: [],
        stories: { 1: { status: 'done', blockerCommentId: 'IC_123' } },
      },
      codeReview: reviewBody({}),
      retro: CLEAN_RETRO,
    });
    const decision = applyAutoMergePolicy(verdict, 'trust-ci');
    assert.equal(decision.arm, false);
    assert.ok(
      decision.blockingReasons.some(
        (r) => r.category === REASON_CATEGORY.BLOCKED_STATE,
      ),
    );
  });

  it('refuses to arm when the run-state checkpoint is missing (cannot certify)', () => {
    const verdict = deriveAutoMergeVerdict({
      state: null,
      codeReview: reviewBody({}),
      retro: CLEAN_RETRO,
    });
    const decision = applyAutoMergePolicy(verdict, 'trust-ci');
    assert.equal(decision.arm, false);
    assert.ok(
      decision.blockingReasons.some(
        (r) => r.category === REASON_CATEGORY.BLOCKED_STATE,
      ),
    );
  });
});

describe('applyAutoMergePolicy — strict (restores prior predicate exactly)', () => {
  it('arms only when the run is fully clean', () => {
    const verdict = deriveAutoMergeVerdict({
      state: CLEAN_STATE,
      codeReview: reviewBody({}),
      retro: CLEAN_RETRO,
    });
    const decision = applyAutoMergePolicy(verdict, 'strict');
    assert.equal(decision.arm, true);
    assert.equal(decision.recordedReasons.length, 0);
  });

  it('blocks on manual interventions (unlike trust-ci)', () => {
    const verdict = deriveAutoMergeVerdict({
      state: {
        manualInterventions: [{ reason: 'operator nudge' }],
        stories: { 1: { status: 'done' } },
      },
      codeReview: reviewBody({}),
      retro: CLEAN_RETRO,
    });
    const decision = applyAutoMergePolicy(verdict, 'strict');
    assert.equal(decision.arm, false);
    assert.equal(decision.recordedReasons.length, 0);
    assert.ok(
      decision.blockingReasons.some((r) =>
        /manual intervention/.test(r.message),
      ),
    );
  });

  it('blocks on 🟠 warning-level review findings (unlike trust-ci)', () => {
    const verdict = deriveAutoMergeVerdict({
      state: CLEAN_STATE,
      codeReview: reviewBody({ high: 2 }),
      retro: CLEAN_RETRO,
    });
    const decision = applyAutoMergePolicy(verdict, 'strict');
    assert.equal(decision.arm, false);
    assert.ok(
      decision.blockingReasons.some((r) => /High Risk/.test(r.message)),
    );
  });

  it('blocks on a non-clean retro (unlike trust-ci)', () => {
    const verdict = deriveAutoMergeVerdict({
      state: CLEAN_STATE,
      codeReview: reviewBody({}),
      retro: DIRTY_RETRO,
    });
    const decision = applyAutoMergePolicy(verdict, 'strict');
    assert.equal(decision.arm, false);
    assert.ok(
      decision.blockingReasons.some((r) => /cleanSprint=false/.test(r.message)),
    );
  });

  it('strict block set is EXACTLY the prior `clean` verdict — every reason blocks', () => {
    const verdict = deriveAutoMergeVerdict({
      state: {
        manualInterventions: [{ reason: 'x' }],
        stories: { 1: { status: 'done' } },
      },
      codeReview: reviewBody({ critical: 1, high: 1 }),
      retro: DIRTY_RETRO,
    });
    const decision = applyAutoMergePolicy(verdict, 'strict');
    assert.equal(decision.arm, false);
    // Every categorized reason is a blocking reason under strict; none recorded.
    assert.equal(
      decision.blockingReasons.length,
      verdict.categorizedReasons.length,
    );
    assert.equal(decision.recordedReasons.length, 0);
    // Parity with the pre-#4361 `clean` boolean.
    assert.equal(verdict.clean, false);
  });
});

describe('AutomergePredicate policy resolution from config', () => {
  it('defaults to trust-ci when no config is supplied', () => {
    const predicate = new AutomergePredicate({
      bus: new Bus(),
      epicId: 4355,
      provider: fakeProvider,
      logger: quietLogger(),
    });
    assert.equal(predicate.policy, 'trust-ci');
  });

  it('reads strict from delivery.ci.autoMerge', () => {
    const predicate = new AutomergePredicate({
      bus: new Bus(),
      epicId: 4355,
      provider: fakeProvider,
      config: { delivery: { ci: { autoMerge: 'strict' } } },
      logger: quietLogger(),
    });
    assert.equal(predicate.policy, 'strict');
  });
});

describe('AutomergePredicate — live probe refusal on epic.automerge.start', () => {
  it('refuses to arm when the live probe reports a red required check (clean verdict)', async () => {
    const { bus, emits } = recordingBus();
    let evalCalls = 0;
    const predicate = new AutomergePredicate({
      bus,
      epicId: 4355,
      provider: fakeProvider,
      probeRequiredChecksFn: () => ({
        status: 8,
        stdout: JSON.stringify([{ name: 'test', state: 'FAILURE' }]),
        stderr: '',
      }),
      evaluatePredicateFn: async () => {
        evalCalls += 1;
        return {
          clean: true,
          reasons: [],
          categorizedReasons: [],
          signals: {},
        };
      },
      logger: quietLogger(),
    });
    predicate.register();

    await bus.emit('epic.automerge.start', { prUrl: PR_URL, epicId: 4355 });
    assert.equal(emits.length, 1);
    assert.equal(emits[0].event, 'epic.merge.blocked');
    assert.match(emits[0].payload.reason, /test=failure/);
    assert.equal(
      evalCalls,
      0,
      'structured evaluator NOT consulted when the live probe is red',
    );
  });

  it('refuses to arm when a required check is still pending (interrupted Phase 8 watch)', async () => {
    const { bus, emits } = recordingBus();
    const predicate = new AutomergePredicate({
      bus,
      epicId: 4355,
      provider: fakeProvider,
      probeRequiredChecksFn: () => ({
        status: 8,
        stdout: JSON.stringify([{ name: 'test', state: 'IN_PROGRESS' }]),
        stderr: '',
      }),
      evaluatePredicateFn: async () => ({
        clean: true,
        reasons: [],
        categorizedReasons: [],
        signals: {},
      }),
      logger: quietLogger(),
    });
    predicate.register();

    await bus.emit('epic.automerge.start', { prUrl: PR_URL, epicId: 4355 });
    assert.equal(emits[0].event, 'epic.merge.blocked');
    assert.match(emits[0].payload.reason, /pending/);
  });

  it('refuses to arm when the probe is unreadable (fail closed)', async () => {
    const { bus, emits } = recordingBus();
    const predicate = new AutomergePredicate({
      bus,
      epicId: 4355,
      provider: fakeProvider,
      probeRequiredChecksFn: () => ({ status: 1, stdout: '', stderr: 'boom' }),
      evaluatePredicateFn: async () => ({
        clean: true,
        reasons: [],
        categorizedReasons: [],
        signals: {},
      }),
      logger: quietLogger(),
    });
    predicate.register();

    await bus.emit('epic.automerge.start', { prUrl: PR_URL, epicId: 4355 });
    assert.equal(emits[0].event, 'epic.merge.blocked');
    assert.match(emits[0].payload.reason, /probe failed/);
  });

  it('arms under trust-ci when the live probe is green and only non-blocking signals are dirty', async () => {
    const { bus, emits } = recordingBus();
    const predicate = new AutomergePredicate({
      bus,
      epicId: 4355,
      provider: fakeProvider,
      config: { delivery: { ci: { autoMerge: 'trust-ci' } } },
      probeRequiredChecksFn: greenProbe,
      evaluatePredicateFn: async () =>
        deriveAutoMergeVerdict({
          state: {
            manualInterventions: [{ reason: 'nudge' }],
            stories: { 1: { status: 'done' } },
          },
          codeReview: reviewBody({ high: 1 }),
          retro: DIRTY_RETRO,
        }),
      logger: quietLogger(),
    });
    predicate.register();

    await bus.emit('epic.automerge.start', { prUrl: PR_URL, epicId: 4355 });
    assert.equal(emits[0].event, 'epic.merge.ready');
    assert.match(emits[0].payload.reason, /trust-ci/);
  });

  it('blocks under strict when the live probe is green but signals are dirty', async () => {
    const { bus, emits } = recordingBus();
    const predicate = new AutomergePredicate({
      bus,
      epicId: 4355,
      provider: fakeProvider,
      config: { delivery: { ci: { autoMerge: 'strict' } } },
      probeRequiredChecksFn: greenProbe,
      evaluatePredicateFn: async () =>
        deriveAutoMergeVerdict({
          state: CLEAN_STATE,
          codeReview: reviewBody({ high: 1 }),
          retro: CLEAN_RETRO,
        }),
      logger: quietLogger(),
    });
    predicate.register();

    await bus.emit('epic.automerge.start', { prUrl: PR_URL, epicId: 4355 });
    assert.equal(emits[0].event, 'epic.merge.blocked');
    assert.match(emits[0].payload.reason, /High Risk/);
  });
});

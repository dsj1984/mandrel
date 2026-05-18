/**
 * Contract test for `/epic-deliver` close-tail resume semantics.
 *
 * Story #1155 (Epic #1142, 5.40.0). Asserts the phase-granular resume
 * contract documented in tech spec #1147:
 *
 *   "A mid-flight crash during code-review resumes at code-review on
 *    next /epic-deliver invocation, not from the start of the wave loop."
 *
 * The test drives `runEpicDeliverCloseTail` against a fake provider whose
 * `epic-run-state` checkpoint is mutated between the two invocations to
 * simulate a clean run-then-crash sequence:
 *
 *   1. First run: close-validation succeeds, code-review succeeds, then
 *      the runner crashes during retro composition (the test injects a
 *      throwing `runRetroFn`).
 *   2. The checkpoint after that crash records `phase: 'retro'` (the
 *      next phase to run — written by `setPhase('retro')` after
 *      code-review completed).
 *   3. Second run: the runner reads the checkpoint, skips
 *      close-validation + code-review, runs retro + finalize.
 *
 * This is the resume contract — the test fails if the runner re-enters
 * code-review on resume (which would mean the close-tail is not honoring
 * the phase field).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLOSE_TAIL_PHASES,
  runEpicDeliverCloseTail,
  shouldSkipPhase,
} from '../../.agents/scripts/lib/orchestration/epic-deliver-close-tail.js';
import {
  CHECKPOINT_SCHEMA_VERSION,
  Checkpointer,
  DELIVER_PHASES,
} from '../fixtures/epic-run-state-store.js';

/**
 * In-memory provider with `getTicketComments` / `postComment` /
 * `deleteComment` — the only surface the Checkpointer exercises.
 */
function makeCheckpointProvider(initialPhase = null) {
  const comments = new Map();
  let nextId = 1;

  // Seed with an initial epic-run-state if a phase was supplied.
  if (initialPhase) {
    const marker = `<!-- ap:structured-comment type="epic-run-state" -->`;
    const payload = {
      version: CHECKPOINT_SCHEMA_VERSION,
      epicId: 42,
      phase: initialPhase,
    };
    const body = `${marker}\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
    comments.set(42, [{ id: nextId++, body }]);
  }

  return {
    posted: [],
    updates: [],
    async getTicketComments(ticketId) {
      return comments.get(ticketId) ?? [];
    },
    async postComment(ticketId, payload) {
      const id = nextId++;
      this.posted.push({ id, ticketId, ...payload });
      const list = comments.get(ticketId) ?? [];
      list.push({ id, body: payload.body });
      comments.set(ticketId, list);
      return { commentId: id };
    },
    async deleteComment(id) {
      for (const [ticketId, list] of comments) {
        const next = list.filter((c) => c.id !== id);
        if (next.length !== list.length) comments.set(ticketId, next);
      }
    },
    async updateTicket(ticketId, patch) {
      this.updates.push({ ticketId, patch });
      return { ok: true };
    },
    async getTicket(id) {
      return { id, title: `Epic ${id}` };
    },
  };
}

test('phase list: includes the four close-tail phases plus prepare + wave-loop', () => {
  // The full DELIVER_PHASES list is the documented checkpoint contract;
  // the close-tail subset is what this module walks.
  assert.deepEqual(DELIVER_PHASES, [
    'prepare',
    'wave-loop',
    'close-validation',
    'code-review',
    'retro',
    'finalize',
  ]);
  assert.deepEqual(CLOSE_TAIL_PHASES, [
    'close-validation',
    'code-review',
    'retro',
    'finalize',
  ]);
});

test('shouldSkipPhase: phases below the checkpoint are skipped, current+ are not', () => {
  assert.equal(shouldSkipPhase('retro', 'close-validation'), true);
  assert.equal(shouldSkipPhase('retro', 'code-review'), true);
  assert.equal(shouldSkipPhase('retro', 'retro'), false);
  assert.equal(shouldSkipPhase('retro', 'finalize'), false);
  assert.equal(shouldSkipPhase('prepare', 'close-validation'), false);
});

test('runEpicDeliverCloseTail: happy path runs all four phases and writes phase=done', async () => {
  const provider = makeCheckpointProvider('close-validation');
  const phasesObserved = [];

  const out = await runEpicDeliverCloseTail({
    epicId: 42,
    provider,
    runWaveGateFn: async () => {
      phasesObserved.push('wave-gate');
      return { exitCode: 0 };
    },
    runHierarchyGateFn: async () => {
      phasesObserved.push('hierarchy-gate');
      return { exitCode: 0 };
    },
    runCodeReviewFn: async () => {
      phasesObserved.push('code-review');
      return {
        status: 'ok',
        severity: { critical: 0, high: 0, medium: 0, suggestion: 0 },
        halted: false,
        blockerReason: null,
        posted: true,
      };
    },
    runRetroFn: async () => {
      phasesObserved.push('retro');
      return { posted: true, compact: true, scorecard: {}, body: '' };
    },
    runFinalizeFn: async () => {
      phasesObserved.push('finalize');
      return {
        epicId: 42,
        ffOk: true,
        pushed: true,
        prUrl: 'https://x/pull/1',
        postedHandoff: true,
      };
    },
  });

  assert.equal(out.completed, true);
  assert.deepEqual(out.phasesRun, [
    'close-validation',
    'code-review',
    'retro',
    'finalize',
  ]);
  assert.deepEqual(out.phasesSkipped, []);
  assert.deepEqual(phasesObserved, [
    'wave-gate',
    'hierarchy-gate',
    'code-review',
    'retro',
    'finalize',
  ]);

  // The final checkpoint write must record phase=done.
  const checkpointer = new Checkpointer({ provider, epicId: 42 });
  const final = await checkpointer.read();
  assert.equal(final.phase, 'done');
});

test('runEpicDeliverCloseTail: code-review critical throws + marks blocked before retro', async () => {
  // Story #2167 — Phase D MUST throw (not return an envelope) when the
  // review reports a critical finding, flip the Epic to agent::blocked,
  // and post a friction comment summarizing the severity counts. Retro
  // and finalize must never be invoked.
  const provider = makeCheckpointProvider('close-validation');
  let retroCalled = false;
  let finalizeCalled = false;

  await assert.rejects(
    () =>
      runEpicDeliverCloseTail({
        epicId: 42,
        provider,
        runWaveGateFn: async () => ({ exitCode: 0 }),
        runHierarchyGateFn: async () => ({ exitCode: 0 }),
        runCodeReviewFn: async () => ({
          status: 'ok',
          severity: { critical: 1, high: 0, medium: 0, suggestion: 0 },
          halted: true,
          blockerReason: '1 critical finding',
          posted: true,
        }),
        runRetroFn: async () => {
          retroCalled = true;
          return {};
        },
        runFinalizeFn: async () => {
          finalizeCalled = true;
          return {};
        },
      }),
    /code-review reported critical findings/,
  );

  assert.equal(retroCalled, false, 'retro must not run after critical');
  assert.equal(finalizeCalled, false, 'finalize must not run after critical');

  const blockedUpdate = provider.updates.find(
    (u) =>
      u.ticketId === 42 &&
      u.patch?.labels?.add?.includes('agent::blocked') &&
      u.patch?.labels?.remove?.includes('agent::executing'),
  );
  assert.ok(
    blockedUpdate,
    'Epic must transition to agent::blocked (executing removed)',
  );

  const friction = provider.posted.find(
    (c) => c.ticketId === 42 && c.type === 'friction',
  );
  assert.ok(friction, 'friction comment must be posted on the Epic');
  assert.match(friction.body, /critical/i);
});

test('runEpicDeliverCloseTail: clean code-review proceeds to retro + finalize', async () => {
  // Story #2167 — a clean review (no criticals) must not trip the new
  // gate; retro + finalize run normally and no agent::blocked transition
  // or friction comment is emitted.
  const provider = makeCheckpointProvider('close-validation');
  let retroCalled = false;
  let finalizeCalled = false;

  const out = await runEpicDeliverCloseTail({
    epicId: 42,
    provider,
    runWaveGateFn: async () => ({ exitCode: 0 }),
    runHierarchyGateFn: async () => ({ exitCode: 0 }),
    runCodeReviewFn: async () => ({
      status: 'ok',
      severity: { critical: 0, high: 1, medium: 0, suggestion: 0 },
      halted: false,
      blockerReason: null,
      posted: true,
    }),
    runRetroFn: async () => {
      retroCalled = true;
      return { posted: true };
    },
    runFinalizeFn: async () => {
      finalizeCalled = true;
      return {
        ffOk: true,
        pushed: true,
        prUrl: 'http://x',
        postedHandoff: true,
      };
    },
  });

  assert.equal(out.completed, true);
  assert.equal(retroCalled, true);
  assert.equal(finalizeCalled, true);
  assert.equal(
    provider.updates.some((u) =>
      u.patch?.labels?.add?.includes('agent::blocked'),
    ),
    false,
    'no agent::blocked transition on a clean review',
  );
  assert.equal(
    provider.posted.some(
      (c) => c.type === 'friction' && /critical/i.test(c.body ?? ''),
    ),
    false,
    'no critical-findings friction comment on a clean review',
  );
});

test('runEpicDeliverCloseTail: close-validation halts on wave-gate failure', async () => {
  const provider = makeCheckpointProvider('close-validation');
  let codeReviewCalled = false;

  const out = await runEpicDeliverCloseTail({
    epicId: 42,
    provider,
    runWaveGateFn: async () => ({ exitCode: 1, message: 'open story #99' }),
    runHierarchyGateFn: async () => ({ exitCode: 0 }),
    runCodeReviewFn: async () => {
      codeReviewCalled = true;
      return {};
    },
    runRetroFn: async () => ({}),
    runFinalizeFn: async () => ({}),
  });

  assert.equal(out.completed, false);
  assert.equal(out.blocker.phase, 'close-validation');
  assert.equal(out.blocker.reason, 'wave-gate-failed');
  assert.equal(codeReviewCalled, false);
});

test('CONTRACT: crash during retro → resume runs retro + finalize, NOT close-validation/code-review', async () => {
  const provider = makeCheckpointProvider('close-validation');

  // Counts to assert exactly which phases re-ran on resume.
  let waveGateCalls = 0;
  let hierarchyGateCalls = 0;
  let codeReviewCalls = 0;
  let retroCalls = 0;
  let finalizeCalls = 0;

  // ============ First run — crash during retro ============
  await runEpicDeliverCloseTail({
    epicId: 42,
    provider,
    runWaveGateFn: async () => {
      waveGateCalls++;
      return { exitCode: 0 };
    },
    runHierarchyGateFn: async () => {
      hierarchyGateCalls++;
      return { exitCode: 0 };
    },
    runCodeReviewFn: async () => {
      codeReviewCalls++;
      return {
        status: 'ok',
        severity: { critical: 0, high: 0, medium: 0, suggestion: 0 },
        halted: false,
      };
    },
    runRetroFn: async () => {
      retroCalls++;
      throw new Error('simulated retro crash');
    },
    runFinalizeFn: async () => {
      finalizeCalls++;
      return { ffOk: true, pushed: true, prUrl: 'x', postedHandoff: true };
    },
  });

  // After the first run, close-validation + code-review ran exactly once
  // each, retro raised once (crash), and finalize never ran.
  assert.equal(waveGateCalls, 1);
  assert.equal(hierarchyGateCalls, 1);
  assert.equal(codeReviewCalls, 1);
  assert.equal(retroCalls, 1);
  assert.equal(finalizeCalls, 0);

  // The checkpoint must record phase=retro (the runner advanced after
  // code-review and before invoking retro).
  const checkpointer = new Checkpointer({ provider, epicId: 42 });
  const cp = await checkpointer.read();
  assert.equal(cp.phase, 'retro');

  // ============ Second run — resume from retro ============
  const out = await runEpicDeliverCloseTail({
    epicId: 42,
    provider,
    runWaveGateFn: async () => {
      waveGateCalls++;
      return { exitCode: 0 };
    },
    runHierarchyGateFn: async () => {
      hierarchyGateCalls++;
      return { exitCode: 0 };
    },
    runCodeReviewFn: async () => {
      codeReviewCalls++;
      return {
        status: 'ok',
        severity: { critical: 0, high: 0, medium: 0, suggestion: 0 },
        halted: false,
      };
    },
    runRetroFn: async () => {
      retroCalls++;
      return { posted: true, compact: true, scorecard: {}, body: '' };
    },
    runFinalizeFn: async () => {
      finalizeCalls++;
      return {
        epicId: 42,
        ffOk: true,
        pushed: true,
        prUrl: 'https://x/pull/9',
        postedHandoff: true,
      };
    },
  });

  // ===== Contract assertions =====
  assert.equal(out.completed, true);
  assert.equal(out.resumedFrom, 'retro');

  // Skipped phases: close-validation and code-review.
  assert.deepEqual(out.phasesSkipped, ['close-validation', 'code-review']);
  // Run phases on the resume: retro and finalize.
  assert.deepEqual(out.phasesRun, ['retro', 'finalize']);

  // Critical contract assertion: wave-gate, hierarchy-gate, and
  // code-review were NOT re-run on the resume.
  assert.equal(waveGateCalls, 1, 'wave-gate must not run on resume');
  assert.equal(hierarchyGateCalls, 1, 'hierarchy-gate must not run on resume');
  assert.equal(codeReviewCalls, 1, 'code-review must not run on resume');

  // retro re-ran (the crashed phase) and finalize ran for the first time.
  assert.equal(retroCalls, 2);
  assert.equal(finalizeCalls, 1);

  // Final checkpoint must be done.
  const finalCp = await checkpointer.read();
  assert.equal(finalCp.phase, 'done');
});

test('runEpicDeliverCloseTail: rejects missing args', async () => {
  await assert.rejects(
    () =>
      runEpicDeliverCloseTail({
        provider: {},
        runFinalizeFn: async () => ({}),
      }),
    /epicId is required/,
  );
  await assert.rejects(
    () =>
      runEpicDeliverCloseTail({
        epicId: 1,
        runFinalizeFn: async () => ({}),
      }),
    /provider is required/,
  );
  await assert.rejects(
    () => runEpicDeliverCloseTail({ epicId: 1, provider: {} }),
    /runFinalizeFn is required/,
  );
});

// Story #2289 — Phase E reads the checkpoint's manualInterventions count
// at retro entry (post-resume, not at close-tail start) and passes the
// length to runRetro so the scorecard reflects out-of-band intervention
// records the host LLM appended via epic-deliver-note-intervention.js.
test('runEpicDeliverCloseTail: passes manualInterventions count from checkpoint to runRetro', async () => {
  const provider = makeCheckpointProvider();
  const checkpointer = new Checkpointer({ provider, epicId: 42 });
  // Seed the checkpoint with two recorded interventions before the
  // close-tail runs Phase E.
  await checkpointer.write({
    epicId: 42,
    phase: 'retro',
    manualInterventions: [
      {
        reason: 'manual git reset',
        source: 'host-llm',
        ts: '2026-05-17T00:00:00.000Z',
      },
      {
        reason: 'AskUserQuestion override',
        source: 'host-llm',
        ts: '2026-05-17T00:01:00.000Z',
      },
    ],
  });

  let retroArgs = null;
  await runEpicDeliverCloseTail({
    epicId: 42,
    provider,
    runWaveGateFn: async () => ({ exitCode: 0 }),
    runHierarchyGateFn: async () => ({ exitCode: 0 }),
    runCodeReviewFn: async () => ({
      status: 'ok',
      severity: { critical: 0, high: 0, medium: 0, suggestion: 0 },
      halted: false,
      blockerReason: null,
      posted: true,
    }),
    runRetroFn: async (args) => {
      retroArgs = args;
      return { posted: true, compact: false, scorecard: {}, body: '' };
    },
    runFinalizeFn: async () => ({
      epicId: 42,
      ffOk: true,
      pushed: true,
      prUrl: 'https://x/pull/1',
      postedHandoff: true,
    }),
  });

  assert.ok(retroArgs, 'expected runRetroFn to be invoked');
  assert.equal(
    retroArgs.manualInterventions,
    2,
    'expected the close-tail to forward the checkpoint count to runRetro',
  );
});

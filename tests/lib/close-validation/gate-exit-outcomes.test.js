/**
 * Story #5471 — a close gate's exit code maps to what happened, not always to
 * "failed". `75` is an expired full-suite lock wait (nothing ran), `124` a
 * suite killed on timeout (no verdict), and anything else a real failure.
 * Each outcome logs its own line; only a real failure prints the gate's own
 * (failing-tests) hint, and every `failed[]` entry carries its `outcome`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runCloseValidation } from '../../../.agents/scripts/lib/close-validation/runner.js';
import { runCloseValidationPhase } from '../../../.agents/scripts/lib/orchestration/single-story-close/phases/close-validation.js';

const FAILING_TESTS_HINT =
  'Coverage capture failed — `npm run test:coverage` exited non-zero. Fix failing tests or coverage-threshold breaches, then re-run close.';

/** A serial gate (coverage-capture) and a parallel one (lint). */
const GATES = {
  serial: {
    name: 'coverage-capture',
    cmd: 'node',
    args: ['.agents/scripts/coverage-capture.js'],
    hint: FAILING_TESTS_HINT,
  },
  parallel: {
    name: 'lint',
    cmd: 'npm',
    args: ['run', 'lint'],
    hint: 'lint hint',
  },
};

async function closeWith(gate, status) {
  const lines = [];
  const result = await runCloseValidation({
    cwd: '/repo',
    gates: [gate],
    useEvidence: false,
    runner: async () => ({ status }),
    log: (m) => lines.push(m),
  });
  return { result, lines, text: lines.join('\n') };
}

for (const [partition, gate] of Object.entries(GATES)) {
  describe(`gate exit outcomes — ${partition} gate (${gate.name})`, () => {
    it('AC-3: exit 75 logs a deferred line, never the failed line or the gate hint', async () => {
      const { result, text } = await closeWith(gate, 75);
      assert.equal(result.ok, false);
      assert.equal(result.failed.length, 1);
      const [entry] = result.failed;
      assert.equal(entry.status, 75);
      assert.equal(entry.outcome, 'deferred');
      assert.equal(entry.gate.name, gate.name);
      assert.equal(entry.gate.hint, undefined);
      assert.match(text, new RegExp(`⏸ ${gate.name} deferred \\(exit 75\\)`));
      assert.match(text, /lock wait expired/);
      assert.doesNotMatch(text, /✖/);
      assert.ok(!text.includes(gate.hint), text);
    });

    it('AC-4: exit 124 logs a timeout line with the timeout hint, never the gate hint', async () => {
      const { result, text } = await closeWith(gate, 124);
      const [entry] = result.failed;
      assert.equal(entry.outcome, 'timeout');
      assert.equal(entry.status, 124);
      assert.match(text, new RegExp(`⏱ ${gate.name} timed out \\(exit 124\\)`));
      assert.match(text, /delivery\.quality\.gates\.coverage\.timeoutMs/);
      assert.match(text, /host contention/);
      assert.doesNotMatch(text, /✖/);
      assert.ok(!text.includes(gate.hint), text);
      assert.match(entry.gate.hint, /timeoutMs/);
    });

    it('AC-4: exit 1 keeps the failed line and the gate hint', async () => {
      const { result, text } = await closeWith(gate, 1);
      const [entry] = result.failed;
      assert.equal(entry.outcome, 'failed');
      assert.equal(entry.gate.hint, gate.hint);
      assert.match(text, new RegExp(`✖ ${gate.name} failed \\(exit 1\\)`));
      assert.ok(text.includes(`hint: ${gate.hint}`), text);
    });
  });
}

describe('gate exit outcomes — the close phase settles them', () => {
  const phaseWith = (status, announce) =>
    runCloseValidationPhase({
      cwd: '/repo',
      worktreePath: null,
      config: {},
      baseBranch: 'main',
      storyId: 5471,
      progress: () => {},
      buildDefaultGates: () => [GATES.serial],
      runPreGateSteps: async () => {},
      runCloseValidation: (opts) =>
        runCloseValidation({
          ...opts,
          useEvidence: false,
          runner: async (_cmd, _args, { log }) => {
            if (announce) log(announce);
            return { status };
          },
        }),
    });

  it('AC-3: an expired lock wait with exit 75 settles pending, not failed', async () => {
    const settled = await phaseWith(
      75,
      '[full-suite-lock] ⌛ gave up waiting for the full-suite lock (waited 900s).',
    );
    assert.equal(settled.pending, true);
    assert.equal(settled.gates, null);
    assert.equal(settled.lockWait.expired, true);
  });

  it('AC-4: a timed-out gate fails close naming the timeout, not failing tests', async () => {
    await assert.rejects(phaseWith(124), (err) => {
      assert.equal(err.closeGate, 'coverage-capture');
      assert.match(err.message, /exit 124/);
      assert.match(err.message, /timeoutMs/);
      assert.doesNotMatch(err.message, /Fix failing tests/);
      return true;
    });
  });
});

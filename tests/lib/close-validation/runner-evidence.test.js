// tests/lib/close-validation/runner-evidence.test.js
/**
 * Story #5278 — the close runner's two credit seams.
 *
 * Both were plumbed and unreachable. `inputFingerprint` was threaded through
 * `runCloseValidation` into `shouldSkip`/`recordPass` and then read from a
 * `gate.inputFingerprint` property nothing ever set, so every gate the worker
 * paid for was discarded as `sha-mismatch` the moment close's own base-sync
 * moved HEAD. And the one gate that can WAIT on the host lock had no way to
 * notice that the wait had made its spawn unnecessary.
 *
 * These are asserted at the runner, not at `validation-evidence.js`: a unit
 * test on the store can only show that a fingerprint match grants a skip, not
 * that anything ever supplies one.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runCloseValidation } from '../../../.agents/scripts/lib/close-validation/runner.js';

const TREE = `tree:${'a'.repeat(40)}`;

/** A single-gate run with every evidence collaborator injected. */
function harness({
  gates,
  treeFingerprint = TREE,
  headSha = 'c'.repeat(40),
  shouldSkip = () => ({ skip: false, reason: 'no-record' }),
  runner = async () => ({ status: 0 }),
} = {}) {
  const recorded = [];
  const probed = [];
  return {
    recorded,
    probed,
    run: () =>
      runCloseValidation({
        cwd: '/repo',
        gates,
        storyId: 5278,
        standalone: true,
        runner,
        getHeadSha: () => headSha,
        getTreeFingerprint: () => treeFingerprint,
        shouldSkip: (input) => {
          probed.push(input);
          return shouldSkip(input);
        },
        recordPass: (record) => recorded.push(record),
      }),
  };
}

describe('runCloseValidation — evidence is keyed on content (Story #5278)', () => {
  it('AC-8: supplies the tree fingerprint to every gate it probes and records', async () => {
    const h = harness({
      gates: [
        { name: 'lint', cmd: 'npm', args: ['run', 'lint'] },
        { name: 'format', cmd: 'npm', args: ['run', 'format:check'] },
      ],
    });
    const result = await h.run();
    assert.equal(result.ok, true);
    assert.deepEqual(
      h.probed.map((p) => p.inputFingerprint),
      [TREE, TREE],
      'a null here is the pre-#5278 defect: nothing ever set the field',
    );
    assert.deepEqual(
      h.recorded.map((r) => r.inputFingerprint),
      [TREE, TREE],
      'and the deposit must carry it, or the next read has nothing to match',
    );
  });

  it('AC-8: a fingerprint match is reported as skipped, not re-run', async () => {
    let spawns = 0;
    const h = harness({
      gates: [{ name: 'lint', cmd: 'npm', args: ['run', 'lint'] }],
      shouldSkip: (input) =>
        input.inputFingerprint === TREE
          ? { skip: true, reason: 'fingerprint-match', record: {} }
          : { skip: false, reason: 'sha-mismatch', record: {} },
      runner: async () => {
        spawns += 1;
        return { status: 0 };
      },
    });
    const result = await h.run();
    assert.equal(spawns, 0);
    assert.deepEqual(
      result.skipped.map((s) => s.reason),
      ['fingerprint-match'],
    );
  });

  it('a gate carrying its own fingerprint keeps it', async () => {
    const h = harness({
      gates: [
        {
          name: 'lint',
          cmd: 'npm',
          args: ['run', 'lint'],
          inputFingerprint: 'own:1',
        },
      ],
    });
    await h.run();
    assert.equal(h.probed[0].inputFingerprint, 'own:1');
  });

  it('an unreadable tree falls back to SHA-only behaviour', async () => {
    const h = harness({
      gates: [{ name: 'lint', cmd: 'npm', args: ['run', 'lint'] }],
      treeFingerprint: null,
    });
    await h.run();
    assert.equal(h.probed[0].inputFingerprint, null);
    assert.equal(h.recorded[0].inputFingerprint, null);
  });
});

describe('runCloseValidation — a pre-decided gate skip (Story #5278)', () => {
  // AC-2's runner half. The gate list decides that coverage-capture will take
  // its own incremental skip; the runner must then REPORT it as skipped —
  // never omit it (a missing gate reads as a passing one) and never spawn it
  // to discover the same thing minutes later.
  it('AC-2: records a `skip`-marked gate with its reason and never spawns it', async () => {
    let spawns = 0;
    const h = harness({
      gates: [
        {
          name: 'coverage-capture',
          cmd: 'node',
          args: ['.agents/scripts/coverage-capture.js'],
          skip: { reason: 'incremental-no-crap-changes' },
        },
        { name: 'test', cmd: 'npm', args: ['test'], fullSuiteLock: true },
      ],
      runner: async () => {
        spawns += 1;
        return { status: 0 };
      },
    });
    const result = await h.run();
    assert.equal(result.ok, true);
    assert.deepEqual(result.skipped, [
      {
        gate: result.skipped[0].gate,
        reason: 'incremental-no-crap-changes',
      },
    ]);
    assert.equal(result.skipped[0].gate.name, 'coverage-capture');
    assert.equal(spawns, 1, 'the `test` gate in its place still runs');
  });

  it('AC-2: a failing `test` gate beside a skipped capture fails the close', async () => {
    const h = harness({
      gates: [
        {
          name: 'coverage-capture',
          cmd: 'node',
          args: ['x'],
          skip: { reason: 'incremental-no-crap-changes' },
        },
        { name: 'test', cmd: 'npm', args: ['test'], fullSuiteLock: true },
      ],
      runner: async () => ({ status: 1 }),
    });
    const result = await h.run();
    assert.equal(result.ok, false, 'a tests-only Story must not close green');
    assert.equal(result.failed[0].gate.name, 'test');
  });
});

describe('runCloseValidation — the post-wait re-probe (Story #5278)', () => {
  // AC-7's runner half: only the full-suite gate can end up waiting on the
  // host lock, and only it is expensive enough for the wait to change the
  // answer, so only it is handed a re-probe.
  it('AC-7: hands the full-suite gate a probe that re-asks the evidence store', async () => {
    const seen = [];
    let evidenceReady = false;
    const h = harness({
      gates: [
        { name: 'test', cmd: 'npm', args: ['test'], fullSuiteLock: true },
      ],
      shouldSkip: () =>
        evidenceReady
          ? { skip: true, reason: 'evidence-match', record: {} }
          : { skip: false, reason: 'no-record' },
      runner: async (_cmd, _args, opts) => {
        seen.push(opts);
        // Stand in for the wait: a sibling deposited the record while we
        // queued behind its suite.
        evidenceReady = true;
        return opts.skipIfSatisfied() ?? { status: 0 };
      },
    });
    const result = await h.run();
    assert.equal(result.ok, true);
    assert.equal(typeof seen[0].skipIfSatisfied, 'function');
  });

  it('no probe is attached to a gate that cannot wait on the lock', async () => {
    const seen = [];
    const h = harness({
      gates: [{ name: 'lint', cmd: 'npm', args: ['run', 'lint'] }],
      runner: async (_cmd, _args, opts) => {
        seen.push(opts);
        return { status: 0 };
      },
    });
    await h.run();
    assert.equal(
      'skipIfSatisfied' in seen[0],
      false,
      'a cheap gate re-probing would be pure overhead on the hot path',
    );
  });
});

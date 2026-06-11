// tests/check-baselines-pre-merge-wiring.test.js
//
// Story #1912 / Task #1917 — `check-baselines` is wired into the pre-merge
// gate chain as the unified baselines gate.
//
// Story #2210 retired the in-process per-kind regression gates
// (`check-maintainability`, `check-crap`, `check-mutation`). The
// `check-baselines` gate is now the single source of truth for per-kind
// regression enforcement — the chain no longer carries the per-kind
// arms alongside it, and the order-sensitivity that previously pinned
// `check-baselines` AFTER the per-kind gates is moot.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildDefaultGates } from '../.agents/scripts/lib/close-validation/gates.js';
import { runCloseValidation } from '../.agents/scripts/lib/close-validation/runner.js';

describe('pre-merge gate chain — Task #1917 contract', () => {
  it('buildDefaultGates includes the unified check-baselines gate', () => {
    const gates = buildDefaultGates({
      config: { delivery: { quality: { gates: { crap: { enabled: true } } } } },
    });
    const names = gates.map((g) => g.name);
    assert.ok(
      names.includes('check-baselines'),
      `expected check-baselines in gate list; got ${names.join(', ')}`,
    );
  });

  it('per-kind in-process regression gates are absent (Story #2210 retirement)', () => {
    const gates = buildDefaultGates({
      config: { delivery: { quality: { gates: { crap: { enabled: true } } } } },
    });
    const names = gates.map((g) => g.name);
    for (const kind of [
      'check-maintainability',
      'check-crap',
      'check-mutation',
    ]) {
      assert.ok(
        !names.includes(kind),
        `retired per-kind gate \`${kind}\` must not appear in the chain; got: ${names.join(', ')}`,
      );
    }
  });

  it('check-baselines invokes the new CLI', () => {
    const gates = buildDefaultGates({});
    const gate = gates.find((g) => g.name === 'check-baselines');
    assert.ok(gate);
    assert.equal(gate.cmd, 'node');
    assert.deepEqual(gate.args, [
      '.agents/scripts/check-baselines.js',
      '--format',
      'text',
    ]);
  });
});

describe('check-baselines epic baseRef threading — Story #3890', () => {
  it('pins BASELINE_REF to origin/<epicBranch> when an epic branch is supplied', () => {
    const gates = buildDefaultGates({ epicBranch: 'epic/3865' });
    const gate = gates.find((g) => g.name === 'check-baselines');
    assert.ok(gate);
    assert.deepEqual(
      gate.env,
      { BASELINE_REF: 'origin/epic/3865' },
      'the unified baselines gate must compare against the epic integration branch',
    );
  });

  it('pins BASELINE_REF to origin/<baseBranch> for the standalone path', () => {
    // single-story-close forwards `baseBranch` (e.g. `main`) as `epicBranch`.
    const gates = buildDefaultGates({ epicBranch: 'main' });
    const gate = gates.find((g) => g.name === 'check-baselines');
    assert.ok(gate);
    assert.deepEqual(gate.env, { BASELINE_REF: 'origin/main' });
  });

  it('omits the env overlay entirely when no integration branch is supplied', () => {
    const gate = buildDefaultGates({}).find(
      (g) => g.name === 'check-baselines',
    );
    assert.ok(gate);
    assert.ok(
      !('env' in gate),
      'no epic branch → no BASELINE_REF overlay → gate keeps default/consumer-config base',
    );
  });

  it('threads the gate env through to the runner (no parent-env mutation)', async () => {
    const seen = [];
    const runner = (cmd, args, opts) => {
      seen.push({ name: opts.gateName, env: opts.env });
      return { status: 0 };
    };
    // Build the canonical gate list, then isolate the check-baselines +
    // an env-less control gate so the test exercises the env-threading
    // path without invoking the format gate's git-backed changedFileScope.
    const built = buildDefaultGates({ epicBranch: 'epic/4242' });
    const baselinesGate = built.find((g) => g.name === 'check-baselines');
    assert.ok(baselinesGate?.env, 'fixture: baselines gate must carry env');
    const gates = [{ name: 'lint', cmd: 'noop', args: [] }, baselinesGate];
    await runCloseValidation({
      cwd: process.cwd(),
      gates,
      runner,
      useEvidence: false,
    });
    const baselinesCall = seen.find((c) => c.name === 'check-baselines');
    assert.ok(baselinesCall, 'check-baselines gate must have been dispatched');
    assert.deepEqual(baselinesCall.env, { BASELINE_REF: 'origin/epic/4242' });
    // The control gate carries no env overlay.
    const lintCall = seen.find((c) => c.name === 'lint');
    assert.ok(lintCall, 'control gate must have been dispatched');
    assert.equal(
      lintCall.env,
      undefined,
      'only check-baselines should receive the BASELINE_REF overlay',
    );
    assert.equal(
      process.env.BASELINE_REF,
      undefined,
      'the gate-scoped env must not leak into the parent process',
    );
  });
});

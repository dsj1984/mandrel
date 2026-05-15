// tests/close-validation-full-scope-crap.test.js
//
// Story #1945 — close-validation must run the CRAP gate at full-scope by
// default so a method-level regression in a file the Story did NOT touch
// is caught before push. The motivating incident (PR #1942 → hotfix
// #1944) saw three full-scope CRAP regressions land on main because the
// diff-scoped close-validation gate never inspected the affected files.
// These tests pin the contract:
//
//   1. buildDefaultGates injects --full-scope into the check-crap args by
//      default.
//   2. An opt-out via fullScopeCrap=false drops --full-scope (mirrors the
//      --no-full-scope-crap CLI flag operators can pass to
//      single-story-close.js when the full-tree scan becomes prohibitive).
//   3. runCloseValidation propagates the --full-scope arg to the spawned
//      gate runner, so a regression in an unrelated file *would* surface
//      at close time under a mocked runner that detects it.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildDefaultGates,
  runCloseValidation,
} from '../.agents/scripts/lib/close-validation.js';

describe('close-validation full-scope CRAP (Story #1945)', () => {
  it('check-crap gate defaults to --full-scope', () => {
    const gates = buildDefaultGates({});
    const crap = gates.find((g) => g.name === 'check-crap');
    assert.ok(crap, 'check-crap gate must be present');
    assert.equal(crap.cmd, 'node');
    assert.ok(
      crap.args.includes('--full-scope'),
      `expected --full-scope in CRAP args; got ${JSON.stringify(crap.args)}`,
    );
  });

  it('fullScopeCrap=false drops --full-scope so operators can opt out', () => {
    const gates = buildDefaultGates({ fullScopeCrap: false });
    const crap = gates.find((g) => g.name === 'check-crap');
    assert.ok(crap);
    assert.ok(
      !crap.args.includes('--full-scope'),
      `expected no --full-scope when fullScopeCrap=false; got ${JSON.stringify(crap.args)}`,
    );
  });

  it('full-scope close-time CRAP catches a regression in an untouched file', async () => {
    // Simulate the PR #1942 incident: the Story under close touched
    // `analyze-execution.js`, but the regression is in
    // `dispatch-engine.js::resolveAndDispatch`. A diff-scoped runner
    // would never inspect that file; a --full-scope runner does. We
    // express that by inspecting the args the runner receives: when the
    // gate carries --full-scope the runner returns "regression detected"
    // (non-zero), otherwise it returns 0 because the diff doesn't touch
    // the regressed file.
    const fakeRunner = (cmd, args) => {
      if (
        cmd === 'node' &&
        args.some((a) => a.endsWith('check-crap.js')) &&
        args.includes('--full-scope')
      ) {
        return { status: 1 };
      }
      return { status: 0 };
    };

    // Pin a minimal gate list to avoid spawning the real typecheck/lint
    // chain — we only need the CRAP gate's contract under the runner.
    const crapGate = buildDefaultGates({}).find((g) => g.name === 'check-crap');
    const fullScopeResult = await runCloseValidation({
      cwd: process.cwd(),
      gates: [crapGate],
      runner: fakeRunner,
      log: () => {},
    });
    assert.equal(
      fullScopeResult.ok,
      false,
      'full-scope CRAP must surface the untouched-file regression at close time',
    );
    assert.equal(fullScopeResult.failed[0].gate.name, 'check-crap');

    const diffScopeCrap = buildDefaultGates({ fullScopeCrap: false }).find(
      (g) => g.name === 'check-crap',
    );
    const diffScopeResult = await runCloseValidation({
      cwd: process.cwd(),
      gates: [diffScopeCrap],
      runner: fakeRunner,
      log: () => {},
    });
    assert.equal(
      diffScopeResult.ok,
      true,
      'diff-scope CRAP misses the untouched-file regression — exactly the gap Story #1945 closes',
    );
  });

  it('hint surfaces --full-scope baseline-refresh remediation', () => {
    const gates = buildDefaultGates({});
    const crap = gates.find((g) => g.name === 'check-crap');
    assert.match(
      crap.hint,
      /crap:update -- --full-scope/,
      'CRAP gate hint must point at the full-scope baseline-refresh command so operators know what to run when CI Linux drifts a row',
    );
    assert.match(crap.hint, /baseline-refresh:/);
  });
});

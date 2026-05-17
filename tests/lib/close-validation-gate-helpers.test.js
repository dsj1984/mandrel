/**
 * Story #1642 — unit-test the extracted helpers behind `defaultGateRunner`.
 *
 * `attachGateAbortHandler` and `gateExitCode` are the two pure pieces that
 * came out of the cc-reduction refactor. Coverage on them keeps the file's
 * function-coverage above its baseline.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  attachGateAbortHandler,
  gateExitCode,
} from '../../.agents/scripts/lib/close-validation.js';

describe('gateExitCode', () => {
  it('returns numeric exit codes verbatim', () => {
    assert.equal(gateExitCode(0, null), 0);
    assert.equal(gateExitCode(2, null), 2);
    assert.equal(gateExitCode(127, null), 127);
  });
  it('maps SIGTERM (no exit code) to 143', () => {
    assert.equal(gateExitCode(null, 'SIGTERM'), 143);
    assert.equal(gateExitCode(undefined, 'SIGKILL'), 143);
  });
  it('falls back to 1 when both code and signal are absent', () => {
    assert.equal(gateExitCode(null, null), 1);
  });
});

function makeFakeChild() {
  const calls = { killed: 0 };
  return {
    kill: () => {
      calls.killed += 1;
    },
    calls,
  };
}

describe('attachGateAbortHandler', () => {
  it('returns a no-op detach when signal is absent', () => {
    const child = makeFakeChild();
    const detach = attachGateAbortHandler(child, null);
    detach();
    assert.equal(child.calls.killed, 0);
  });

  it('kills the child immediately when signal is already aborted', () => {
    const ac = new AbortController();
    ac.abort();
    const child = makeFakeChild();
    attachGateAbortHandler(child, ac.signal);
    assert.equal(child.calls.killed, 1);
  });

  it('attaches an abort listener that kills the child when the signal fires', () => {
    const ac = new AbortController();
    const child = makeFakeChild();
    const detach = attachGateAbortHandler(child, ac.signal);
    assert.equal(child.calls.killed, 0);
    ac.abort();
    assert.equal(child.calls.killed, 1);
    detach();
  });

  it('detach removes the listener so a later abort is a no-op', () => {
    const ac = new AbortController();
    const child = makeFakeChild();
    const detach = attachGateAbortHandler(child, ac.signal);
    detach();
    ac.abort();
    assert.equal(child.calls.killed, 0);
  });

  it('swallows kill() races (child already exited)', () => {
    const ac = new AbortController();
    const child = {
      kill: () => {
        throw new Error('already exited');
      },
    };
    attachGateAbortHandler(child, ac.signal);
    // Must not throw.
    assert.doesNotThrow(() => ac.abort());
  });
});

// Story #2210 — the `describe('buildDefaultGates per-kind in-process gates')`
// block was deleted with the retirement of the in-process per-kind regression
// gate. The unified `check-baselines` gate is the only path; coverage for
// that gate lives in `tests/check-baselines-pre-merge-wiring.test.js` and
// the attribution-wiring tests under
// `tests/lib/orchestration/story-close/baseline-attribution-wiring.test.js`.
// The pure helpers above (`gateExitCode`, `attachGateAbortHandler`) remain.

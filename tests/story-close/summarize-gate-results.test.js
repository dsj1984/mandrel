/**
 * Unit tests for `summarizeGateResults` (Story #2995 — split
 * `runPreMergeValidation` into a pure summarizer + side-effecting
 * emitter). Covers every branch of the verdict classifier.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { summarizeGateResults } from '../../.agents/scripts/lib/orchestration/story-close/phases/gates.js';

describe('summarizeGateResults', () => {
  it('returns blocked-timeout when format-autofix tripped its watchdog', () => {
    const formatAutofixOutcome = {
      timedOut: true,
      exitCode: 124,
      writeCmdString: 'biome format --write .',
      timeoutMs: 60000,
    };
    const summary = summarizeGateResults({ formatAutofixOutcome });
    assert.equal(summary.verdict, 'blocked-timeout');
    assert.equal(summary.blockers.length, 1);
    assert.equal(summary.blockers[0].kind, 'format-autofix-timeout');
    assert.equal(
      summary.blockers[0].formatAutofixOutcome,
      formatAutofixOutcome,
    );
    assert.deepEqual(summary.advisories, []);
  });

  it('prefers format-autofix timeout over a downstream gate outcome', () => {
    // If both outcomes are present and the format step already timed
    // out, the summarizer must short-circuit on the format step. The
    // sequencer never reaches the attribution gate in this case, but
    // the summarizer must remain deterministic against partial inputs.
    const formatAutofixOutcome = { timedOut: true };
    const gateOutcome = { status: 'blocked' };
    const summary = summarizeGateResults({
      formatAutofixOutcome,
      gateOutcome,
    });
    assert.equal(summary.verdict, 'blocked-timeout');
    assert.equal(summary.blockers[0].kind, 'format-autofix-timeout');
  });

  it('returns blocked when the attribution gate reports baseline drift', () => {
    const gateOutcome = {
      status: 'blocked',
      nonAttributable: ['src/a.ts', 'src/b.ts'],
      commentId: 'abc123',
    };
    const summary = summarizeGateResults({ gateOutcome });
    assert.equal(summary.verdict, 'blocked');
    assert.equal(summary.blockers.length, 1);
    assert.equal(summary.blockers[0].kind, 'baseline-drift');
    assert.equal(summary.blockers[0].gateOutcome, gateOutcome);
    assert.deepEqual(summary.advisories, []);
  });

  it('returns blocked-timeout when the attribution gate spawn timed out', () => {
    const gateOutcome = {
      status: 'blocked-timeout',
      gateName: 'lint',
      exitCode: 124,
    };
    const summary = summarizeGateResults({ gateOutcome });
    assert.equal(summary.verdict, 'blocked-timeout');
    assert.equal(summary.blockers.length, 1);
    assert.equal(summary.blockers[0].kind, 'gate-timeout');
    assert.equal(summary.blockers[0].gateOutcome, gateOutcome);
  });

  it('returns ok when gates pass with a status:ok envelope', () => {
    const gateOutcome = { status: 'ok' };
    const summary = summarizeGateResults({
      formatAutofixOutcome: { timedOut: false },
      gateOutcome,
    });
    assert.equal(summary.verdict, 'ok');
    assert.deepEqual(summary.blockers, []);
    assert.deepEqual(summary.advisories, []);
    assert.equal(summary.gateOutcome, gateOutcome);
  });

  it('returns ok for the empty-results case', () => {
    const summary = summarizeGateResults({});
    assert.equal(summary.verdict, 'ok');
    assert.deepEqual(summary.blockers, []);
    assert.deepEqual(summary.advisories, []);
    assert.equal(summary.gateOutcome, null);
  });

  it('returns ok when called with no argument at all', () => {
    // The sequencer always passes an object, but defensive default
    // matters because the summarizer is documented as pure.
    const summary = summarizeGateResults();
    assert.equal(summary.verdict, 'ok');
    assert.deepEqual(summary.blockers, []);
    assert.equal(summary.gateOutcome, null);
  });

  it('treats falsy formatAutofixOutcome.timedOut as a non-blocker', () => {
    const formatAutofixOutcome = { timedOut: false };
    const gateOutcome = { status: 'ok' };
    const summary = summarizeGateResults({
      formatAutofixOutcome,
      gateOutcome,
    });
    assert.equal(summary.verdict, 'ok');
  });

  it('does not invent advisories or mutate inputs', () => {
    const gateOutcome = { status: 'blocked', nonAttributable: ['x'] };
    const frozen = Object.freeze({ ...gateOutcome });
    const summary = summarizeGateResults({ gateOutcome: frozen });
    assert.equal(summary.verdict, 'blocked');
    assert.deepEqual(summary.advisories, []);
    // Verify input was not mutated.
    assert.deepEqual(frozen, { status: 'blocked', nonAttributable: ['x'] });
  });

  it('performs no I/O — invocation is synchronous and side-effect free', () => {
    // Sentinel: if the summarizer ever grew an async/IO hop, the
    // returned value would be a Promise. Lock it down.
    const result = summarizeGateResults({ gateOutcome: { status: 'ok' } });
    assert.equal(typeof result.then, 'undefined');
  });
});

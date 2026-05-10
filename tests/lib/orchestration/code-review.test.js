/**
 * Unit tests for the in-process `runCodeReview` wrapper.
 *
 * Story #1155 (Epic #1142, 5.40.0). The wrapper delegates to the existing
 * `runEpicCodeReview` runner — these tests stub that runner to verify:
 *   - Argument shape (provider injection, post=true, scopeLint default).
 *   - Halting semantics on critical findings.
 *   - Pass-through severity envelope on clean reviews.
 *   - Non-`ok` statuses (no-changes / invalid) never halt.
 *   - epicId validation.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { runCodeReview } from '../../../.agents/scripts/lib/orchestration/code-review.js';

function makeStubRunner({
  status = 'ok',
  severity = { critical: 0, high: 0, medium: 0, suggestion: 0 },
  posted = true,
  report = '## review',
} = {}) {
  const calls = [];
  const stub = async (args, deps) => {
    calls.push({ args, deps });
    return { status, severity, posted, report };
  };
  return { stub, calls };
}

test('runCodeReview: rejects missing/invalid epicId', async () => {
  await assert.rejects(
    () => runCodeReview({ provider: {}, runner: async () => ({}) }),
    /epicId is required/,
  );
  await assert.rejects(
    () =>
      runCodeReview({
        epicId: 0,
        provider: {},
        runner: async () => ({}),
      }),
    /epicId is required/,
  );
});

test('runCodeReview: forwards provider via providerFactory and post=true', async () => {
  const provider = { id: 'stub-provider' };
  const { stub, calls } = makeStubRunner();

  const out = await runCodeReview({
    epicId: 42,
    provider,
    runner: stub,
  });

  assert.equal(calls.length, 1);
  const { args, deps } = calls[0];
  assert.equal(args.epicId, 42);
  assert.equal(args.post, true);
  assert.equal(args.scopeLint, 'changed-only');
  assert.equal(args.useEvidence, true);
  assert.equal(typeof deps.providerFactory, 'function');
  assert.equal(deps.providerFactory(), provider);
  assert.equal(out.status, 'ok');
  assert.equal(out.halted, false);
  assert.equal(out.posted, true);
  assert.equal(out.blockerReason, null);
});

test('runCodeReview: critical > 0 sets halted=true with reason', async () => {
  const { stub } = makeStubRunner({
    severity: { critical: 2, high: 1, medium: 0, suggestion: 0 },
  });
  const out = await runCodeReview({
    epicId: 42,
    provider: {},
    runner: stub,
  });
  assert.equal(out.halted, true);
  assert.match(out.blockerReason, /2 critical/);
  assert.equal(out.severity.critical, 2);
});

test('runCodeReview: status=no-changes never halts and forwards envelope', async () => {
  const { stub } = makeStubRunner({
    status: 'no-changes',
    severity: undefined,
    posted: false,
    report: undefined,
  });
  const out = await runCodeReview({
    epicId: 42,
    provider: {},
    runner: stub,
  });
  assert.equal(out.status, 'no-changes');
  assert.equal(out.halted, false);
  assert.equal(out.posted, false);
  assert.equal(out.blockerReason, null);
});

test('runCodeReview: status=invalid surfaces but does not halt', async () => {
  const { stub } = makeStubRunner({
    status: 'invalid',
    severity: undefined,
    posted: false,
  });
  const out = await runCodeReview({
    epicId: 42,
    provider: {},
    runner: stub,
  });
  assert.equal(out.status, 'invalid');
  assert.equal(out.halted, false);
});

test('runCodeReview: passes through optional config knobs', async () => {
  const { stub, calls } = makeStubRunner();
  await runCodeReview({
    epicId: 42,
    provider: {},
    runner: stub,
    baseBranch: 'develop',
    scopeLint: 'off',
    storyId: 99,
    useEvidence: false,
  });
  const { args } = calls[0];
  assert.equal(args.baseBranch, 'develop');
  assert.equal(args.scopeLint, 'off');
  assert.equal(args.storyId, 99);
  assert.equal(args.useEvidence, false);
});

test('runCodeReview: defaults severity buckets to zero when runner omits them', async () => {
  const { stub } = makeStubRunner({ severity: undefined });
  const out = await runCodeReview({
    epicId: 42,
    provider: {},
    runner: stub,
  });
  assert.deepEqual(out.severity, {
    critical: 0,
    high: 0,
    medium: 0,
    suggestion: 0,
  });
  assert.equal(out.halted, false);
});

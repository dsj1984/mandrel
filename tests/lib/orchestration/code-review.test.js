/**
 * Unit tests for the in-process `runCodeReview` wrapper.
 *
 * Story #1155 (Epic #1142) — original wrapper extracted the helper-driven
 * `epic-code-review` invocation into a callable module.
 *
 * Story #2831 (Epic #2815) — refactored to load the review provider
 * through the factory, render the structured comment via
 * `findings-renderer`, and post via `upsertStructuredComment`. These
 * tests now stub the factory + upsert seam (the runner-stub indirection
 * is gone — the adapter is the seam).
 *
 * v2.0.0 removed the Epic tier: Story is the only scope, and the
 * Epic-scoped `code-review.start` / `.end` lifecycle emits (whose schema
 * requires `epicId`) are gone with it — hence no bus wiring here.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { runCodeReview } from '../../../.agents/scripts/lib/orchestration/code-review.js';
import { verifyCriticals } from '../../../.agents/scripts/lib/orchestration/review-providers/critical-verifier.js';

function noopUpsert() {
  return async () => {};
}

function recordingUpsert() {
  const calls = [];
  const fn = async (...args) => {
    calls.push(args);
  };
  return { fn, calls };
}

function fakeAdapter(findings) {
  const calls = [];
  return {
    calls,
    runReview: async (input) => {
      calls.push(input);
      return findings;
    },
  };
}

function baseResolveConfig() {
  return {
    project: { baseBranch: 'main' },
    delivery: { codeReview: { providers: [{ name: 'native' }] } },
  };
}

test('runCodeReview: rejects missing/invalid ticketId', async () => {
  await assert.rejects(
    () => runCodeReview({ provider: {}, headRef: 'story-42' }),
    /ticketId is required/,
  );
  await assert.rejects(
    () =>
      runCodeReview({
        ticketId: 0,
        headRef: 'story-42',
        provider: {},
      }),
    /ticketId is required/,
  );
});

test('runCodeReview: clean run posts the structured comment and reports posted=true', async () => {
  const adapter = fakeAdapter([]);
  const upsert = recordingUpsert();

  const out = await runCodeReview({
    ticketId: 42,
    headRef: 'story-42',
    provider: { kind: 'github' },
    reviewProvider: adapter,
    resolveConfigFn: baseResolveConfig,
    upsertCommentFn: upsert.fn,
  });

  assert.equal(out.status, 'ok');
  assert.equal(out.halted, false);
  assert.equal(out.posted, true);
  assert.equal(out.blockerReason, null);
  assert.deepEqual(out.severity, {
    critical: 0,
    high: 0,
    medium: 0,
    suggestion: 0,
  });
  assert.equal(upsert.calls.length, 1);
  const [provider, ticketId, type, body] = upsert.calls[0];
  assert.deepEqual(provider, { kind: 'github' });
  assert.equal(ticketId, 42);
  assert.equal(type, 'verification-results');
  assert.match(body, /Code Review — Story #42/);
});

test('runCodeReview: passes scope/ticketId/baseRef/headRef to the adapter', async () => {
  const adapter = fakeAdapter([]);
  await runCodeReview({
    ticketId: 42,
    headRef: 'story-42',
    provider: {},
    baseRef: 'develop',
    reviewProvider: adapter,
    resolveConfigFn: baseResolveConfig,
    upsertCommentFn: noopUpsert(),
  });
  assert.equal(adapter.calls.length, 1);
  // Story #2871 — ReviewInput now carries an optional `labels` field
  // (defaults to []) so chain-entry gate predicates can read ticket
  // labels at invocation time.
  // Story #3876 — ReviewInput now also carries a `depth` field derived from
  // the judged risk envelope's overallLevel. With no planningRisk supplied it
  // resolves to the neutral `standard` default.
  assert.deepEqual(adapter.calls[0], {
    scope: 'story',
    ticketId: 42,
    baseRef: 'develop',
    headRef: 'story-42',
    labels: [],
    depth: 'standard',
  });
});

test('runCodeReview: critical findings set halted=true with a reason', async () => {
  const adapter = fakeAdapter([
    {
      severity: 'critical',
      title: 'Low Maintainability',
      body: 'critical body',
    },
    { severity: 'high', title: 'Lint check failed', body: 'high body' },
  ]);
  const out = await runCodeReview({
    ticketId: 42,
    headRef: 'story-42',
    provider: {},
    reviewProvider: adapter,
    resolveConfigFn: baseResolveConfig,
    upsertCommentFn: noopUpsert(),
  });
  assert.equal(out.halted, true);
  assert.equal(out.severity.critical, 1);
  assert.equal(out.severity.high, 1);
  assert.match(out.blockerReason, /1 critical/);
});

test('runCodeReview: defaults baseRef to the REMOTE project.baseBranch when arg is null', async () => {
  const adapter = fakeAdapter([]);
  await runCodeReview({
    ticketId: 7,
    headRef: 'story-7',
    provider: {},
    reviewProvider: adapter,
    resolveConfigFn: () => ({
      project: { baseBranch: 'trunk' },
      delivery: { codeReview: { providers: [{ name: 'native' }] } },
    }),
    upsertCommentFn: noopUpsert(),
  });
  // Story #5325 — the bare name resolves to the LOCAL `refs/heads/trunk`,
  // whose drift would be scored as the ticket's own change. A caller that
  // omits a base must inherit the remote-tracking ref instead.
  assert.equal(adapter.calls[0].baseRef, 'origin/trunk');
});

test('runCodeReview: surfaces upsert failure as posted=false but still returns ok', async () => {
  const adapter = fakeAdapter([]);
  const out = await runCodeReview({
    ticketId: 42,
    headRef: 'story-42',
    provider: {},
    reviewProvider: adapter,
    resolveConfigFn: baseResolveConfig,
    upsertCommentFn: async () => {
      throw new Error('network down');
    },
  });
  assert.equal(out.status, 'ok');
  assert.equal(out.posted, false);
});

test('runCodeReview: routes provider name from delivery.codeReview to the factory', async () => {
  const factoryCalls = [];
  const adapter = fakeAdapter([]);
  await runCodeReview({
    ticketId: 42,
    headRef: 'story-42',
    provider: {},
    resolveConfigFn: () => ({
      project: { baseBranch: 'main' },
      delivery: { codeReview: { providers: [{ name: 'native' }] } },
    }),
    createReviewProviderFn: (cfg) => {
      factoryCalls.push(cfg);
      return adapter;
    },
    upsertCommentFn: noopUpsert(),
  });
  assert.equal(factoryCalls.length, 1);
  assert.deepEqual(factoryCalls[0], { providers: [{ name: 'native' }] });
});

// --- Claim grounding (Story #5904) -----------------------------------------

function groundingRun({ findings, degradations = [], catFile = 0 }) {
  return runCodeReview({
    ticketId: 5904,
    headRef: 'deadbeef',
    provider: {},
    changedFiles: [],
    reviewProvider: {
      runReview: async () => findings,
      getDegradations: () => degradations,
    },
    gitSpawnFn: (_cwd, ...args) =>
      args[0] === 'cat-file'
        ? { status: catFile, stdout: '', stderr: '' }
        : { status: 1, stdout: '', stderr: '' },
    resolveConfigFn: baseResolveConfig,
    upsertCommentFn: noopUpsert(),
    deferPost: true,
  });
}

const PATH_CLAIM = { kind: 'path-absent', path: 'db/0398.sql' };

test('#5904 AC-1/AC-6: a refuted critical does not halt or count toward its provider', async () => {
  const out = await groundingRun({
    findings: [
      {
        severity: 'critical',
        title: 'Missing SQL',
        body: 'b',
        claim: PATH_CLAIM,
        provider: 'llm-review',
      },
      { severity: 'high', title: 'h', body: 'b', provider: 'native' },
    ],
  });
  assert.equal(out.halted, false);
  assert.equal(out.blockerReason, null);
  assert.equal(out.severity.critical, 0);
  assert.equal(out.severity.suggestion, 1);
  assert.deepEqual(out.criticalByProvider, {});
  assert.equal(out.findings[0].ungrounded, 'git cat-file found db/0398.sql');
  assert.match(
    out.report,
    /Not blocking: ungrounded — git cat-file found db\/0398\.sql/,
  );
});

test('#5904 AC-3/AC-6: a confirmed claim still halts and is attributed per provider', async () => {
  const out = await groundingRun({
    catFile: 128,
    findings: [
      {
        severity: 'critical',
        title: 'Missing SQL',
        body: 'b',
        claim: PATH_CLAIM,
        provider: 'llm-review',
      },
      { severity: 'critical', title: 'Bug', body: 'b', provider: 'native' },
    ],
  });
  assert.equal(out.halted, true);
  assert.deepEqual(out.criticalByProvider, { 'llm-review': 1, native: 1 });
});

test('#5904 AC-5: a degradation naming the finding file annotates it without changing severity', async () => {
  const out = await groundingRun({
    findings: [
      { severity: 'critical', title: 'Bug', body: 'b', file: 'src/big.js' },
    ],
    degradations: [
      {
        tool: 'code-review',
        gate: 'codeReview',
        surface: 'model-bug-review',
        reason:
          'src/big.js truncated at 200000 characters: 9 characters not reviewed',
      },
    ],
  });
  assert.equal(out.findings[0].context, 'reviewed-with-truncated-context');
  assert.equal(out.halted, true);
  assert.equal(out.degraded, true);
});

// --- Critical verifier (Story #5919) ---------------------------------------

const verdictEnvelope = (verdict) => ({
  status: 0,
  stdout: JSON.stringify({ subtype: 'success', structured_output: verdict }),
  stderr: '',
});

/** A verifier whose claude spawn answers `verdict`; records each prompt. */
function stubVerifier(verdict) {
  const prompts = [];
  const fn = (args) =>
    verifyCriticals({
      ...args,
      probeFn: () => true,
      spawnFn: async (_f, _a, options) => {
        prompts.push(options.input);
        return verdictEnvelope(verdict);
      },
      gitSpawnFn: () => ({ status: 0, stdout: 'a\nb\n', stderr: '' }),
    });
  return { fn, prompts };
}

function verifiedRun(findings, verifier, extra = {}) {
  return runCodeReview({
    ticketId: 5919,
    headRef: 'deadbeef',
    provider: {},
    changedFiles: [],
    reviewProvider: { runReview: async () => findings },
    gitSpawnFn: () => ({ status: 1, stdout: '', stderr: '' }),
    resolveConfigFn: baseResolveConfig,
    upsertCommentFn: noopUpsert(),
    verifyCriticalsFn: verifier.fn,
    deferPost: true,
    ...extra,
  });
}

test('#5919 AC-1: a refuted critical renders unverified and does not halt', async () => {
  const verifier = stubVerifier({
    verdict: 'refuted',
    evidence: null,
    reason: 'the null is guarded',
  });
  const out = await verifiedRun(
    [
      {
        severity: 'critical',
        title: 'Bug',
        body: 'b',
        provider: 'code-review',
      },
    ],
    verifier,
  );
  assert.equal(out.halted, false);
  assert.equal(out.blockerReason, null);
  assert.deepEqual(out.criticalByProvider, {});
  assert.equal(out.findings[0].provider, 'code-review');
  assert.equal(out.findings[0].unverified, 'the null is guarded');
  assert.match(out.report, /Not blocking: unverified — the null is guarded/);
  assert.match(
    out.report,
    /Critical verification\*\*: 1 attempted · 0 confirmed · 1 refuted/,
  );
  assert.equal(out.verification.refuted, 1);
});

test('#5919 AC-2: a confirmed critical with evidence at head halts', async () => {
  const verifier = stubVerifier({
    verdict: 'confirmed',
    evidence: { file: 'a.js', line: 1 },
    reason: 'real',
  });
  const out = await verifiedRun(
    [{ severity: 'critical', title: 'Bug', body: 'b' }],
    verifier,
  );
  assert.equal(out.halted, true);
  assert.equal(out.degraded, false);
  assert.equal(out.verification.confirmed, 1);
});

test('#5919 AC-4: only findings still critical after grounding reach the verifier', async () => {
  const verifier = stubVerifier({ verdict: 'refuted', reason: 'x' });
  const out = await verifiedRun(
    [
      {
        severity: 'critical',
        title: 'Grounded away',
        body: 'b',
        claim: { kind: 'path-absent', path: 'db/x.sql' },
      },
      { severity: 'high', title: 'High one', body: 'b' },
      { severity: 'critical', title: 'Kept', body: 'b' },
    ],
    verifier,
    {
      gitSpawnFn: (_cwd, verb) => ({
        status: verb === 'cat-file' || verb === 'rev-parse' ? 0 : 1,
        stdout: '',
        stderr: '',
      }),
    },
  );
  assert.equal(verifier.prompts.length, 1);
  assert.match(verifier.prompts[0], /Kept/);
  assert.equal(out.verification.attempted, 1);
});

test('#5919 AC-3: a verifier error keeps the halt and adds a degradation', async () => {
  const out = await verifiedRun(
    [{ severity: 'critical', title: 'Bug', body: 'b' }],
    {
      fn: (args) => verifyCriticals({ ...args, probeFn: () => false }),
    },
  );
  assert.equal(out.halted, true);
  assert.equal(out.degraded, true);
  assert.equal(out.degradations[0].tool, 'critical-verifier');
  assert.match(out.report, /critical-verification/);
});

test('#5919: an injected review provider without a verifier is scored as returned', async () => {
  const out = await groundingRun({
    findings: [{ severity: 'critical', title: 'Bug', body: 'b' }],
  });
  assert.equal(out.halted, true);
  assert.equal(out.verification.attempted, 0);
  assert.doesNotMatch(out.report, /Critical verification/);
});

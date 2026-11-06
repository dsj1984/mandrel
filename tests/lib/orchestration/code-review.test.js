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
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { runCodeReview } from '../../../.agents/scripts/lib/orchestration/code-review.js';
import {
  appendReviewRun,
  recordOverriddenIds,
} from '../../../.agents/scripts/lib/orchestration/review-history.js';
import { findingId } from '../../../.agents/scripts/lib/orchestration/review-providers/finding-identity.js';
import { handleOverriddenReviewBlock } from '../../../.agents/scripts/lib/orchestration/single-story-close/phases/review-override.js';
import { makeTempDir } from '../../../.agents/scripts/lib/test-temp.js';

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
    effort: 'low',
    guidance: null,
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

/** Verifier seams whose claude spawn answers `verdict`; records each prompt. */
function stubVerifier(verdict) {
  const prompts = [];
  const seams = {
    probeFn: () => true,
    spawnFn: async (_f, _a, options) => {
      prompts.push(options.input);
      return verdictEnvelope(verdict);
    },
    gitSpawnFn: () => ({ status: 0, stdout: 'a\nb\n', stderr: '' }),
  };
  return { seams, prompts };
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
    verifier: verifier.seams,
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
    { seams: { probeFn: () => false } },
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

function tempDir(t, prefix) {
  const dir = makeTempDir(prefix);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function configWith(codeReview = {}) {
  return () => ({
    project: { baseBranch: 'main' },
    delivery: {
      codeReview: { providers: [{ name: 'native' }], ...codeReview },
    },
  });
}

async function review(adapter, extra = {}) {
  return runCodeReview({
    ticketId: 42,
    headRef: 'story-42',
    baseRef: 'main',
    provider: {},
    changedFiles: [],
    reviewProvider: adapter,
    resolveConfigFn: baseResolveConfig,
    upsertCommentFn: noopUpsert(),
    ...extra,
  });
}

test('guidance: a root REVIEW.md reaches the adapter once; none yields null', async (t) => {
  const cwd = tempDir(t, 'review-guidance-');
  const bare = fakeAdapter([]);
  await review(bare, { cwd });
  assert.equal(bare.calls[0].guidance, null);
  fs.writeFileSync(
    path.join(cwd, 'REVIEW.md'),
    '# Rules\nBound every retry.\n',
  );
  const guided = fakeAdapter([]);
  await review(guided, { cwd });
  assert.equal(guided.calls[0].guidance, '# Rules\nBound every retry.');
});

test('guidance: delivery.codeReview.guidanceFile names the file', async (t) => {
  const cwd = tempDir(t, 'review-guidance-');
  fs.mkdirSync(path.join(cwd, 'docs'));
  fs.writeFileSync(path.join(cwd, 'docs', 'review.md'), 'Custom rules.');
  fs.writeFileSync(path.join(cwd, 'REVIEW.md'), 'Root rules.');
  const adapter = fakeAdapter([]);
  await review(adapter, {
    cwd,
    resolveConfigFn: configWith({ guidanceFile: 'docs/review.md' }),
  });
  assert.equal(adapter.calls[0].guidance, 'Custom rules.');
});

test('AC-2: guidance over 8,000 characters is truncated and records a degradation', async (t) => {
  const cwd = tempDir(t, 'review-guidance-');
  fs.writeFileSync(path.join(cwd, 'REVIEW.md'), 'x'.repeat(8_500));
  const adapter = fakeAdapter([]);
  const out = await review(adapter, { cwd });
  assert.equal(adapter.calls[0].guidance.length, 8_000);
  assert.equal(out.degraded, true);
  const row = out.degradations.find((d) => d.tool === 'review-guidance');
  assert.match(row.reason, /truncated at 8000 characters: 500 characters/);
  assert.match(out.report, /review-guidance/);
});

test('AC-4: a finding on a skipPaths file is dropped before severity is counted, and the report says how many', async () => {
  const adapter = fakeAdapter([
    { severity: 'critical', title: 'gen', body: 'b', file: 'gen/api.js' },
    {
      severity: 'critical',
      title: 'mixed',
      body: 'b',
      file: 'gen/a.js',
      instances: [{ file: 'gen/a.js' }, { file: 'src/a.js', line: 2 }],
    },
    { severity: 'high', title: 'kept', body: 'b', file: 'src/b.js' },
  ]);
  const out = await review(adapter, {
    resolveConfigFn: configWith({ skipPaths: ['gen/**'] }),
  });
  assert.deepEqual(
    out.findings.map((f) => f.title),
    ['mixed', 'kept'],
  );
  assert.equal(out.severity.critical, 1);
  assert.match(out.report, /\*\*Skipped by `skipPaths`\*\*: 1/);
});

function historyOpts(t) {
  const tempRoot = tempDir(t, 'review-history-');
  return { historyDeps: { config: { project: { paths: { tempRoot } } } } };
}

const retryAt = (line, severity = 'critical') => ({
  severity,
  title: 'Unbounded retry',
  body: 'FULL-BODY',
  file: 'src/a.js',
  line,
  class: 'unbounded-retry',
});

test('AC-6: a re-review at a moved head marks the same finding a repeat and renders it collapsed', async (t) => {
  const opts = historyOpts(t);
  const first = await review(fakeAdapter([retryAt(10)]), opts);
  assert.ok(!first.findings[0].repeat);
  assert.match(first.report, /FULL-BODY/);
  const second = await review(fakeAdapter([retryAt(17)]), {
    ...opts,
    headRef: 'story-42-moved',
  });
  assert.equal(second.findings[0].repeat, true);
  assert.doesNotMatch(second.report, /FULL-BODY/);
  assert.match(second.report, /Previously raised \(1\)/);
  const far = await review(fakeAdapter([retryAt(40)]), opts);
  assert.ok(!far.findings[0].repeat, 'outside ±10 lines is a new location');
});

test('AC-7: a repeat of an overridden CRITICAL does not halt; one never overridden still halts', async (t) => {
  const opts = historyOpts(t);
  const first = await review(fakeAdapter([retryAt(10)]), opts);
  assert.equal(first.halted, true);
  const stillBlocking = await review(fakeAdapter([retryAt(12)]), opts);
  assert.equal(stillBlocking.findings[0].repeat, true);
  assert.equal(stillBlocking.halted, true);
  await handleOverriddenReviewBlock({
    provider: {},
    storyId: 42,
    prUrl: 'https://example.test/pr/1',
    prNumber: null,
    criticalCount: 1,
    reason: 'false positive',
    findings: stillBlocking.findings,
    config: opts.historyDeps.config,
    emitFrictionFn: async () => {},
  });
  const afterOverride = await review(fakeAdapter([retryAt(11)]), opts);
  assert.equal(afterOverride.halted, false);
  assert.equal(afterOverride.findings[0].severity, 'suggestion');
  assert.equal(afterOverride.findings[0].ungrounded, 'overridden earlier');
});

// --- Earlier CRITICALs carried forward (Story #5974) -----------------------

const CONFIRMED_AT_HEAD = verdictEnvelope({
  verdict: 'confirmed',
  evidence: { file: 'src/a.js', line: 1 },
  reason: 'still there',
});
const verdictOf = (verdict, reason = 'r') =>
  verdictEnvelope({ verdict, evidence: null, reason });

/**
 * History plus verifier seams; `answers[i]` answers the i-th verifier call
 * (the last repeats). `diffOut` is what `git diff --name-only` prints.
 */
function carryOpts(t, answers, { diffOut = '' } = {}) {
  const prompts = [];
  const opts = {
    ...historyOpts(t),
    verifier: {
      probeFn: () => true,
      spawnFn: async (_f, _a, options) => {
        prompts.push(options.input);
        return answers[Math.min(prompts.length - 1, answers.length - 1)];
      },
      gitSpawnFn: () => ({ status: 0, stdout: 'a\nb\n', stderr: '' }),
    },
    gitSpawnFn: (_cwd, verb) => ({
      status: 0,
      stdout: verb === 'diff' ? diffOut : '',
      stderr: '',
    }),
  };
  return { opts, prompts };
}

const unproven = verdictEnvelope({
  verdict: 'confirmed',
  evidence: { file: 'src/a.js', line: 99 },
  reason: 'r',
});

for (const [name, answer] of [
  ['confirmed', CONFIRMED_AT_HEAD],
  ['uncertain', verdictOf('uncertain')],
  ['an unproven confirmation', unproven],
  ['an error', { status: 1, stdout: '', stderr: 'boom' }],
]) {
  test(`#5974 AC-1: an earlier CRITICAL absent from the next run halts when the re-check returns ${name}`, async (t) => {
    const { opts, prompts } = carryOpts(t, [CONFIRMED_AT_HEAD, answer]);
    const first = await review(fakeAdapter([retryAt(10)]), opts);
    assert.equal(first.halted, true);
    const second = await review(fakeAdapter([]), opts);
    assert.equal(prompts.length, 2);
    assert.equal(second.halted, true);
    assert.equal(second.severity.critical, 1);
    assert.equal(typeof second.findings[0].carried, 'string');
    assert.match(second.report, /Earlier CRITICALs \(1\)/);
    assert.match(second.report, /\*\*still open\*\*/);
    assert.doesNotMatch(second.report, /FULL-BODY/);
    if (name === 'an error' || name === 'an unproven confirmation') {
      assert.match(second.report, /critical-verification/);
    }
  });
}

test('#5974 AC-2: a refuting re-check does not halt, and a later run does not re-check it', async (t) => {
  const { opts, prompts } = carryOpts(t, [
    CONFIRMED_AT_HEAD,
    verdictOf('refuted', 'guarded now'),
  ]);
  await review(fakeAdapter([retryAt(10)]), opts);
  const second = await review(fakeAdapter([]), opts);
  assert.equal(second.halted, false);
  assert.match(second.report, /\*\*refuted\*\*: guarded now/);
  assert.match(second.report, /No findings/);
  const third = await review(fakeAdapter([]), opts);
  assert.equal(third.halted, false);
  assert.equal(prompts.length, 2);
  assert.match(third.report, /\*\*refuted\*\*/);
});

test('#5974: a refuted earlier CRITICAL whose instance files changed is reported fixed', async (t) => {
  const { opts } = carryOpts(t, [CONFIRMED_AT_HEAD, verdictOf('refuted')], {
    diffOut: 'src/a.js\n',
  });
  await review(fakeAdapter([retryAt(10)]), opts);
  const second = await review(fakeAdapter([]), opts);
  assert.equal(second.halted, false);
  assert.match(second.report, /\*\*fixed\*\*/);
});

test('#5974 AC-3: a CRITICAL refuted when raised, ungrounded, or overridden is never re-checked', async (t) => {
  const refutedOpts = carryOpts(t, [verdictOf('refuted')]);
  const first = await review(fakeAdapter([retryAt(10)]), refutedOpts.opts);
  assert.equal(first.halted, false);
  const after = await review(fakeAdapter([]), refutedOpts.opts);
  assert.equal(after.halted, false);
  assert.equal(refutedOpts.prompts.length, 1);

  const ungrounded = carryOpts(t, [CONFIRMED_AT_HEAD]);
  appendReviewRun(
    42,
    { headSha: 'x', findings: [{ ...retryAt(10), ungrounded: 'gone' }] },
    ungrounded.opts.historyDeps,
  );
  const clean = await review(fakeAdapter([]), ungrounded.opts);
  assert.equal(clean.halted, false);
  assert.equal(ungrounded.prompts.length, 0);

  const overridden = carryOpts(t, [CONFIRMED_AT_HEAD]);
  const halted = await review(fakeAdapter([retryAt(10)]), overridden.opts);
  recordOverriddenIds(42, [findingId(halted.findings[0])], {
    config: overridden.opts.historyDeps.config,
  });
  const cleared = await review(fakeAdapter([]), overridden.opts);
  assert.equal(cleared.halted, false);
  assert.equal(overridden.prompts.length, 1);
  assert.match(cleared.report, /\*\*overridden\*\*/);
});

test('#5974 AC-4: a carried CRITICAL stays open on the next run until an override clears it', async (t) => {
  const { opts, prompts } = carryOpts(t, [CONFIRMED_AT_HEAD]);
  await review(fakeAdapter([retryAt(10)]), opts);
  await review(fakeAdapter([]), opts);
  const third = await review(fakeAdapter([]), opts);
  assert.equal(third.halted, true);
  assert.equal(prompts.length, 3);
  await handleOverriddenReviewBlock({
    provider: {},
    storyId: 42,
    prUrl: 'https://example.test/pr/1',
    prNumber: null,
    criticalCount: 1,
    reason: 'false positive',
    findings: third.findings,
    config: opts.historyDeps.config,
    emitFrictionFn: async () => {},
  });
  const fourth = await review(fakeAdapter([]), opts);
  assert.equal(fourth.halted, false);
  assert.equal(prompts.length, 3);
});

test('#5974 AC-7: a CRITICAL raised again at an overlapping location is not re-checked', async (t) => {
  const { opts, prompts } = carryOpts(t, [CONFIRMED_AT_HEAD]);
  await review(fakeAdapter([retryAt(10)]), opts);
  const second = await review(fakeAdapter([retryAt(14)]), opts);
  assert.equal(second.halted, true);
  assert.equal(second.findings.length, 1);
  assert.equal(second.findings[0].repeat, true);
  assert.equal(prompts.length, 2, 'one vetting call per run, no re-check');
  assert.match(second.report, /\*\*still open\*\*/);
});

test('#5974 AC-9: without a history seam an earlier CRITICAL is not carried', async (t) => {
  const { opts } = carryOpts(t, [CONFIRMED_AT_HEAD]);
  await review(fakeAdapter([retryAt(10)]), opts);
  const { historyDeps: _ignored, ...noHistory } = opts;
  const out = await review(fakeAdapter([]), noHistory);
  assert.equal(out.halted, false);
  assert.doesNotMatch(out.report, /Earlier CRITICALs/);
});

test('#5976: the effort resolves from depth once; effortByDepth overrides only its own depth', async () => {
  const efforts = async (codeReview, changedFileCount) => {
    const adapter = fakeAdapter([]);
    await review(adapter, {
      changedFileCount,
      resolveConfigFn: configWith(codeReview),
    });
    const { depth, effort } = adapter.calls[0];
    return [depth, effort];
  };
  assert.deepEqual(await efforts({}, 31), ['deep', 'high']);
  assert.deepEqual(await efforts({}, 20), ['standard', 'low']);
  const config = { effortByDepth: { standard: 'medium' } };
  assert.deepEqual(await efforts(config, 20), ['standard', 'medium']);
  assert.deepEqual(await efforts(config, 31), ['deep', 'high']);
  const deepMax = { effortByDepth: { deep: 'max' } };
  assert.deepEqual(await efforts(deepMax, 31), ['deep', 'max']);
});

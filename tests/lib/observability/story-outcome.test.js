/**
 * story-outcome.js: the opt-in per-Story outcome record upserted on every
 * close and confirm-merge terminal (Story #5977).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { Logger } from '../../../.agents/scripts/lib/Logger.js';
import {
  parseOutcomeBody,
  recordStoryOutcome,
} from '../../../.agents/scripts/lib/observability/story-outcome.js';
import { emitTerminal } from '../../../.agents/scripts/lib/orchestration/single-story-close/result.js';
import { structuredCommentMarker } from '../../../.agents/scripts/lib/orchestration/ticketing/reads.js';
import { makeTempDir } from '../../../.agents/scripts/lib/test-temp.js';
import { runConfirmMerge } from '../../../.agents/scripts/single-story-confirm-merge.js';

const STORY = 4242;
const MARKER = structuredCommentMarker('story-outcome');

function fakeProvider(seed = []) {
  let nextId = 900;
  const comments = seed.map((body) => ({
    id: nextId++,
    ticketId: STORY,
    body,
  }));
  const calls = [];
  return {
    comments,
    calls,
    async getTicketComments(id) {
      calls.push('read');
      return comments.filter((c) => c.ticketId === id).map((c) => ({ ...c }));
    },
    async postComment(id, { body }) {
      calls.push('write');
      const c = { id: nextId++, ticketId: id, body };
      comments.push(c);
      return { commentId: c.id };
    },
    async deleteComment(cid) {
      calls.push('delete');
      comments.splice(
        comments.findIndex((c) => c.id === cid),
        1,
      );
    },
  };
}

function config(t, outcomeRecord = true) {
  const tempRoot = makeTempDir('story-outcome-');
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  return {
    project: { paths: { tempRoot } },
    delivery: { feedbackLoop: { outcomeRecord } },
  };
}

const envelope = (status, extra = {}) => ({
  storyId: STORY,
  status,
  phase: status === 'landed' ? 'done' : 'confirm-merge',
  elapsedSeconds: 60,
  ...extra,
});

const record = (args, overrides = {}) =>
  recordStoryOutcome({
    tool: 'single-story-close',
    readFn: async () => {},
    mandrelVersion: '2.120.0',
    ...args,
    ...overrides,
  });

function onlyRecord(provider) {
  const outcome = provider.comments.filter((c) => c.body.includes(MARKER));
  assert.equal(outcome.length, 1, 'exactly one story-outcome comment');
  return parseOutcomeBody(outcome[0].body);
}

test('toggle off: close and confirm-merge make no outcome-record call (AC-1)', async (t) => {
  const provider = fakeProvider();
  const cfg = config(t, false);
  await emitTerminal({
    terminal: envelope('blocked', { blocked: { blockClass: 'checks-failed' } }),
    result: { storyId: STORY },
    config: cfg,
    provider,
  });
  const outcome = await runConfirmMerge({
    storyId: STORY,
    injectedConfig: cfg,
    injectedProvider: provider,
    injectedGh: { pr: { list: async () => [] } },
  });
  assert.equal(outcome.terminal.status, 'pending');
  assert.deepEqual(provider.calls, []);
});

test('confirm-merge records its terminal when the toggle is on', async (t) => {
  const provider = fakeProvider();
  await runConfirmMerge({
    storyId: STORY,
    injectedConfig: config(t),
    injectedProvider: provider,
    injectedGh: { pr: { list: async () => [] } },
  });
  const rec = onlyRecord(provider);
  assert.equal(rec.attempts[0].tool, 'single-story-confirm-merge');
  assert.equal(rec.summary.byStatus.pending, 1);
});

test('blocked then landed leaves one comment with summed counts (AC-2)', async (t) => {
  const provider = fakeProvider();
  const cfg = config(t);
  const gates = {
    validation: 'failed',
    codeReview: 'skipped',
    baseSync: 'failed',
  };
  await record({
    envelope: envelope('blocked', {
      gates,
      blocked: { blockClass: 'checks-failed' },
    }),
    config: cfg,
    provider,
  });
  await record({
    envelope: envelope('landed', { pr: { number: 7 } }),
    config: cfg,
    provider,
  });
  const rec = onlyRecord(provider);
  assert.equal(rec.summary.attempts, 2);
  assert.equal(rec.summary.byStatus.blocked, 1);
  assert.equal(rec.summary.byStatus.landed, 1);
  assert.equal(rec.summary.firstPass, false);
  assert.equal(rec.summary.landedOnAttempt, 2);
  assert.deepEqual(rec.attempts[0].failedGates, ['baseSync', 'validation']);
  assert.equal(rec.attempts[0].cause, 'ci-red');
  assert.equal(rec.attempts[1].prNumber, 7);
  assert.deepEqual(rec.summary.failedGates, { baseSync: 1, validation: 1 });
});

test('an attempt lists the gates its envelope deferred (Story #6050)', async (t) => {
  const provider = fakeProvider();
  await record({
    envelope: envelope('pending', {
      gates: {
        validation: 'passed',
        lint: 'deferred',
        'coverage-capture': 'deferred',
        typecheck: 'deferred',
      },
    }),
    config: config(t),
    provider,
  });
  const [attempt] = onlyRecord(provider).attempts;
  assert.deepEqual(attempt.deferredGates, [
    'coverage-capture',
    'lint',
    'typecheck',
  ]);
  assert.deepEqual(attempt.failedGates, []);
});

test('a prior record from another machine keeps its counts (AC-3)', async (t) => {
  const other = fakeProvider();
  const cfg = config(t);
  for (const status of ['blocked', 'blocked', 'pending']) {
    await record({
      envelope: envelope(status),
      config: cfg,
      provider: other,
      mandrelVersion: '2.119.0',
      readFn: async (_e, _s, cb) =>
        cb({ kind: 'acceptance-eval', details: { round: 3 } }),
    });
  }
  const provider = fakeProvider([other.comments[0].body]);
  await record({ envelope: envelope('landed'), config: config(t), provider });
  const rec = onlyRecord(provider);
  assert.equal(rec.summary.attempts, 4);
  assert.equal(rec.summary.byStatus.blocked, 2);
  assert.equal(rec.summary.byStatus.landed, 1);
  assert.equal(rec.summary.acceptanceRounds, 3);
  assert.deepEqual(rec.summary.mandrelVersions, ['2.119.0', '2.120.0']);
});

test('pending then landed is first-pass; a re-run adds no landing (AC-4)', async (t) => {
  const provider = fakeProvider();
  const cfg = config(t);
  await record({ envelope: envelope('pending'), config: cfg, provider });
  const landed = {
    envelope: envelope('landed'),
    config: cfg,
    provider,
    tool: 'single-story-confirm-merge',
  };
  assert.equal(await record(landed), true);
  assert.equal(await record(landed), false);
  const rec = onlyRecord(provider);
  assert.equal(rec.summary.firstPass, true);
  assert.equal(rec.summary.attempts, 2);
  assert.equal(rec.summary.byStatus.landed, 1);
});

test('no record for an escalated envelope or an already-closed no-op (AC-5)', async (t) => {
  const provider = fakeProvider();
  const cfg = config(t);
  await record({
    envelope: { storyId: null, status: 'escalated' },
    config: cfg,
    provider,
  });
  for (const reason of ['already-closed', 'closed-not-planned']) {
    await record({
      envelope: envelope('landed'),
      result: { reason },
      config: cfg,
      provider,
    });
  }
  assert.deepEqual(provider.calls, []);
});

test('a write failure warns once and leaves the envelope alone (AC-6)', async (t) => {
  const provider = fakeProvider();
  provider.postComment = async () => {
    throw new Error('HTTP 502');
  };
  const warn = t.mock.method(Logger, 'warn', () => {});
  const terminal = envelope('blocked', {
    blocked: { blockClass: 'checks-failed' },
  });
  const before = structuredClone(terminal);
  await emitTerminal({ terminal, result: null, config: config(t), provider });
  assert.deepEqual(terminal, before);
  const outcomeWarnings = warn.mock.calls.filter((c) =>
    String(c.arguments[0]).includes('[story-outcome]'),
  );
  assert.equal(outcomeWarnings.length, 1);
  assert.match(outcomeWarnings[0].arguments[0], /#4242.*HTTP 502/);
});

test('an unparsable prior record is replaced and the warning says so (AC-6)', async (t) => {
  const provider = fakeProvider([`${MARKER}\n\n\`\`\`json\n{not json\n\`\`\``]);
  const warn = t.mock.method(Logger, 'warn', () => {});
  assert.equal(
    await record({ envelope: envelope('failed'), config: config(t), provider }),
    true,
  );
  const rec = onlyRecord(provider);
  assert.equal(rec.summary.attempts, 1);
  assert.equal(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments[0], /replaced/);
});

test('review halts count only inside this invocation window', async (t) => {
  const provider = fakeProvider();
  const nowMs = Date.now();
  const rows = [
    {
      kind: 'friction',
      category: 'review-blocked',
      ts: new Date(nowMs - 10_000).toISOString(),
    },
    {
      kind: 'friction',
      category: 'review-blocked',
      ts: new Date(nowMs - 3_600_000).toISOString(),
    },
    {
      kind: 'friction',
      category: 'review-block-overridden',
      ts: new Date(nowMs - 5_000).toISOString(),
    },
    { kind: 'acceptance-eval', details: { round: 2 } },
  ];
  await record({
    envelope: envelope('blocked'),
    config: config(t),
    provider,
    worker: { workerModel: 'opus', workerTokens: 1200 },
    readFn: async (_e, _s, cb) => {
      for (const r of rows) cb(r);
    },
  });
  const [attempt] = onlyRecord(provider).attempts;
  assert.equal(attempt.reviewHalts, 1);
  assert.equal(attempt.reviewOverrides, 1);
  assert.equal(attempt.workerModel, 'opus');
  assert.equal(attempt.workerTokens, 1200);
  assert.equal(onlyRecord(provider).summary.acceptanceRounds, 2);
});

test('attempts are capped at 100 while counters carry forward', async (t) => {
  const provider = fakeProvider();
  const cfg = config(t);
  const gates = { lint: 'failed' };
  for (let i = 0; i < 105; i++) {
    await record({
      envelope: envelope('failed', { gates }),
      config: cfg,
      provider,
    });
  }
  const rec = onlyRecord(provider);
  assert.equal(rec.attempts.length, 100);
  assert.equal(rec.summary.attempts, 105);
  assert.equal(rec.summary.byStatus.failed, 105);
  assert.equal(rec.summary.failedGates.lint, 105);
});

test('a near-limit record is trimmed by size so the post fits and counters hold', async (t) => {
  const gateNames = [
    'validation',
    'baseSync',
    'codeReview',
    'check-baselines',
    'check-baselines-independent',
    'check-baselines-coverage',
  ];
  const attempt = {
    ts: '2026-01-01T00:00:00.000Z',
    tool: 'single-story-close',
    status: 'failed',
    phase: 'close-validation',
    failedGates: gateNames,
    workerModel: 'm'.repeat(300),
  };
  const prior = {
    schemaVersion: 1,
    storyId: STORY,
    attempts: Array.from({ length: 100 }, () => attempt),
    summary: {
      attempts: 100,
      byStatus: { failed: 100 },
      failedGates: Object.fromEntries(gateNames.map((g) => [g, 100])),
    },
  };
  const provider = fakeProvider([
    `${MARKER}\n\n\`\`\`json\n${JSON.stringify(prior, null, 2)}\n\`\`\``,
  ]);
  const post = provider.postComment;
  provider.postComment = async (id, payload) => {
    if (payload.body.length > 65536) throw new Error('422 body too long');
    return post(id, payload);
  };
  const gates = Object.fromEntries(gateNames.map((g) => [g, 'failed']));
  const wrote = await record({
    envelope: envelope('failed', { gates }),
    config: config(t),
    provider,
    worker: { workerModel: 'w'.repeat(5000) },
  });
  assert.equal(wrote, true);
  const body = provider.comments.find((c) => c.body.includes(MARKER)).body;
  assert.ok(body.length < 65536);
  const rec = onlyRecord(provider);
  assert.equal(rec.summary.attempts, 101);
  for (const g of gateNames) assert.equal(rec.summary.failedGates[g], 101);
  assert.equal(rec.attempts.at(-1).workerModel.length, 200);
});

test('each attempt records the mandrel version at the project root, or null (AC-7)', async (t) => {
  const root = makeTempDir('story-outcome-version-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = config(t);
  const versionAfter = async () => {
    const provider = fakeProvider();
    await record({
      envelope: envelope('pending'),
      config: cfg,
      provider,
      cwd: root,
      mandrelVersion: undefined,
    });
    return onlyRecord(provider).attempts[0].mandrelVersion;
  };
  assert.equal(await versionAfter(), null);
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'consumer', version: '1.0.0' }),
  );
  assert.equal(await versionAfter(), null);
  fs.mkdirSync(path.join(root, 'node_modules', 'mandrel'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'node_modules', 'mandrel', 'package.json'),
    JSON.stringify({ name: 'mandrel', version: '2.118.0' }),
  );
  assert.equal(await versionAfter(), '2.118.0');
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'mandrel', version: '2.121.0' }),
  );
  assert.equal(await versionAfter(), '2.121.0');
});

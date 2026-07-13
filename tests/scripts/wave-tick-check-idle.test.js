/**
 * wave-tick-check-idle.test.js — Story #3061 Task #3070.
 *
 * Exercises `wave-tick.js --check-idle <minutes>` against a synthetic
 * `temp/epic-<id>/lifecycle.ndjson` ledger fixture. Asserts:
 *
 *   - the in-process `runCheckIdle` helper computes per-Story idle
 *     deltas correctly,
 *   - the emitted envelope matches the `wave-stall` structured-comment
 *     payload shape (kind, epicId, thresholdMinutes, checkedAt, stalled,
 *     inFlight),
 *   - the CLI exits non-zero when a stalled in-flight Story is found
 *     and exit 0 when every in-flight Story has a recent event.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  branchLastCommitMs,
  buildWaveStallEnvelope,
  readLedgerLastEvents,
  readLedgerSliceEvents,
  runCheckIdle,
} from '../../.agents/scripts/wave-tick.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WAVE_TICK_CLI = path.join(
  REPO_ROOT,
  '.agents',
  'scripts',
  'wave-tick.js',
);

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wave-tick-check-idle-'));
}

function writeLedger(ledgerPath, records) {
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(
    ledgerPath,
    `${records.map((r) => JSON.stringify(r)).join('\n')}\n`,
    'utf8',
  );
}

function emitted(event, payload, ts) {
  return { kind: 'emitted', ts, event, payload };
}

test('readLedgerLastEvents skips ended stories and tracks latest ts', () => {
  const tmp = makeTmpDir();
  const ledger = path.join(tmp, 'lifecycle.ndjson');
  writeLedger(ledger, [
    emitted(
      'story.dispatch.start',
      { storyId: 100, epicId: 9 },
      '2026-05-26T19:00:00.000Z',
    ),
    emitted(
      'story.heartbeat',
      { storyId: 100, epicId: 9, taskId: 1, phase: 'implementing' },
      '2026-05-26T19:05:00.000Z',
    ),
    emitted(
      'story.dispatch.start',
      { storyId: 101, epicId: 9 },
      '2026-05-26T18:50:00.000Z',
    ),
    emitted(
      'story.dispatch.end',
      { storyId: 101, epicId: 9 },
      '2026-05-26T18:55:00.000Z',
    ),
  ]);

  const events = readLedgerLastEvents(ledger);

  // Story 101 has matching end — must be excluded.
  assert.equal(events.has(101), false);
  // Story 100 in-flight; latest ts wins.
  assert.equal(events.get(100), '2026-05-26T19:05:00.000Z');
});

test('readLedgerLastEvents returns empty map when ledger missing', () => {
  const tmp = makeTmpDir();
  const ledger = path.join(tmp, 'lifecycle.ndjson'); // never written
  const events = readLedgerLastEvents(ledger);
  assert.equal(events.size, 0);
});

test('buildWaveStallEnvelope reports stalled stories past threshold', () => {
  const lastEvents = new Map([
    [100, '2026-05-26T19:00:00.000Z'], // 15 min ago → stalled at 10
    [101, '2026-05-26T19:13:00.000Z'], // 2 min ago → fresh at 10
  ]);
  const envelope = buildWaveStallEnvelope({
    epicId: 9,
    thresholdMinutes: 10,
    lastEvents,
    now: new Date('2026-05-26T19:15:00.000Z'),
    // No branch activity for either Story → ledger staleness governs.
    branchActivity: () => null,
  });

  assert.equal(envelope.kind, 'wave-stall');
  assert.equal(envelope.epicId, 9);
  assert.equal(envelope.thresholdMinutes, 10);
  assert.equal(envelope.checkedAt, '2026-05-26T19:15:00.000Z');
  assert.deepEqual(envelope.inFlight, [100, 101]);
  assert.deepEqual(envelope.stalled, [
    {
      storyId: 100,
      lastEventAt: '2026-05-26T19:00:00.000Z',
      idleMinutes: 15,
    },
  ]);
});

test('buildWaveStallEnvelope: recent branch commit downgrades a ledger-idle Story (Story #3900)', () => {
  const now = new Date('2026-05-26T19:15:00.000Z');
  const lastEvents = new Map([
    [100, '2026-05-26T19:00:00.000Z'], // 15 min idle in the ledger
  ]);
  // Branch committed 2 minutes ago — healthy long-running Story.
  const recentCommitMs = now.getTime() - 2 * 60 * 1000;
  const envelope = buildWaveStallEnvelope({
    epicId: 9,
    thresholdMinutes: 10,
    lastEvents,
    now,
    branchActivity: (storyId) => (storyId === 100 ? recentCommitMs : null),
  });

  // Still in-flight, but NOT stalled — no spurious re-dispatch.
  assert.deepEqual(envelope.inFlight, [100]);
  assert.deepEqual(envelope.stalled, []);
});

test('buildWaveStallEnvelope: stale branch commit still flags a stalled Story (Story #3900)', () => {
  const now = new Date('2026-05-26T19:15:00.000Z');
  const lastEvents = new Map([[100, '2026-05-26T19:00:00.000Z']]);
  // Branch last committed 40 minutes ago — past threshold → genuinely stalled.
  const staleCommitMs = now.getTime() - 40 * 60 * 1000;
  const envelope = buildWaveStallEnvelope({
    epicId: 9,
    thresholdMinutes: 10,
    lastEvents,
    now,
    branchActivity: () => staleCommitMs,
  });

  assert.equal(envelope.stalled.length, 1);
  assert.equal(envelope.stalled[0].storyId, 100);
});

test('runCheckIdle: a recent branch commit clears the stall (Story #3900)', () => {
  const tmp = makeTmpDir();
  const ledger = path.join(tmp, 'lifecycle.ndjson');
  writeLedger(ledger, [
    emitted(
      'story.dispatch.start',
      { storyId: 300, epicId: 9 },
      '2026-05-26T18:00:00.000Z',
    ),
  ]);
  const now = new Date('2026-05-26T19:00:00.000Z');
  const { stalledCount, envelope } = runCheckIdle({
    epicId: 9,
    thresholdMinutes: 10,
    ledgerPath: ledger,
    now,
    branchActivity: () => now.getTime() - 60 * 1000, // committed 1 min ago
  });
  assert.equal(stalledCount, 0);
  assert.deepEqual(envelope.inFlight, [300]);
});

test('branchLastCommitMs returns null for an absent branch / git error', () => {
  const throwingExec = () => {
    throw new Error('unknown revision');
  };
  assert.equal(branchLastCommitMs(999999, { exec: throwingExec }), null);
});

test('branchLastCommitMs parses %cI output into epoch-ms', () => {
  const iso = '2026-05-26T19:00:00.000Z';
  const fakeExec = () => `${iso}\n`;
  assert.equal(branchLastCommitMs(7, { exec: fakeExec }), Date.parse(iso));
});

test('runCheckIdle reports stalled in-flight story (non-zero stalledCount)', () => {
  const tmp = makeTmpDir();
  const ledger = path.join(tmp, 'lifecycle.ndjson');
  writeLedger(ledger, [
    emitted(
      'story.dispatch.start',
      { storyId: 200, epicId: 9 },
      '2026-05-26T18:00:00.000Z',
    ),
  ]);

  const { envelope, stalledCount } = runCheckIdle({
    epicId: 9,
    thresholdMinutes: 10,
    ledgerPath: ledger,
    now: new Date('2026-05-26T19:00:00.000Z'),
  });

  assert.equal(stalledCount, 1);
  assert.equal(envelope.stalled[0].storyId, 200);
  assert.ok(envelope.stalled[0].idleMinutes >= 10);
});

test('runCheckIdle returns zero stalled when recent heartbeat present', () => {
  const tmp = makeTmpDir();
  const ledger = path.join(tmp, 'lifecycle.ndjson');
  writeLedger(ledger, [
    emitted(
      'story.dispatch.start',
      { storyId: 201, epicId: 9 },
      '2026-05-26T18:00:00.000Z',
    ),
    emitted(
      'story.heartbeat',
      { storyId: 201, epicId: 9, taskId: 7, phase: 'implementing' },
      '2026-05-26T18:58:00.000Z',
    ),
  ]);

  const { envelope, stalledCount } = runCheckIdle({
    epicId: 9,
    thresholdMinutes: 10,
    ledgerPath: ledger,
    now: new Date('2026-05-26T19:00:00.000Z'),
  });

  assert.equal(stalledCount, 0);
  assert.deepEqual(envelope.stalled, []);
  assert.deepEqual(envelope.inFlight, [201]);
});

// ── Single-delivery slice liveness (Epic #4476, M5) ──────────────────────

test('readLedgerSliceEvents tracks in-flight slices and skips ended ones', () => {
  const tmp = makeTmpDir();
  const ledger = path.join(tmp, 'lifecycle.ndjson');
  writeLedger(ledger, [
    emitted(
      'slice.start',
      { epicId: 9, sliceId: 'slice-1' },
      '2026-05-26T19:00:00.000Z',
    ),
    emitted(
      'slice.heartbeat',
      { epicId: 9, sliceId: 'slice-1', phase: 'implementing' },
      '2026-05-26T19:05:00.000Z',
    ),
    emitted(
      'slice.start',
      { epicId: 9, sliceId: 'slice-2' },
      '2026-05-26T18:50:00.000Z',
    ),
    emitted(
      'slice.end',
      { epicId: 9, sliceId: 'slice-2', outcome: 'done' },
      '2026-05-26T18:55:00.000Z',
    ),
  ]);

  const events = readLedgerSliceEvents(ledger);
  // slice-2 has a matching end — excluded.
  assert.equal(events.has('slice-2'), false);
  // slice-1 in-flight; the heartbeat is its latest event.
  assert.equal(events.get('slice-1'), '2026-05-26T19:05:00.000Z');
});

test('buildWaveStallEnvelope flags a stalled slice and leaves story fields empty', () => {
  const now = new Date('2026-05-26T19:15:00.000Z');
  const sliceEvents = new Map([['slice-1', '2026-05-26T19:00:00.000Z']]); // 15m idle
  const envelope = buildWaveStallEnvelope({
    epicId: 9,
    thresholdMinutes: 10,
    lastEvents: new Map(),
    now,
    sliceEvents,
    // No commit on epic-9 → ledger staleness governs.
    epicBranchActivity: () => null,
  });
  assert.deepEqual(envelope.inFlight, []);
  assert.deepEqual(envelope.stalled, []);
  assert.deepEqual(envelope.inFlightSlices, ['slice-1']);
  assert.equal(envelope.stalledSlices.length, 1);
  assert.equal(envelope.stalledSlices[0].sliceId, 'slice-1');
});

test('buildWaveStallEnvelope: a recent epic-branch commit clears a slice stall', () => {
  const now = new Date('2026-05-26T19:15:00.000Z');
  const sliceEvents = new Map([['slice-1', '2026-05-26T19:00:00.000Z']]);
  const recentCommitMs = now.getTime() - 60 * 1000; // committed 1m ago
  const envelope = buildWaveStallEnvelope({
    epicId: 9,
    thresholdMinutes: 10,
    lastEvents: new Map(),
    now,
    sliceEvents,
    epicBranchActivity: () => recentCommitMs,
  });
  assert.deepEqual(envelope.stalledSlices, []);
  assert.deepEqual(envelope.inFlightSlices, ['slice-1']);
});

test('runCheckIdle: a fresh hook-emitted slice.heartbeat clears the single-delivery stall', () => {
  const tmp = makeTmpDir();
  const ledger = path.join(tmp, 'lifecycle.ndjson');
  const now = new Date('2026-05-26T19:15:00.000Z');
  writeLedger(ledger, [
    emitted(
      'slice.start',
      { epicId: 9, sliceId: 'slice-1' },
      '2026-05-26T18:00:00.000Z',
    ),
    // Hook-emitted heartbeat 2 minutes ago → session is alive.
    emitted(
      'slice.heartbeat',
      { epicId: 9, sliceId: 'slice-1', phase: 'implementing' },
      new Date(now.getTime() - 2 * 60 * 1000).toISOString(),
    ),
  ]);
  const { stalledCount, envelope } = runCheckIdle({
    epicId: 9,
    thresholdMinutes: 10,
    ledgerPath: ledger,
    now,
    epicBranchActivity: () => null,
  });
  assert.equal(stalledCount, 0);
  assert.deepEqual(envelope.inFlightSlices, ['slice-1']);
});

test('runCheckIdle: a silent single-delivery slice is flagged (non-zero stalledCount)', () => {
  const tmp = makeTmpDir();
  const ledger = path.join(tmp, 'lifecycle.ndjson');
  writeLedger(ledger, [
    emitted(
      'slice.start',
      { epicId: 9, sliceId: 'slice-1' },
      '2026-05-26T18:00:00.000Z',
    ),
  ]);
  const { stalledCount, envelope } = runCheckIdle({
    epicId: 9,
    thresholdMinutes: 10,
    ledgerPath: ledger,
    now: new Date('2026-05-26T19:00:00.000Z'),
    epicBranchActivity: () => null,
  });
  assert.equal(stalledCount, 1);
  assert.equal(envelope.stalledSlices[0].sliceId, 'slice-1');
});

function makeIsolatedRoot() {
  const root = makeTmpDir();
  // Minimal .agentrc.json so the CLI's resolveConfig finds tempRoot. The
  // resolver validates against the schema, so we mirror the production
  // shape exactly.
  const tempRoot = path.join(root, 'temp');
  fs.mkdirSync(tempRoot, { recursive: true });
  fs.writeFileSync(
    path.join(root, '.agentrc.json'),
    JSON.stringify(
      {
        $schema: path.join(
          REPO_ROOT,
          '.agents',
          'schemas',
          'agentrc.schema.json',
        ),
        project: {
          paths: {
            agentRoot: path.join(REPO_ROOT, '.agents'),
            docsRoot: 'docs',
            tempRoot,
          },
        },
        github: { owner: 'test', repo: 'test' },
      },
      null,
      2,
    ),
    'utf8',
  );
  return { root, tempRoot };
}

test('CLI: --check-idle exits non-zero when a stalled in-flight Story exists', () => {
  const { root, tempRoot } = makeIsolatedRoot();
  const epicId = 9991;
  const ledger = path.join(tempRoot, `epic-${epicId}`, 'lifecycle.ndjson');
  // Backdate the start far enough that "now" (real wall clock) is past
  // the threshold regardless of test schedule.
  const longAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  writeLedger(ledger, [
    emitted('story.dispatch.start', { storyId: 4242, epicId }, longAgo),
  ]);

  const result = spawnSync(
    process.execPath,
    [WAVE_TICK_CLI, '--epic', String(epicId), '--check-idle', '5'],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, AGENT_LOG_LEVEL: 'silent' },
    },
  );

  assert.equal(
    result.status,
    1,
    `expected exit 1 on stalled Story, got ${result.status}; stderr=${result.stderr}`,
  );
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.kind, 'wave-stall');
  assert.equal(envelope.epicId, epicId);
  assert.equal(envelope.thresholdMinutes, 5);
  assert.equal(envelope.stalled.length, 1);
  assert.equal(envelope.stalled[0].storyId, 4242);
});

test('CLI: --check-idle exits 0 when in-flight Story has recent event', () => {
  const { root, tempRoot } = makeIsolatedRoot();
  const epicId = 9992;
  const ledger = path.join(tempRoot, `epic-${epicId}`, 'lifecycle.ndjson');
  const fresh = new Date(Date.now() - 1000).toISOString();
  writeLedger(ledger, [
    emitted(
      'story.dispatch.start',
      { storyId: 5151, epicId },
      new Date(Date.now() - 2000).toISOString(),
    ),
    emitted(
      'story.heartbeat',
      { storyId: 5151, epicId, taskId: 1, phase: 'implementing' },
      fresh,
    ),
  ]);

  const result = spawnSync(
    process.execPath,
    [WAVE_TICK_CLI, '--epic', String(epicId), '--check-idle', '10'],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, AGENT_LOG_LEVEL: 'silent' },
    },
  );

  assert.equal(
    result.status,
    0,
    `expected exit 0 on fresh Story, got ${result.status}; stderr=${result.stderr}`,
  );
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.kind, 'wave-stall');
  assert.equal(envelope.stalled.length, 0);
  assert.deepEqual(envelope.inFlight, [5151]);
});

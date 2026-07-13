/**
 * hook-heartbeat.test.js — Epic #4476 (M5): heartbeats OFF the token stream.
 *
 * The `story.heartbeat` / `slice.heartbeat` forward-progress signal the
 * `/deliver` §2e Idle Watchdog reads used to be an LLM obligation (a
 * per-step `story-phase.js` / `slice-phase.js --event heartbeat` turn). M5
 * moves that emission into the PostToolUse trace hook so it is a free
 * byproduct of any tool call.
 *
 * These tests pin the three load-bearing contracts:
 *   1. target resolution off the active-Story / active-slice env vars,
 *   2. the cross-process throttle (marker mtime),
 *   3. the HARD constraint: a hook-emitted heartbeat lands in the SAME
 *      `lifecycle.ndjson` the watchdog reads, and `readLedgerLastEvents` /
 *      `runCheckIdle` treat it as liveness — i.e. the watchdog still sees a
 *      heartbeat under the new mechanism.
 */

import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  emitHeartbeatFromHook,
  heartbeatMarkerName,
  resolveHeartbeatTarget,
  shouldEmitHeartbeat,
} from '../../../.agents/scripts/lib/observability/hook-heartbeat.js';
import {
  readLedgerLastEvents,
  runCheckIdle,
} from '../../../.agents/scripts/wave-tick.js';

let tempRoot;
let config;

function ledgerPathFor(epicId) {
  return path.join(tempRoot, `epic-${epicId}`, 'lifecycle.ndjson');
}

beforeEach(() => {
  tempRoot = mkdtempSync(path.join(tmpdir(), 'hook-heartbeat-'));
  config = { project: { paths: { tempRoot } } };
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('resolveHeartbeatTarget', () => {
  it('resolves a fan-out Story target from CC_EPIC_ID + CC_STORY_ID', () => {
    const t = resolveHeartbeatTarget({ CC_EPIC_ID: '42', CC_STORY_ID: '99' });
    assert.deepEqual(t, { kind: 'story', epicId: 42, storyId: 99 });
  });

  it('resolves a single-delivery slice target from CC_EPIC_ID + CC_SLICE_ID', () => {
    const t = resolveHeartbeatTarget({
      CC_EPIC_ID: '42',
      CC_SLICE_ID: 'slice-3',
    });
    assert.deepEqual(t, { kind: 'slice', epicId: 42, sliceId: 'slice-3' });
  });

  it('carries the operator handle when CC_OPERATOR is set', () => {
    const t = resolveHeartbeatTarget({
      CC_EPIC_ID: '42',
      CC_STORY_ID: '99',
      CC_OPERATOR: 'octocat',
    });
    assert.equal(t.operator, 'octocat');
  });

  it('returns null for a standalone Story (no parent Epic)', () => {
    // story.heartbeat's schema pins epicId >= 1 — no Epic ledger to write to.
    assert.equal(resolveHeartbeatTarget({ CC_STORY_ID: '99' }), null);
  });

  it('returns null when neither story nor slice context is present', () => {
    assert.equal(resolveHeartbeatTarget({ CC_EPIC_ID: '42' }), null);
    assert.equal(resolveHeartbeatTarget({}), null);
  });

  it('prefers Story over slice when both are set', () => {
    const t = resolveHeartbeatTarget({
      CC_EPIC_ID: '42',
      CC_STORY_ID: '99',
      CC_SLICE_ID: 'slice-3',
    });
    assert.equal(t.kind, 'story');
  });
});

describe('shouldEmitHeartbeat (throttle)', () => {
  it('emits when the marker is missing', () => {
    assert.equal(
      shouldEmitHeartbeat({
        markerPath: path.join(tempRoot, 'nope'),
        now: new Date(),
        intervalMs: 60_000,
      }),
      true,
    );
  });

  it('suppresses when the marker mtime is within the interval', () => {
    const now = new Date('2026-07-13T12:00:00.000Z');
    const statFn = () => ({ mtimeMs: now.getTime() - 10_000 });
    assert.equal(
      shouldEmitHeartbeat({
        markerPath: 'x',
        now,
        intervalMs: 60_000,
        statFn,
      }),
      false,
    );
  });

  it('emits again once the marker mtime is older than the interval', () => {
    const now = new Date('2026-07-13T12:00:00.000Z');
    const statFn = () => ({ mtimeMs: now.getTime() - 90_000 });
    assert.equal(
      shouldEmitHeartbeat({
        markerPath: 'x',
        now,
        intervalMs: 60_000,
        statFn,
      }),
      true,
    );
  });
});

describe('heartbeatMarkerName', () => {
  it('sanitises a slice id into a filesystem-safe basename', () => {
    assert.equal(
      heartbeatMarkerName({ kind: 'slice', sliceId: 'slice/../1' }),
      '.heartbeat-slice-slice_.._1',
    );
  });
});

describe('emitHeartbeatFromHook', () => {
  it('appends a story.heartbeat to the Epic lifecycle ledger', () => {
    const res = emitHeartbeatFromHook({
      env: { CC_EPIC_ID: '7', CC_STORY_ID: '11' },
      config,
    });
    assert.equal(res.emitted, true);
    assert.equal(res.kind, 'story');
    const record = JSON.parse(readFileSync(ledgerPathFor(7), 'utf8').trim());
    assert.equal(record.event, 'story.heartbeat');
    assert.equal(record.payload.storyId, 11);
    assert.equal(record.payload.epicId, 7);
    assert.equal(record.payload.phase, 'implementing');
  });

  it('appends a slice.heartbeat for single-delivery context', () => {
    const res = emitHeartbeatFromHook({
      env: { CC_EPIC_ID: '7', CC_SLICE_ID: 'slice-2' },
      config,
    });
    assert.equal(res.emitted, true);
    assert.equal(res.kind, 'slice');
    const record = JSON.parse(readFileSync(ledgerPathFor(7), 'utf8').trim());
    assert.equal(record.event, 'slice.heartbeat');
    assert.equal(record.payload.sliceId, 'slice-2');
  });

  it('throttles a second emit within the interval, then emits after it', () => {
    const env = { CC_EPIC_ID: '7', CC_STORY_ID: '11' };
    const t0 = new Date('2026-07-13T12:00:00.000Z');
    const first = emitHeartbeatFromHook({ env, config, now: t0 });
    assert.equal(first.emitted, true);

    const withinWindow = new Date(t0.getTime() + 10_000);
    const second = emitHeartbeatFromHook({
      env,
      config,
      now: withinWindow,
    });
    assert.equal(second.emitted, false);
    assert.equal(second.reason, 'throttled');

    // The ledger still carries exactly one record.
    const lines = readFileSync(ledgerPathFor(7), 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);

    const afterWindow = new Date(t0.getTime() + 90_000);
    const third = emitHeartbeatFromHook({ env, config, now: afterWindow });
    assert.equal(third.emitted, true);
    const linesAfter = readFileSync(ledgerPathFor(7), 'utf8')
      .trim()
      .split('\n');
    assert.equal(linesAfter.length, 2);
  });

  it('is a no-op with no active context', () => {
    const res = emitHeartbeatFromHook({ env: {}, config });
    assert.equal(res.emitted, false);
    assert.equal(res.reason, 'no-target');
  });

  it('writes a throttle marker whose mtime advances the throttle', () => {
    const env = { CC_EPIC_ID: '7', CC_STORY_ID: '11' };
    emitHeartbeatFromHook({ env, config });
    const marker = path.join(
      tempRoot,
      'epic-7',
      heartbeatMarkerName({ kind: 'story', storyId: 11 }),
    );
    // Marker exists (its mtime is the throttle anchor).
    assert.ok(statSync(marker));
  });
});

describe('watchdog reads the hook-emitted heartbeat (HARD constraint)', () => {
  it('a hook-emitted story.heartbeat refreshes the watchdog liveness for an in-flight Story', () => {
    // Simulate a dispatched-but-not-ended Story, then a hook-emitted
    // heartbeat while it works. The watchdog's ledger reader must treat the
    // hook heartbeat as the Story's latest event — proving the signal it
    // consumes survives the move off the token stream.
    const epicId = 7;
    const storyId = 11;
    const dispatchTs = '2026-07-13T11:00:00.000Z';
    const ledger = ledgerPathFor(epicId);
    // Seed a dispatch.start so the Story is "in-flight".
    mkdirSync(path.dirname(ledger), { recursive: true });
    writeFileSync(
      ledger,
      `${JSON.stringify({
        kind: 'emitted',
        ts: dispatchTs,
        event: 'story.dispatch.start',
        payload: { storyId, epicId },
      })}\n`,
      'utf8',
    );

    const now = new Date('2026-07-13T11:20:00.000Z');
    emitHeartbeatFromHook({
      env: { CC_EPIC_ID: String(epicId), CC_STORY_ID: String(storyId) },
      config,
      now,
    });

    // The watchdog's own reader now sees the hook heartbeat as the latest
    // event for the Story.
    const events = readLedgerLastEvents(ledger);
    assert.equal(events.get(storyId), now.toISOString());

    // And the idle check clears the stall (no re-dispatch) at a 30-min
    // threshold, because the heartbeat is fresh.
    const { stalledCount } = runCheckIdle({
      epicId,
      thresholdMinutes: 30,
      ledgerPath: ledger,
      now: new Date(now.getTime() + 5 * 60 * 1000),
      branchActivity: () => null,
    });
    assert.equal(stalledCount, 0);
  });
});

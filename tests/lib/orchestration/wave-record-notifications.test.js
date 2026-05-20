import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildNotifyFn,
  emitWaveBoundaryNotifications,
} from '../../../.agents/scripts/lib/orchestration/wave-record-notifications.js';

test('buildNotifyFn returns injected notify verbatim', async () => {
  const calls = [];
  const injected = async (ticketId, payload) => {
    calls.push({ ticketId, event: payload.event });
  };
  const fn = buildNotifyFn(injected, {}, {}, async () => {});
  await fn(42, { event: 'epic-progress' });
  assert.deepEqual(calls, [{ ticketId: 42, event: 'epic-progress' }]);
});

test('emitWaveBoundaryNotifications fires epic-started on first wave 0 record', async () => {
  const events = [];
  await emitWaveBoundaryNotifications({
    injectedNotify: async (ticketId, payload) => {
      events.push({
        ticketId,
        event: payload.event,
        severity: payload.severity,
      });
    },
    defaultNotify: async () => {},
    config: { orchestration: {} },
    provider: {},
    epicId: 900,
    wave: 0,
    status: 'complete',
    priorWaves: [],
    nextWaves: [{ index: 0, status: 'complete', stories: [] }],
    titleById: new Map([[1, 'Story A']]),
    totalWaves: 2,
    nextCurrentWave: 1,
    verified: [{ storyId: 1, status: 'done' }],
    blockedStoryIds: [],
  });
  assert.deepEqual(
    events.map((e) => e.event),
    ['epic-started', 'epic-progress'],
  );
});

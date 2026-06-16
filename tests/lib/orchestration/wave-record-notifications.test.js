import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildNotifyFn,
  countDoneStories,
  emitRecordNotifications,
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

test('countDoneStories counts done entries in the flat status map', () => {
  assert.equal(
    countDoneStories({
      1: { status: 'done' },
      2: { status: 'pending' },
      3: { status: 'done' },
    }),
    2,
  );
  assert.equal(countDoneStories(undefined), 0);
});

test('emitRecordNotifications fires epic-started then epic-progress on the first beat', async () => {
  const events = [];
  await emitRecordNotifications({
    injectedNotify: async (ticketId, payload) => {
      events.push({ ticketId, event: payload.event });
    },
    defaultNotify: async () => {},
    config: { orchestration: {} },
    provider: {},
    epicId: 900,
    firstRecord: true,
    stories: { 1: { status: 'done' }, 2: { status: 'pending' } },
    verified: [{ storyId: 1, status: 'done' }],
    blockedStoryIds: [],
  });
  assert.deepEqual(
    events.map((e) => e.event),
    ['epic-started', 'epic-progress'],
  );
});

test('emitRecordNotifications fires epic-blocked when this beat blocked a Story', async () => {
  const events = [];
  await emitRecordNotifications({
    injectedNotify: async (_ticketId, payload) => {
      events.push(payload.event);
    },
    defaultNotify: async () => {},
    config: { orchestration: {} },
    provider: {},
    epicId: 901,
    firstRecord: false,
    stories: { 1: { status: 'done' }, 2: { status: 'blocked' } },
    verified: [{ storyId: 2, status: 'blocked' }],
    blockedStoryIds: [2],
  });
  // No epic-started on a non-first beat; blocked fires before progress.
  assert.deepEqual(events, ['epic-blocked', 'epic-progress']);
});

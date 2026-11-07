// Run: node --test tests/scripts/single-story-sweep-stalled-executing.test.js
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { GhNotFoundError } from '../../.agents/scripts/lib/gh-exec.js';
import {
  DEFAULT_STALLED_AFTER_HOURS,
  reportStalledExecuting,
  resolveStalledAfterHours,
} from '../../.agents/scripts/lib/single-story-sweep/report-stalled-executing.js';

const NOW = Date.parse('2026-11-06T12:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3_600_000).toISOString();
const quiet = { info: () => {}, warn: () => {} };
const CONFIG = { github: { owner: 'acme', repo: 'widgets' } };

function story(id, labels = ['type::story', 'agent::executing']) {
  return { id, state: 'open', labels };
}

/** Records every call; only the read methods exist, so a write would throw. */
function fakeProvider(tickets) {
  const calls = [];
  return {
    calls,
    listTicketsByLabel: async (opts) => {
      calls.push(opts);
      return tickets;
    },
  };
}

/**
 * `heads[branch]`: `{ sha, at }` | 'missing' | Error. `prs[branch]`: rows | Error.
 * `pushes[branch]`: activity rows | Error; absent is a 404.
 * Every call is recorded so a test can assert only reads were issued.
 */
function fakeGh({ heads = {}, prs = {}, pushes = {} } = {}) {
  const calls = [];
  return {
    calls,
    api: async ({ method, endpoint }) => {
      calls.push({ kind: 'api', method, endpoint });
      const ref = /\/activity\?ref=refs%2Fheads%2F([^&]+)/.exec(endpoint);
      if (ref) {
        const rows = pushes[decodeURIComponent(ref[1])];
        if (rows === undefined)
          throw new GhNotFoundError('not found', { args: [] });
        if (rows instanceof Error) throw rows;
        return { stdout: JSON.stringify(rows) };
      }
      const branch = endpoint.split('/branches/')[1];
      const head = heads[branch];
      if (head === undefined || head === 'missing') {
        throw new GhNotFoundError('not found', { args: [] });
      }
      if (head instanceof Error) throw head;
      return {
        stdout: JSON.stringify({
          commit: { sha: head.sha, commit: { committer: { date: head.at } } },
        }),
      };
    },
    pr: {
      list: async (flags, fields) => {
        calls.push({ kind: 'pr.list', flags, fields });
        const rows = prs[flags[1]] ?? [];
        if (rows instanceof Error) throw rows;
        return rows;
      },
    },
  };
}

function run(provider, gh, extra = {}) {
  return reportStalledExecuting({
    provider,
    config: CONFIG,
    gh,
    logger: quiet,
    now: () => NOW,
    ...extra,
  });
}

function assertReadOnly(gh) {
  for (const call of gh.calls) {
    if (call.kind === 'api') assert.equal(call.method, 'GET');
    else assert.equal(call.kind, 'pr.list');
  }
}

describe('reportStalledExecuting (Story #5980)', () => {
  it('reports a stalled Story with its head, idle hours, last PR and recover command', async () => {
    const provider = fakeProvider([story(101)]);
    const gh = fakeGh({
      heads: { 'story-101': { sha: 'abc123', at: hoursAgo(9) } },
      prs: { 'story-101': [{ number: 77, state: 'CLOSED' }] },
    });
    const infos = [];
    const out = await run(provider, gh, {
      logger: { info: (m) => infos.push(m), warn: () => {} },
    });
    assert.equal(out.ok, true);
    assert.deepEqual(out.stalled, [
      {
        storyId: 101,
        headSha: 'abc123',
        headCommittedAt: hoursAgo(9),
        headPushedAt: null,
        idleHours: 9,
        pr: { number: 77, state: 'CLOSED' },
        command: 'node .agents/scripts/deliver-recover.js --story 101',
      },
    ]);
    assert.deepEqual(provider.calls, [
      { state: 'open', labels: 'type::story,agent::executing' },
    ]);
    assert.equal(
      gh.calls[0].endpoint,
      '/repos/acme/widgets/branches/story-101',
      'origin is read over REST, never a local ref',
    );
    assert.deepEqual(gh.calls[1].flags, [
      '--head',
      'story-101',
      '--state',
      'all',
    ]);
    assert.equal(infos.length, 1);
    assert.match(infos[0], /#101 .*idle 9h.*deliver-recover\.js --story 101/);
    assertReadOnly(gh);
  });

  it('reports a Story with no PR at all as pr: null', async () => {
    const gh = fakeGh({ heads: { 'story-5': { sha: 's', at: hoursAgo(30) } } });
    const out = await run(fakeProvider([story(5)]), gh);
    assert.equal(out.stalled[0].pr, null);
  });

  it('skips a fresh head, an open PR, a missing origin branch and excluded ids', async () => {
    const provider = fakeProvider([
      story(1),
      story(2),
      story(3),
      story(4),
      story(5),
      story(6, ['type::epic', 'agent::executing']),
    ]);
    const gh = fakeGh({
      heads: {
        'story-1': { sha: 'a', at: hoursAgo(2) },
        'story-2': { sha: 'b', at: hoursAgo(20) },
        'story-3': 'missing',
        'story-4': { sha: 'd', at: hoursAgo(20) },
        'story-5': { sha: 'e', at: hoursAgo(20) },
        'story-6': { sha: 'f', at: hoursAgo(20) },
      },
      prs: {
        'story-2': [
          { number: 9, state: 'OPEN' },
          { number: 8, state: 'CLOSED' },
        ],
      },
    });
    const out = await run(provider, gh, { excludeStoryIds: [4, 5, null] });
    assert.deepEqual(out.stalled, []);
    assert.deepEqual(out.skipped, []);
    const probed = gh.calls
      .filter((c) => c.kind === 'api')
      .map((c) => c.endpoint.split('/').pop());
    assert.deepEqual(probed, ['story-1', 'story-2', 'story-3']);
    assertReadOnly(gh);
  });

  it('skips a Story whose old head was just pushed (handoff before the PR)', async () => {
    const gh = fakeGh({
      heads: { 'story-8': { sha: 'h', at: hoursAgo(7) } },
      pushes: {
        'story-8': [
          { timestamp: hoursAgo(1 / 60), activity_type: 'branch_creation' },
        ],
      },
    });
    const out = await run(fakeProvider([story(8)]), gh);
    assert.deepEqual(out.stalled, []);
    assert.deepEqual(gh.calls[1].flags, [
      '--head',
      'story-8',
      '--state',
      'all',
    ]);
    assert.match(
      gh.calls[2].endpoint,
      /\/repos\/acme\/widgets\/activity\?ref=refs%2Fheads%2Fstory-8&per_page=1$/,
    );
    assertReadOnly(gh);
  });

  it('reports a Story whose commit and last push are both old', async () => {
    const gh = fakeGh({
      heads: { 'story-9': { sha: 'h', at: hoursAgo(8) } },
      pushes: {
        'story-9': [{ timestamp: hoursAgo(7), activity_type: 'push' }],
      },
    });
    const [row] = (await run(fakeProvider([story(9)]), gh)).stalled;
    assert.equal(row.idleHours, 7);
    assert.equal(row.headPushedAt, hoursAgo(7));
  });

  it('falls back to the committer date when the activity read fails', async () => {
    const gh = fakeGh({
      heads: { 'story-10': { sha: 'h', at: hoursAgo(7) } },
      pushes: { 'story-10': new Error('403 forbidden') },
    });
    const out = await run(fakeProvider([story(10)]), gh);
    assert.deepEqual(out.skipped, []);
    assert.equal(out.stalled[0].idleHours, 7);
    assert.equal(out.stalled[0].headPushedAt, null);
  });

  it('honours a custom threshold', async () => {
    const gh = fakeGh({ heads: { 'story-7': { sha: 'x', at: hoursAgo(3) } } });
    const out = await run(fakeProvider([story(7)]), gh, {
      stalledAfterHours: 2,
    });
    assert.equal(out.thresholdHours, 2);
    assert.equal(out.stalled.length, 1);
  });

  it('records a listing failure without throwing', async () => {
    const provider = {
      listTicketsByLabel: async () => {
        throw new Error('rate limited');
      },
    };
    const out = await run(provider, fakeGh());
    assert.equal(out.ok, false);
    assert.equal(out.error, 'rate limited');
    assert.deepEqual(out.stalled, []);
  });

  it('records a per-Story read failure and keeps probing', async () => {
    const gh = fakeGh({
      heads: {
        'story-1': new Error('502 bad gateway'),
        'story-2': { sha: 'b', at: 'not-a-date' },
        'story-3': { sha: 'c', at: hoursAgo(10) },
        'story-4': { sha: 'd', at: hoursAgo(10) },
      },
      prs: { 'story-3': new Error('pr list failed') },
    });
    const out = await run(
      fakeProvider([story(1), story(2), story(3), story(4)]),
      gh,
    );
    assert.equal(out.ok, true);
    assert.deepEqual(out.skipped, [
      { storyId: 1, reason: '502 bad gateway' },
      { storyId: 2, reason: 'unreadable origin head' },
      { storyId: 3, reason: 'pr list failed' },
    ]);
    assert.deepEqual(
      out.stalled.map((s) => s.storyId),
      [4],
    );
  });

  it('probes at most 20 Stories in ascending order and counts the rest unprobed', async () => {
    const ids = Array.from({ length: 25 }, (_, i) => 200 - i);
    const gh = fakeGh();
    const out = await run(fakeProvider(ids.map((id) => story(id))), gh);
    const probed = gh.calls.map((c) => Number(c.endpoint.split('-').pop()));
    assert.equal(probed.length, 20);
    assert.equal(probed[0], 176);
    assert.equal(probed[19], 195);
    assert.equal(out.unprobed, 5);
  });

  it('is a no-op for a provider without listTicketsByLabel', async () => {
    const gh = fakeGh();
    const out = await run({}, gh);
    assert.deepEqual(out.stalled, []);
    assert.equal(gh.calls.length, 0);
  });
});

describe('resolveStalledAfterHours', () => {
  it('accepts a positive number or numeric string, else the default', () => {
    assert.equal(resolveStalledAfterHours('12'), 12);
    assert.equal(resolveStalledAfterHours(0.5), 0.5);
    for (const bad of [undefined, '', 'abc', '0', -3, 0, Number.NaN]) {
      assert.equal(resolveStalledAfterHours(bad), DEFAULT_STALLED_AFTER_HOURS);
    }
  });
});

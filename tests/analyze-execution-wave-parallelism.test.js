/**
 * Unit tests for `analyze-execution.js`'s wave-parallelism wiring
 * (Epic #3019 / Story #3025 / Task #3030).
 *
 * The analyzer's Epic-mode used to omit lifecycle events when calling
 * `computeEpicPerfReport`, which left `waveParallelism` at `[]` on the
 * persisted epic-perf-report comment. This test pins the post-fix
 * contract: when a fixture lifecycle log seeds N waves, the resulting
 * report carries N rows with non-zero `wallClockMs` on each row that
 * has matching wave-start / wave-complete events.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { runEpicMode } from '../.agents/scripts/analyze-execution.js';

function createFakeProvider({ subTickets = {} } = {}) {
  const commentStore = new Map();
  let nextCommentId = 5000;
  return {
    async getSubTickets(parentId) {
      return subTickets[parentId] ?? [];
    },
    async getTicketComments(ticketId) {
      return [...(commentStore.get(Number(ticketId)) ?? [])];
    },
    async deleteComment(commentId) {
      for (const [, list] of commentStore) {
        const i = list.findIndex((c) => c.id === commentId);
        if (i >= 0) list.splice(i, 1);
      }
    },
    async postComment(ticketId, payload) {
      const id = ++nextCommentId;
      const list = commentStore.get(Number(ticketId)) ?? [];
      list.push({ id, body: payload.body, type: payload.type });
      commentStore.set(Number(ticketId), list);
      return { commentId: id };
    },
    _commentStore: commentStore,
  };
}

let workRoot;
let config;

beforeEach(() => {
  workRoot = mkdtempSync(path.join(tmpdir(), 'analyze-wave-'));
  config = { project: { paths: { tempRoot: workRoot } } };
});

afterEach(() => {
  rmSync(workRoot, { recursive: true, force: true });
});

async function seedEpicSignals(eid, lines) {
  const dir = path.join(workRoot, `epic-${eid}`);
  await fs.mkdir(dir, { recursive: true });
  const body = `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
  await fs.writeFile(path.join(dir, 'signals.ndjson'), body);
}

function extractReportPayload(body) {
  const m = body.match(/```json\s*\n([\s\S]*?)\n```/);
  assert.ok(m, 'expected fenced JSON in epic-perf-report body');
  return JSON.parse(m[1]);
}

describe('analyze-execution Epic mode — waveParallelism wiring (Story #3025)', () => {
  it('produces one waveParallelism row per wave in the lifecycle log with non-zero wallClockMs', async () => {
    const epicId = 3019;
    // Seed an epic-level signals.ndjson with two complete waves.
    await seedEpicSignals(epicId, [
      {
        kind: 'wave-start',
        ts: '2026-05-26T00:00:00.000Z',
        epic: epicId,
        index: 0,
        totalWaves: 2,
        stories: [{ id: 1 }],
      },
      {
        kind: 'state-transition',
        ts: '2026-05-26T00:00:01.000Z',
        epic: epicId,
        story: 1,
        details: { to: 'agent::executing' },
      },
      {
        kind: 'state-transition',
        ts: '2026-05-26T00:00:04.000Z',
        epic: epicId,
        story: 1,
        details: { to: 'agent::done' },
      },
      {
        kind: 'wave-complete',
        ts: '2026-05-26T00:00:05.000Z',
        epic: epicId,
        index: 0,
        totalWaves: 2,
      },
      {
        kind: 'wave-start',
        ts: '2026-05-26T00:00:10.000Z',
        epic: epicId,
        index: 1,
        totalWaves: 2,
        stories: [{ id: 2 }],
      },
      {
        kind: 'state-transition',
        ts: '2026-05-26T00:00:11.000Z',
        epic: epicId,
        story: 2,
        details: { to: 'agent::executing' },
      },
      {
        kind: 'state-transition',
        ts: '2026-05-26T00:00:18.000Z',
        epic: epicId,
        story: 2,
        details: { to: 'agent::done' },
      },
      {
        kind: 'wave-complete',
        ts: '2026-05-26T00:00:20.000Z',
        epic: epicId,
        index: 1,
        totalWaves: 2,
      },
    ]);

    const provider = createFakeProvider({ subTickets: { [epicId]: [] } });

    const result = await runEpicMode({
      epicId,
      provider,
      config,
      // Stub the git-log gatherer + friction aggregator so the test does
      // not need a real repo or per-Story NDJSON; the assertions in this
      // test are wave-parallelism-specific.
      gatherEpicCommitsFn: async () => [],
      aggregateFrictionFn: async () => null,
    });

    const payload = result.payload;
    assert.equal(payload.kind, 'epic-perf-report');
    // AC#1: waveParallelism array length equals the number of waves
    // observed in the lifecycle log.
    assert.equal(payload.waveParallelism.length, 2);
    // AC#2: each row carries non-zero wallClockMs.
    for (const row of payload.waveParallelism) {
      assert.ok(
        row.wallClockMs > 0,
        `expected non-zero wallClockMs, got ${row.wallClockMs} for wave ${row.waveIndex}`,
      );
    }
    // Re-extract via the rendered comment body to pin the on-the-wire shape.
    const stored = provider._commentStore.get(epicId);
    assert.ok(stored && stored.length === 1, 'expected one upserted comment');
    const fromBody = extractReportPayload(stored[0].body);
    assert.equal(fromBody.waveParallelism.length, 2);
  });
});

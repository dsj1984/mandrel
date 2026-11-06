/**
 * story-outcomes-report.js: per-Story rows and a roll-up over fixture
 * `story-outcome` comments, read-only (Story #5977).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { recordStoryOutcome } from '../../.agents/scripts/lib/observability/story-outcome.js';
import { structuredCommentMarker } from '../../.agents/scripts/lib/orchestration/ticketing/reads.js';
import { runStoryOutcomesReport } from '../../.agents/scripts/story-outcomes-report.js';

const MARKER = structuredCommentMarker('story-outcome');

const RECORD_CONFIG = { delivery: { feedbackLoop: { outcomeRecord: true } } };

/** Builds the comment the recorder itself writes, attempt by attempt. */
async function outcomeComment(
  storyId,
  attempts,
  updatedAt = '2026-11-05T00:00:00Z',
) {
  let body = null;
  const provider = {
    getTicketComments: async () => (body ? [{ id: 1, body }] : []),
    deleteComment: async () => {},
    postComment: async (_id, payload) => {
      body = payload.body;
      return { commentId: 1 };
    },
  };
  for (const [status, version, gates = []] of attempts) {
    await recordStoryOutcome({
      envelope: {
        storyId,
        status,
        phase: 'done',
        gates: Object.fromEntries(gates.map((g) => [g, 'failed'])),
      },
      config: RECORD_CONFIG,
      provider,
      tool: 'single-story-close',
      readFn: async () => {},
      mandrelVersion: version,
    });
  }
  return {
    id: storyId * 10,
    issue_url: `https://api.github.com/repos/o/r/issues/${storyId}`,
    updated_at: updatedAt,
    body,
  };
}

const COMMENTS = [
  await outcomeComment(1, [['landed', '2.1.0']]),
  await outcomeComment(2, [
    ['failed', '2.1.0', ['lint', 'test']],
    ['blocked', '2.1.0', ['lint']],
    ['landed', '2.2.0'],
  ]),
  await outcomeComment(3, [['pending', '2.2.0']]),
  {
    id: 40,
    issue_url: 'https://api.github.com/repos/o/r/issues/4',
    updated_at: '2026-11-05T00:00:00Z',
    body: `${MARKER}\n\nno json here`,
  },
  {
    id: 50,
    issue_url: 'https://api.github.com/repos/o/r/issues/5',
    body: 'unrelated',
  },
];

function setup(comments) {
  let out = '';
  const calls = [];
  const provider = {
    async getRepoCommentsSince(since) {
      calls.push(['read', since]);
      return comments;
    },
    async postComment() {
      calls.push(['write']);
    },
    async deleteComment() {
      calls.push(['write']);
    },
  };
  return {
    deps: {
      resolveConfigImpl: () => ({}),
      providerFactory: () => provider,
      stdout: { write: (s) => (out += s) },
      nowMs: Date.parse('2026-11-06T00:00:00Z'),
    },
    out: () => out,
    calls,
  };
}

test('--json reports rows, first-pass, attempts, gates and versions (AC-8)', async () => {
  const { deps, out, calls } = setup(COMMENTS);
  await runStoryOutcomesReport(['--json'], deps);
  const report = JSON.parse(out());
  assert.equal(report.since, '2026-10-30T00:00:00.000Z');
  assert.equal(report.stories, 3);
  assert.equal(report.landed, 2);
  assert.equal(report.firstPassRate, 0.5);
  assert.equal(report.meanAttemptsToLand, 2);
  assert.equal(report.blockedShare, 1 / 5);
  assert.equal(report.failedShare, 1 / 5);
  assert.deepEqual(report.failedGates, [
    { gate: 'lint', count: 2 },
    { gate: 'test', count: 1 },
  ]);
  assert.deepEqual(report.byMandrelVersion, {
    '2.1.0': { landed: 1, firstPassRate: 1, meanAttemptsToLand: 1 },
    '2.2.0': { landed: 1, firstPassRate: 0, meanAttemptsToLand: 3 },
  });
  assert.deepEqual(report.unreadable, [{ storyId: 4, commentId: 40 }]);
  assert.deepEqual(
    report.rows.map((r) => r.storyId),
    [1, 2, 3],
  );
  assert.deepEqual(calls, [['read', '2026-10-30T00:00:00.000Z']]);
});

test('the table names each Story and lists unreadable records', async () => {
  const { deps, out } = setup(COMMENTS);
  await runStoryOutcomesReport(['--since', '2026-11-01'], deps);
  assert.match(out(), /^#2\s+3\s+yes\s+no\s+2\.2\.0\s+lint, test$/m);
  assert.match(out(), /first-pass 50\.0%/);
  assert.match(out(), /unreadable: #4/);
});

test('an empty window exits cleanly with zero stories (AC-8)', async () => {
  const { deps, out, calls } = setup([]);
  const report = await runStoryOutcomesReport(
    ['--json', '--since', '2026-11-01'],
    deps,
  );
  assert.equal(report.stories, 0);
  assert.equal(report.firstPassRate, null);
  assert.equal(JSON.parse(out()).since, '2026-11-01T00:00:00Z');
  assert.deepEqual(calls, [['read', '2026-11-01T00:00:00Z']]);
});

test('--since rejects a malformed date', async () => {
  const { deps } = setup([]);
  await assert.rejects(
    () => runStoryOutcomesReport(['--since', 'last week'], deps),
    /YYYY-MM-DD/,
  );
});

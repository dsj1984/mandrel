/**
 * Unit tests for `.agents/scripts/analyze-execution.js` (Epic #1030 /
 * Story #1123 / Task #1135). Covers Story-mode and Epic-mode end-to-end
 * with an in-memory provider and an isolated tempRoot.
 *
 * The CLI itself is exercised through its exported `runStoryMode` /
 * `runEpicMode` entry points so we don't have to spawn a child process
 * or stub `parseArgs`. Idempotence is verified by running the writer
 * twice and asserting no duplicate marker comments survive.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  extractStoryPerfSummaryFromComment,
  runEpicMode,
  runStoryMode,
} from '../.agents/scripts/analyze-execution.js';

// In-memory ticketing provider that satisfies the slice of the
// ITicketingProvider surface analyze-execution touches. Comments are
// stored in a Map keyed by ticket id so we can assert idempotence.
function createFakeProvider({ subTickets = {}, comments = {} } = {}) {
  const commentStore = new Map();
  for (const [id, list] of Object.entries(comments)) {
    commentStore.set(Number(id), [...list]);
  }
  let nextCommentId = 1000;

  return {
    _commentStore: commentStore,
    async getSubTickets(parentId) {
      return subTickets[parentId] ?? [];
    },
    async getTicketComments(ticketId) {
      return [...(commentStore.get(Number(ticketId)) ?? [])];
    },
    async deleteComment(commentId) {
      for (const [, list] of commentStore) {
        const idx = list.findIndex((c) => c.id === commentId);
        if (idx >= 0) list.splice(idx, 1);
      }
    },
    async postComment(ticketId, payload) {
      const id = ++nextCommentId;
      const list = commentStore.get(Number(ticketId)) ?? [];
      list.push({ id, body: payload.body, type: payload.type });
      commentStore.set(Number(ticketId), list);
      return { commentId: id };
    },
  };
}

let workRoot;
let cfg;

beforeEach(() => {
  workRoot = mkdtempSync(path.join(tmpdir(), 'analyze-execution-'));
  cfg = { paths: { tempRoot: workRoot } };
});

afterEach(() => {
  rmSync(workRoot, { recursive: true, force: true });
});

async function seedSignals(eid, sid, lines) {
  const dir = path.join(workRoot, `epic-${eid}`, `story-${sid}`);
  await fs.mkdir(dir, { recursive: true });
  const body = `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
  await fs.writeFile(path.join(dir, 'signals.ndjson'), body);
}

async function seedPhaseTimings(eid, sid, payload) {
  const dir = path.join(workRoot, `epic-${eid}`, `story-${sid}`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'phase-timings.json'),
    JSON.stringify(payload),
  );
}

describe('runStoryMode', () => {
  it('upserts a story-perf-summary comment from NDJSON + phase-timings', async () => {
    await seedSignals(100, 200, [
      { kind: 'friction', details: { category: 'Tool Limitation' } },
      { kind: 'friction', details: { category: 'Tool Limitation' } },
      { kind: 'retry', details: { command: 'npm test' } },
    ]);
    await seedPhaseTimings(100, 200, {
      storyId: 200,
      totalMs: 5000,
      phases: [
        { name: 'install', elapsedMs: 1500 },
        { name: 'test', elapsedMs: 3500 },
      ],
    });

    const provider = createFakeProvider();
    const result = await runStoryMode({
      storyId: 200,
      epicId: 100,
      provider,
      config: cfg,
      logger: { info() {}, warn() {}, error() {} },
      now: () => new Date('2026-05-07T12:00:00.000Z'),
    });

    assert.equal(result.payload.kind, 'story-perf-summary');
    assert.equal(result.payload.storyId, 200);
    assert.equal(result.payload.epicId, 100);
    assert.equal(result.payload.frictionByCategory['Tool Limitation'], 2);
    assert.equal(result.payload.phaseTimingsMs.install, 1500);
    assert.equal(result.payload.retryDensity.retries, 1);

    const commentList = provider._commentStore.get(200);
    assert.equal(commentList.length, 1);
    assert.match(
      commentList[0].body,
      /<!-- ap:structured-comment type="story-perf-summary" -->/,
    );
    assert.match(commentList[0].body, /"kind": "story-perf-summary"/);
  });

  it('posts an empty payload when signals.ndjson is missing', async () => {
    const provider = createFakeProvider();
    const result = await runStoryMode({
      storyId: 5,
      epicId: 6,
      provider,
      config: cfg,
      logger: { info() {}, warn() {} },
      now: () => new Date('2026-05-07T12:00:00.000Z'),
    });
    assert.deepEqual(result.payload.frictionByCategory, {});
    assert.deepEqual(result.payload.phaseTimingsMs, {});
    assert.equal(provider._commentStore.get(5).length, 1);
  });

  it('is idempotent — second run replaces in place', async () => {
    await seedSignals(1, 2, [
      { kind: 'friction', details: { category: 'Execution Error' } },
    ]);
    const provider = createFakeProvider();

    await runStoryMode({
      storyId: 2,
      epicId: 1,
      provider,
      config: cfg,
      logger: { info() {} },
      now: () => new Date('2026-05-07T12:00:00.000Z'),
    });
    await runStoryMode({
      storyId: 2,
      epicId: 1,
      provider,
      config: cfg,
      logger: { info() {} },
      now: () => new Date('2026-05-07T13:00:00.000Z'),
    });

    const list = provider._commentStore.get(2);
    assert.equal(list.length, 1);
  });
});

describe('runEpicMode', () => {
  it('rolls up Story summaries into an epic-perf-report', async () => {
    // Two child Stories; each has a story-perf-summary comment already
    // posted on its ticket. The aggregator pulls them via comment fetch.
    const storySummaryBody = (storyId, friction, hotspots) => {
      const payload = {
        kind: 'story-perf-summary',
        storyId,
        epicId: 99,
        closedAt: '2026-05-07T00:00:00.000Z',
        frictionByCategory: friction,
        phaseTimingsMs: {},
        topSlowPhasesVsBaseline: hotspots,
        reworkScore: { filesEditedBeyondThreshold: 0 },
        retryDensity: { retries: 0, uniqueCommands: 0 },
      };
      return [
        '<!-- ap:structured-comment type="story-perf-summary" -->',
        '',
        '### Story Perf Summary',
        '',
        '```json',
        JSON.stringify(payload, null, 2),
        '```',
      ].join('\n');
    };

    const provider = createFakeProvider({
      subTickets: {
        99: [
          { id: 1, number: 1, labels: ['type::story'] },
          { id: 2, number: 2, labels: [{ name: 'type::story' }] },
          { id: 3, number: 3, labels: ['type::task'] }, // ignored
        ],
      },
      comments: {
        1: [
          {
            id: 1,
            body: storySummaryBody(1, { 'Tool Limitation': 3 }, [
              { phase: 'test', elapsedMs: 9000, baselineP95Ms: 3000, ratio: 3 },
            ]),
          },
        ],
        2: [
          {
            id: 2,
            body: storySummaryBody(2, { 'Execution Error': 1 }, [
              { phase: 'test', elapsedMs: 6000, baselineP95Ms: 3000, ratio: 2 },
            ]),
          },
        ],
      },
    });

    const result = await runEpicMode({
      epicId: 99,
      provider,
      logger: { info() {}, warn() {} },
      now: () => new Date('2026-05-07T15:00:00.000Z'),
    });

    assert.equal(result.payload.kind, 'epic-perf-report');
    assert.equal(result.payload.epicId, 99);
    assert.equal(result.payload.signalCounts.friction, 4);
    assert.equal(result.payload.topHotspots.length, 1);
    assert.equal(result.payload.topHotspots[0].phase, 'test');
    assert.equal(result.payload.topHotspots[0].occurrences, 2);
    assert.equal(result.payload.topHotspots[0].avgRatio, 2.5);
    assert.equal(result.payload.mostFrictionStories[0].storyId, 1);
    assert.equal(result.payload.mostFrictionStories[0].frictionCount, 3);

    const epicComments = provider._commentStore.get(99) ?? [];
    assert.equal(epicComments.length, 1);
    assert.match(
      epicComments[0].body,
      /<!-- ap:structured-comment type="epic-perf-report" -->/,
    );
  });

  it('produces an empty report when the Epic has no Stories', async () => {
    const provider = createFakeProvider({ subTickets: { 1: [] } });
    const result = await runEpicMode({
      epicId: 1,
      provider,
      logger: { info() {}, warn() {} },
      now: () => new Date('2026-05-07T00:00:00.000Z'),
    });
    assert.equal(result.payload.kind, 'epic-perf-report');
    assert.deepEqual(result.payload.mostFrictionStories, []);
    assert.deepEqual(result.payload.topHotspots, []);
  });

  it('is idempotent — second run replaces in place', async () => {
    const provider = createFakeProvider({ subTickets: { 1: [] } });
    await runEpicMode({
      epicId: 1,
      provider,
      logger: { info() {} },
      now: () => new Date('2026-05-07T00:00:00.000Z'),
    });
    await runEpicMode({
      epicId: 1,
      provider,
      logger: { info() {} },
      now: () => new Date('2026-05-07T01:00:00.000Z'),
    });
    assert.equal((provider._commentStore.get(1) ?? []).length, 1);
  });
});

describe('runEpicMode — Quality gate friction block (Story #1400 / Task #1429)', () => {
  // The Quality-gate friction block aggregates `baseline-refresh-regression`
  // friction records from each child Story's signals.ndjson stream.
  // Tests pin three verdicts: none, one, and many friction records.

  function storySummaryBody(storyId, epicId) {
    const payload = {
      kind: 'story-perf-summary',
      storyId,
      epicId,
      closedAt: '2026-05-07T00:00:00.000Z',
      frictionByCategory: {},
      phaseTimingsMs: {},
      topSlowPhasesVsBaseline: [],
      reworkScore: { filesEditedBeyondThreshold: 0 },
      retryDensity: { retries: 0, uniqueCommands: 0 },
    };
    return [
      '<!-- ap:structured-comment type="story-perf-summary" -->',
      '',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
  }

  function makeProvider({ epicId, storyIds }) {
    const subTickets = {
      [epicId]: storyIds.map((id) => ({
        id,
        number: id,
        labels: ['type::story'],
      })),
    };
    const comments = {};
    for (const sid of storyIds) {
      comments[sid] = [{ id: sid * 10, body: storySummaryBody(sid, epicId) }];
    }
    return createFakeProvider({ subTickets, comments });
  }

  it('prints "Quality gate friction: none" when no friction signals exist', async () => {
    const provider = makeProvider({ epicId: 700, storyIds: [701] });
    // No NDJSON seeded → totalRecords === 0
    const result = await runEpicMode({
      epicId: 700,
      provider,
      config: cfg,
      logger: { info() {}, warn() {} },
      now: () => new Date('2026-05-07T12:00:00.000Z'),
      // Stub the git-log gather so we don't shell out.
      gatherEpicCommitsFn: () => [],
    });
    const epicComments = provider._commentStore.get(700) ?? [];
    assert.equal(epicComments.length, 1);
    assert.match(epicComments[0].body, /\*\*Quality gate friction:\*\* none/);
    assert.equal(result.qualityGateFriction.totalRecords, 0);
  });

  it('prints a count and top offenders for a single friction record', async () => {
    await seedSignals(800, 801, [
      {
        kind: 'friction',
        category: 'baseline-refresh-regression',
        timestamp: '2026-05-07T11:00:00.000Z',
        regressedFiles: [
          { file: 'lib/foo.js', current: 60, baseline: 75, drop: 15 },
        ],
      },
    ]);
    const provider = makeProvider({ epicId: 800, storyIds: [801] });
    const result = await runEpicMode({
      epicId: 800,
      provider,
      config: cfg,
      logger: { info() {}, warn() {} },
      now: () => new Date('2026-05-07T12:00:00.000Z'),
      gatherEpicCommitsFn: () => [],
    });
    const body = (provider._commentStore.get(800) ?? [])[0].body;
    assert.match(
      body,
      /\*\*Quality gate friction:\*\* 1 `baseline-refresh-regression` record\(s\) across 1 Story\/Stories/,
    );
    assert.match(body, /Top offenders:/);
    assert.match(body, /`lib\/foo\.js` — 1 occurrence\(s\)/);
    assert.equal(result.qualityGateFriction.totalRecords, 1);
    assert.equal(result.qualityGateFriction.storiesAffected, 1);
    assert.equal(result.qualityGateFriction.topOffenders[0].file, 'lib/foo.js');
  });

  it('aggregates many records across mixed verdicts and shapes', async () => {
    // Story 901 — two records, mixed shapes (regressedFiles + miOverCap).
    await seedSignals(900, 901, [
      {
        kind: 'friction',
        category: 'baseline-refresh-regression',
        timestamp: '2026-05-07T10:00:00.000Z',
        regressedFiles: [
          { file: 'lib/a.js', current: 50, baseline: 70, drop: 20 },
          { file: 'lib/b.js', current: 55, baseline: 70, drop: 15 },
        ],
      },
      {
        kind: 'friction',
        category: 'baseline-refresh-regression',
        timestamp: '2026-05-07T11:00:00.000Z',
        miOverCap: [{ path: 'lib/a.js', mi: 50, baseline: 70 }],
        crapOverCap: [{ file: 'lib/c.js', method: 'doSomething', crap: 35 }],
      },
    ]);
    // Story 902 — one record, irrelevant friction (different category) is skipped.
    await seedSignals(900, 902, [
      {
        kind: 'friction',
        category: 'baseline-refresh-regression',
        timestamp: '2026-05-07T11:30:00.000Z',
        regressedFiles: [{ file: 'lib/a.js' }], // 3rd hit on lib/a.js
      },
      {
        kind: 'friction',
        category: 'tool-limitation', // ignored
        timestamp: '2026-05-07T11:45:00.000Z',
      },
      // Out-of-window (default 28d) — 60 days before NOW.
      {
        kind: 'friction',
        category: 'baseline-refresh-regression',
        timestamp: '2026-03-08T00:00:00.000Z',
        regressedFiles: [{ file: 'lib/old.js' }],
      },
    ]);

    const provider = makeProvider({ epicId: 900, storyIds: [901, 902] });
    const result = await runEpicMode({
      epicId: 900,
      provider,
      config: cfg,
      logger: { info() {}, warn() {} },
      now: () => new Date('2026-05-07T12:00:00.000Z'),
      gatherEpicCommitsFn: () => [],
    });

    assert.equal(result.qualityGateFriction.totalRecords, 3);
    assert.equal(result.qualityGateFriction.storiesAffected, 2);

    // lib/a.js appears 3 times (2 in story 901 + 1 in story 902) → top offender
    const top = result.qualityGateFriction.topOffenders;
    assert.equal(top[0].file, 'lib/a.js');
    assert.equal(top[0].occurrences, 3);

    // lib/c.js → doSomething method aggregated separately
    const crapRow = top.find(
      (o) => o.file === 'lib/c.js' && o.method === 'doSomething',
    );
    assert.ok(crapRow, 'crapOverCap method offender should be aggregated');
    assert.equal(crapRow.occurrences, 1);

    // out-of-window record dropped
    assert.equal(
      top.find((o) => o.file === 'lib/old.js'),
      undefined,
    );

    const body = (provider._commentStore.get(900) ?? [])[0].body;
    assert.match(
      body,
      /\*\*Quality gate friction:\*\* 3 `baseline-refresh-regression` record\(s\) across 2 Story\/Stories/,
    );
    assert.match(body, /`lib\/a\.js` — 3 occurrence\(s\)/);
    assert.match(body, /`lib\/c\.js → doSomething` — 1 occurrence\(s\)/);
  });
});

describe('runEpicMode — baseline-refresh-rate row (Story #1400 / Task #1427)', () => {
  it('prints the clean-merge rate row when commits are gathered', async () => {
    const provider = createFakeProvider({ subTickets: { 555: [] } });
    const NOW = new Date('2026-05-11T12:00:00.000Z');
    const isoDaysAgo = (n) =>
      new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
    const result = await runEpicMode({
      epicId: 555,
      provider,
      config: cfg,
      logger: { info() {}, warn() {} },
      now: () => NOW,
      gatherEpicCommitsFn: ({ epicId }) => [
        {
          sha: 'a1',
          isoDate: isoDaysAgo(2),
          subject: 'feat: a (resolves #1)',
          epicId,
        },
        {
          sha: 'a2',
          isoDate: isoDaysAgo(3),
          subject: 'feat: b (resolves #2)',
          epicId,
        },
        {
          sha: 'a3',
          isoDate: isoDaysAgo(3),
          subject: 'baseline-refresh: drift',
          epicId,
        },
      ],
    });
    assert.equal(result.baselineRefreshRate.kind, 'baseline-refresh-rate');
    assert.equal(result.baselineRefreshRate.perEpic[0].cleanMergeRate, 0.5);
    const body = (provider._commentStore.get(555) ?? [])[0].body;
    assert.match(body, /Baseline refresh discipline \(trailing 28d\):/);
    assert.match(body, /50\.0% clean-merge rate/);
  });

  it('prints "no Story merges in window" when the window is empty', async () => {
    const provider = createFakeProvider({ subTickets: { 556: [] } });
    await runEpicMode({
      epicId: 556,
      provider,
      config: cfg,
      logger: { info() {}, warn() {} },
      now: () => new Date('2026-05-11T12:00:00.000Z'),
      gatherEpicCommitsFn: () => [],
    });
    const body = (provider._commentStore.get(556) ?? [])[0].body;
    assert.match(body, /no Story merges in window/);
  });
});

describe('extractStoryPerfSummaryFromComment', () => {
  it('returns null on bodies without the marker', () => {
    assert.equal(extractStoryPerfSummaryFromComment('hello world'), null);
    assert.equal(extractStoryPerfSummaryFromComment(null), null);
  });

  it('parses the fenced JSON payload', () => {
    const body = [
      '<!-- ap:structured-comment type="story-perf-summary" -->',
      '',
      '```json',
      JSON.stringify({ kind: 'story-perf-summary', storyId: 1 }, null, 2),
      '```',
    ].join('\n');
    const out = extractStoryPerfSummaryFromComment(body);
    assert.equal(out.kind, 'story-perf-summary');
    assert.equal(out.storyId, 1);
  });

  it('returns null when the fenced JSON is malformed', () => {
    const body = [
      '<!-- ap:structured-comment type="story-perf-summary" -->',
      '```json',
      'not json',
      '```',
    ].join('\n');
    assert.equal(extractStoryPerfSummaryFromComment(body), null);
  });
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  aggregatePhaseTimings,
  EPIC_RUN_PROGRESS_TYPE,
  PHASE_TIMINGS_TYPE,
  ProgressReporter,
  parsePhaseTimingsComment,
  renderPhaseTimingsSection,
  runHotspotDetection,
} from '../../.agents/scripts/lib/orchestration/epic-runner/progress-reporter.js';
import { structuredCommentMarker } from '../../.agents/scripts/lib/orchestration/ticketing.js';

function buildProvider(tickets = {}, comments = []) {
  return {
    async getTicket(id) {
      return tickets[id] ?? null;
    },
    async getTicketComments() {
      return comments;
    },
    async listComments() {
      return comments;
    },
    async postComment(_ticketId, { body }) {
      comments.push({ id: `new-${comments.length}`, body });
      return { id: `new-${comments.length - 1}` };
    },
    async updateComment(commentId, { body }) {
      const target = comments.find((c) => c.id === commentId);
      if (target) target.body = body;
      return target ?? { id: commentId };
    },
  };
}

function buildPhaseCommentBody(storyId, phasePairs) {
  const phases = phasePairs.map(([name, elapsedMs]) => ({ name, elapsedMs }));
  const totalMs = phases.reduce((acc, p) => acc + p.elapsedMs, 0);
  const payload = { kind: 'phase-timings', storyId, totalMs, phases };
  const marker = structuredCommentMarker(PHASE_TIMINGS_TYPE);
  return `${marker}\n\n### Phase timings — story #${storyId}\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n`;
}

function silentLogger() {
  const calls = { info: [], warn: [] };
  return {
    log: calls,
    info: (m) => calls.info.push(m),
    warn: (m) => calls.warn.push(m),
  };
}

describe('ProgressReporter', () => {
  it('is disabled when intervalSec <= 0', () => {
    const reporter = new ProgressReporter({
      provider: buildProvider(),
      epicId: 1,
      intervalSec: 0,
    });
    assert.equal(reporter.isEnabled(), false);
    reporter.start();
    assert.equal(reporter.timer, null);
  });

  it('rejects missing provider or non-numeric epicId', () => {
    assert.throws(
      () => new ProgressReporter({ epicId: 1 }),
      /requires a provider/,
    );
    assert.throws(
      () => new ProgressReporter({ provider: buildProvider() }),
      /requires a numeric epicId/,
    );
  });

  it('renders a table with the correct state emoji and done-count', async () => {
    const provider = buildProvider({
      10: { number: 10, title: 'A', state: 'CLOSED', labels: [] },
      11: {
        number: 11,
        title: 'B',
        state: 'OPEN',
        labels: ['agent::executing'],
      },
      12: { number: 12, title: 'C', state: 'OPEN', labels: ['agent::ready'] },
      13: { number: 13, title: 'D', state: 'OPEN', labels: ['agent::blocked'] },
    });
    const logger = silentLogger();
    const reporter = new ProgressReporter({
      provider,
      epicId: 42,
      intervalSec: 60,
      logger,
    });
    reporter.setWave({
      index: 0,
      totalWaves: 1,
      stories: [10, 11, 12, 13],
      startedAt: new Date(Date.now() - 90_000).toISOString(),
    });
    const { rows, body } = await reporter.fire();
    assert.equal(rows[0].state, 'done');
    assert.equal(rows[1].state, 'in-flight');
    assert.equal(rows[2].state, 'queued');
    assert.equal(rows[3].state, 'blocked');
    assert.match(body, /Wave 1\/1 · 1\/4 closed/);
    assert.match(body, /#10 \| ✅ done \| A/);
    assert.match(body, /#13 \| 🚧 blocked \| D/);
    assert.match(body, /1 stor[y] blocked: #13/);
    assert.equal(logger.log.info.length, 1);
  });

  it('upserts a structured comment with the progress type', async () => {
    const provider = buildProvider({
      1: { number: 1, title: 'only', state: 'CLOSED', labels: [] },
    });
    const reporter = new ProgressReporter({
      provider,
      epicId: 9,
      intervalSec: 60,
      logger: silentLogger(),
    });
    reporter.setWave({ index: 0, totalWaves: 1, stories: [1] });
    await reporter.fire();
    const [comment] = await provider.listComments();
    assert.ok(
      comment.body.includes(
        `<!-- ap:structured-comment type="${EPIC_RUN_PROGRESS_TYPE}" -->`,
      ),
      'comment should include the structured-comment marker',
    );
  });

  it('drops re-entrant fires while one is in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const provider = {
      async getTicket() {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight -= 1;
        return { number: 1, title: '', state: 'OPEN', labels: [] };
      },
      async getTicketComments() {
        return [];
      },
      async postComment() {
        return { id: '1' };
      },
    };
    const reporter = new ProgressReporter({
      provider,
      epicId: 1,
      intervalSec: 60,
      logger: silentLogger(),
    });
    reporter.setWave({ index: 0, totalWaves: 1, stories: [1] });
    await Promise.all([reporter.fire(), reporter.fire(), reporter.fire()]);
    assert.equal(peak, 1, 'only one fire should execute at a time');
  });

  it('renders all waves when setPlan is called, with a Wave column', async () => {
    const provider = buildProvider({
      10: { number: 10, title: 'A', state: 'CLOSED', labels: [] },
      11: { number: 11, title: 'B', state: 'CLOSED', labels: [] },
      20: {
        number: 20,
        title: 'C',
        state: 'OPEN',
        labels: ['agent::executing'],
      },
    });
    const logger = silentLogger();
    const reporter = new ProgressReporter({
      provider,
      epicId: 7,
      intervalSec: 60,
      logger,
    });
    reporter.setPlan({
      waves: [
        [
          { id: 10, title: 'A' },
          { id: 11, title: 'B' },
        ],
        [{ id: 20, title: 'C' }],
      ],
      startedAt: new Date(Date.now() - 600_000).toISOString(),
    });
    reporter.setWave({
      index: 1,
      totalWaves: 2,
      stories: [20],
      startedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const { rows, body } = await reporter.fire();
    assert.equal(rows.length, 3, 'rows cover every wave, not just the active');
    assert.match(body, /Wave 2\/2 · 2\/3 closed/);
    assert.match(body, /\| Wave \| ID \| State \| Title \|/);
    assert.match(body, /\| 1 \| #10 \| ✅ done \| A \|/);
    assert.match(body, /\| 1 \| #11 \| ✅ done \| B \|/);
    assert.match(body, /\| 2 \| #20 \| 🔧 in-flight \| C \|/);
  });

  it('renders fixture story states (not unknown) when the GraphQL read succeeds', async () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL('../fixtures/progress-reporter-stories.json', import.meta.url),
        'utf8',
      ),
    );
    const tickets = Object.fromEntries(
      fixture.stories.map((s) => [s.number, s]),
    );
    const provider = buildProvider(tickets);
    const reporter = new ProgressReporter({
      provider,
      epicId: 77,
      intervalSec: 60,
      logger: silentLogger(),
    });
    reporter.setWave({
      index: 0,
      totalWaves: 1,
      stories: fixture.stories.map((s) => s.number),
    });

    const { rows } = await reporter.fire();
    const unknown = rows.filter((r) => r.state === 'unknown');
    assert.equal(
      unknown.length,
      0,
      'no fixture story should fall back to unknown',
    );
    assert.deepEqual(
      rows.map((r) => [r.id, r.state]),
      [
        [501, 'done'],
        [502, 'in-flight'],
        [503, 'queued'],
        [504, 'blocked'],
      ],
    );
  });

  it('propagates provider errors from fire() (fail loud)', async () => {
    const provider = {
      async getTicket() {
        throw new Error('variableNotUsed: $issueId');
      },
      async getTicketComments() {
        return [];
      },
      async postComment() {
        return { id: '1' };
      },
    };
    const reporter = new ProgressReporter({
      provider,
      epicId: 1,
      intervalSec: 60,
      logger: silentLogger(),
    });
    reporter.setWave({ index: 0, totalWaves: 1, stories: [1] });
    await assert.rejects(() => reporter.fire(), /variableNotUsed/);
  });

  it('tees each snapshot to logFile with an ISO divider when configured', async () => {
    const provider = buildProvider({
      1: {
        number: 1,
        title: 'x',
        state: 'OPEN',
        labels: ['agent::executing'],
      },
    });
    const writes = [];
    const mkdirs = [];
    const reporter = new ProgressReporter({
      provider,
      epicId: 99,
      intervalSec: 60,
      logger: silentLogger(),
      logFile: 'temp/test-logs/epic-99-progress.log',
      appendFile: async (path, chunk) => {
        writes.push({ path, chunk });
      },
      mkdir: async (path, opts) => {
        mkdirs.push({ path, opts });
      },
    });
    reporter.setWave({ index: 0, totalWaves: 1, stories: [1] });
    await reporter.fire();
    await reporter.fire();
    assert.equal(writes.length, 2, 'each fire should append once');
    assert.equal(mkdirs.length, 1, 'mkdir is lazy — only on first append');
    assert.deepEqual(mkdirs[0], {
      path: 'temp/test-logs',
      opts: { recursive: true },
    });
    assert.match(writes[0].chunk, /^### ⏱ \d{4}-\d{2}-\d{2}T/);
    assert.match(writes[0].chunk, /Progress — Wave 1\/1/);
    assert.match(writes[0].chunk, /---\n\n$/);
  });

  it('writes a wave-start header to logFile on start()', async () => {
    const provider = buildProvider({
      1: { number: 1, title: 'x', state: 'OPEN', labels: ['agent::ready'] },
    });
    const writes = [];
    const reporter = new ProgressReporter({
      provider,
      epicId: 42,
      intervalSec: 60,
      logger: silentLogger(),
      logFile: 'temp/test-logs/epic-42-progress.log',
      appendFile: async (_path, chunk) => {
        writes.push(chunk);
      },
      mkdir: async () => {},
      setInterval: () => ({ ref: () => {}, unref: () => {} }),
      clearInterval: () => {},
    });
    reporter.setWave({ index: 2, totalWaves: 3, stories: [1] });
    reporter.start();
    // Header write is async-scheduled from inside start(); let it flush.
    await new Promise((r) => setImmediate(r));
    assert.equal(writes.length, 1);
    assert.match(writes[0], /Wave 3\/3 starting/);
  });

  it('does not touch the filesystem when logFile is null', async () => {
    const provider = buildProvider({
      1: { number: 1, title: 'x', state: 'CLOSED', labels: [] },
    });
    let appendCalls = 0;
    const reporter = new ProgressReporter({
      provider,
      epicId: 1,
      intervalSec: 60,
      logger: silentLogger(),
      logFile: null,
      appendFile: async () => {
        appendCalls += 1;
      },
    });
    reporter.setWave({ index: 0, totalWaves: 1, stories: [1] });
    await reporter.fire();
    assert.equal(appendCalls, 0);
  });

  it('renders a phase-timings section from done-story structured comments', async () => {
    // 5-story fixture: each done story has a `phase-timings` structured
    // comment with a known elapsedMs profile. The rendered section must
    // aggregate median + p95 across all five and preserve the canonical
    // phase ordering.
    const phaseComments = {
      1: buildPhaseCommentBody(1, [
        ['worktree-create', 100],
        ['install', 1000],
        ['implement', 30_000],
        ['lint', 200],
        ['test', 5_000],
        ['close', 300],
        ['api-sync', 50],
      ]),
      2: buildPhaseCommentBody(2, [
        ['worktree-create', 200],
        ['install', 1100],
        ['implement', 40_000],
        ['lint', 220],
        ['test', 5_200],
        ['close', 320],
        ['api-sync', 55],
      ]),
      3: buildPhaseCommentBody(3, [
        ['worktree-create', 150],
        ['install', 900],
        ['implement', 35_000],
        ['lint', 190],
        ['test', 4_800],
        ['close', 290],
        ['api-sync', 45],
      ]),
      4: buildPhaseCommentBody(4, [
        ['worktree-create', 180],
        ['install', 1050],
        ['implement', 50_000],
        ['lint', 210],
        ['test', 5_500],
        ['close', 310],
        ['api-sync', 60],
      ]),
      5: buildPhaseCommentBody(5, [
        ['worktree-create', 120],
        ['install', 950],
        ['implement', 45_000],
        ['lint', 205],
        ['test', 5_100],
        ['close', 305],
        ['api-sync', 52],
      ]),
    };
    const commentsByTicket = new Map(
      Object.entries(phaseComments).map(([id, body]) => [
        Number(id),
        [{ id: `c-${id}`, body }],
      ]),
    );
    const tickets = {
      1: { number: 1, title: 'A', state: 'CLOSED', labels: [] },
      2: { number: 2, title: 'B', state: 'CLOSED', labels: [] },
      3: { number: 3, title: 'C', state: 'CLOSED', labels: [] },
      4: { number: 4, title: 'D', state: 'CLOSED', labels: [] },
      5: { number: 5, title: 'E', state: 'CLOSED', labels: [] },
    };
    const upserted = [];
    const provider = {
      async getTicket(id) {
        return tickets[id] ?? null;
      },
      async getTicketComments(id) {
        return commentsByTicket.get(Number(id)) ?? [];
      },
      async postComment(_ticketId, { body }) {
        upserted.push(body);
        return { id: `u-${upserted.length}` };
      },
      async deleteComment() {},
    };
    const reporter = new ProgressReporter({
      provider,
      epicId: 99,
      intervalSec: 60,
      logger: silentLogger(),
    });
    reporter.setPlan({
      waves: [[1, 2, 3, 4, 5]],
      startedAt: new Date().toISOString(),
    });
    reporter.setWave({ index: 0, totalWaves: 1, stories: [1, 2, 3, 4, 5] });

    const { body } = await reporter.fire();

    assert.match(body, /### Phase timings \(last 5 completed stories\)/);
    assert.match(body, /\| Phase \| median ms \| p95 ms \| n \|/);
    // Canonical phase ordering — worktree-create must precede install,
    // implement, lint, test, close, api-sync. Assert by string-index order.
    const iwc = body.indexOf('| worktree-create |');
    const iinstall = body.indexOf('| install |');
    const iimpl = body.indexOf('| implement |');
    const ilint = body.indexOf('| lint |');
    const itest = body.indexOf('| test |');
    const iclose = body.indexOf('| close |');
    const iapi = body.indexOf('| api-sync |');
    assert.ok(
      iwc < iinstall &&
        iinstall < iimpl &&
        iimpl < ilint &&
        ilint < itest &&
        itest < iclose &&
        iclose < iapi,
      `phase rows must render in canonical order; body was:\n${body}`,
    );
    // install elapsedMs samples: [1000, 1100, 900, 1050, 950]. sorted:
    // [900, 950, 1000, 1050, 1100]. median (nearest-rank, q=0.5) = index
    // ceil(0.5*5)-1 = 2 → 1000. p95 = index ceil(0.95*5)-1 = 4 → 1100.
    assert.match(body, /\| install \| 1000 \| 1100 \| 5 \|/);
    // n=5 for every phase.
    assert.match(body, /\| api-sync \| \d+ \| \d+ \| 5 \|/);
  });

  it('omits the phase-timings section when no done-story comments exist', async () => {
    const provider = buildProvider({
      1: {
        number: 1,
        title: 'still working',
        state: 'OPEN',
        labels: ['agent::executing'],
      },
    });
    const reporter = new ProgressReporter({
      provider,
      epicId: 3,
      intervalSec: 60,
      logger: silentLogger(),
    });
    reporter.setWave({ index: 0, totalWaves: 1, stories: [1] });
    const { body } = await reporter.fire();
    assert.ok(
      !body.includes('Phase timings'),
      'no phase-timings section when no done stories',
    );
  });

  it('caches structured-comment reads — bounded fetches per story across ticks', async () => {
    // Once a story is terminal, both its `phase-timings` comment and its
    // `story-run-progress` comment are immutable (or permanently absent);
    // the reporter must not re-fetch them on every tick. With the post-#908
    // story-run-progress reader, the bounded fetch count is 2 per story per
    // epic run (one per marker the reporter looks for) — both are cached
    // after the first lookup. This protects the GH API budget on 50+ story
    // epics regardless of how often the reporter fires.
    const fetchesByTicket = new Map();
    const fixtureBody = buildPhaseCommentBody(1, [
      ['implement', 30_000],
      ['lint', 200],
    ]);
    const provider = {
      async getTicket() {
        return { number: 1, title: 'A', state: 'CLOSED', labels: [] };
      },
      async getTicketComments(ticketId) {
        fetchesByTicket.set(ticketId, (fetchesByTicket.get(ticketId) ?? 0) + 1);
        if (ticketId === 1) return [{ id: 'c-1', body: fixtureBody }];
        return []; // epic-level progress upsert — no prior comment.
      },
      async postComment() {
        return { id: 'u-1' };
      },
      async deleteComment() {},
    };
    const reporter = new ProgressReporter({
      provider,
      epicId: 7,
      intervalSec: 60,
      logger: silentLogger(),
    });
    reporter.setWave({ index: 0, totalWaves: 1, stories: [1] });
    await reporter.fire();
    await reporter.fire();
    await reporter.fire();
    assert.equal(
      fetchesByTicket.get(1) ?? 0,
      2,
      'one fetch per marker (story-run-progress + phase-timings); both cached on subsequent fires',
    );
  });

  it('caps phase-timings comment fetch fanout using reporter concurrency', async () => {
    const storyIds = Array.from({ length: 20 }, (_, i) => 1000 + i);
    let inFlight = 0;
    let maxInFlight = 0;
    const provider = {
      async getTicket(id) {
        return { number: id, title: `S${id}`, state: 'CLOSED', labels: [] };
      },
      async getTicketComments(ticketId) {
        if (storyIds.includes(ticketId)) {
          inFlight += 1;
          if (inFlight > maxInFlight) maxInFlight = inFlight;
          await new Promise((r) => setImmediate(r));
          await new Promise((r) => setImmediate(r));
          inFlight -= 1;
          return [
            {
              id: `c-${ticketId}`,
              body: buildPhaseCommentBody(ticketId, [['implement', 100]]),
            },
          ];
        }
        return [];
      },
      async postComment() {
        return { id: 'u-1' };
      },
      async deleteComment() {},
    };
    const reporter = new ProgressReporter({
      provider,
      epicId: 7,
      intervalSec: 60,
      logger: silentLogger(),
      concurrency: 3,
    });
    reporter.setWave({ index: 0, totalWaves: 1, stories: storyIds });

    await reporter.fire();

    assert.equal(maxInFlight, 3);
  });

  it('parsePhaseTimingsComment tolerates malformed bodies', () => {
    assert.equal(parsePhaseTimingsComment(null), null);
    assert.equal(parsePhaseTimingsComment({}), null);
    assert.equal(parsePhaseTimingsComment({ body: 'no fence here' }), null);
    assert.equal(
      parsePhaseTimingsComment({ body: '```json\nnot-json\n```' }),
      null,
    );
    assert.equal(
      parsePhaseTimingsComment({ body: '```json\n{"phases": "nope"}\n```' }),
      null,
    );
  });

  it('aggregatePhaseTimings handles zero and single-sample inputs', () => {
    assert.deepEqual(aggregatePhaseTimings([]), []);
    const rows = aggregatePhaseTimings([
      {
        storyId: 1,
        totalMs: 1,
        phases: [{ name: 'implement', elapsedMs: 42 }],
      },
    ]);
    assert.deepEqual(rows, [{ name: 'implement', median: 42, p95: 42, n: 1 }]);
  });

  it('renderPhaseTimingsSection returns null for empty input', () => {
    assert.equal(renderPhaseTimingsSection([]), null);
    assert.equal(renderPhaseTimingsSection(null), null);
  });

  it('stop() emits a final snapshot and clears the interval', async () => {
    let intervalCleared = false;
    const fakeSetInterval = () => ({ ref: () => {}, unref: () => {} });
    const fakeClearInterval = () => {
      intervalCleared = true;
    };
    const provider = buildProvider({
      1: { number: 1, title: 'x', state: 'CLOSED', labels: [] },
    });
    const reporter = new ProgressReporter({
      provider,
      epicId: 1,
      intervalSec: 60,
      logger: silentLogger(),
      setInterval: fakeSetInterval,
      clearInterval: fakeClearInterval,
    });
    reporter.setWave({ index: 0, totalWaves: 1, stories: [1] });
    reporter.start();
    await reporter.stop();
    assert.equal(intervalCleared, true);
    const [comment] = await provider.listComments();
    assert.ok(comment.body.includes('Progress — Wave 1/1'));
  });

  describe('consecutive fire() failure escalation', () => {
    function buildFlakyProvider({ failuresBeforeRecover, epicLabels = [] }) {
      let remaining = failuresBeforeRecover;
      const updateCalls = [];
      return {
        updateCalls,
        async getTicket(id) {
          if (id === 999) {
            return {
              number: 999,
              title: 'Epic',
              state: 'OPEN',
              labels: epicLabels,
            };
          }
          if (remaining > 0) {
            remaining -= 1;
            throw new Error(
              `provider down (${remaining} more failures queued)`,
            );
          }
          return { number: id, title: `s${id}`, state: 'OPEN', labels: [] };
        },
        async getTicketComments() {
          return [];
        },
        async listComments() {
          return [];
        },
        async postComment() {
          return { id: 'c1' };
        },
        async updateComment() {
          return { id: 'c1' };
        },
        async updateTicket(id, patch) {
          updateCalls.push({ id, patch });
          return { id, ...patch };
        },
      };
    }

    function newReporter(provider, overrides = {}) {
      const reporter = new ProgressReporter({
        provider,
        epicId: 999,
        intervalSec: 60,
        logger: silentLogger(),
        concurrency: 1,
        setInterval: () => ({ ref: () => {}, unref: () => {} }),
        ...overrides,
      });
      reporter.setWave({ index: 0, totalWaves: 1, stories: [1] });
      return reporter;
    }

    it('one transient failure does not escalate', async () => {
      const provider = buildFlakyProvider({ failuresBeforeRecover: 1 });
      const reporter = newReporter(provider);
      await reporter.tick();
      assert.equal(reporter.consecutiveFireFailures, 1);
      assert.equal(provider.updateCalls.length, 0);
    });

    it('three consecutive failures escalate exactly once with agent::blocked', async () => {
      const provider = buildFlakyProvider({
        failuresBeforeRecover: 10,
        epicLabels: ['type::epic', 'agent::executing'],
      });
      const reporter = newReporter(provider);
      await reporter.tick();
      await reporter.tick();
      assert.equal(
        provider.updateCalls.length,
        0,
        'no escalation before 3 strikes',
      );
      await reporter.tick();
      assert.equal(reporter.consecutiveFireFailures, 3);
      assert.equal(provider.updateCalls.length, 1, 'escalated exactly once');
      assert.ok(
        provider.updateCalls[0].patch.labels.includes('agent::blocked'),
        'Epic transitioned to agent::blocked',
      );
      assert.ok(
        !provider.updateCalls[0].patch.labels.includes('agent::executing'),
        'previous agent:: label was stripped',
      );
      // Subsequent failure increments but does NOT re-escalate at the same boundary.
      await reporter.tick();
      assert.equal(reporter.consecutiveFireFailures, 4);
      assert.equal(provider.updateCalls.length, 1, 'no duplicate escalation');
    });

    it('recovery after two failures clears the counter', async () => {
      const provider = buildFlakyProvider({ failuresBeforeRecover: 2 });
      const reporter = newReporter(provider);
      await reporter.tick();
      await reporter.tick();
      assert.equal(reporter.consecutiveFireFailures, 2);
      await reporter.tick();
      assert.equal(
        reporter.consecutiveFireFailures,
        0,
        'counter reset on success',
      );
      assert.equal(provider.updateCalls.length, 0, 'no escalation');
    });
  });
});

describe('runHotspotDetection', () => {
  function makeLogger() {
    const warnings = [];
    const infos = [];
    return {
      warnings,
      infos,
      info: (m) => infos.push(m),
      warn: (m) => warnings.push(m),
      error: () => {},
    };
  }

  it('resolves multiplier via getSignals(config) and persists each event via appendEpicSignal', async () => {
    const logger = makeLogger();
    const detectorCalls = [];
    const appendCalls = [];
    const events = [
      {
        ts: 't',
        kind: 'hotspot',
        source: { tool: 'hotspot-detector' },
        epicId: 1721,
        details: {
          targetHash: 'h-a',
          totalEdits: 12,
          storiesAffected: 3,
          p95Threshold: 7.5,
          multiplier: 1.5,
        },
      },
      {
        ts: 't',
        kind: 'hotspot',
        source: { tool: 'hotspot-detector' },
        epicId: 1721,
        details: {
          targetHash: 'h-b',
          totalEdits: 14,
          storiesAffected: 2,
          p95Threshold: 7.5,
          multiplier: 1.5,
        },
      },
    ];
    const result = await runHotspotDetection({
      epicId: 1721,
      config: {
        delivery: { signals: { hotspot: { p95Multiplier: 1.5 } } },
      },
      logger,
      detect: async (args) => {
        detectorCalls.push(args);
        return events;
      },
      append: async (args) => {
        appendCalls.push(args);
        return true;
      },
    });
    assert.deepEqual(result, { hotspot: 2 });
    assert.equal(detectorCalls.length, 1);
    assert.equal(detectorCalls[0].epicId, 1721);
    assert.equal(
      detectorCalls[0].multiplier,
      1.5,
      'forwards merged multiplier',
    );
    assert.equal(appendCalls.length, 2);
    assert.equal(appendCalls[0].epicId, 1721);
    assert.equal(appendCalls[0].signal.kind, 'hotspot');
  });

  it('failure-isolated: detector throws → returns hotspot=0 and logs warn', async () => {
    const logger = makeLogger();
    const result = await runHotspotDetection({
      epicId: 1721,
      config: {},
      logger,
      detect: async () => {
        throw new Error('detector boom');
      },
      append: async () => true,
    });
    assert.deepEqual(result, { hotspot: 0 });
    assert.ok(
      logger.warnings.some((m) => /detector threw/.test(m)),
      `expected warn log, got: ${JSON.stringify(logger.warnings)}`,
    );
  });

  it('failure-isolated: appendEpicSignal throwing on one event does not block subsequent events', async () => {
    const logger = makeLogger();
    let calls = 0;
    const result = await runHotspotDetection({
      epicId: 1721,
      config: {},
      logger,
      detect: async () => [
        {
          ts: 't',
          kind: 'hotspot',
          source: { tool: 'hotspot-detector' },
          epicId: 1721,
          details: {
            targetHash: 'a',
            totalEdits: 9,
            storiesAffected: 2,
            p95Threshold: 5,
            multiplier: 1.25,
          },
        },
        {
          ts: 't',
          kind: 'hotspot',
          source: { tool: 'hotspot-detector' },
          epicId: 1721,
          details: {
            targetHash: 'b',
            totalEdits: 9,
            storiesAffected: 2,
            p95Threshold: 5,
            multiplier: 1.25,
          },
        },
      ],
      append: async () => {
        calls += 1;
        if (calls === 1) throw new Error('disk boom');
        return true;
      },
    });
    assert.deepEqual(result, { hotspot: 1 });
    assert.ok(logger.warnings.some((m) => /appendEpicSignal failed/.test(m)));
  });

  it('skips with hotspot=0 when epicId is invalid', async () => {
    const logger = makeLogger();
    const result = await runHotspotDetection({
      epicId: 0,
      config: {},
      logger,
      detect: async () => {
        throw new Error('should not be called');
      },
      append: async () => true,
    });
    assert.deepEqual(result, { hotspot: 0 });
  });
});

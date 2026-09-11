import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { graduateRetroProposals } from '../../../.agents/scripts/lib/feedback-loop/retro-proposals-graduator.js';
import { DEFAULT_FRAMEWORK_REPO } from '../../../.agents/scripts/lib/github/framework-repo.js';
import {
  emitBlockRecoveredFriction,
  emitRuntimeFriction,
  RUNTIME_FRICTION_CATEGORIES,
} from '../../../.agents/scripts/lib/observability/runtime-friction.js';
import {
  composeRoutedProposals,
  deriveUnresolvedBlockedEvents,
} from '../../../.agents/scripts/lib/orchestration/retro-proposals.js';
import { runPostLandTail } from '../../../.agents/scripts/lib/orchestration/single-story-close/phases/post-land.js';
import {
  assessRollupOutcome,
  buildFollowUpsCommentBody,
  captureStoryFollowUps,
  gatherRunFrictionSignals,
  gatherStoryFrictionSignals,
  resolveFollowUpRepos,
  summarizeSignalCategories,
} from '../../../.agents/scripts/lib/orchestration/story-follow-ups.js';
import { makeTempDir } from '../../../.agents/scripts/lib/test-temp.js';

describe('story follow-ups', () => {
  it('resolves repos from github config', () => {
    const repos = resolveFollowUpRepos({
      github: {
        owner: 'acme',
        repo: 'app',
        followUpRepos: { framework: 'acme/mandrel', platform: 'acme/platform' },
      },
    });
    assert.equal(repos.consumerRepo, 'acme/app');
    assert.equal(repos.frameworkRepo, 'acme/mandrel');
    assert.equal(repos.platform, 'acme/platform');
    assert.deepEqual(repos.repos.platform, { owner: 'acme', repo: 'platform' });
  });

  it('defaults the framework bucket but never invents a platform one', () => {
    // Story #5300 — `framework` is the one bucket with a knowable default;
    // `platform` unset must stay null so a caller reports it as unroutable
    // instead of filing platform-owned work in the nearest tracker.
    const repos = resolveFollowUpRepos({
      github: { owner: 'acme', repo: 'app' },
    });
    assert.equal(repos.frameworkRepo, DEFAULT_FRAMEWORK_REPO);
    assert.equal(repos.platform, null);
    assert.equal(repos.repos.platform, null);
    assert.deepEqual(repos.repos.consumer, { owner: 'acme', repo: 'app' });
  });

  it('falls back to the mirror constant when no consumer repo is configured', () => {
    // The `currentRepo` arm nothing else reaches: with no github block the
    // consumer slug has to come from somewhere, and it is the mirror — never
    // a half-formed `unknown/unknown` the graduators would then file into.
    const repos = resolveFollowUpRepos({});
    assert.equal(repos.consumerRepo, DEFAULT_FRAMEWORK_REPO);
    assert.deepEqual(
      repos.currentRepo,
      { owner: 'dsj1984', repo: 'mandrel' },
      'currentRepo is derived from the resolved consumer slug',
    );
    assert.deepEqual(repos.repos.consumer, repos.currentRepo);
  });

  it('ignores the retired github.frameworkRepo key', () => {
    // It was read here but rejected by the closed schema, so it never
    // validated — a phantom key, retired by Story #5300 rather than migrated.
    const repos = resolveFollowUpRepos({
      github: { owner: 'acme', repo: 'app', frameworkRepo: 'acme/legacy' },
    });
    assert.equal(repos.frameworkRepo, DEFAULT_FRAMEWORK_REPO);
  });

  it('records — but does not file — single-occurrence Story friction', () => {
    // Story #4649: a per-Story window has population 1, so the old
    // story-scope threshold of 1 auto-filed every transient event on a
    // cleanly-shipped Story. It lands in `discarded` now, which the
    // follow-ups comment still renders.
    const proposals = composeRoutedProposals({
      anchorId: 42,
      anchorKind: 'story',
      frameworkRepo: 'a/b',
      consumerRepo: 'c/d',
      signals: [{ category: 'lint-loop', source: 'framework', storyId: 42 }],
    });
    assert.equal(proposals.framework.length, 0);
    assert.equal(proposals.consumer.length, 0);
    // Story #4824 widened DiscardedItem with the descriptive fields a
    // below-threshold roll-up needs to name what it discarded.
    assert.deepEqual(proposals.discarded, [
      {
        category: 'lint-loop',
        occurrences: 1,
        source: 'framework',
        tools: [],
        fingerprint: proposals.discarded[0].fingerprint,
        storyCount: 1,
      },
    ]);
    assert.match(proposals.discarded[0].fingerprint, /^[0-9a-f]{8}$/);
  });

  it('still files a genuinely recurring Story friction category', () => {
    const proposals = composeRoutedProposals({
      anchorId: 42,
      anchorKind: 'story',
      frameworkRepo: 'a/b',
      consumerRepo: 'c/d',
      signals: [
        { category: 'lint-loop', source: 'framework', storyId: 42 },
        { category: 'lint-loop', source: 'framework', storyId: 42 },
      ],
    });
    assert.equal(proposals.framework.length, 1);
    assert.match(proposals.framework[0].title, /Story #42/);
    assert.equal(proposals.discarded.length, 0);
  });

  it('renders a follow-ups comment body', () => {
    const body = buildFollowUpsCommentBody({
      storyId: 9,
      proposals: {
        framework: [],
        consumer: [],
        discarded: [{ category: 'noise', occurrences: 1, source: 'consumer' }],
      },
      graduated: { filed: [] },
    });
    assert.match(body, /follow-ups/);
    assert.match(body, /Story #9/);
    assert.match(body, /noise/);
  });
});

describe('gatherStoryFrictionSignals field preservation (Story #4649)', () => {
  /**
   * The regression this whole Story exists for: both production gathers used
   * to flatten each record to `{ category, source }`, dropping exactly the
   * two fields the composer's recovery-netting keys on. The #4622 fix was
   * therefore unreachable on real data while its unit tests stayed green,
   * because they fed the composer synthetic signals no producer emitted.
   *
   * So this test drives the REAL writer and the REAL gather against a real
   * temp tree — a composer-level assertion could not have caught it.
   */
  let tempRoot;
  let config;

  beforeEach(async () => {
    tempRoot = await makeTempDir('follow-ups-');
    config = { project: { paths: { tempRoot } } };
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('preserves storyId and details through the gather', async () => {
    await emitRuntimeFriction({
      storyId: 4649,
      category: RUNTIME_FRICTION_CATEGORIES.STORY_BLOCKED,
      tool: 'test',
      details: { toState: 'agent::blocked' },
      config,
    });

    const signals = await gatherStoryFrictionSignals(4649, config);
    assert.equal(signals.length, 1);
    assert.equal(signals[0].category, 'story-blocked');
    assert.equal(signals[0].storyId, 4649);
    assert.equal(signals[0].details.toState, 'agent::blocked');
  });

  it('nets a self-resolved block out end-to-end, writer through composer', async () => {
    await emitRuntimeFriction({
      storyId: 4650,
      category: RUNTIME_FRICTION_CATEGORIES.STORY_BLOCKED,
      tool: 'test',
      details: { toState: 'agent::blocked' },
      config,
    });
    await emitBlockRecoveredFriction({
      storyId: 4650,
      fromState: 'agent::blocked',
      toState: 'agent::executing',
      config,
    });

    const signals = await gatherStoryFrictionSignals(4650, config);
    assert.equal(signals.length, 2, 'both records are on the stream');

    const proposals = composeRoutedProposals({
      anchorId: 4650,
      anchorKind: 'story',
      frameworkRepo: 'a/b',
      consumerRepo: 'c/d',
      signals,
      unresolvedBlockedEvents: deriveUnresolvedBlockedEvents(signals),
    });
    assert.deepEqual(
      proposals,
      { framework: [], consumer: [], discarded: [] },
      'a Story that blocked and self-resolved files nothing',
    );
  });
});

/**
 * Story #4824 — the recurrence WINDOW, not the threshold.
 *
 * `gatherRunFrictionSignals` used to reduce over the current run's Story ids
 * only. A defect that fires exactly once per Story — which is what a systemic
 * framework defect looks like — therefore scored `occurrences: 1` on every
 * Story and was discarded as a singleton, on every Story, forever. Eighteen
 * consecutive Stories filed nothing.
 *
 * These drive the REAL writer into a real temp tree and the REAL gather back
 * out, because that is the only place the bug lived: a composer-level test
 * fed synthetic multi-Story signals no production gather could produce.
 */
describe('cross-Story recurrence window (Story #4824)', () => {
  let tempRoot;
  let config;

  beforeEach(async () => {
    tempRoot = await makeTempDir('recurrence-window-');
    config = { project: { paths: { tempRoot } } };
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  /** Emit the real `tool-degraded` record a lint-runner failure produces. */
  const degrade = (storyId) =>
    emitRuntimeFriction({
      storyId,
      category: RUNTIME_FRICTION_CATEGORIES.TOOL_DEGRADED,
      tool: 'native-review-lint',
      details: {
        surface: 'scoped-lint',
        reason: 'lint runner produced no parseable output',
      },
      config,
    });

  it('AC-4: one occurrence in each of two Stories reaches the threshold', async () => {
    await degrade(8101);
    await degrade(8102);

    // The run under way is Story #8102 alone — exactly the shape that used to
    // discard this defect as a singleton.
    const { signals } = await gatherRunFrictionSignals([8102], config);
    assert.equal(signals.length, 2, 'the window spans both surviving streams');

    const proposals = composeRoutedProposals({
      anchorId: 8102,
      anchorKind: 'run',
      frameworkRepo: 'dsj1984/mandrel',
      consumerRepo: 'acme/app',
      signals,
      unresolvedBlockedEvents: deriveUnresolvedBlockedEvents(signals),
    });
    assert.equal(proposals.discarded.length, 0, 'no longer discarded');
    assert.equal(proposals.framework.length, 1);
    assert.equal(proposals.framework[0].category, 'tool-degraded');
    assert.equal(proposals.framework[0].occurrences, 2);
  });

  it('AC-5: five streams carrying one fingerprint produce exactly one proposal', async () => {
    for (const sid of [8201, 8202, 8203, 8204, 8205]) await degrade(sid);

    const { signals } = await gatherRunFrictionSignals([8205], config);
    assert.equal(signals.length, 5);

    const proposals = composeRoutedProposals({
      anchorId: 8205,
      anchorKind: 'run',
      frameworkRepo: 'dsj1984/mandrel',
      consumerRepo: 'acme/app',
      signals,
    });
    assert.equal(
      proposals.framework.length + proposals.consumer.length,
      1,
      'recurrence files one proposal, never one per occurrence',
    );
    assert.equal(proposals.framework[0].occurrences, 5);
  });

  it('counts an event once even though the run Story is also walked', async () => {
    // The gather reads the run's own Story explicitly AND rediscovers it in
    // the temp-tree walk. Without `eventId` de-duplication that inflates a
    // genuine singleton into a fabricated recurrence.
    await degrade(8301);

    const { signals } = await gatherRunFrictionSignals([8301], config);
    assert.equal(signals.length, 1);

    const proposals = composeRoutedProposals({
      anchorId: 8301,
      anchorKind: 'run',
      frameworkRepo: 'dsj1984/mandrel',
      consumerRepo: 'acme/app',
      signals,
    });
    assert.equal(proposals.framework.length, 0);
    assert.equal(proposals.discarded.length, 1);
    assert.equal(proposals.discarded[0].occurrences, 1);
  });

  it('walks Epic-attached streams as well as standalone ones', async () => {
    await emitRuntimeFriction({
      storyId: 8401,
      epicId: 9001,
      category: RUNTIME_FRICTION_CATEGORIES.TOOL_DEGRADED,
      tool: 'local-lens-review',
      details: { surface: 'lens-materialization', reason: 'ENOENT' },
      config,
    });
    await degrade(8402);

    const { signals } = await gatherRunFrictionSignals([8402], config);
    assert.equal(signals.length, 2, 'run-<eid>/stories/ is in the window too');
    assert.deepEqual(signals.map((s) => s.storyId).sort(), [8401, 8402]);
  });

  it('returns no signals when the temp tree does not exist', async () => {
    const missing = { project: { paths: { tempRoot: `${tempRoot}/absent` } } };
    const { signals, window } = await gatherRunFrictionSignals([1, 2], missing);
    assert.deepEqual(signals, []);
    assert.equal(window.excludedStale, 0);
    assert.equal(window.excludedUnparseable, 0);
  });

  it('tags a runtime tool-degradation framework end to end (Story #4824)', async () => {
    // The classification limb and the window limb meet here: the record is
    // written by the real writer, so its `source` is whatever
    // `tagSignalSource` decided — which, pre-#4824, was always `consumer`.
    await degrade(8501);
    const { signals } = await gatherRunFrictionSignals([8501], config);
    assert.equal(signals[0].source, 'framework');
    assert.equal(signals[0].tool, 'native-review-lint');
  });
});

/**
 * Story #4850 — widening the window to the whole surviving temp tree
 * (Story #4824) also made it unbounded in TIME. A defect fixed weeks ago kept
 * its occurrences on disk and kept re-routing forever, burying a genuine new
 * regression under a historical ledger.
 *
 * The floor fails toward UNDER-counting: an out-of-window row and an undateable
 * row are both excluded, because under-counting fails toward not filing, which
 * is the safe direction. Both exclusions are counted, never silent.
 */
describe('friction recurrence window is age-bounded (Story #4850)', () => {
  let tempRoot;
  let config;

  beforeEach(async () => {
    tempRoot = await makeTempDir('friction-window-');
    config = { project: { paths: { tempRoot } } };
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  /** Write one row directly, so its `ts` can be placed anywhere in time. */
  async function seedRow(storyId, ts, category = 'tool-degraded') {
    const dir = `${tempRoot}/standalone/stories/story-${storyId}`;
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(
      `${dir}/signals.ndjson`,
      `${JSON.stringify({
        kind: 'friction',
        eventId: `${storyId}-${ts}-${category}`,
        category,
        storyId,
        source: 'framework',
        emitter: { tool: 'native-review-lint' },
        details: { surface: 'scoped-lint' },
        ...(ts === undefined ? {} : { ts }),
      })}\n`,
      'utf8',
    );
  }

  const daysAgo = (now, days) => new Date(now - days * 86400000).toISOString();

  it('AC-4: excludes rows older than the default 30-day window', async () => {
    const now = Date.parse('2026-07-30T12:00:00.000Z');
    await seedRow(8601, daysAgo(now, 2));
    await seedRow(8602, daysAgo(now, 29));
    await seedRow(8603, daysAgo(now, 31));
    await seedRow(8604, daysAgo(now, 400));

    const { signals, window } = await gatherRunFrictionSignals([8601], config, {
      now,
    });
    assert.deepEqual(
      signals.map((s) => s.storyId).sort(),
      [8601, 8602],
      'only the in-window rows reach the composer',
    );
    assert.equal(window.days, 30, 'the default bound is 30 days');
    assert.equal(window.cutoff, daysAgo(now, 30));
    assert.equal(window.excludedStale, 2);
    assert.equal(window.excludedUnparseable, 0);
  });

  it('AC-4: honours delivery.feedbackLoop.frictionWindowDays', async () => {
    const now = Date.parse('2026-07-30T12:00:00.000Z');
    await seedRow(8701, daysAgo(now, 3));
    await seedRow(8702, daysAgo(now, 10));

    const tuned = {
      ...config,
      delivery: { feedbackLoop: { frictionWindowDays: 7 } },
    };
    const { signals, window } = await gatherRunFrictionSignals([8701], tuned, {
      now,
    });
    assert.deepEqual(
      signals.map((s) => s.storyId),
      [8701],
    );
    assert.equal(window.days, 7);
    assert.equal(window.excludedStale, 1);
  });

  it('AC-4: excludes an undateable row rather than aging it in', async () => {
    const now = Date.parse('2026-07-30T12:00:00.000Z');
    await seedRow(8801, undefined);
    await seedRow(8802, 'the day before yesterday');
    await seedRow(8803, daysAgo(now, 1));

    const { signals, window } = await gatherRunFrictionSignals([8803], config, {
      now,
    });
    assert.deepEqual(
      signals.map((s) => s.storyId),
      [8803],
      'a row with no readable ts cannot be proven in-window, so it is out',
    );
    assert.equal(window.excludedUnparseable, 2);
    assert.equal(window.excludedStale, 0);
  });

  it('AC-4: an aged-out incident cannot be resurrected by its recovery marker', async () => {
    // The netting is per (category, storyId) over the rows in the window. A
    // marker is written after the incident it cancels, so this asymmetric case
    // — stale incident, fresh marker — is the only one the floor can produce,
    // and it must contribute nothing rather than a bare `recovered` row.
    const now = Date.parse('2026-07-30T12:00:00.000Z');
    await seedRow(8901, daysAgo(now, 90), 'close-failed');
    const dir = `${tempRoot}/standalone/stories/story-8901`;
    await fs.appendFile(
      `${dir}/signals.ndjson`,
      `${JSON.stringify({
        kind: 'friction',
        eventId: 'marker-8901',
        category: 'close-failed',
        storyId: 8901,
        source: 'framework',
        ts: daysAgo(now, 1),
        details: { recovered: true },
      })}\n`,
      'utf8',
    );

    const { signals } = await gatherRunFrictionSignals([8901], config, { now });
    assert.equal(signals.length, 1, 'only the fresh marker is in the window');
    const proposals = composeRoutedProposals({
      anchorId: 8901,
      anchorKind: 'run',
      anchorStoryIds: [8901],
      frameworkRepo: 'a/b',
      consumerRepo: 'c/d',
      signals,
    });
    assert.deepEqual(proposals, {
      framework: [],
      consumer: [],
      discarded: [],
    });
  });
});

describe('post-land recovery marking end-to-end (Story #4654)', () => {
  let tempRoot;
  let config;

  beforeEach(async () => {
    tempRoot = await makeTempDir('post-land-recover-');
    // Disable auto-filing so the graduator is a no-op (no `gh` calls) and the
    // assertions read the composed proposals, not a live GitHub filing.
    config = {
      project: { paths: { tempRoot } },
      delivery: { feedbackLoop: { retroProposals: false } },
    };
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  /** A ticketing provider fake sufficient for `upsertStructuredComment`. */
  function fakeProvider() {
    let nextId = 1;
    return {
      getTicketComments: async () => [],
      postComment: async () => ({ id: nextId++ }),
      deleteComment: async () => {},
    };
  }

  /**
   * Run only the recovery-marker emits of the tail against a real temp tree:
   * every git/GitHub/status/lock step is stubbed so the emits (defaulted to
   * the real functions, threaded `config`) are the only side effect.
   */
  const landTail = (storyId) =>
    runPostLandTail({
      storyId,
      storyBranch: `story-${storyId}`,
      baseBranch: 'main',
      cwd: tempRoot,
      provider: {},
      config,
      captureStoryFollowUpsFn: async () => ({ ok: true }),
      reassertStatusColumnFn: async () => ({ status: 'synced' }),
      gitSpawnFn: () => ({ status: 1 }),
      planFastForwardFn: () => ({
        runnable: false,
        reason: 'already-up-to-date',
      }),
      executeFastForwardFn: () => ({ applied: true, behind: 0 }),
      acquireLockWithWaitFn: async () => ({
        acquired: true,
        release: () => {},
        ownerId: 't',
      }),
    });

  const seed = (storyId, category) =>
    emitRuntimeFriction({
      storyId,
      category,
      tool: 'test',
      details: { reason: 'boom' },
      config,
    });

  it('AC-1: a Story that blocked then landed files no story-blocked follow-up', async () => {
    await seed(5501, RUNTIME_FRICTION_CATEGORIES.STORY_BLOCKED);
    await landTail(5501);

    const result = await captureStoryFollowUps({
      storyId: 5501,
      provider: fakeProvider(),
      config,
    });
    assert.equal(result.ok, true);
    const filed = [...result.proposals.framework, ...result.proposals.consumer];
    assert.ok(
      !filed.some((i) => i.category === 'story-blocked'),
      'no story-blocked proposal survives the recovery marker',
    );
    assert.equal(result.graduated.filed.length, 0);
  });

  it('AC-2: the marker is conditional — a Story that never blocked gains no story-blocked row', async () => {
    await landTail(5502);
    const rows = await gatherStoryFrictionSignals(5502, config);
    assert.deepEqual(rows, [], 'no spurious marker suppresses a clean bucket');
  });

  it('AC-5: three merge-wait-exhausted records that then land file no follow-up', async () => {
    await seed(5503, RUNTIME_FRICTION_CATEGORIES.MERGE_WAIT_EXHAUSTED);
    await seed(5503, RUNTIME_FRICTION_CATEGORIES.MERGE_WAIT_EXHAUSTED);
    await seed(5503, RUNTIME_FRICTION_CATEGORIES.MERGE_WAIT_EXHAUSTED);
    await landTail(5503);

    const result = await captureStoryFollowUps({
      storyId: 5503,
      provider: fakeProvider(),
      config,
    });
    assert.equal(result.ok, true);
    const filed = [...result.proposals.framework, ...result.proposals.consumer];
    assert.ok(
      !filed.some((i) => i.category === 'merge-wait-exhausted'),
      'genuine exhaustion clears the ≥2 threshold but is netted by the marker',
    );
    assert.equal(result.graduated.filed.length, 0);
  });
});

describe('unresolved-block derivation (Story #4649)', () => {
  const BLOCKED = 'story-blocked';
  const blk = (storyId, details) => ({
    category: BLOCKED,
    source: 'framework',
    storyId,
    details: details ?? { toState: 'agent::blocked' },
  });
  const recovered = (storyId) => blk(storyId, { recovered: true });

  it('emits an event for a Story still parked at agent::blocked', () => {
    assert.deepEqual(deriveUnresolvedBlockedEvents([blk(7)]), [
      { ticketId: 7, source: 'framework', category: BLOCKED },
    ]);
  });

  it('emits nothing for a Story whose block self-resolved', () => {
    assert.deepEqual(deriveUnresolvedBlockedEvents([blk(7), recovered(7)]), []);
  });

  it('forces a parked Story actionable at a single occurrence', () => {
    // The whole point of the derivation: this is what the retired
    // story-scope threshold carve-out was standing in for.
    const signals = [blk(7)];
    const proposals = composeRoutedProposals({
      anchorId: 7,
      anchorKind: 'story',
      frameworkRepo: 'a/b',
      consumerRepo: 'c/d',
      signals,
      unresolvedBlockedEvents: deriveUnresolvedBlockedEvents(signals),
    });
    assert.equal(proposals.framework.length, 1);
    assert.equal(proposals.framework[0].category, BLOCKED);
    assert.equal(proposals.discarded.length, 0);
  });

  it('files nothing for a Story that blocked and self-resolved', () => {
    const signals = [blk(7), recovered(7)];
    const proposals = composeRoutedProposals({
      anchorId: 7,
      anchorKind: 'story',
      frameworkRepo: 'a/b',
      consumerRepo: 'c/d',
      signals,
      unresolvedBlockedEvents: deriveUnresolvedBlockedEvents(signals),
    });
    assert.deepEqual(proposals, {
      framework: [],
      consumer: [],
      discarded: [],
    });
  });

  it('ignores non-block categories and unusable story ids', () => {
    assert.deepEqual(
      deriveUnresolvedBlockedEvents([
        { category: 'close-failed', source: 'framework', storyId: 7 },
        { category: BLOCKED, source: 'framework', storyId: 0 },
        { category: BLOCKED, source: 'framework' },
        null,
      ]),
      [],
    );
  });

  it('returns [] for a non-array input', () => {
    assert.deepEqual(deriveUnresolvedBlockedEvents(undefined), []);
  });
});

describe('empty roll-up assertion (Story #4578)', () => {
  const empty = {
    proposals: { framework: [], consumer: [], discarded: [] },
    graduated: { filed: [] },
  };

  it('stays quiet and truthful for a genuinely clean single-Story run', () => {
    const body = buildFollowUpsCommentBody({ storyId: 9, ...empty });
    assert.match(body, /No friction signals — nothing to follow up/);
    assert.doesNotMatch(body, /telemetry/i);
    assert.doesNotMatch(body, /claim/i);
  });

  it('defaults to the quiet reading when storyCount is omitted', () => {
    // captureStoryFollowUps (per-Story close) passes no storyCount.
    const body = buildFollowUpsCommentBody({ storyId: 9, ...empty });
    assert.match(body, /nothing to follow up/);
  });

  it('flags an empty roll-up over an N>1 run as a claim, not a success', () => {
    const body = buildFollowUpsCommentBody({
      storyId: 9,
      ...empty,
      storyCount: 7,
    });
    // The count is named — "0 across 7" is the claim worth flagging.
    assert.match(body, /0 friction signals across 7 Stories/);
    assert.match(body, /not a clean bill of health/);
    assert.match(body, /telemetry never fired/);
    // and it must NOT still read as the reassuring line.
    assert.doesNotMatch(body, /nothing to follow up/);
  });

  it('exposes emptyRollupSuspect in the machine-readable block', () => {
    const flagged = buildFollowUpsCommentBody({
      storyId: 9,
      ...empty,
      storyCount: 7,
    });
    assert.match(flagged, /"emptyRollupSuspect": true/);
    assert.match(flagged, /"storyCount": 7/);

    const clean = buildFollowUpsCommentBody({ storyId: 9, ...empty });
    assert.match(clean, /"emptyRollupSuspect": false/);
  });

  it('does not flag an N>1 run that actually produced signals', () => {
    const body = buildFollowUpsCommentBody({
      storyId: 9,
      proposals: {
        framework: [],
        consumer: [],
        discarded: [{ category: 'noise', occurrences: 1, source: 'consumer' }],
      },
      graduated: { filed: [] },
      storyCount: 7,
    });
    assert.doesNotMatch(body, /telemetry may not|not a clean bill of health/);
    assert.match(body, /"emptyRollupSuspect": false/);
  });
});

/**
 * Story #4828 — the roll-up over Stories 4824 + 4825 composed a routed
 * proposal at threshold and still filed zero.
 *
 * The composer was fine. `gh issue create` resolves every `--label` against
 * the repo before it creates anything and rejects the whole call when one is
 * absent, and the two axes the feedback loop stamps —
 * `meta::consumer-improvement` and `friction::<category>` — were absent:
 * neither is in `LABEL_TAXONOMY`, and a `friction::` name is minted from live
 * telemetry, so no bootstrap could have pre-created it. Every filing failed
 * into the graduator's `errors[]`, which nothing rendered.
 *
 * The fake below is the repo as it actually was: no labels, and a create that
 * rejects a label the repo does not carry.
 */
describe('a routed bucket at threshold reaches the filer (Story #4828)', () => {
  /**
   * @param {{ labelCreateFails?: boolean }} [opts]
   */
  function makeLabelAwareGh({ labelCreateFails = false } = {}) {
    const live = new Set();
    const created = [];
    const fn = function spawnImpl(cmd, args) {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      let result = { stdout: '', stderr: '', code: 0 };
      const [a0, a1] = args;
      if (cmd !== 'gh') {
        result = { stdout: '', stderr: '', code: 1 };
      } else if (a0 === 'label' && a1 === 'list') {
        result = {
          stdout: JSON.stringify([...live].map((name) => ({ name }))),
          stderr: '',
          code: 0,
        };
      } else if (a0 === 'label' && a1 === 'create') {
        if (labelCreateFails) {
          result = {
            stdout: '',
            stderr: 'HTTP 403: Resource not accessible',
            code: 1,
          };
        } else {
          live.add(args[2]);
          result = { stdout: '', stderr: '', code: 0 };
        }
      } else if (a0 === 'search' || (a0 === 'issue' && a1 === 'list')) {
        result = { stdout: '[]', stderr: '', code: 0 };
      } else if (a0 === 'issue' && a1 === 'create') {
        const labels = [];
        for (let i = 0; i < args.length; i += 1) {
          if (args[i] === '--label') labels.push(args[i + 1]);
        }
        const absent = labels.filter((label) => !live.has(label));
        if (absent.length > 0) {
          result = {
            stdout: '',
            stderr: `could not add label: '${absent[0]}' not found`,
            code: 1,
          };
        } else {
          created.push({ labels });
          result = {
            stdout: `https://github.com/acme/app/issues/${created.length}`,
            stderr: '',
            code: 0,
          };
        }
      }
      queueMicrotask(() => {
        if (result.stdout)
          child.stdout.emit('data', Buffer.from(result.stdout));
        if (result.stderr)
          child.stderr.emit('data', Buffer.from(result.stderr));
        child.emit('close', result.code);
      });
      return child;
    };
    fn.created = created;
    fn.live = live;
    return fn;
  }

  const provider = {
    getTicketComments: async () => [],
    postComment: async () => ({ commentId: 1 }),
    deleteComment: async () => {},
  };

  /** A category at the ≥2 threshold, routed to the repo the roll-up runs in. */
  function thresholdProposals() {
    return composeRoutedProposals({
      anchorId: 4824,
      anchorKind: 'run',
      frameworkRepo: 'acme/app',
      consumerRepo: 'acme/app',
      signals: [
        { category: 'tool-degraded', source: 'consumer', storyId: 4824 },
        { category: 'tool-degraded', source: 'consumer', storyId: 4825 },
      ],
      unresolvedBlockedEvents: [],
    });
  }

  it('mints the absent routing labels so a proposal at threshold files', async () => {
    const proposals = thresholdProposals();
    assert.equal(
      proposals.consumer.length,
      1,
      'arrange: the bucket is non-empty',
    );
    const gh = makeLabelAwareGh();

    const result = await graduateRetroProposals({
      epicId: 4824,
      provider,
      config: {},
      currentRepo: { owner: 'acme', repo: 'app' },
      frameworkRepo: { owner: 'acme', repo: 'app' },
      routedProposals: proposals,
      spawnImpl: gh,
    });

    assert.equal(
      result.filed.length,
      1,
      `expected one filing; got errors=${JSON.stringify(result.errors)} skipped=${JSON.stringify(result.skipped)}`,
    );
    assert.deepEqual(result.errors, []);
    assert.deepEqual(
      [...gh.live].sort(),
      ['friction::tool-degraded', 'meta::consumer-improvement'],
      'both absent axes are minted before the create',
    );
    assert.deepEqual(gh.created[0].labels.sort(), [
      'friction::tool-degraded',
      'meta::consumer-improvement',
    ]);
  });

  it('reports a filer that could not mint the label instead of returning a bare zero', async () => {
    const proposals = thresholdProposals();
    const gh = makeLabelAwareGh({ labelCreateFails: true });

    const result = await graduateRetroProposals({
      epicId: 4824,
      provider,
      config: {},
      currentRepo: { owner: 'acme', repo: 'app' },
      frameworkRepo: { owner: 'acme', repo: 'app' },
      routedProposals: proposals,
      spawnImpl: gh,
    });

    assert.equal(result.filed.length, 0);
    assert.equal(
      gh.created.length,
      0,
      'never attempts a create it knows will fail',
    );
    assert.ok(
      result.errors.some((e) => /gh label create/.test(e)),
      `expected a label-create error; got ${JSON.stringify(result.errors)}`,
    );
    assert.ok(result.skipped.some((s) => s.reason === 'label-ensure-failed'));

    // The reporting layer must call this what it is — a failing loop, not a
    // loop with nothing to say.
    const outcome = assessRollupOutcome({
      signalCount: 2,
      proposalCount: 1,
      discardedCount: 0,
      filedCount: 0,
      filingErrors: result.errors,
      filingSkipped: result.skipped,
    });
    assert.equal(outcome.unfiledProposals, true);
    assert.deepEqual(outcome.blockingSkipReasons, ['label-ensure-failed']);

    const body = buildFollowUpsCommentBody({
      storyId: 4824,
      proposals,
      graduated: result,
      storyCount: 2,
      signalCount: 2,
      categories: summarizeSignalCategories([
        { category: 'tool-degraded' },
        { category: 'tool-degraded' },
      ]),
    });
    assert.match(
      body,
      /1 actionable proposal\(s\) reached the filer and none were filed/,
    );
    assert.match(body, /gh label create/);
    assert.match(body, /"unfiledProposalSuspect": true/);
  });
});

/**
 * Story #4828 — the third instance of a silence this codebase has now fixed
 * three times: zero signals (#4578), all-discarded (#4824), and here, signals
 * gathered that produced no proposal at all.
 */
describe('zero proposals from a non-empty corpus (Story #4828)', () => {
  it('summarizes the categories it saw, in a stable order', () => {
    assert.deepEqual(
      summarizeSignalCategories([
        { category: 'tool-degraded' },
        { category: 'close-failed' },
        { category: 'tool-degraded' },
        { category: '  ' },
        null,
      ]),
      [
        { category: 'close-failed', occurrences: 1 },
        { category: 'tool-degraded', occurrences: 2 },
      ],
    );
  });

  it('flags signals-in / nothing-out, and does not flag a genuinely empty stream', () => {
    assert.equal(
      assessRollupOutcome({
        signalCount: 9,
        proposalCount: 0,
        discardedCount: 0,
        filedCount: 0,
      }).zeroProposals,
      true,
    );
    assert.equal(
      assessRollupOutcome({
        signalCount: 0,
        proposalCount: 0,
        discardedCount: 0,
        filedCount: 0,
      }).zeroProposals,
      false,
      'zero signals is the #4578 shape, reported by emptyRollupSuspect',
    );
    assert.equal(
      assessRollupOutcome({
        signalCount: 3,
        proposalCount: 0,
        discardedCount: 1,
        filedCount: 0,
      }).zeroProposals,
      false,
      'a below-threshold row is a rendered outcome, not silence',
    );
  });

  it('treats a deliberate skip as a decision, not a failure', () => {
    const outcome = assessRollupOutcome({
      signalCount: 4,
      proposalCount: 2,
      discardedCount: 0,
      filedCount: 0,
      filingSkipped: [
        { reason: 'already-filed' },
        { reason: 'toggle-disabled' },
      ],
    });
    assert.equal(outcome.unfiledProposals, false);
    assert.deepEqual(outcome.blockingSkipReasons, []);
  });

  it('names the corpus when nothing routed out of it', () => {
    const body = buildFollowUpsCommentBody({
      storyId: 4824,
      proposals: { framework: [], consumer: [], discarded: [] },
      graduated: { filed: [], skipped: [], errors: [] },
      storyCount: 2,
      signalCount: 4,
      categories: [
        { category: 'close-failed', occurrences: 2 },
        { category: 'story-blocked', occurrences: 2 },
      ],
    });
    assert.match(body, /4 friction signals gathered, 0 proposals produced/);
    assert.match(body, /`close-failed` ×2/);
    assert.match(body, /`story-blocked` ×2/);
    assert.doesNotMatch(
      body,
      /nothing to follow up/,
      'a corpus that produced nothing must not read as a clean run',
    );
    assert.match(body, /"zeroProposalSuspect": true/);
    assert.match(body, /"signalCount": 4/);
  });
});

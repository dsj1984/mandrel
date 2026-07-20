import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  emitBlockRecoveredFriction,
  emitRuntimeFriction,
  RUNTIME_FRICTION_CATEGORIES,
} from '../../../.agents/scripts/lib/observability/runtime-friction.js';
import {
  composeRoutedProposals,
  deriveUnresolvedBlockedEvents,
} from '../../../.agents/scripts/lib/orchestration/retro-proposals.js';
import {
  buildFollowUpsCommentBody,
  gatherStoryFrictionSignals,
  resolveFollowUpRepos,
} from '../../../.agents/scripts/lib/orchestration/story-follow-ups.js';

describe('story follow-ups', () => {
  it('resolves repos from github config', () => {
    const repos = resolveFollowUpRepos({
      github: { owner: 'acme', repo: 'app', frameworkRepo: 'acme/mandrel' },
    });
    assert.equal(repos.consumerRepo, 'acme/app');
    assert.equal(repos.frameworkRepo, 'acme/mandrel');
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
    assert.deepEqual(proposals.discarded, [
      { category: 'lint-loop', occurrences: 1, source: 'framework' },
    ]);
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
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'follow-ups-'));
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

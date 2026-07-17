import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { composeRoutedProposals } from '../../../.agents/scripts/lib/orchestration/retro-proposals.js';
import {
  buildFollowUpsCommentBody,
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

  it('promotes single-occurrence Story friction to actionable', () => {
    const proposals = composeRoutedProposals({
      anchorId: 42,
      anchorKind: 'story',
      frameworkRepo: 'a/b',
      consumerRepo: 'c/d',
      signals: [{ category: 'lint-loop', source: 'framework' }],
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

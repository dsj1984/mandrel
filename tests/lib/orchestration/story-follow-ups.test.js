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

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  getStoryBranch,
  isStoryBranch,
  parseStoryBranch,
} from '../../.agents/scripts/lib/git-utils.js';

describe('git-utils — parseStoryBranch', () => {
  it('extracts the numeric Story ID from a canonical branch name', () => {
    assert.equal(parseStoryBranch('story-3334'), 3334);
    assert.equal(parseStoryBranch('story-1'), 1);
  });

  it('round-trips with getStoryBranch', () => {
    const branch = getStoryBranch(null, 42);
    assert.equal(parseStoryBranch(branch), 42);
  });

  it('returns null for non-Story branch names', () => {
    assert.equal(parseStoryBranch('epic/3316'), null);
    assert.equal(parseStoryBranch('main'), null);
    assert.equal(parseStoryBranch('story-'), null);
    assert.equal(parseStoryBranch('story-12a'), null);
    assert.equal(parseStoryBranch('story/epic-1/2'), null);
    assert.equal(parseStoryBranch('feature-story-12'), null);
  });

  it('returns null for non-string input', () => {
    assert.equal(parseStoryBranch(undefined), null);
    assert.equal(parseStoryBranch(null), null);
    assert.equal(parseStoryBranch(3334), null);
  });
});

describe('git-utils — isStoryBranch', () => {
  it('is true for canonical Story branch names', () => {
    assert.equal(isStoryBranch('story-3334'), true);
    assert.equal(isStoryBranch('story-1'), true);
  });

  it('is false for non-Story branch names and bad input', () => {
    assert.equal(isStoryBranch('epic/3316'), false);
    assert.equal(isStoryBranch('main'), false);
    assert.equal(isStoryBranch('story-'), false);
    assert.equal(isStoryBranch(undefined), false);
    assert.equal(isStoryBranch(42), false);
  });
});

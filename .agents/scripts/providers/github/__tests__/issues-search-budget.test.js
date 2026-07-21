/**
 * `IssuesGateway#searchIssues` budget + rate-limit wiring (Story #4678).
 *
 * AC-1: `searchIssues` awaits the shared search budget before every
 *       `/search/issues` call.
 * AC-3: a rate-limit error no longer burns transient retries at the search
 *       call site — `gh api` is invoked exactly once for a `GhRateLimitError`
 *       (the budget, not `withTransientRetry`, owns the wait), while
 *       `classifyGithubError` still classifies that same error as transient.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { GhRateLimitError } from '../../../lib/gh-exec.js';
import { classifyGithubError } from '../errors.js';
import { IssuesGateway } from '../issues.js';

/** A budget stub that records the order of `take()` vs the wrapped call. */
function recordingBudget(events) {
  return {
    take: async () => {
      events.push('take');
    },
    noteRateLimited: (resetAtMs) => {
      events.push(`noteRateLimited:${resetAtMs}`);
    },
  };
}

describe('searchIssues budget wiring', () => {
  it('AC-1: awaits the search budget before issuing the /search/issues call', async () => {
    const events = [];
    const gh = {
      api: async () => {
        events.push('api');
        return { stdout: JSON.stringify({ items: [] }) };
      },
    };
    const gateway = new IssuesGateway({
      gh,
      owner: 'o',
      repo: 'r',
      searchBudget: recordingBudget(events),
    });

    await gateway.searchIssues({ query: 'abc' });

    assert.deepEqual(events, ['take', 'api'], 'budget taken before the call');
  });

  it('AC-3: invokes gh api exactly once for a rate-limit error and notes the budget', async () => {
    const events = [];
    let apiCalls = 0;
    const rateLimitErr = new GhRateLimitError(
      'gh-exec: gh API rate limit exceeded',
      { stderr: 'x-ratelimit-reset: 1704067200' },
    );
    const gh = {
      api: async () => {
        apiCalls += 1;
        throw rateLimitErr;
      },
    };
    const gateway = new IssuesGateway({
      gh,
      owner: 'o',
      repo: 'r',
      searchBudget: recordingBudget(events),
    });

    await assert.rejects(
      () => gateway.searchIssues({ query: 'abc' }),
      (err) => err instanceof GhRateLimitError,
    );

    assert.equal(apiCalls, 1, 'no transient-retry re-issue at the call site');
    assert.deepEqual(events, ['take', 'noteRateLimited:1704067200000']);
    // The global classifier is deliberately unchanged: other endpoints still
    // retry a rate-limit error.
    assert.equal(classifyGithubError(rateLimitErr), 'transient');
  });
});

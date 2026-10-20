/**
 * tests/scripts/gh-graphql-preflight.test.js — the GraphQL reachability
 * preflight (Story #5355): the probe in `lib/gh-exec.js`, the refusal text it
 * feeds, and the close-side step in
 * `single-story-close/phases/graphql-preflight.js` that turns a refusing
 * verdict into an `agent::blocked` Story.
 *
 * The defect this covers: a close run from a session where GitHub GraphQL
 * answers HTTP 403 ran the whole gate chain, synced, and pushed, and only
 * then died on `gh pr create` with `gh-exec: gh exited with code 1` wrapping
 * a raw 403 — a message naming neither the cause nor a remedy. Everything
 * asserted here is about learning that at second one instead.
 *
 * The end-to-end half — that the refusal stops the run in `init`, spawns no
 * gate, pushes nothing, and emits a schema-valid `blocked` envelope — lives in
 * `tests/single-story-close-sync.test.js`, where the close pipeline's
 * injection harness already is.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  describeGraphqlPreflight,
  GhAuthError,
  GhExecError,
  GhRateLimitError,
  GhScopeError,
  probeGraphqlAvailability,
  prSurfaceUsesRest,
  setGraphqlAvailability,
} from '../../.agents/scripts/lib/gh-exec.js';
import { runGraphqlPreflight } from '../../.agents/scripts/lib/orchestration/single-story-close/phases/graphql-preflight.js';

/** A gh facade whose single `api` call records its args and answers `reply`. */
function facadeThatAnswers(reply) {
  const calls = [];
  return {
    calls,
    api: async (opts) => {
      calls.push(opts);
      return reply;
    },
  };
}

/** A gh facade whose single `api` call rejects with `err`. */
function facadeThatRejects(err) {
  const calls = [];
  return {
    calls,
    api: async (opts) => {
      calls.push(opts);
      throw err;
    },
  };
}

function graphql403() {
  return new GhExecError('gh-exec: gh exited with code 1', {
    args: ['api', '-X', 'POST', 'graphql'],
    stderr: 'gh: HTTP 403 (https://api.github.com/graphql)',
    code: 1,
  });
}

describe('probeGraphqlAvailability', () => {
  // AC-4 — the happy path costs one API read and says so.
  it('reports available on one API read when GraphQL answers', async () => {
    const facade = facadeThatAnswers({
      stdout: '{"data":{"viewer":{"login":"octocat"}}}',
      stderr: '',
      code: 0,
    });
    const probe = await probeGraphqlAvailability({ ghFacade: facade });
    assert.deepEqual(probe, {
      verdict: 'available',
      available: true,
      reason: 'ok',
      detail: null,
    });
    assert.equal(facade.calls.length, 1, 'the probe is one API read');
    assert.equal(facade.calls[0].endpoint, 'graphql');
    assert.match(facade.calls[0].body.query, /viewer/);
    assert.ok(
      facade.calls[0].execOpts?.timeoutMs > 0,
      'the probe is bounded — a hung gh must never hold a close',
    );
  });

  // AC-3 (first half) — the 403 shape, carrying no rate-limit evidence, is
  // its own verdict.
  it('reports unavailable on an HTTP 403 from the GraphQL endpoint', async () => {
    const probe = await probeGraphqlAvailability({
      ghFacade: facadeThatRejects(graphql403()),
    });
    assert.equal(probe.verdict, 'unavailable');
    assert.equal(probe.available, false);
    assert.equal(probe.reason, 'http-403');
    assert.match(probe.detail, /403/);
  });

  // Story #5362 AC-1 — GitHub answers a secondary rate limit with HTTP 403.
  // A throttle says nothing about reachability, and the `unavailable` remedy
  // ("re-run from a local session") would send the operator to reproduce it.
  it('falls open to available when a 403 carries secondary-rate-limit text', async () => {
    const probe = await probeGraphqlAvailability({
      ghFacade: facadeThatRejects(
        new GhExecError('gh-exec: gh exited with code 1', {
          args: ['api', '-X', 'POST', 'graphql'],
          stderr:
            'gh: You have exceeded a secondary rate limit. Please wait a few minutes before you try again. (HTTP 403)',
          code: 1,
        }),
      ),
    });
    assert.equal(probe.verdict, 'available');
    assert.equal(probe.available, true);
    assert.equal(probe.reason, 'rate-limited-inconclusive');
    assert.match(probe.detail, /secondary rate limit/i);
  });

  it('falls open to available on a primary API rate limit', async () => {
    const probe = await probeGraphqlAvailability({
      ghFacade: facadeThatRejects(
        new GhExecError('gh-exec: gh exited with code 1', {
          args: [],
          stderr: 'gh: API rate limit exceeded for user ID 1 (HTTP 403)',
          code: 1,
        }),
      ),
    });
    assert.equal(probe.verdict, 'available');
    assert.equal(probe.reason, 'rate-limited-inconclusive');
  });

  // Story #5362 AC-2 — the typed error the shared classifier already produces
  // is rate-limit evidence on its own, whatever status text it carries.
  it('falls open to available on the typed rate-limit error, 403 text and all', async () => {
    const probe = await probeGraphqlAvailability({
      ghFacade: facadeThatRejects(
        new GhRateLimitError('gh-exec: gh API rate limit exceeded', {
          args: [],
          stderr: 'gh: HTTP 403 (https://api.github.com/graphql)',
          code: 1,
        }),
      ),
    });
    assert.equal(probe.verdict, 'available');
    assert.equal(probe.available, true);
    assert.equal(probe.reason, 'rate-limited-inconclusive');
  });

  // Story #5362 AC-4 — rate-limit evidence must not swallow an auth fault.
  it('still reports auth-failed when a rate-limited session also has no token', async () => {
    const probe = await probeGraphqlAvailability({
      ghFacade: facadeThatRejects(
        new GhAuthError('gh-exec: gh is not authenticated', {
          args: [],
          stderr:
            'gh: To use GitHub CLI, run: gh auth login (rate limit applies to unauthenticated requests)',
          code: 1,
        }),
      ),
    });
    assert.equal(probe.verdict, 'auth-failed');
    assert.equal(probe.reason, 'auth');
  });

  // AC-3 (second half) — an auth fault is a DIFFERENT verdict, not the same
  // one with a different sentence.
  it('reports auth-failed for a missing or expired token', async () => {
    const probe = await probeGraphqlAvailability({
      ghFacade: facadeThatRejects(
        new GhAuthError('gh-exec: gh is not authenticated', {
          args: [],
          stderr: 'gh: To use GitHub CLI, run: gh auth login',
          code: 1,
        }),
      ),
    });
    assert.equal(probe.verdict, 'auth-failed');
    assert.equal(probe.available, false);
  });

  it('reports auth-failed for HTTP 401 bad credentials', async () => {
    const probe = await probeGraphqlAvailability({
      ghFacade: facadeThatRejects(
        new GhExecError('gh-exec: gh exited with code 1', {
          args: [],
          stderr: 'gh: Bad credentials (HTTP 401)',
          code: 1,
        }),
      ),
    });
    assert.equal(probe.verdict, 'auth-failed');
  });

  it('reports auth-failed for an under-scoped token', async () => {
    const probe = await probeGraphqlAvailability({
      ghFacade: facadeThatRejects(
        new GhScopeError(
          'gh-exec: gh token is missing a required OAuth scope',
          {
            args: [],
            stderr: 'your token has not been granted the required scopes',
            code: 1,
          },
        ),
      ),
    });
    assert.equal(probe.verdict, 'auth-failed');
  });

  // The fail-open edge: an unclassifiable failure is not evidence that this
  // session cannot reach GraphQL, and must not block a healthy close.
  it('falls open to available, marked inconclusive, on an unrelated failure', async () => {
    const probe = await probeGraphqlAvailability({
      ghFacade: facadeThatRejects(
        new GhExecError('gh-exec: gh exited with code 1', {
          args: [],
          stderr: 'gh: connection reset by peer',
          code: 1,
        }),
      ),
    });
    assert.equal(probe.verdict, 'available');
    assert.equal(probe.available, true);
    assert.equal(probe.reason, 'probe-inconclusive');
  });
});

describe('describeGraphqlPreflight', () => {
  // Story #5793 — an unavailable verdict no longer refuses, so only the auth
  // fault carries a remedy; any other verdict is a plain, non-auth line.
  it('describes a non-auth verdict without the re-authenticate remedy', () => {
    const message = describeGraphqlPreflight({
      verdict: 'unavailable',
      detail: 'gh: HTTP 403',
    });
    assert.match(message, /verdict=unavailable/);
    assert.match(message, /HTTP 403/);
    assert.doesNotMatch(message, /gh auth login/);
  });

  // AC-3 — the two faults do not share a sentence, and the auth remedy is
  // explicitly NOT "go somewhere else".
  it('gives the auth fault its own message and its own remedy', () => {
    const auth = describeGraphqlPreflight({
      verdict: 'auth-failed',
      detail: 'gh: run gh auth login',
    });
    const unavailable = describeGraphqlPreflight({
      verdict: 'unavailable',
      detail: 'gh: HTTP 403',
    });
    assert.notEqual(auth, unavailable);
    assert.match(auth, /gh auth login/);
    assert.match(auth, /NOT the GraphQL-unavailable condition/);
    assert.doesNotMatch(
      auth,
      /re-run the close from a local session/i,
      'an auth fault must not inherit the move-sessions remedy',
    );
  });
});

describe('runGraphqlPreflight', () => {
  afterEach(() => setGraphqlAvailability(null));

  function recorder() {
    const lines = [];
    return { lines, progress: (tag, msg) => lines.push(`${tag} ${msg}`) };
  }

  function recordingProvider() {
    const comments = [];
    const labels = [];
    return {
      comments,
      labels,
      getTicket: async () => ({ id: 5355, state: 'open', labels: [] }),
      getTicketComments: async () => [],
      postComment: async (id, payload) => {
        comments.push({ id, ...payload });
        return { id: 1 };
      },
      updateTicket: async (id, patch) => {
        labels.push(...(patch?.labels?.add ?? []));
        return { id };
      },
    };
  }

  it('returns null and mutates nothing when GraphQL is available', async () => {
    const provider = recordingProvider();
    const { lines, progress } = recorder();
    const outcome = await runGraphqlPreflight({
      storyId: 5355,
      provider,
      progress,
      probe: async () => ({
        verdict: 'available',
        available: true,
        reason: 'ok',
      }),
    });
    assert.equal(outcome, null);
    assert.deepEqual(provider.comments, []);
    assert.deepEqual(provider.labels, []);
    assert.ok(lines.some((l) => l.includes('reachable')));
  });

  // Story #5362 AC-5 — a throttled probe is an `available` verdict, so the
  // close proceeds on its own terms: no friction comment, no `agent::blocked`.
  it('mutates nothing when the probe was rate-limited', async () => {
    const provider = recordingProvider();
    const { lines, progress } = recorder();
    const outcome = await runGraphqlPreflight({
      storyId: 5362,
      provider,
      progress,
      probe: async () => ({
        verdict: 'available',
        available: true,
        reason: 'rate-limited-inconclusive',
        detail: 'gh: You have exceeded a secondary rate limit (HTTP 403)',
      }),
    });
    assert.equal(outcome, null, 'a rate limit must not refuse the close');
    assert.deepEqual(provider.comments, [], 'no friction comment is posted');
    assert.deepEqual(provider.labels, [], 'no agent::blocked label is applied');
    assert.ok(lines.some((l) => l.includes('rate-limited-inconclusive')));
  });

  // Story #5793 AC-1 — the proxy 403 selects the REST transport instead of
  // refusing: nothing is posted, nothing is blocked, the latch is seeded.
  it('selects the REST transport on an unavailable verdict, mutating nothing', async () => {
    const provider = recordingProvider();
    const { lines, progress } = recorder();
    const outcome = await runGraphqlPreflight({
      storyId: 5793,
      provider,
      progress,
      probe: async () => ({
        verdict: 'unavailable',
        available: false,
        reason: 'http-403',
        detail: 'gh: HTTP 403',
      }),
    });
    assert.equal(outcome, null, 'the close proceeds');
    assert.deepEqual(provider.comments, []);
    assert.deepEqual(provider.labels, []);
    assert.equal(prSurfaceUsesRest(), true, 'the gh-exec latch is seeded');
    assert.ok(lines.some((l) => /repo-scoped REST/.test(l)));
  });

  it('seeds an available verdict as GraphQL', async () => {
    const { progress } = recorder();
    await runGraphqlPreflight({
      storyId: 5793,
      provider: recordingProvider(),
      progress,
      probe: async () => ({
        verdict: 'available',
        available: true,
        reason: 'ok',
      }),
    });
    assert.equal(prSurfaceUsesRest(), false);
  });

  // Story #5793 AC-5 — REST would fail an auth fault the same way, so it
  // still refuses with today's re-authenticate wording.
  it('refuses, flips agent::blocked and posts friction on an auth-failed verdict', async () => {
    const provider = recordingProvider();
    const { progress } = recorder();
    const outcome = await runGraphqlPreflight({
      storyId: 5355,
      provider,
      progress,
      probe: async () => ({
        verdict: 'auth-failed',
        available: false,
        reason: 'auth',
        detail: 'gh: run gh auth login',
      }),
    });
    assert.equal(outcome.verdict, 'auth-failed');
    assert.match(outcome.reason, /re-authenticate/);
    assert.match(outcome.reason, /gh auth login/);
    assert.equal(prSurfaceUsesRest(), false);
    assert.ok(
      provider.labels.includes('agent::blocked'),
      'the Story the blocked envelope describes must actually carry the label',
    );
    const friction = provider.comments.at(-1);
    assert.ok(friction, 'the operator gets a friction comment');
    assert.match(friction.body, /gh auth login/);
    assert.match(friction.body, /single-story-close\.js --story 5355/);
  });

  it('keeps the refusal when the Story writes fail', async () => {
    const provider = recordingProvider();
    provider.postComment = async () => {
      throw new Error('comment write failed');
    };
    provider.updateTicket = async () => {
      throw new Error('label write failed');
    };
    const { progress } = recorder();
    const outcome = await runGraphqlPreflight({
      storyId: 5355,
      provider,
      progress,
      probe: async () => ({
        verdict: 'auth-failed',
        available: false,
        reason: 'auth',
      }),
    });
    assert.equal(
      outcome.verdict,
      'auth-failed',
      'a notification-side failure must not replace the real blocker',
    );
  });

  // AC-4 — the preflight may never be the reason a healthy close dies.
  it('fails open when the probe itself throws', async () => {
    const { lines, progress } = recorder();
    const outcome = await runGraphqlPreflight({
      storyId: 5355,
      provider: recordingProvider(),
      progress,
      probe: async () => {
        throw new Error('probe exploded');
      },
    });
    assert.equal(outcome, null);
    assert.ok(lines.some((l) => l.includes('could not run')));
  });
});

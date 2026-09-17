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
import { describe, it } from 'node:test';
import {
  describeGraphqlPreflight,
  GhAuthError,
  GhExecError,
  GhScopeError,
  probeGraphqlAvailability,
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

  // AC-3 (first half) — the 403 shape is its own verdict.
  it('reports unavailable on an HTTP 403 from the GraphQL endpoint', async () => {
    const probe = await probeGraphqlAvailability({
      ghFacade: facadeThatRejects(graphql403()),
    });
    assert.equal(probe.verdict, 'unavailable');
    assert.equal(probe.available, false);
    assert.equal(probe.reason, 'http-403');
    assert.match(probe.detail, /403/);
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
  // AC-2 — all three things the operator needs, in one message.
  it('names the condition, the whole gh pr surface, and the local-session remedy', () => {
    const message = describeGraphqlPreflight({
      verdict: 'unavailable',
      detail: 'gh: HTTP 403',
    });
    assert.match(message, /GraphQL is unavailable in this session/i);
    assert.match(message, /403/);
    for (const sub of [
      'view',
      'create',
      'edit',
      'merge',
      'update-branch',
      'list',
    ]) {
      assert.ok(
        message.includes(`gh pr ${sub}`),
        `the refusal must name \`gh pr ${sub}\` — the surface it gates`,
      );
    }
    assert.match(message, /local session/i);
    assert.match(message, /Retrying here will not help/i);
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

  it('refuses, flips agent::blocked and posts friction on an unavailable verdict', async () => {
    const provider = recordingProvider();
    const { progress } = recorder();
    const outcome = await runGraphqlPreflight({
      storyId: 5355,
      provider,
      progress,
      probe: async () => ({
        verdict: 'unavailable',
        available: false,
        reason: 'http-403',
        detail: 'gh: HTTP 403',
      }),
    });
    assert.equal(outcome.verdict, 'unavailable');
    assert.match(outcome.reason, /local session/i);
    assert.ok(
      provider.labels.includes('agent::blocked'),
      'the Story the blocked envelope describes must actually carry the label',
    );
    const friction = provider.comments.at(-1);
    assert.ok(friction, 'the operator gets a friction comment');
    assert.match(friction.body, /gh pr create/);
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
        verdict: 'unavailable',
        available: false,
        reason: 'http-403',
      }),
    });
    assert.equal(
      outcome.verdict,
      'unavailable',
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

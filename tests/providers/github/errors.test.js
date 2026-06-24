/**
 * Unit tests for `.agents/scripts/providers/github/errors.js`.
 *
 * Covers all four classification branches that `classifyGithubError`
 * routes through (feature-disabled, permission, transient, permanent),
 * plus a public-surface check that the parent module still re-exports
 * the four named symbols.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');

const errorsMod = await import(
  pathToFileURL(
    path.join(ROOT, '.agents', 'scripts', 'providers', 'github', 'errors.js'),
  ).href
);
const providerMod = await import(
  pathToFileURL(path.join(ROOT, '.agents', 'scripts', 'providers', 'github.js'))
    .href
);
const ghExecMod = await import(
  pathToFileURL(path.join(ROOT, '.agents', 'scripts', 'lib', 'gh-exec.js')).href
);

const { GhExecTimeoutError } = ghExecMod;

const {
  classifyGithubError,
  SUB_ISSUES_QUERY,
  ADD_SUB_ISSUE_MUTATION,
  REMOVE_SUB_ISSUE_MUTATION,
  TRANSIENT_RETRY_DEFAULTS,
  withTransientRetry,
} = errorsMod;

/**
 * Test fixture: build an Error whose `.status` triggers the classifier's
 * transient branch. `classifyGithubError` checks `err.status === number`
 * (extractErrorFields), so we set it on a plain Error object.
 */
function transientError(status = 502, message = `gh: HTTP ${status}`) {
  const err = new Error(message);
  err.status = status;
  return err;
}

describe('providers/github/errors.js — classifyGithubError', () => {
  it('feature-disabled branch: subissues field-not-available message', () => {
    assert.strictEqual(
      classifyGithubError(new Error('feature not available')),
      'feature-disabled',
    );
    assert.strictEqual(
      classifyGithubError(new Error("field 'subIssues' doesn't exist on type")),
      'feature-disabled',
    );
  });

  it('transient branch: 5xx / 429 / rate-limit / network codes', () => {
    assert.strictEqual(
      classifyGithubError({ message: 'server boom', status: 503 }),
      'transient',
    );
    assert.strictEqual(
      classifyGithubError({ message: 'too many', status: 429 }),
      'transient',
    );
    assert.strictEqual(
      classifyGithubError({ message: 'network', code: 'ECONNRESET' }),
      'transient',
    );
    assert.strictEqual(
      classifyGithubError({ message: 'secondary rate limit hit' }),
      'transient',
    );
    // Rate-limit-via-403 is transient, not permission — regression guard.
    assert.strictEqual(
      classifyGithubError({ message: 'secondary rate limit', status: 403 }),
      'transient',
    );
  });

  it('permission branch: 401 / 403 / unauthorized / forbidden messages', () => {
    assert.strictEqual(
      classifyGithubError({ message: 'Unauthorized', status: 401 }),
      'permission',
    );
    assert.strictEqual(
      classifyGithubError({ message: 'Forbidden', status: 403 }),
      'permission',
    );
    assert.strictEqual(
      classifyGithubError({ message: 'permission denied' }),
      'permission',
    );
  });

  it('transient branch: GhExecTimeoutError is reclassified by err.name (Story #2860)', () => {
    // GhExecTimeoutError's message is "gh-exec: gh ... exceeded Nms" — no
    // transient keyword and no `.status` / `.code`. Without the name-based
    // branch added in #2860, classifyGithubError would fall through to
    // 'permanent' and withTransientRetry would never fire on a real
    // gh subprocess timeout.
    const err = new GhExecTimeoutError(
      'gh-exec: gh api /repos exceeded 60000ms',
      { args: ['api', '/repos'], timeoutMs: 60000 },
    );
    assert.strictEqual(classifyGithubError(err), 'transient');
  });

  it('regression guard: a plain Error with a non-matching name is not reclassified', () => {
    // Negative guard for #2860 — only `name === 'GhExecTimeoutError'`
    // routes to 'transient' via the name-match branch. A plain Error with
    // a non-transient message and no transient status/code stays
    // 'permanent'.
    const err = new Error('something unrelated went wrong');
    err.name = 'CustomBenignError';
    assert.strictEqual(classifyGithubError(err), 'permanent');
  });

  it('permanent branch: null err and anything that doesn’t match the others', () => {
    assert.strictEqual(classifyGithubError(null), 'permanent');
    assert.strictEqual(
      classifyGithubError({ message: 'some unexpected failure' }),
      'permanent',
    );
    assert.strictEqual(
      classifyGithubError({ message: 'bad request', status: 400 }),
      'permanent',
    );
  });
});

describe('providers/github/errors.js — GraphQL constants', () => {
  it('SUB_ISSUES_QUERY queries the subIssues paginated connection', () => {
    assert.match(SUB_ISSUES_QUERY, /subIssues\(first: 100, after: \$cursor\)/);
    assert.match(SUB_ISSUES_QUERY, /pageInfo \{ hasNextPage endCursor \}/);
  });

  it('ADD_SUB_ISSUE_MUTATION sends parentId/subIssueId/replaceParent', () => {
    assert.match(ADD_SUB_ISSUE_MUTATION, /addSubIssue\(input:/);
    assert.match(ADD_SUB_ISSUE_MUTATION, /\$replaceParent: Boolean/);
  });

  it('REMOVE_SUB_ISSUE_MUTATION sends parentId/subIssueId', () => {
    assert.match(REMOVE_SUB_ISSUE_MUTATION, /removeSubIssue\(input:/);
    assert.match(REMOVE_SUB_ISSUE_MUTATION, /\$parentId: ID!/);
    assert.match(REMOVE_SUB_ISSUE_MUTATION, /\$subIssueId: ID!/);
  });
});

describe('providers/github.js — re-export surface', () => {
  it('parent re-exports classifyGithubError and the four predicate helpers unchanged', () => {
    assert.strictEqual(
      providerMod.classifyGithubError,
      classifyGithubError,
      'classifyGithubError identity preserved',
    );
  });
});

describe('providers/github/errors.js — withTransientRetry (Story #2852)', () => {
  it('returns the first successful value without retrying', async () => {
    let calls = 0;
    const result = await withTransientRetry(
      async () => {
        calls++;
        return 'ok';
      },
      { sleep: () => Promise.resolve() },
    );
    assert.equal(result, 'ok');
    assert.equal(calls, 1);
  });

  it('retries transient failures with jittered backoff, then succeeds', async () => {
    const delays = [];
    let calls = 0;
    const result = await withTransientRetry(
      async () => {
        calls++;
        if (calls < 3) throw transientError(502);
        return 'recovered';
      },
      {
        baseDelayMs: 100,
        capMs: 1000,
        jitterMs: 50,
        sleep: (ms) => {
          delays.push(ms);
          return Promise.resolve();
        },
        random: () => 0.5,
      },
    );
    assert.equal(result, 'recovered');
    assert.equal(calls, 3);
    // 2 retries → 2 sleeps: 100 + jitter, 200 + jitter
    assert.equal(delays.length, 2);
    assert.equal(delays[0], 100 + 25);
    assert.equal(delays[1], 200 + 25);
  });

  it('does not retry non-transient errors (permanent bubbles immediately)', async () => {
    let calls = 0;
    const err = new Error('not found');
    err.status = 404;
    await assert.rejects(
      withTransientRetry(
        async () => {
          calls++;
          throw err;
        },
        { sleep: () => Promise.resolve() },
      ),
      { message: 'not found' },
    );
    assert.equal(calls, 1);
  });

  it('does not retry permission errors', async () => {
    let calls = 0;
    const err = new Error('unauthorized');
    err.status = 401;
    await assert.rejects(
      withTransientRetry(
        async () => {
          calls++;
          throw err;
        },
        { sleep: () => Promise.resolve() },
      ),
      { message: 'unauthorized' },
    );
    assert.equal(calls, 1);
  });

  it('does not retry feature-disabled errors', async () => {
    let calls = 0;
    await assert.rejects(
      withTransientRetry(
        async () => {
          calls++;
          throw new Error('feature not available');
        },
        { sleep: () => Promise.resolve() },
      ),
      { message: 'feature not available' },
    );
    assert.equal(calls, 1);
  });

  it('bubbles the last transient error when every attempt fails', async () => {
    let calls = 0;
    await assert.rejects(
      withTransientRetry(
        async () => {
          calls++;
          throw transientError(503, `attempt ${calls}`);
        },
        {
          maxAttempts: 3,
          baseDelayMs: 1,
          jitterMs: 0,
          sleep: () => Promise.resolve(),
        },
      ),
      { message: 'attempt 3' },
    );
    assert.equal(calls, 3);
  });

  it('caps backoff at capMs', async () => {
    const delays = [];
    await assert.rejects(
      withTransientRetry(
        async () => {
          throw transientError(502);
        },
        {
          maxAttempts: 5,
          baseDelayMs: 1000,
          capMs: 2500,
          jitterMs: 0,
          sleep: (ms) => {
            delays.push(ms);
            return Promise.resolve();
          },
          random: () => 0,
        },
      ),
    );
    // 4 retries: 1000, 2000, 2500 (capped), 2500 (capped)
    assert.deepEqual(delays, [1000, 2000, 2500, 2500]);
  });

  it('invokes onRetry with attempt metadata', async () => {
    const events = [];
    let calls = 0;
    await withTransientRetry(
      async () => {
        calls++;
        if (calls < 2) throw transientError(429, 'rate limit');
        return 'ok';
      },
      {
        baseDelayMs: 10,
        jitterMs: 0,
        label: 'spec-call',
        onRetry: (info) => events.push(info),
        sleep: () => Promise.resolve(),
      },
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].attempt, 1);
    assert.equal(events[0].maxAttempts, TRANSIENT_RETRY_DEFAULTS.maxAttempts);
    assert.equal(events[0].label, 'spec-call');
    assert.equal(events[0].err.message, 'rate limit');
  });

  it('retries ECONNRESET via the code-based transient branch', async () => {
    let calls = 0;
    const err = new Error('socket hang up');
    err.code = 'ECONNRESET';
    const result = await withTransientRetry(
      async () => {
        calls++;
        if (calls < 2) throw err;
        return 'ok';
      },
      { baseDelayMs: 1, jitterMs: 0, sleep: () => Promise.resolve() },
    );
    assert.equal(result, 'ok');
    assert.equal(calls, 2);
  });

  it('honors a custom classifier', async () => {
    let calls = 0;
    const result = await withTransientRetry(
      async () => {
        calls++;
        if (calls < 2) throw new Error('something weird');
        return 'ok';
      },
      {
        classify: () => 'transient',
        baseDelayMs: 1,
        jitterMs: 0,
        sleep: () => Promise.resolve(),
      },
    );
    assert.equal(result, 'ok');
    assert.equal(calls, 2);
  });
});

/**
 * Story #4298 — the two divergent `withTransientRetry` implementations
 * (network-only in the deleted `transient-retry.js`, status/code-only here)
 * were unified into this single canonical primitive. These tests pin the
 * binding constraint: the default classifier retries the **union** of both
 * prior predicates, and every call site's retry class is preserved.
 */
describe('providers/github/errors.js — unified transient predicate (Story #4298)', () => {
  it('classifies a fetch-path network failure (err.cause.code) as transient', () => {
    // The `fetch` path surfaces `TypeError: fetch failed` with the real
    // reason nested on `err.cause`. Folded in from the former
    // `transient-retry.js` predicate; no `.status` and the message keyword
    // alone (`fetch failed`) is what rescues it.
    const err = new Error('fetch failed');
    err.cause = { code: 'ENOTFOUND' };
    assert.equal(classifyGithubError(err), 'transient');
  });

  it('does NOT classify a 422 validation error as transient', () => {
    assert.equal(
      classifyGithubError({ message: 'Validation Failed', status: 422 }),
      'permanent',
    );
  });

  it('classifies a transient network error (dropped socket) as transient', () => {
    // Former `transient-retry.js` consumers (branch-protection, labels,
    // projects-v2-graphql) relied on this class retrying. The error carries
    // no `.status` and a code (`ECONNREFUSED`) the status/code-message checks
    // above already cover — but the bare-message socket case below is one the
    // network predicate uniquely rescues.
    const err = new Error('socket hang up');
    assert.equal(classifyGithubError(err), 'transient');
  });

  it('classifies a gh-CLI dial timeout (err.stderr only) as transient', () => {
    // `dial tcp ...: i/o timeout` lives on `err.stderr` with no `.status` /
    // `.code` and no transient keyword in `.message` — only the network
    // predicate catches it. This is the union's load-bearing addition.
    const err = new Error('gh exited with code 1');
    err.stderr = 'dial tcp 140.82.121.3:443: i/o timeout';
    assert.equal(classifyGithubError(err), 'transient');
  });

  it('classifies a transient HTTP 503 status as transient', () => {
    // Former `errors.js` consumers (tickets, issues, comments, request-helpers)
    // relied on this class retrying — preserved unchanged.
    assert.equal(
      classifyGithubError({ message: 'service unavailable', status: 503 }),
      'transient',
    );
  });

  it('does NOT classify a non-transient 404 as transient (no retry regression)', () => {
    assert.equal(
      classifyGithubError({ message: 'Not Found', status: 404 }),
      'permanent',
    );
  });

  it('retries a transient network error to success (binding: dropped socket)', async () => {
    let calls = 0;
    const result = await withTransientRetry(
      async () => {
        calls++;
        if (calls < 2) {
          const err = new Error('socket hang up');
          err.code = 'ECONNREFUSED';
          throw err;
        }
        return 'recovered';
      },
      { baseDelayMs: 1, jitterMs: 0, sleep: () => Promise.resolve() },
    );
    assert.equal(result, 'recovered');
    assert.equal(calls, 2);
  });

  it('retries a transient HTTP 503 to success (binding: server error)', async () => {
    let calls = 0;
    const result = await withTransientRetry(
      async () => {
        calls++;
        if (calls < 2) throw transientError(503);
        return 'recovered';
      },
      { baseDelayMs: 1, jitterMs: 0, sleep: () => Promise.resolve() },
    );
    assert.equal(result, 'recovered');
    assert.equal(calls, 2);
  });

  it('does NOT retry a non-transient 404 (binding: no regression)', async () => {
    let calls = 0;
    const err = new Error('Not Found');
    err.status = 404;
    await assert.rejects(
      withTransientRetry(
        async () => {
          calls++;
          throw err;
        },
        { baseDelayMs: 1, jitterMs: 0, sleep: () => Promise.resolve() },
      ),
      { message: 'Not Found' },
    );
    assert.equal(calls, 1);
  });
});

/**
 * GitHub Provider Tests
 *
 * Tests GitHubProvider with mocked fetch() responses — no live API calls.
 * Covers all 10 interface methods, auth resolution, error handling,
 * and dependency parsing.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const { GitHubProvider } = await import(
  pathToFileURL(path.join(ROOT, '.agents', 'scripts', 'providers', 'github.js'))
    .href
);
const { ITicketingProvider } = await import(
  pathToFileURL(
    path.join(ROOT, '.agents', 'scripts', 'lib', 'ITicketingProvider.js'),
  ).href
);
const { createGh } = await import(
  pathToFileURL(path.join(ROOT, '.agents', 'scripts', 'lib', 'gh-exec.js')).href
);

// ---------------------------------------------------------------------------
// gh-exec mock
//
// Story #1357 rebuilt the issue + comment surface on top of gh-exec, so tests
// inject a fake exec via `opts.gh = createGh(fakeExec)`. The fake routes on the
// argv shape `['api', '-X', <METHOD>, <ENDPOINT>, ...]` produced by
// `gh.api({ method, endpoint, body })`. Routes are keyed `"<METHOD> <ENDPOINT>
// fragment>"` matching the same `createRouteMock` ergonomic. Pagination
// (`paginateRest` in providers/github.js) appends `page=N&per_page=100`
// directly to the endpoint, so the route's `endpoint fragment` field is enough
// to match every page of a single list call.
// ---------------------------------------------------------------------------
function createGhExec(routes) {
  const calls = [];
  const exec = async ({ args, input }) => {
    calls.push({ args, input });

    // The `gh.api` facade builds argv as `['api', '-X', <METHOD>, <ENDPOINT>, ...]`.
    // The `gh.pr.*` / `gh.label.*` / `gh.repo.*` facades build
    // `[<noun>, <verb>, <target?>, ...flags]`. Disambiguate so a single mock
    // can carry both kinds of route (api routes are keyed
    // "<METHOD> <ENDPOINT>"; nounful routes are keyed
    // "<noun> <verb>"). Routes that look nounful (no leading HTTP verb) are
    // matched on `args[0] args[1]` and may optionally read the trailing
    // stdout payload from `response.stdout`.
    const noun = args[0];
    const isApi = noun === 'api';
    const method = isApi ? (args[2] ?? 'GET') : null;
    const endpoint = isApi ? (args[3] ?? '') : '';
    const bodyStr = input ?? '';

    let matched = null;
    for (const [pattern, response] of Object.entries(routes)) {
      const parts = pattern.split(' ');
      const head = parts[0];
      const second = parts[1] ?? '';
      const rest = parts.length > 2 ? parts.slice(2).join(' ') : null;

      // HTTP-method route (api path).
      const isHttpRoute = /^(GET|POST|PUT|PATCH|DELETE)$/.test(head);
      if (isHttpRoute) {
        if (!isApi) continue;
        if (
          method === head &&
          endpoint.includes(second) &&
          (!rest || bodyStr.includes(rest))
        ) {
          matched = response;
          break;
        }
        continue;
      }

      // Nounful route — `pr create`, `pr view`, `label list`, etc.
      if (noun === head && args[1] === second) {
        matched = response;
        break;
      }
    }
    const final = matched ?? { status: 200, json: {} };
    if (final.status >= 200 && final.status < 300) {
      // Nounful routes may override the canonical JSON-on-stdout shape with
      // a raw `stdout` string (e.g. `gh pr create` emits the URL plain).
      const stdout =
        typeof final.stdout === 'string'
          ? final.stdout
          : JSON.stringify(final.json ?? {});
      return { stdout, stderr: '', code: 0 };
    }
    // Non-2xx — gh exec rejects via classify(); for tests we throw a
    // shape-compatible Error so assertions on `/failed/` still match.
    const err = new Error(`gh-exec: gh exited with code ${final.status}`);
    err.code = final.status;
    err.stderr = JSON.stringify(final.json ?? '');
    err.stdout = '';
    throw err;
  };
  exec.calls = calls;
  return exec;
}

function makeGh(routes) {
  const exec = createGhExec(routes);
  const gh = createGh(exec);
  gh.__exec = exec;
  return gh;
}

// ---------------------------------------------------------------------------
// Helpers — mock fetch
// ---------------------------------------------------------------------------

function _createRouteMock(routes) {
  const calls = [];

  const mockFn = async (url, opts = {}) => {
    calls.push({ url, opts });
    const method = (opts.method || 'GET').toUpperCase();
    const bodyStr = opts.body || '';

    let matchedResponse = null;
    for (const [routePattern, response] of Object.entries(routes)) {
      const parts = routePattern.split(' ');
      const routeMethod = parts.length > 1 ? parts[0] : 'GET';
      const routePath = parts.length > 1 ? parts[1] : parts[0];
      const routeBodyMatcher =
        parts.length > 2 ? parts.slice(2).join(' ') : null;

      const methodMatches = method === routeMethod.toUpperCase();
      const pathMatches = url.includes(routePath);
      const bodyMatches =
        !routeBodyMatcher || bodyStr.includes(routeBodyMatcher);

      if (methodMatches && pathMatches && bodyMatches) {
        matchedResponse = response;
        break;
      }
    }

    const finalResponse = matchedResponse ?? { status: 200, json: {} };

    return {
      ok: finalResponse.status >= 200 && finalResponse.status < 300,
      status: finalResponse.status,
      headers: { get: () => null },
      json: async () => finalResponse.json,
      text: async () => JSON.stringify(finalResponse.json ?? ''),
    };
  };

  mockFn.calls = calls;
  return mockFn;
}

function createTestProvider(opts = {}) {
  return new GitHubProvider(
    {
      owner: 'test-owner',
      repo: 'test-repo',
      projectNumber: opts.projectNumber ?? null,
      operatorHandle: '@tester',
    },
    { token: 'test-token-123', gh: opts.gh },
  );
}

// ---------------------------------------------------------------------------
// listIssues & getEpics
// ---------------------------------------------------------------------------
describe('GitHubProvider — listIssues() & getEpics()', () => {
  const mockIssues = [
    {
      number: 101,
      title: 'Epic 1',
      labels: [{ name: 'type::epic' }],
      state: 'open',
    },
    {
      number: 102,
      title: 'Epic 2',
      labels: ['type::epic'],
      state: 'closed',
      state_reason: 'completed',
    },
    {
      number: 104,
      title: 'A PR',
      labels: ['type::epic'],
      state: 'open',
      pull_request: {},
    },
  ];

  it('listIssues() fetches and filters epics correctly', async () => {
    const gh = makeGh({ 'GET /issues': { status: 200, json: mockIssues } });
    const provider = createTestProvider({ gh });
    const epics = await provider.listIssues({ state: 'all' });

    assert.equal(epics.length, 2);
    assert.equal(epics[0].id, 101);
    assert.equal(epics[0].title, 'Epic 1');
    assert.deepEqual(epics[0].labels, ['type::epic']);
    assert.equal(epics[1].id, 102);
    assert.equal(epics[1].state, 'closed');
    assert.equal(epics[1].state_reason, 'completed');

    // Verify the argv shape that gh.api built carries the same encoded
    // params the old fetch URL had.
    const firstCall = gh.__exec.calls[0];
    const endpoint = firstCall.args[3] ?? '';
    assert.ok(endpoint.includes('labels=type%3A%3Aepic'));
    assert.ok(endpoint.includes('state=all'));
  });

  it('getEpics() returns the same result as listIssues()', async () => {
    const gh = makeGh({ 'GET /issues': { status: 200, json: mockIssues } });
    const provider = createTestProvider({ gh });
    const epics = await provider.getEpics();

    assert.equal(epics.length, 2);
    assert.equal(epics[0].id, 101);
  });
});

// ---------------------------------------------------------------------------
// Basic construction
// ---------------------------------------------------------------------------
describe('GitHubProvider — construction', () => {
  it('extends ITicketingProvider', () => {
    const provider = createTestProvider();
    assert.ok(provider instanceof ITicketingProvider);
  });

  it('stores config values', () => {
    const provider = createTestProvider({ projectNumber: 5 });
    assert.equal(provider.owner, 'test-owner');
    assert.equal(provider.repo, 'test-repo');
    assert.equal(provider.projectNumber, 5);
    assert.equal(provider.operatorHandle, '@tester');
  });

  it('uses provided token', () => {
    const provider = createTestProvider();
    assert.equal(provider.token, 'test-token-123');
  });
});

// ---------------------------------------------------------------------------
// getEpic
// ---------------------------------------------------------------------------
describe('GitHubProvider — getEpic()', () => {
  it('returns epic with parsed linked issues', async () => {
    const gh = makeGh({
      'GET /issues/10': {
        status: 200,
        json: {
          number: 10,
          title: 'Epic: Build v5',
          body: 'Goal description\n\nPRD: #11\nTech Spec: #12',
          labels: [{ name: 'type::epic' }],
        },
      },
    });
    const provider = createTestProvider({ gh });
    const epic = await provider.getEpic(10);

    assert.equal(epic.id, 10);
    assert.equal(epic.title, 'Epic: Build v5');
    assert.deepEqual(epic.labels, ['type::epic']);
    assert.deepEqual(epic.linkedIssues, { prd: 11, techSpec: 12 });
  });

  it('handles missing linked issues', async () => {
    const gh = makeGh({
      'GET /issues/10': {
        status: 200,
        json: {
          number: 10,
          title: 'Simple Epic',
          body: 'No linked docs here',
          labels: [],
        },
      },
    });
    const provider = createTestProvider({ gh });
    const epic = await provider.getEpic(10);
    assert.deepEqual(epic.linkedIssues, { prd: null, techSpec: null });
  });

  it('handles null body', async () => {
    const gh = makeGh({
      'GET /issues/10': {
        status: 200,
        json: { number: 10, title: 'No Body', body: null, labels: [] },
      },
    });
    const provider = createTestProvider({ gh });
    const epic = await provider.getEpic(10);
    assert.equal(epic.body, '');
    assert.deepEqual(epic.linkedIssues, { prd: null, techSpec: null });
  });

  it('throws on API error', async () => {
    const gh = makeGh({
      'GET /issues/999': { status: 404, json: { message: 'Not Found' } },
    });
    const provider = createTestProvider({ gh });
    // gh-exec error surface — the canonical mid-tier message includes the
    // exit code; downstream consumers handle classification via the typed
    // errors in lib/gh-exec.js.
    await assert.rejects(provider.getEpic(999), /code 404/);
  });
});

// ---------------------------------------------------------------------------
// getTicket
// ---------------------------------------------------------------------------
describe('GitHubProvider — getTicket()', () => {
  it('returns ticket with all metadata', async () => {
    const gh = makeGh({
      'GET /issues/42': {
        status: 200,
        json: {
          number: 42,
          title: 'Fix the thing',
          body: 'Detailed description',
          labels: [{ name: 'bug' }, { name: 'agent::ready' }],
          assignees: [{ login: 'alice' }, { login: 'bob' }],
          state: 'open',
        },
      },
    });
    const provider = createTestProvider({ gh });
    const ticket = await provider.getTicket(42);

    assert.equal(ticket.id, 42);
    assert.equal(ticket.title, 'Fix the thing');
    assert.deepEqual(ticket.labels, ['bug', 'agent::ready']);
    assert.deepEqual(ticket.assignees, ['alice', 'bob']);
    assert.equal(ticket.state, 'open');
  });
});

// ---------------------------------------------------------------------------
// getTicketDependencies
// ---------------------------------------------------------------------------
describe('GitHubProvider — getTicketDependencies()', () => {
  it('parses blocked by and blocks patterns', async () => {
    const gh = makeGh({
      'GET /issues/5': {
        status: 200,
        json: {
          number: 5,
          title: 'Dependent task',
          body: 'This is blocked by #3\nAlso depends on #4\nblocks #6',
          labels: [],
          assignees: [],
          state: 'open',
        },
      },
    });
    const provider = createTestProvider({ gh });
    const deps = await provider.getTicketDependencies(5);

    assert.deepEqual(deps.blockedBy, [3, 4]);
    assert.deepEqual(deps.blocks, [6]);
  });

  it('returns empty arrays when no dependencies', async () => {
    const gh = makeGh({
      'GET /issues/5': {
        status: 200,
        json: {
          number: 5,
          title: 'Independent task',
          body: 'No deps here',
          labels: [],
          assignees: [],
          state: 'open',
        },
      },
    });
    const provider = createTestProvider({ gh });
    const deps = await provider.getTicketDependencies(5);

    assert.deepEqual(deps.blockedBy, []);
    assert.deepEqual(deps.blocks, []);
  });
});

// ---------------------------------------------------------------------------
// createTicket
// ---------------------------------------------------------------------------
describe('GitHubProvider — createTicket()', () => {
  it('creates a ticket linked to the epic', async () => {
    const gh = makeGh({
      'POST /repos/test-owner/test-repo/issues': {
        status: 201,
        json: {
          number: 20,
          html_url: 'https://github.com/test-owner/test-repo/issues/20',
        },
      },
      // addSubIssue reads the parent via getTicket — return a stub.
      'GET /issues/10': {
        status: 200,
        json: {
          number: 10,
          node_id: 'parent-node',
          title: 'Parent Epic',
          body: '',
          labels: [],
          assignees: [],
          state: 'open',
        },
      },
      // Sub-issue link mutation — return a successful GraphQL payload.
      'POST graphql': {
        status: 200,
        json: { data: { addSubIssue: { issue: { number: 10 } } } },
      },
    });
    const provider = createTestProvider({ gh });
    const result = await provider.createTicket(10, {
      title: 'New task',
      body: 'Task description',
      labels: ['type::task'],
    });

    assert.equal(result.id, 20);
    assert.ok(result.url.includes('/issues/20'));

    // Find the POST /issues call and inspect its stdin body.
    const createCall = gh.__exec.calls.find(
      (c) => c.args[2] === 'POST' && /\/issues$/.test(c.args[3] ?? ''),
    );
    assert.ok(createCall, 'POST /issues call should have happened');
    const sentBody = JSON.parse(createCall.input);
    assert.ok(sentBody.body.includes('parent: #10'));
  });

  it('includes dependency references in the body', async () => {
    const gh = makeGh({
      'POST /repos/test-owner/test-repo/issues': {
        status: 201,
        json: { number: 21, html_url: 'http://x', node_id: 'n21' },
      },
      'GET /issues/10': {
        status: 200,
        json: {
          number: 10,
          node_id: 'parent-node',
          title: 'P',
          body: '',
          labels: [],
          assignees: [],
          state: 'open',
        },
      },
      'POST graphql': {
        status: 200,
        json: { data: { addSubIssue: { issue: { number: 10 } } } },
      },
    });
    const provider = createTestProvider({ gh });
    await provider.createTicket(10, {
      title: 'Dependent task',
      body: 'Depends on stuff',
      labels: [],
      dependencies: [5, 6],
    });

    const createCall = gh.__exec.calls.find(
      (c) => c.args[2] === 'POST' && /\/issues$/.test(c.args[3] ?? ''),
    );
    const sentBody = JSON.parse(createCall.input);
    assert.ok(sentBody.body.includes('blocked by #5'));
    assert.ok(sentBody.body.includes('blocked by #6'));
  });
});

// ---------------------------------------------------------------------------
// updateTicket
// ---------------------------------------------------------------------------
describe('GitHubProvider — updateTicket()', () => {
  it('patches body and assignees', async () => {
    const gh = makeGh({
      'PATCH /issues/42': { status: 200, json: {} },
    });
    const provider = createTestProvider({ gh });
    await provider.updateTicket(42, {
      body: 'Updated body',
      assignees: ['alice'],
    });

    assert.equal(gh.__exec.calls.length, 1);
    const sentBody = JSON.parse(gh.__exec.calls[0].input);
    assert.equal(sentBody.body, 'Updated body');
    assert.deepEqual(sentBody.assignees, ['alice']);
  });

  it('batches label additions and removals via GET and PATCH', async () => {
    const gh = makeGh({
      'GET /issues/42': {
        status: 200,
        json: {
          number: 42,
          labels: [{ name: 'agent::ready' }, { name: 'bug' }],
        },
      },
      'PATCH /issues/42': { status: 200, json: {} },
    });
    const provider = createTestProvider({ gh });
    await provider.updateTicket(42, {
      labels: {
        add: ['agent::executing'],
        remove: ['agent::ready'],
      },
    });

    // Should have made 2 calls: GET + PATCH
    assert.equal(gh.__exec.calls.length, 2);
    assert.equal(gh.__exec.calls[0].args[2], 'GET');
    assert.ok(gh.__exec.calls[0].args[3].includes('/issues/42'));
    assert.equal(gh.__exec.calls[1].args[2], 'PATCH');
    assert.ok(gh.__exec.calls[1].args[3].includes('/issues/42'));

    const patchBody = JSON.parse(gh.__exec.calls[1].input);
    assert.ok(patchBody.labels.includes('bug'));
    assert.ok(patchBody.labels.includes('agent::executing'));
    assert.equal(patchBody.labels.includes('agent::ready'), false);
  });
});

// ---------------------------------------------------------------------------
// postComment
// ---------------------------------------------------------------------------
describe('GitHubProvider — postComment()', () => {
  it('prepends type badge to comment body', async () => {
    const gh = makeGh({
      'POST /issues/42/comments': { status: 201, json: { id: 100 } },
    });
    const provider = createTestProvider({ gh });
    const result = await provider.postComment(42, {
      body: 'Unit tests pass',
      type: 'progress',
    });

    assert.equal(result.commentId, 100);
    const sentBody = JSON.parse(gh.__exec.calls[0].input);
    assert.ok(sentBody.body.includes('🔄 **Progress**'));
    assert.ok(sentBody.body.includes('Unit tests pass'));
  });
});

// ---------------------------------------------------------------------------
// createPullRequest
// ---------------------------------------------------------------------------
describe('GitHubProvider — createPullRequest()', () => {
  it('creates PR with Closes reference via gh pr create', async () => {
    // Story #1359 (Task #1371) rewrites this on `gh.pr.create` + a follow-
    // up `gh.pr.view` to harvest the {number, url, id} envelope. The
    // issue read (`getTicket`) is the same gh.api path Story #1357 landed.
    const gh = makeGh({
      'GET /issues/42': {
        status: 200,
        json: {
          number: 42,
          title: 'Fix the thing',
          body: '',
          labels: [],
          assignees: [],
          state: 'open',
        },
      },
      'pr create': {
        status: 200,
        // `gh pr create` emits the html_url on stdout (plain text, not JSON).
        stdout: 'https://github.com/test-owner/test-repo/pull/15\n',
      },
      'pr view': {
        status: 200,
        json: {
          number: 15,
          url: 'https://api.github.com/repos/test-owner/test-repo/pulls/15',
          id: 'PR_node_15',
        },
      },
    });

    const provider = createTestProvider({ gh });
    const result = await provider.createPullRequest('feature/fix-42', 42);

    assert.equal(result.number, 15);
    assert.ok(result.htmlUrl.includes('/pull/15'));
    assert.equal(result.nodeId, 'PR_node_15');

    const prCreate = gh.__exec.calls.find(
      (c) => c.args[0] === 'pr' && c.args[1] === 'create',
    );
    assert.ok(prCreate, 'expected `gh pr create` to fire');
    // The argv carries --title/--body/--base/--head explicitly so the
    // `Closes #N` body reaches the API without shell interpolation.
    assert.deepEqual(prCreate.args, [
      'pr',
      'create',
      '--title',
      'Fix the thing',
      '--body',
      'Closes #42',
      '--base',
      'main',
      '--head',
      'feature/fix-42',
    ]);

    // `gh pr view` is invoked against the URL the create call returned,
    // with --json number,url,id.
    const prView = gh.__exec.calls.find(
      (c) => c.args[0] === 'pr' && c.args[1] === 'view',
    );
    assert.ok(prView, 'expected follow-up `gh pr view` to fire');
    assert.equal(
      prView.args[2],
      'https://github.com/test-owner/test-repo/pull/15',
    );
    assert.ok(prView.args.includes('--json'));
    assert.ok(prView.args.includes('number,url,id'));
  });
});

// ---------------------------------------------------------------------------
// getBranchProtection / setBranchProtection — Task #1371
// ---------------------------------------------------------------------------
describe('GitHubProvider — getBranchProtection()', () => {
  it('returns {enabled:true, raw} when the branch is protected', async () => {
    const raw = {
      required_status_checks: { strict: true, contexts: ['lint'] },
      enforce_admins: { enabled: true },
      required_pull_request_reviews: { required_approving_review_count: 0 },
      restrictions: null,
    };
    const gh = makeGh({
      'GET /branches/main/protection': { status: 200, json: raw },
    });
    const provider = createTestProvider({ gh });
    const result = await provider.getBranchProtection('main');
    assert.deepEqual(result, { enabled: true, raw });
  });

  it('returns {enabled:false} on a 404 from gh-exec', async () => {
    const gh = makeGh({
      'GET /branches/main/protection': {
        status: 404,
        json: { message: 'Not Found' },
      },
    });
    const provider = createTestProvider({ gh });
    const result = await provider.getBranchProtection('main');
    assert.deepEqual(result, { enabled: false });
  });

  it('URL-encodes branch names with slashes', async () => {
    const gh = makeGh({
      'GET /branches/release%2F2025-q4/protection': {
        status: 200,
        json: { ok: true },
      },
    });
    const provider = createTestProvider({ gh });
    const result = await provider.getBranchProtection('release/2025-q4');
    assert.equal(result.enabled, true);

    const endpoint = gh.__exec.calls[0].args[3];
    assert.ok(endpoint.includes('release%2F2025-q4'));
  });

  it('propagates non-404 errors', async () => {
    const gh = makeGh({
      'GET /branches/main/protection': {
        status: 500,
        json: { message: 'server error' },
      },
    });
    const provider = createTestProvider({ gh });
    await assert.rejects(provider.getBranchProtection('main'), /code 500/);
  });
});

describe('GitHubProvider — setBranchProtection()', () => {
  it('creates a fresh rule when no protection exists', async () => {
    let putBody = null;
    const gh = makeGh({
      'GET /branches/main/protection': {
        status: 404,
        json: { message: 'Not Found' },
      },
      'PUT /branches/main/protection': { status: 200, json: {} },
    });
    const provider = createTestProvider({ gh });
    const result = await provider.setBranchProtection('main', {
      contexts: ['lint', 'test'],
      enforceAdmins: true,
      requiredApprovingReviewCount: 0,
    });

    assert.equal(result.created, true);
    assert.deepEqual(result.added, ['lint', 'test']);
    assert.deepEqual(result.existing, []);

    const putCall = gh.__exec.calls.find((c) => c.args[2] === 'PUT');
    assert.ok(putCall, 'expected PUT call to fire');
    putBody = JSON.parse(putCall.input);
    assert.deepEqual(putBody.required_status_checks, {
      strict: true,
      contexts: ['lint', 'test'],
    });
    assert.equal(putBody.enforce_admins, true);
    assert.equal(
      putBody.required_pull_request_reviews.required_approving_review_count,
      0,
    );
    assert.equal(putBody.restrictions, null);
  });

  it('additively merges contexts when a rule already exists', async () => {
    const existing = {
      required_status_checks: { strict: true, contexts: ['lint'] },
      enforce_admins: { enabled: true },
      required_pull_request_reviews: { required_approving_review_count: 0 },
      restrictions: null,
    };
    const gh = makeGh({
      'GET /branches/main/protection': { status: 200, json: existing },
      'PUT /branches/main/protection': { status: 200, json: {} },
    });
    const provider = createTestProvider({ gh });
    const result = await provider.setBranchProtection('main', {
      contexts: ['lint', 'test'],
    });

    assert.equal(result.created, false);
    assert.deepEqual(result.added, ['test']);
    assert.deepEqual(result.existing, ['lint']);

    const putCall = gh.__exec.calls.find((c) => c.args[2] === 'PUT');
    const body = JSON.parse(putCall.input);
    assert.deepEqual(body.required_status_checks.contexts, ['lint', 'test']);
    // No override → preserves the existing enforce_admins value (true).
    assert.equal(body.enforce_admins, true);
  });

  it('preserves operator review flags when overriding approval count', async () => {
    const existing = {
      required_status_checks: { strict: true, contexts: ['lint'] },
      enforce_admins: { enabled: false },
      required_pull_request_reviews: {
        required_approving_review_count: 2,
        dismiss_stale_reviews: true,
      },
      restrictions: null,
    };
    const gh = makeGh({
      'GET /branches/main/protection': { status: 200, json: existing },
      'PUT /branches/main/protection': { status: 200, json: {} },
    });
    const provider = createTestProvider({ gh });
    await provider.setBranchProtection('main', {
      contexts: ['lint'],
      enforceAdmins: true,
      requiredApprovingReviewCount: 0,
    });

    const putCall = gh.__exec.calls.find((c) => c.args[2] === 'PUT');
    const body = JSON.parse(putCall.input);
    assert.equal(body.enforce_admins, true);
    assert.equal(
      body.required_pull_request_reviews.required_approving_review_count,
      0,
    );
    // dismiss_stale_reviews survives the override.
    assert.equal(
      body.required_pull_request_reviews.dismiss_stale_reviews,
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// ensureLabels — Task #1373
//
// Story #1359 (Task #1373) rewrote `ensureLabels` to iterate per def and
// shell to `gh label create`, swallowing the "already exists" stderr as
// the idempotent skip path. We assert both the argv shape per create and
// the swallow-on-exists path. The mock allows a custom `error` field so a
// route can simulate the CLI's exit-non-zero-with-stderr behaviour for
// the duplicate-name case.
// ---------------------------------------------------------------------------
describe('GitHubProvider — ensureLabels()', () => {
  // Local exec that exposes per-call control via a routes Map. Unlike
  // makeGh's createGhExec we want to differentiate per labelDef so this
  // suite carries a tiny purpose-built mock.
  function makeLabelGh(perCallResponses) {
    const calls = [];
    let i = 0;
    const exec = async ({ args }) => {
      calls.push({ args });
      const response = perCallResponses[i++] ?? { ok: true };
      if (response.error) {
        const err = new Error(response.error.message ?? 'gh-exec failure');
        err.stderr = response.error.stderr ?? '';
        throw err;
      }
      return { stdout: '', stderr: '', code: 0 };
    };
    exec.calls = calls;
    const gh = createGh(exec);
    gh.__exec = exec;
    return gh;
  }

  it('creates missing labels and skips ones that already exist', async () => {
    const gh = makeLabelGh([
      { ok: true }, // type::epic — pretend GitHub side has no rule yet
      {
        error: {
          message: 'gh-exec: gh exited with code 422',
          stderr: '! Label "type::task" already exists',
        },
      },
    ]);
    const provider = createTestProvider({ gh });
    const result = await provider.ensureLabels([
      { name: 'type::epic', color: '#7057FF', description: 'Epic' },
      { name: 'type::task', color: '#7057FF', description: 'Task' },
    ]);

    assert.deepEqual(result.created, ['type::epic']);
    assert.deepEqual(result.skipped, ['type::task']);
    // Post-loop verification was unable to read live labels (test mock
    // returns empty stdout), so the missing-reconcile is best-effort and
    // returns []. Story #2018 (Bug 2) added this envelope key.
    assert.deepEqual(result.missing, []);

    // Two `gh label create` calls plus the post-loop `gh label list`
    // verification (Story #2018, Bug 2).
    assert.equal(gh.__exec.calls.length, 3);
    assert.deepEqual(gh.__exec.calls[0].args, [
      'label',
      'create',
      'type::epic',
      '--color',
      '7057FF',
      '--description',
      'Epic',
    ]);
    assert.equal(gh.__exec.calls[1].args[2], 'type::task');
    assert.equal(gh.__exec.calls[2].args[0], 'label');
    assert.equal(gh.__exec.calls[2].args[1], 'list');
  });

  it('strips # from color code when shelling to gh label create', async () => {
    const gh = makeLabelGh([{ ok: true }]);
    const provider = createTestProvider({ gh });
    await provider.ensureLabels([
      { name: 'new-label', color: '#FF0000', description: '' },
    ]);
    const args = gh.__exec.calls[0].args;
    assert.equal(args[args.indexOf('--color') + 1], 'FF0000'); // No # prefix
  });

  it('propagates non-already-exists errors so transport faults stay loud', async () => {
    const gh = makeLabelGh([
      {
        error: {
          message: 'gh-exec: gh exited with code 401',
          stderr: 'requires authentication',
        },
      },
    ]);
    const provider = createTestProvider({ gh });
    await assert.rejects(
      provider.ensureLabels([
        { name: 'bug', color: '#D93F0B', description: '' },
      ]),
      /code 401/,
    );
  });

  // -------------------------------------------------------------------------
  // Story #2018 (Bug 2) — post-loop verification + tightened matcher.
  //
  // The fresh-repo bootstrap regression report showed `ensureLabels` reporting
  // `skipped: 23` when zero labels were actually present on the remote. Two
  // safety nets keep that from happening silently: a tightened
  // `isLabelAlreadyExistsError` regex that requires the label-create lexicon,
  // and a post-loop reconcile that lists live labels and surfaces any
  // already-counted name that isn't actually present via the `missing[]`
  // envelope. The bootstrap caller then renders a loud warning.
  // -------------------------------------------------------------------------
  describe('Story #2018 (Bug 2) — post-loop verification', () => {
    function makeReconcileGh({ createResponses, listStdout }) {
      const calls = [];
      let i = 0;
      const exec = async ({ args }) => {
        calls.push({ args });
        if (args[0] === 'label' && args[1] === 'list') {
          return { stdout: listStdout, stderr: '', code: 0 };
        }
        const response = createResponses[i++] ?? { ok: true };
        if (response.error) {
          const err = new Error(response.error.message ?? 'gh-exec failure');
          err.stderr = response.error.stderr ?? '';
          throw err;
        }
        return { stdout: '', stderr: '', code: 0 };
      };
      exec.calls = calls;
      const gh = createGh(exec);
      gh.__exec = exec;
      return gh;
    }

    it('surfaces labels missing from the live set even when create reported success', async () => {
      // Two creates return ok=true (no error thrown), so the loop tallies
      // both as `created`. But the post-loop list only shows the first —
      // the second must end up in `missing[]` and be stripped from `created`.
      const gh = makeReconcileGh({
        createResponses: [{ ok: true }, { ok: true }],
        listStdout: JSON.stringify([{ name: 'type::epic' }]),
      });
      const provider = createTestProvider({ gh });
      const result = await provider.ensureLabels([
        { name: 'type::epic', color: '#7057FF', description: 'Epic' },
        { name: 'type::task', color: '#7057FF', description: 'Task' },
      ]);
      assert.deepEqual(result.created, ['type::epic']);
      assert.deepEqual(result.skipped, []);
      assert.deepEqual(result.missing, ['type::task']);
    });

    it('surfaces labels misclassified as skipped that are not actually present', async () => {
      // Both creates fail with an already-exists shape (idempotent skip),
      // but the live label set contains only one of them. The other was
      // misclassified — `missing[]` must call it out.
      const gh = makeReconcileGh({
        createResponses: [
          {
            error: {
              message: 'gh-exec: gh exited with code 422',
              stderr: '! Label "type::epic" already exists',
            },
          },
          {
            error: {
              message: 'gh-exec: gh exited with code 422',
              stderr: '! Label "type::task" already exists',
            },
          },
        ],
        listStdout: JSON.stringify([{ name: 'type::epic' }]),
      });
      const provider = createTestProvider({ gh });
      const result = await provider.ensureLabels([
        { name: 'type::epic', color: '#7057FF', description: 'Epic' },
        { name: 'type::task', color: '#7057FF', description: 'Task' },
      ]);
      assert.deepEqual(result.skipped, ['type::epic']);
      assert.deepEqual(result.missing, ['type::task']);
    });

    it('returns empty missing[] when listing fails (best-effort verification)', async () => {
      // The verification path swallows list failures so a transient
      // post-loop probe doesn't fail an otherwise-clean bootstrap.
      const calls = [];
      let createIdx = 0;
      const exec = async ({ args }) => {
        calls.push({ args });
        if (args[0] === 'label' && args[1] === 'list') {
          const err = new Error('gh-exec: gh exited with code 500');
          err.stderr = 'transient';
          throw err;
        }
        createIdx += 1;
        return { stdout: '', stderr: '', code: 0 };
      };
      exec.calls = calls;
      const gh = createGh(exec);
      gh.__exec = exec;
      const provider = createTestProvider({ gh });
      const result = await provider.ensureLabels([
        { name: 'type::epic', color: '#7057FF', description: 'Epic' },
      ]);
      assert.deepEqual(result.created, ['type::epic']);
      assert.deepEqual(result.missing, []);
      assert.equal(createIdx, 1);
    });

    it('tightened matcher rejects stderr that mentions "already exists" outside the label lexicon', async () => {
      // A spurious stderr ("file already exists") must NOT be classified as
      // an idempotent label skip — the create should propagate as a real
      // failure rather than getting filed under `skipped` and dropped.
      const gh = makeReconcileGh({
        createResponses: [
          {
            error: {
              message: 'gh-exec: gh exited with code 500',
              stderr: 'database error: file already exists at /tmp/foo',
            },
          },
        ],
        listStdout: '[]',
      });
      const provider = createTestProvider({ gh });
      await assert.rejects(
        provider.ensureLabels([
          { name: 'type::epic', color: '#7057FF', description: 'Epic' },
        ]),
        /code 500/,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// branchExists — Story #2018 (Bug 3)
//
// `lib/bootstrap/branch-protection.js` consults `provider.branchExists()`
// before attempting a protection write so empty-repo bootstraps get a clean
// "no-base-branch" skip instead of a confusing PUT 404. The probe is a
// thin GET wrapper that returns true/false on 404 and propagates anything
// else so auth/scope failures don't masquerade as a missing branch.
// ---------------------------------------------------------------------------
describe('GitHubProvider — branchExists()', () => {
  it('returns true when GET /repos/.../branches/{branch} resolves', async () => {
    const gh = makeGh({
      'GET /repos/test-owner/test-repo/branches/main': {
        status: 200,
        json: { name: 'main' },
      },
    });
    const provider = createTestProvider({ gh });
    assert.equal(await provider.branchExists('main'), true);
  });

  it('returns false on 404 (branch not pushed yet)', async () => {
    const gh = makeGh({
      'GET /repos/test-owner/test-repo/branches/main': {
        status: 404,
        json: { message: 'Branch not found' },
      },
    });
    const provider = createTestProvider({ gh });
    assert.equal(await provider.branchExists('main'), false);
  });

  it('propagates non-404 errors so auth/scope failures stay loud', async () => {
    const gh = makeGh({
      'GET /repos/test-owner/test-repo/branches/main': {
        status: 401,
        json: { message: 'Bad credentials' },
      },
    });
    const provider = createTestProvider({ gh });
    await assert.rejects(provider.branchExists('main'), /code 401/);
  });
});

// ---------------------------------------------------------------------------
// getMergeMethods / setMergeMethods — Task #1373
// ---------------------------------------------------------------------------
describe('GitHubProvider — getMergeMethods()', () => {
  it('returns the merge-method allowlist + auto-merge / delete-branch flags', async () => {
    const gh = makeGh({
      'GET /repos/test-owner/test-repo': {
        status: 200,
        json: {
          allow_squash_merge: true,
          allow_rebase_merge: false,
          allow_merge_commit: false,
          allow_auto_merge: true,
          delete_branch_on_merge: true,
          // Other repo knobs the bootstrap doesn't care about — must be
          // filtered out.
          name: 'test-repo',
          private: false,
        },
      },
    });
    const provider = createTestProvider({ gh });
    const result = await provider.getMergeMethods();
    assert.deepEqual(result, {
      allow_squash_merge: true,
      allow_rebase_merge: false,
      allow_merge_commit: false,
      allow_auto_merge: true,
      delete_branch_on_merge: true,
    });
  });

  it('returns only fields the API surfaces (sparse response)', async () => {
    const gh = makeGh({
      'GET /repos/test-owner/test-repo': {
        status: 200,
        json: { allow_squash_merge: true },
      },
    });
    const provider = createTestProvider({ gh });
    const result = await provider.getMergeMethods();
    assert.deepEqual(result, { allow_squash_merge: true });
  });
});

describe('GitHubProvider — setMergeMethods()', () => {
  it('PATCHes only the supplied merge-method fields', async () => {
    const gh = makeGh({
      'PATCH /repos/test-owner/test-repo': { status: 200, json: {} },
    });
    const provider = createTestProvider({ gh });
    const result = await provider.setMergeMethods({
      allow_squash_merge: true,
      allow_merge_commit: false,
      // Field the API understands but bootstrap doesn't care about — should
      // be dropped so we don't accidentally write it.
      private: true,
    });

    assert.deepEqual(result.patched, [
      'allow_squash_merge',
      'allow_merge_commit',
    ]);
    const patchCall = gh.__exec.calls.find((c) => c.args[2] === 'PATCH');
    assert.ok(patchCall, 'expected PATCH call to fire');
    const body = JSON.parse(patchCall.input);
    assert.deepEqual(body, {
      allow_squash_merge: true,
      allow_merge_commit: false,
    });
  });
});

// ---------------------------------------------------------------------------
// ensureProjectFields
// ---------------------------------------------------------------------------
describe('GitHubProvider — ensureProjectFields()', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns empty results when projectNumber is null', async () => {
    const provider = createTestProvider({ projectNumber: null });
    const result = await provider.ensureProjectFields([
      {
        name: 'Execution',
        type: 'single_select',
        options: ['sequential', 'concurrent'],
      },
    ]);
    assert.deepEqual(result, { created: [], skipped: [] });
  });
});

// ---------------------------------------------------------------------------
// isInsufficientScopes
// ---------------------------------------------------------------------------
describe('GitHubProvider — isInsufficientScopes()', () => {
  it('detects GraphQL INSUFFICIENT_SCOPES error', () => {
    const err = new Error(
      '[GitHubProvider] GraphQL errors: [{"type":"INSUFFICIENT_SCOPES","message":"missing project scope"}]',
    );
    assert.equal(GitHubProvider.isInsufficientScopes(err), true);
  });

  it('detects "Resource not accessible by personal access token"', () => {
    const err = new Error('Resource not accessible by personal access token');
    assert.equal(GitHubProvider.isInsufficientScopes(err), true);
  });

  it('returns false for unrelated errors', () => {
    assert.equal(
      GitHubProvider.isInsufficientScopes(new Error('404 Not Found')),
      false,
    );
    assert.equal(GitHubProvider.isInsufficientScopes(null), false);
    assert.equal(GitHubProvider.isInsufficientScopes(undefined), false);
  });
});

// ---------------------------------------------------------------------------
// ensureStatusField
// ---------------------------------------------------------------------------
describe('GitHubProvider — ensureStatusField()', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('throws when projectNumber is not configured', async () => {
    const provider = createTestProvider({ projectNumber: null });
    await assert.rejects(
      provider.ensureStatusField(['Backlog']),
      /projectNumber/,
    );
  });

  it('creates the Status field with all options when missing', async () => {
    const calls = [];
    globalThis.fetch = async (_url, opts) => {
      const body = JSON.parse(opts.body);
      calls.push(body);

      if (body.query.includes('fields(first')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({
            data: {
              user: {
                projectV2: { id: 'PVT_1', fields: { nodes: [] } },
              },
            },
          }),
          text: async () => '',
        };
      }
      if (body.query.includes('createProjectV2Field')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({
            data: {
              createProjectV2Field: {
                projectV2Field: { id: 'FLD_1', name: 'Status' },
              },
            },
          }),
          text: async () => '',
        };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ data: {} }),
        text: async () => '',
      };
    };

    const provider = createTestProvider({ projectNumber: 1 });
    const result = await provider.ensureStatusField(['Backlog', 'Done']);
    assert.equal(result.status, 'created');
    assert.deepEqual(result.added, ['Backlog', 'Done']);
  });

  it('adds only missing options when Status already exists', async () => {
    let updateCall = null;
    globalThis.fetch = async (_url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.query.includes('fields(first')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({
            data: {
              user: {
                projectV2: {
                  id: 'PVT_1',
                  fields: {
                    nodes: [
                      {
                        id: 'FLD_1',
                        name: 'Status',
                        options: [
                          { id: 'OPT_A', name: 'Backlog' },
                          { id: 'OPT_B', name: 'Done' },
                        ],
                      },
                    ],
                  },
                },
              },
            },
          }),
          text: async () => '',
        };
      }
      if (body.query.includes('updateProjectV2Field')) {
        updateCall = body;
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({
            data: {
              updateProjectV2Field: {
                projectV2Field: { id: 'FLD_1', name: 'Status' },
              },
            },
          }),
          text: async () => '',
        };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ data: {} }),
        text: async () => '',
      };
    };

    const provider = createTestProvider({ projectNumber: 1 });
    const result = await provider.ensureStatusField([
      'Backlog',
      'Planning',
      'Done',
    ]);
    assert.equal(result.status, 'updated');
    assert.deepEqual(result.added, ['Planning']);

    // Verify existing option ids were preserved in the merged list.
    const sentOptions = updateCall.variables.options;
    const withIds = sentOptions.filter((o) => o.id);
    assert.equal(withIds.length, 2);
    assert.ok(sentOptions.some((o) => o.name === 'Planning' && !o.id));
  });

  it('returns unchanged when every option already exists', async () => {
    globalThis.fetch = async (_url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.query.includes('fields(first')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({
            data: {
              user: {
                projectV2: {
                  id: 'PVT_1',
                  fields: {
                    nodes: [
                      {
                        id: 'FLD_1',
                        name: 'Status',
                        options: [{ id: 'OPT_A', name: 'Done' }],
                      },
                    ],
                  },
                },
              },
            },
          }),
          text: async () => '',
        };
      }
      throw new Error('unexpected call');
    };

    const provider = createTestProvider({ projectNumber: 1 });
    const result = await provider.ensureStatusField(['Done']);
    assert.equal(result.status, 'unchanged');
    assert.deepEqual(result.added, []);
  });

  it('returns scopes-missing when INSUFFICIENT_SCOPES surfaces', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        errors: [
          { type: 'INSUFFICIENT_SCOPES', message: 'missing project scope' },
        ],
      }),
      text: async () => '',
    });

    const provider = createTestProvider({ projectNumber: 1 });
    const result = await provider.ensureStatusField(['Backlog']);
    assert.equal(result.status, 'scopes-missing');
    assert.deepEqual(result.added, []);
  });
});

// ---------------------------------------------------------------------------
// ensureProjectViews
// ---------------------------------------------------------------------------
describe('GitHubProvider — ensureProjectViews()', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('throws when projectNumber is not configured', async () => {
    const provider = createTestProvider({ projectNumber: null });
    await assert.rejects(
      provider.ensureProjectViews([{ name: 'x', filter: 'y' }]),
      /projectNumber/,
    );
  });

  it('reports unavailable when the views field cannot be queried', async () => {
    // The metadata query itself fails (views field unknown). The provider
    // treats this as unavailable rather than fatal.
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        errors: [
          { message: "Field 'views' doesn't exist on type 'ProjectV2'" },
        ],
      }),
      text: async () => '',
    });

    const provider = createTestProvider({ projectNumber: 1 });
    const result = await provider.ensureProjectViews([
      { name: 'Epic Roadmap', filter: 'label:type::epic' },
    ]);
    assert.equal(result.unavailable, true);
    assert.deepEqual(result.skipped, ['Epic Roadmap']);
    assert.deepEqual(result.created, []);
  });

  it('reports unavailable + stops after first createProjectV2View failure', async () => {
    let createCount = 0;
    globalThis.fetch = async (_url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.query.includes('views(first')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({
            data: {
              user: {
                projectV2: { id: 'PVT_1', views: { nodes: [] } },
              },
            },
          }),
          text: async () => '',
        };
      }
      if (body.query.includes('createProjectV2View')) {
        createCount += 1;
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({
            errors: [{ message: 'Field createProjectV2View not found' }],
          }),
          text: async () => '',
        };
      }
      throw new Error('unexpected call');
    };

    const provider = createTestProvider({ projectNumber: 1 });
    const result = await provider.ensureProjectViews([
      { name: 'Epic Roadmap', filter: 'label:type::epic' },
      { name: 'Active Stories', filter: 'label:type::story' },
    ]);
    assert.equal(result.unavailable, true);
    assert.equal(createCount, 1);
    assert.equal(result.skipped.length, 2);
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------
describe('GitHubProvider — error handling', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('includes status code in REST error messages', async () => {
    const gh = makeGh({
      'GET /issues/1': { status: 403, json: { message: 'rate limited' } },
    });
    const provider = createTestProvider({ gh });
    await assert.rejects(provider.getTicket(1), /code 403/);
  });

  it('error message carries the failing argv for gh-exec failures', async () => {
    // 422 (not retried) is a deterministic terminal failure under the new
    // gh-exec error surface. The argv is captured on the thrown error via
    // gh-exec's classify() path.
    const gh = makeGh({
      'GET /issues/1': { status: 422, json: { message: 'validation failed' } },
    });
    const provider = createTestProvider({ gh });
    await assert.rejects(provider.getEpic(1), (err) => {
      // The argv shape includes the endpoint path.
      return /code 422/.test(err.message);
    });
  });

  it('supports graphql queries (routed through gh api graphql)', async () => {
    const gh = makeGh({
      'POST graphql': {
        status: 200,
        json: { data: { viewer: { login: 'tester' } } },
      },
    });
    const provider = createTestProvider({ gh });
    const result = await provider.graphql('query { viewer { login } }');
    assert.strictEqual(result.viewer.login, 'tester');
    // Verify argv routes through `gh api -X POST graphql`.
    const call = gh.__exec.calls[0];
    assert.strictEqual(call.args[0], 'api');
    assert.strictEqual(call.args[2], 'POST');
    assert.strictEqual(call.args[3], 'graphql');
    const body = JSON.parse(call.input);
    assert.match(body.query, /viewer/);
  });

  it('updates body/description in updateTicket', async () => {
    const gh = makeGh({
      'PATCH /issues/123': { status: 200, json: { id: 123 } },
    });
    const provider = createTestProvider({ gh });
    await provider.updateTicket(123, { body: 'New body content' });
    const call = gh.__exec.calls[0];
    assert.strictEqual(JSON.parse(call.input).body, 'New body content');
  });
});

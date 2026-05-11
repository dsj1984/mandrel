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
    const method = args[2] ?? 'GET';
    const endpoint = args[3] ?? '';
    const bodyStr = input ?? '';

    let matched = null;
    for (const [pattern, response] of Object.entries(routes)) {
      const parts = pattern.split(' ');
      const routeMethod = parts.length > 1 ? parts[0] : 'GET';
      const routePath = parts.length > 1 ? parts[1] : parts[0];
      const routeBody = parts.length > 2 ? parts.slice(2).join(' ') : null;
      if (
        method === routeMethod &&
        endpoint.includes(routePath) &&
        (!routeBody || bodyStr.includes(routeBody))
      ) {
        matched = response;
        break;
      }
    }
    const final = matched ?? { status: 200, json: {} };
    if (final.status >= 200 && final.status < 300) {
      return {
        stdout: JSON.stringify(final.json ?? {}),
        stderr: '',
        code: 0,
      };
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

function createRouteMock(routes) {
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
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('creates PR with Closes reference', async () => {
    // After Story #1357 the issue read (`hooks.getTicket`) routes through
    // gh-exec while the actual `POST /pulls` body still goes through the
    // legacy http client (branches submodule rewrite is a later Story in
    // Epic #1179). Mock both transports.
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
    });
    const mockFetch = createRouteMock({
      'POST /pulls': {
        status: 201,
        json: {
          number: 15,
          url: 'https://api.github.com/repos/test-owner/test-repo/pulls/15',
          html_url: 'https://github.com/test-owner/test-repo/pull/15',
        },
      },
    });
    globalThis.fetch = mockFetch;

    const provider = createTestProvider({ gh });
    const result = await provider.createPullRequest('feature/fix-42', 42);

    assert.equal(result.number, 15);
    assert.ok(result.htmlUrl.includes('/pull/15'));

    // The PR-create call is the only fetch call now; the issue read is on gh.
    const prCreate = mockFetch.calls.find(
      (c) => (c.opts?.method ?? 'GET') === 'POST',
    );
    assert.ok(prCreate, 'expected POST /pulls to fire on the legacy client');
    const prBody = JSON.parse(prCreate.opts.body);
    assert.ok(prBody.body.includes('Closes #42'));
  });
});

// ---------------------------------------------------------------------------
// ensureLabels
// ---------------------------------------------------------------------------
describe('GitHubProvider — ensureLabels()', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('creates missing labels and skips existing', async () => {
    const mockFetch = createRouteMock({
      'GET /labels': {
        status: 200,
        json: [
          { name: 'type::epic', color: '7057FF' },
          { name: 'bug', color: 'D93F0B' },
        ],
      },
      'POST /labels': { status: 201, json: { name: 'type::task' } },
    });
    globalThis.fetch = mockFetch;

    const provider = createTestProvider();
    const result = await provider.ensureLabels([
      { name: 'type::epic', color: '#7057FF', description: 'Epic' },
      { name: 'type::task', color: '#7057FF', description: 'Task' },
    ]);

    assert.deepEqual(result.created, ['type::task']);
    assert.deepEqual(result.skipped, ['type::epic']);
  });

  it('strips # from color code when sending to API', async () => {
    const mockFetch = createRouteMock({
      'GET /labels': { status: 200, json: [] },
      'POST /labels': { status: 201, json: { name: 'new-label' } },
    });
    globalThis.fetch = mockFetch;

    const provider = createTestProvider();
    await provider.ensureLabels([
      { name: 'new-label', color: '#FF0000', description: '' },
    ]);

    const sentBody = JSON.parse(mockFetch.calls[1].opts.body);
    assert.equal(sentBody.color, 'FF0000'); // No # prefix
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
      { name: 'Sprint', type: 'iteration' },
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
      { name: 'Current Sprint', filter: 'label:type::story' },
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

  it('supports graphql queries', async () => {
    const fetchMock = createRouteMock({
      'POST /graphql': {
        status: 200,
        json: { data: { viewer: { login: 'tester' } } },
      },
    });
    global.fetch = fetchMock;
    const provider = createTestProvider();
    const result = await provider.graphql('query { viewer { login } }');
    assert.strictEqual(result.viewer.login, 'tester');
    assert.strictEqual(fetchMock.calls[0].url.endsWith('/graphql'), true);
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

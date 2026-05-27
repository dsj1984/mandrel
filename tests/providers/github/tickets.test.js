/**
 * Unit tests for `.agents/scripts/providers/github/tickets.js`.
 *
 * Covers ticket CRUD (create / get / list / update) plus cache priming
 * semantics. Uses a fake gh-exec facade so no subprocess fires; the test
 * routes on the `[method, endpoint]` shape produced by `gh.api(...)`.
 *
 * Story #2462 / Task #2482 — TicketGateway is the first slice of the
 * seven-gateway split.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');

const ticketsMod = await import(
  pathToFileURL(
    path.join(ROOT, '.agents', 'scripts', 'providers', 'github', 'tickets.js'),
  ).href
);
const cacheMod = await import(
  pathToFileURL(
    path.join(ROOT, '.agents', 'scripts', 'providers', 'github', 'cache.js'),
  ).href
);
const ghExecMod = await import(
  pathToFileURL(path.join(ROOT, '.agents', 'scripts', 'lib', 'gh-exec.js')).href
);

const { TicketGateway } = ticketsMod;
const { createInlineTicketCache } = cacheMod;
const { createGh } = ghExecMod;

/**
 * Build a fake gh-exec facade that routes on the argv shape
 * `['api', '-X', <METHOD>, <ENDPOINT>, ...]` produced by `gh.api(...)`.
 */
function makeFakeGh(routes) {
  const calls = [];
  const exec = async ({ args, input }) => {
    calls.push({ args, input });
    const method = args[2] ?? 'GET';
    const endpoint = args[3] ?? '';
    for (const [key, val] of Object.entries(routes)) {
      const [m, ...rest] = key.split(' ');
      if (m === method && endpoint.includes(rest.join(' '))) {
        if (val.status >= 200 && val.status < 300) {
          return {
            stdout: JSON.stringify(val.json ?? {}),
            stderr: '',
            code: 0,
          };
        }
        const err = new Error(`gh-exec: gh exited with code ${val.status}`);
        err.code = val.status;
        throw err;
      }
    }
    return { stdout: '{}', stderr: '', code: 0 };
  };
  exec.calls = calls;
  const gh = createGh(exec);
  gh.__exec = exec;
  return gh;
}

describe('providers/github/tickets.js — TicketGateway', () => {
  it('getTicket: round-trips the issue, primes the cache, and returns from cache on the second call', async () => {
    const gh = makeFakeGh({
      'GET /issues/42': {
        status: 200,
        json: {
          number: 42,
          id: 9999,
          node_id: 'node_42',
          title: 'T42',
          body: 'Epic: #1',
          labels: [{ name: 'type::task' }],
          assignees: [],
          state: 'open',
        },
      },
    });
    const gateway = new TicketGateway({ gh, owner: 'o', repo: 'r' });
    const first = await gateway.getTicket(42);
    assert.equal(first.id, 42);
    assert.equal(first.title, 'T42');
    const second = await gateway.getTicket(42);
    assert.equal(second.id, 42);
    // Cache hit means the second call did NOT add a new exec invocation.
    assert.equal(gh.__exec.calls.length, 1);
  });

  it('getTicket: opts.fresh bypasses the cache', async () => {
    const gh = makeFakeGh({
      'GET /issues/7': {
        status: 200,
        json: {
          number: 7,
          id: 70,
          node_id: 'node_7',
          title: 'T7',
          body: '',
          labels: [],
          assignees: [],
          state: 'open',
        },
      },
    });
    const gateway = new TicketGateway({ gh, owner: 'o', repo: 'r' });
    await gateway.getTicket(7);
    await gateway.getTicket(7, { fresh: true });
    assert.equal(gh.__exec.calls.length, 2);
  });

  it('getTickets: filters by Epic body reference', async () => {
    const gh = makeFakeGh({
      'GET /issues': {
        status: 200,
        json: [
          {
            number: 100,
            id: 1000,
            title: 'in-scope',
            body: 'Epic: #10',
            labels: [{ name: 'type::task' }],
            state: 'open',
          },
          {
            number: 101,
            id: 1010,
            title: 'wrong-epic',
            body: 'Epic: #11',
            labels: [{ name: 'type::task' }],
            state: 'open',
          },
          {
            number: 102,
            id: 1020,
            title: 'not-a-task',
            body: 'unrelated',
            labels: [],
            state: 'open',
            pull_request: { url: 'pr' },
          },
        ],
      },
    });
    const gateway = new TicketGateway({ gh, owner: 'o', repo: 'r' });
    const tickets = await gateway.getTickets(10);
    assert.equal(tickets.length, 1);
    assert.equal(tickets[0].id, 100);
  });

  it('getTicketDependencies: parses blocks/blocked-by from body', async () => {
    const gh = makeFakeGh({
      'GET /issues/55': {
        status: 200,
        json: {
          number: 55,
          id: 550,
          node_id: 'node_55',
          title: 'T55',
          body: 'blocked by #10\nblocks #20',
          labels: [],
          assignees: [],
          state: 'open',
        },
      },
    });
    const gateway = new TicketGateway({ gh, owner: 'o', repo: 'r' });
    const deps = await gateway.getTicketDependencies(55);
    assert.ok(deps.blockedBy.includes(10));
    assert.ok(deps.blocks.includes(20));
  });

  it('createTicket: POSTs, returns canonical envelope, and calls the addSubIssue + addItemToProject hooks', async () => {
    const subIssueCalls = [];
    const projectCalls = [];
    const gh = makeFakeGh({
      'POST /repos/o/r/issues': {
        status: 201,
        json: {
          number: 200,
          id: 2000,
          node_id: 'node_200',
          html_url: 'https://example/200',
        },
      },
    });
    const gateway = new TicketGateway({
      gh,
      owner: 'o',
      repo: 'r',
      hooks: {
        addSubIssue: async (parentId, nodeId) => {
          subIssueCalls.push({ parentId, nodeId });
        },
        addItemToProject: async (nodeId) => {
          projectCalls.push(nodeId);
        },
        getProjectNumber: () => 1,
      },
    });
    const out = await gateway.createTicket(99, {
      title: 'new ticket',
      body: 'body',
      labels: ['type::task'],
      epicId: 99,
    });
    assert.equal(out.id, 200);
    assert.equal(out.nodeId, 'node_200');
    assert.equal(out.subIssueLinked, true);
    assert.equal(out.subIssueError, null);
    assert.deepEqual(subIssueCalls, [{ parentId: 99, nodeId: 'node_200' }]);
    assert.deepEqual(projectCalls, ['node_200']);
  });

  it('createTicket: surfaces subIssueError when the hook throws but still returns the issue', async () => {
    const gh = makeFakeGh({
      'POST /repos/o/r/issues': {
        status: 201,
        json: {
          number: 300,
          id: 3000,
          node_id: 'node_300',
          html_url: 'https://example/300',
        },
      },
    });
    const gateway = new TicketGateway({
      gh,
      owner: 'o',
      repo: 'r',
      hooks: {
        addSubIssue: async () => {
          throw new Error('link failed');
        },
      },
    });
    const out = await gateway.createTicket(11, {
      title: 't',
      body: '',
      labels: [],
    });
    assert.equal(out.id, 300);
    assert.equal(out.subIssueLinked, false);
    assert.ok(out.subIssueError instanceof Error);
  });

  it('updateTicket: additive label-only PATCH skips body PATCH and invalidates cache', async () => {
    const cache = createInlineTicketCache();
    cache.set(50, {
      id: 50,
      title: 'T50',
      labels: ['type::task'],
      body: '',
    });
    const gh = makeFakeGh({
      'POST /repos/o/r/issues/50/labels': { status: 200, json: {} },
    });
    const gateway = new TicketGateway({
      gh,
      owner: 'o',
      repo: 'r',
      cache,
    });
    await gateway.updateTicket(50, { labels: { add: ['agent::executing'] } });
    // Cache was invalidated.
    assert.equal(cache.has(50), false);
    // One exec call only (the additive labels POST).
    assert.equal(gh.__exec.calls.length, 1);
  });

  it('updateTicket: with body merges labels via PATCH', async () => {
    const cache = createInlineTicketCache();
    cache.set(60, {
      id: 60,
      title: 'T60',
      labels: ['existing', 'old'],
      body: '',
    });
    const gh = makeFakeGh({
      'PATCH /repos/o/r/issues/60': { status: 200, json: {} },
    });
    const gateway = new TicketGateway({
      gh,
      owner: 'o',
      repo: 'r',
      cache,
    });
    await gateway.updateTicket(60, {
      body: 'new body',
      labels: { add: ['fresh'], remove: ['old'] },
    });
    const patchCall = gh.__exec.calls[0];
    const body = JSON.parse(patchCall.input);
    assert.equal(body.body, 'new body');
    assert.ok(body.labels.includes('fresh'));
    assert.ok(body.labels.includes('existing'));
    assert.ok(!body.labels.includes('old'));
  });

  it('primeTicketCache / invalidateTicket: exposed for parent provider compatibility', () => {
    const cache = createInlineTicketCache();
    const gateway = new TicketGateway({
      gh: makeFakeGh({}),
      owner: 'o',
      repo: 'r',
      cache,
    });
    gateway.primeTicketCache([{ id: 1, title: 'T1', labels: [] }]);
    assert.equal(cache.has(1), true);
    gateway.invalidateTicket(1);
    assert.equal(cache.has(1), false);
  });
});

// Story #3097 (Wave-0 additive, Epic #3078 Strategy B) — Storyless mapper
// guard. In 3-tier mode a Story can legitimately have zero Task children,
// which surfaces at the provider boundary as an empty/missing sub-issue
// node in the GraphQL response. The mappers must return `null` (or an
// empty list) instead of throwing on missing children — pinned here so
// the Storyless code path is contractually exercised at the provider
// surface called out in the task body.
describe('providers/github mappers — Storyless tolerance (Story #3097)', () => {
  it('subIssueNodeToTicket returns null for a missing sub-issue node', async () => {
    const mappersMod = await import(
      pathToFileURL(
        path.join(
          ROOT,
          '.agents',
          'scripts',
          'providers',
          'github',
          'mappers.js',
        ),
      ).href
    );
    const { subIssueNodeToTicket } = mappersMod;
    assert.equal(subIssueNodeToTicket(null), null);
    assert.equal(subIssueNodeToTicket(undefined), null);
  });

  it('subIssueNodesToTickets returns [] for a Storyless Story (no child Tasks)', async () => {
    const mappersMod = await import(
      pathToFileURL(
        path.join(
          ROOT,
          '.agents',
          'scripts',
          'providers',
          'github',
          'mappers.js',
        ),
      ).href
    );
    const { subIssueNodesToTickets } = mappersMod;
    // The Storyless invariant: the GraphQL response carries an empty
    // `nodes` array under the Story → child relation.
    assert.deepEqual(subIssueNodesToTickets([]), []);
    assert.deepEqual(subIssueNodesToTickets(null), []);
    assert.deepEqual(subIssueNodesToTickets(undefined), []);
  });

  it('subIssueNodesToTickets skips null entries and maps the rest', async () => {
    const mappersMod = await import(
      pathToFileURL(
        path.join(
          ROOT,
          '.agents',
          'scripts',
          'providers',
          'github',
          'mappers.js',
        ),
      ).href
    );
    const { subIssueNodesToTickets } = mappersMod;
    const out = subIssueNodesToTickets([
      null,
      {
        number: 5,
        databaseId: 50,
        id: 'node_5',
        title: 'Child',
        body: 'b',
        labels: { nodes: [{ name: 'type::task' }] },
        assignees: { nodes: [] },
        state: 'OPEN',
      },
      undefined,
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 5);
    assert.equal(out[0].state, 'open');
  });
});

describe('providers/github.js — surface stays byte-identical', () => {
  it('GitHubProvider delegates ticket CRUD to TicketGateway without changing public shape', async () => {
    const providerMod = await import(
      pathToFileURL(
        path.join(ROOT, '.agents', 'scripts', 'providers', 'github.js'),
      ).href
    );
    const { GitHubProvider } = providerMod;
    const gh = makeFakeGh({
      'GET /issues/77': {
        status: 200,
        json: {
          number: 77,
          id: 770,
          node_id: 'node_77',
          title: 'T77',
          body: '',
          labels: [],
          assignees: [],
          state: 'open',
        },
      },
    });
    process.env.GITHUB_TOKEN = 'mock-token';
    const provider = new GitHubProvider({ owner: 'o', repo: 'r' }, { gh });
    const ticket = await provider.getTicket(77);
    assert.equal(ticket.id, 77);
    // tickets gateway is the shared owner; invalidation through provider
    // surfaces on the gateway's cache.
    provider.invalidateTicket(77);
    assert.equal(provider.tickets.cache.has(77), false);
  });
});

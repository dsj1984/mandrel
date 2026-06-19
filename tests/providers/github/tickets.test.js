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

const { TicketGateway, composeStoryBody } = ticketsMod;
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

  it('getTickets: searches server-side and post-filters by Epic body reference', async () => {
    const gh = makeFakeGh({
      'GET /search/issues': {
        status: 200,
        json: {
          total_count: 3,
          items: [
            {
              number: 100,
              id: 1000,
              title: 'in-scope',
              body: 'Epic: #10',
              labels: [{ name: 'type::task' }],
              state: 'open',
            },
            {
              // Search tokenization false positive — the regex post-filter
              // must drop it (#10 must not match #101).
              number: 101,
              id: 1010,
              title: 'wrong-epic',
              body: 'Epic: #101',
              labels: [{ name: 'type::task' }],
              state: 'open',
            },
            {
              number: 102,
              id: 1020,
              title: 'a-pr',
              body: 'Epic: #10',
              labels: [],
              state: 'open',
              pull_request: { url: 'pr' },
            },
          ],
        },
      },
    });
    const gateway = new TicketGateway({ gh, owner: 'o', repo: 'r' });
    const tickets = await gateway.getTickets(10);
    assert.equal(tickets.length, 1);
    assert.equal(tickets[0].id, 100);
    // Search path only: two search queries (Epic + parent), no repo-wide list.
    const endpoints = gh.__exec.calls.map((c) => c.args[3]);
    assert.ok(endpoints.every((e) => e.startsWith('/search/issues?')));
    assert.equal(endpoints.length, 2);
  });

  it('getTickets: dedupes issues matched by both Epic and parent queries', async () => {
    const issue = {
      number: 200,
      id: 2000,
      title: 'both-refs',
      body: 'parent: #10\nEpic: #10',
      labels: [],
      state: 'open',
    };
    const gh = makeFakeGh({
      'GET /search/issues': {
        status: 200,
        json: { total_count: 1, items: [issue] },
      },
    });
    const gateway = new TicketGateway({ gh, owner: 'o', repo: 'r' });
    const tickets = await gateway.getTickets(10);
    assert.equal(tickets.length, 1);
    assert.equal(tickets[0].id, 200);
  });

  it('getTickets: falls back to the repo-wide listing when search fails', async () => {
    const gh = makeFakeGh({
      'GET /search/issues': { status: 422 },
      'GET /repos/o/r/issues': {
        status: 200,
        json: [
          {
            number: 300,
            id: 3000,
            title: 'via-fallback',
            body: 'Epic: #10',
            labels: [],
            state: 'open',
          },
        ],
      },
    });
    const gateway = new TicketGateway({ gh, owner: 'o', repo: 'r' });
    const tickets = await gateway.getTickets(10);
    assert.equal(tickets.length, 1);
    assert.equal(tickets[0].id, 300);
  });

  it('getTickets: memoizes per epic+filters and clears the memo on writes', async () => {
    const gh = makeFakeGh({
      'GET /search/issues': {
        status: 200,
        json: {
          total_count: 1,
          items: [
            {
              number: 400,
              id: 4000,
              title: 'memoized',
              body: 'Epic: #10',
              labels: [],
              state: 'open',
            },
          ],
        },
      },
      'POST /repos/o/r/issues': {
        status: 201,
        json: { number: 401, id: 4010, node_id: 'n401', html_url: 'u' },
      },
    });
    const gateway = new TicketGateway({ gh, owner: 'o', repo: 'r' });
    await gateway.getTickets(10);
    const callsAfterFirst = gh.__exec.calls.length;
    const second = await gateway.getTickets(10);
    assert.equal(second.length, 1);
    // Memo hit: no additional gh calls.
    assert.equal(gh.__exec.calls.length, callsAfterFirst);
    // Different filters miss the memo.
    await gateway.getTickets(10, { state: 'open' });
    assert.ok(gh.__exec.calls.length > callsAfterFirst);
    // A write clears the memo.
    const callsBeforeWrite = gh.__exec.calls.length;
    await gateway.createIssue({ title: 't', body: 'b' });
    await gateway.getTickets(10);
    assert.ok(gh.__exec.calls.length > callsBeforeWrite + 1);
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

  it('createIssue: POSTs a bare body (no parent footer), surfaces nodeId, and adds the issue to the board when a project number resolves (Story #3822)', async () => {
    const projectCalls = [];
    const gh = makeFakeGh({
      'POST /repos/o/r/issues': {
        status: 201,
        json: {
          number: 400,
          id: 4000,
          node_id: 'node_400',
          html_url: 'https://example/400',
        },
      },
    });
    const gateway = new TicketGateway({
      gh,
      owner: 'o',
      repo: 'r',
      hooks: {
        addItemToProject: async (nodeId) => {
          projectCalls.push(nodeId);
        },
        getProjectNumber: () => 1,
      },
    });
    const out = await gateway.createIssue({
      title: 'bare issue',
      body: '# Bare issue body',
      labels: ['type::epic'],
    });
    assert.equal(out.id, 400);
    assert.equal(out.number, 400);
    assert.equal(out.nodeId, 'node_400');
    assert.equal(out.url, 'https://example/400');
    assert.deepEqual(out.boardAdd, { added: true });
    assert.deepEqual(projectCalls, ['node_400']);
    // The POSTed body must be the caller's body verbatim — no
    // `parent: #N` footer composition on the bare-issue path.
    const post = gh.__exec.calls.find((c) => c.args[2] === 'POST');
    const posted = JSON.parse(post.input);
    assert.equal(posted.body, '# Bare issue body');
    assert.equal(posted.title, 'bare issue');
    assert.deepEqual(posted.labels, ['type::epic']);
  });

  it('createIssue: skips the board add cleanly when no project number is configured (Story #3822)', async () => {
    const projectCalls = [];
    const gh = makeFakeGh({
      'POST /repos/o/r/issues': {
        status: 201,
        json: {
          number: 401,
          id: 4010,
          node_id: 'node_401',
          html_url: 'https://example/401',
        },
      },
    });
    const gateway = new TicketGateway({
      gh,
      owner: 'o',
      repo: 'r',
      hooks: {
        addItemToProject: async (nodeId) => {
          projectCalls.push(nodeId);
        },
        getProjectNumber: () => null,
      },
    });
    const out = await gateway.createIssue({
      title: 'no board',
      body: 'b',
      labels: [],
    });
    assert.equal(out.id, 401);
    assert.deepEqual(out.boardAdd, {
      added: false,
      reason: 'no-project-number',
    });
    assert.deepEqual(projectCalls, []);
  });

  it('createIssue: a failing board add is non-fatal and surfaces reason "error" (Story #3822)', async () => {
    const gh = makeFakeGh({
      'POST /repos/o/r/issues': {
        status: 201,
        json: {
          number: 402,
          id: 4020,
          node_id: 'node_402',
          html_url: 'https://example/402',
        },
      },
    });
    const gateway = new TicketGateway({
      gh,
      owner: 'o',
      repo: 'r',
      hooks: {
        addItemToProject: async () => {
          throw new Error('board down');
        },
        getProjectNumber: () => 1,
      },
    });
    const out = await gateway.createIssue({ title: 't', body: 'b' });
    assert.equal(out.id, 402);
    assert.deepEqual(out.boardAdd, { added: false, reason: 'error' });
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

  // Story #4241 — createTicket must always carry type::story in the POST body.
  it('createTicket: injects type::story when labels is undefined (Story #4241)', async () => {
    const gh = makeFakeGh({
      'POST /repos/o/r/issues': {
        status: 201,
        json: {
          number: 500,
          id: 5000,
          node_id: 'node_500',
          html_url: 'https://example/500',
        },
      },
    });
    const gateway = new TicketGateway({ gh, owner: 'o', repo: 'r', hooks: {} });
    await gateway.createTicket(10, {
      title: 'Story without labels',
      body: '',
      // labels intentionally absent — simulates the authoring-agent miss
    });
    const posted = JSON.parse(
      gh.__exec.calls.find((c) => c.args[2] === 'POST').input,
    );
    assert.ok(
      posted.labels.includes('type::story'),
      `POST body must carry type::story; got: ${JSON.stringify(posted.labels)}`,
    );
  });

  it('createTicket: injects type::story when labels is an empty array (Story #4241)', async () => {
    const gh = makeFakeGh({
      'POST /repos/o/r/issues': {
        status: 201,
        json: {
          number: 501,
          id: 5010,
          node_id: 'node_501',
          html_url: 'https://example/501',
        },
      },
    });
    const gateway = new TicketGateway({ gh, owner: 'o', repo: 'r', hooks: {} });
    await gateway.createTicket(10, {
      title: 'Story with empty labels',
      body: '',
      labels: [],
    });
    const posted = JSON.parse(
      gh.__exec.calls.find((c) => c.args[2] === 'POST').input,
    );
    assert.ok(
      posted.labels.includes('type::story'),
      `POST body must carry type::story; got: ${JSON.stringify(posted.labels)}`,
    );
  });

  it('createTicket: does not duplicate type::story when caller already includes it (Story #4241)', async () => {
    const gh = makeFakeGh({
      'POST /repos/o/r/issues': {
        status: 201,
        json: {
          number: 502,
          id: 5020,
          node_id: 'node_502',
          html_url: 'https://example/502',
        },
      },
    });
    const gateway = new TicketGateway({ gh, owner: 'o', repo: 'r', hooks: {} });
    await gateway.createTicket(10, {
      title: 'Story with type::story already',
      body: '',
      labels: ['type::story', 'persona::backend'],
    });
    const posted = JSON.parse(
      gh.__exec.calls.find((c) => c.args[2] === 'POST').input,
    );
    const storyLabelCount = posted.labels.filter(
      (l) => l === 'type::story',
    ).length;
    assert.equal(
      storyLabelCount,
      1,
      `type::story must appear exactly once; got: ${JSON.stringify(posted.labels)}`,
    );
    assert.ok(posted.labels.includes('persona::backend'));
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
// guard. In 2-tier mode a Story can legitimately have zero Task children,
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

// Story #3958 — composeStoryBody is the single owner of the `blocked by #N`
// footer. These tests pin the single-occurrence invariant: each dependency
// renders exactly once, in the canonical position relative to the
// `---` / `parent: #N` trailer, regardless of dependency count. The
// duplication bug arose because the reconciler-apply create path ALSO
// pre-appended a footer to the body before handing it here; that path no
// longer does, so the composed body must contain each line exactly once.
function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

describe('composeStoryBody — single blocked-by footer (Story #3958)', () => {
  it('renders a single dependency exactly once in the canonical position', () => {
    const out = composeStoryBody({
      body: '# Story body',
      parentId: 1477,
      epicId: 1477,
      dependencies: [1480],
    });
    assert.equal(countOccurrences(out, 'blocked by #1480'), 1);
    // Canonical position: after the `---` / `parent:` / `Epic:` trailer
    // block. Under the 2-tier hierarchy a directly-attached Story has
    // epicId === parentId, and the `Epic: #N` line is emitted regardless
    // (Story #4102).
    assert.match(out, /---\nparent: #1477\nEpic: #1477\n\nblocked by #1480$/);
  });

  it('renders multiple dependencies each exactly once', () => {
    const out = composeStoryBody({
      body: '# Story body',
      parentId: 1477,
      epicId: 1490,
      dependencies: [1480, 1481, 1482],
    });
    assert.equal(countOccurrences(out, 'blocked by #1480'), 1);
    assert.equal(countOccurrences(out, 'blocked by #1481'), 1);
    assert.equal(countOccurrences(out, 'blocked by #1482'), 1);
    // Total `blocked by` markers equals the dependency count — no doubling.
    assert.equal(countOccurrences(out, 'blocked by #'), 3);
    // Epic line present because epicId !== parentId; footer order stable.
    assert.match(
      out,
      /---\nparent: #1477\nEpic: #1490\n\nblocked by #1480\nblocked by #1481\nblocked by #1482$/,
    );
  });

  it('renders no blocked-by line and no stray blank trailer for zero dependencies', () => {
    const out = composeStoryBody({
      body: '# Story body',
      parentId: 1477,
      epicId: 1477,
      dependencies: [],
    });
    assert.equal(countOccurrences(out, 'blocked by #'), 0);
    // The `Epic: #N` line is always the last trailer line when no deps are
    // present (Story #4102 — emitted even when epicId === parentId).
    assert.match(out, /---\nparent: #1477\nEpic: #1477$/);
    // No trailing blank line after the trailer when there are no deps.
    assert.doesNotMatch(out, /Epic: #1477\n\n/);
  });

  it('is robust to a body that itself mentions a dependency in prose (no double count)', () => {
    // A description that happens to say "blocked by #1480" in prose is the
    // author's content, not a footer. composeStoryBody only adds the
    // canonical footer once; it must not strip or dedupe prose. The
    // invariant we pin is that the *footer* adds exactly one line — the
    // total here is prose(1) + footer(1) = 2, proving the footer itself is
    // single-write (the duplication bug would have made it 3).
    const out = composeStoryBody({
      body: 'This work was blocked by #1480 earlier in the sprint.',
      parentId: 1477,
      epicId: 1477,
      dependencies: [1480],
    });
    assert.equal(countOccurrences(out, 'blocked by #1480'), 2);
    assert.match(out, /---\nparent: #1477\nEpic: #1477\n\nblocked by #1480$/);
  });
});

// Story #4102 — under the 2-tier hierarchy, a Story attaches directly to its
// Epic, so epicId === parentId. composeStoryBody MUST still emit the
// `Epic: #N` trailer line in that case; the prior `epicId !== parentId` guard
// (a stale 3-tier assumption that the Story's parent was a Feature) suppressed
// it and made every directly-attached 2-tier Story un-initializable.
describe('composeStoryBody — 2-tier Epic footer (Story #4102)', () => {
  it('emits Epic: #N when epicId === parentId (directly-attached Story)', () => {
    const out = composeStoryBody({
      body: '# Story body',
      parentId: 23,
      epicId: 23,
      dependencies: [],
    });
    assert.match(out, /---\nparent: #23\nEpic: #23$/);
  });

  it('still omits Epic: #N when no epicId is known (standalone Story)', () => {
    const out = composeStoryBody({
      body: '# Story body',
      parentId: 23,
      dependencies: [],
    });
    assert.match(out, /---\nparent: #23$/);
    assert.doesNotMatch(out, /Epic: #/);
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

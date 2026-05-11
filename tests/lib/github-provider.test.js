import assert from 'node:assert/strict';
import test from 'node:test';
import { createGh } from '../../.agents/scripts/lib/gh-exec.js';
import { GitHubProvider } from '../../.agents/scripts/providers/github.js';

// Mock global fetch — still needed for the unrelated tests in this file that
// exercise non-rewritten provider methods. Story #1357 swung issue + comment
// surfaces onto gh-exec, so those tests inject a fake exec instead.
const originalFetch = global.fetch;
process.env.GITHUB_TOKEN = 'mock-token';

/**
 * Build a fake gh-exec facade that routes on the argv shape
 * `['api', '-X', <METHOD>, <ENDPOINT>, ...]` produced by `gh.api(...)`.
 *
 * @param {Record<string, { status: number, json: unknown }>} routes
 *   Keys of the form `"<METHOD> <endpoint substring>"`.
 */
function makeFakeGh(routes) {
  const calls = [];
  const exec = async ({ args, input }) => {
    calls.push({ args, input });
    const method = args[2] ?? 'GET';
    const endpoint = args[3] ?? '';
    let matched = null;
    for (const [key, val] of Object.entries(routes)) {
      const [m, ...rest] = key.split(' ');
      if (m === method && endpoint.includes(rest.join(' '))) {
        matched = val;
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
    const err = new Error(`gh-exec: gh exited with code ${final.status}`);
    err.code = final.status;
    err.stderr = '';
    err.stdout = '';
    throw err;
  };
  exec.calls = calls;
  const gh = createGh(exec);
  gh.__exec = exec;
  return gh;
}

test('GitHubProvider: getTicket handles simple ticket', async () => {
  const gh = makeFakeGh({
    'GET /issues/123': {
      status: 200,
      json: {
        number: 123,
        id: 456,
        node_id: 'node_123',
        title: 'Test Ticket',
        body: 'Parent: #1\n**Focus Areas**: lib',
        labels: [{ name: 'type::task' }],
        assignees: [],
        state: 'open',
      },
    },
  });
  const provider = new GitHubProvider({ owner: 'owner', repo: 'repo' }, { gh });
  const ticket = await provider.getTicket(123);
  assert.equal(ticket.id, 123);
  assert.equal(ticket.title, 'Test Ticket');
  assert.ok(ticket.labels.includes('type::task'));
});

test('GitHubProvider: getEpic parses PRD/TechSpec links', async () => {
  const gh = makeFakeGh({
    'GET /issues/1': {
      status: 200,
      json: {
        number: 1,
        id: 111,
        node_id: 'node_1',
        title: 'Epic Title',
        body: 'PRD: #2\nTech Spec: #3',
        labels: [{ name: 'type::epic' }],
      },
    },
  });
  const provider = new GitHubProvider({ owner: 'owner', repo: 'repo' }, { gh });
  const epic = await provider.getEpic(1);
  assert.equal(epic.id, 1);
  assert.equal(epic.linkedIssues.prd, 2);
  assert.equal(epic.linkedIssues.techSpec, 3);
});

test('GitHubProvider: getTickets filters by labels', async () => {
  const gh = makeFakeGh({
    'GET /issues': {
      status: 200,
      json: [
        {
          number: 1,
          id: 101,
          title: 'T1',
          body: 'Epic: #10',
          labels: [{ name: 'type::task' }],
          state: 'open',
        },
      ],
    },
  });
  const provider = new GitHubProvider({ owner: 'owner', repo: 'repo' }, { gh });
  const tickets = await provider.getTickets(10);
  assert.equal(tickets.length, 1);
  assert.equal(tickets[0].id, 1);
});

test('GitHubProvider: postComment accepts a bare string body', async () => {
  const gh = makeFakeGh({
    'POST /issues/1/comments': {
      status: 201,
      json: { id: 'comment-1' },
    },
  });
  const provider = new GitHubProvider({ owner: 'owner', repo: 'repo' }, { gh });
  const result = await provider.postComment(1, 'Hello');
  assert.equal(result.commentId, 'comment-1');
});

test('GitHubProvider._updateLabels: add-only fast path uses labels endpoint', async () => {
  const gh = makeFakeGh({
    'POST /issues/42/labels': { status: 200, json: {} },
  });
  const provider = new GitHubProvider({ owner: 'o', repo: 'r' }, { gh });
  const result = await provider._updateLabels(
    42,
    { add: ['agent::executing'] },
    /* hasOtherPatchFields */ false,
  );

  assert.equal(result.skipPatch, true);
  assert.equal(gh.__exec.calls.length, 1);
  assert.ok(gh.__exec.calls[0].args[3].endsWith('/issues/42/labels'));
  assert.equal(gh.__exec.calls[0].args[2], 'POST');
});

test('GitHubProvider._updateLabels: removal path merges current labels', async () => {
  const gh = makeFakeGh({
    'GET /issues/42': {
      status: 200,
      json: {
        number: 42,
        id: 42,
        node_id: 'n',
        title: 't',
        body: '',
        labels: [{ name: 'agent::executing' }, { name: 'type::task' }],
        assignees: [],
        state: 'open',
      },
    },
  });
  const provider = new GitHubProvider({ owner: 'o', repo: 'r' }, { gh });
  const result = await provider._updateLabels(
    42,
    { add: ['agent::done'], remove: ['agent::executing'] },
    /* hasOtherPatchFields */ false,
  );

  assert.equal(result.skipPatch, false);
  assert.ok(result.mergedLabels.includes('agent::done'));
  assert.ok(result.mergedLabels.includes('type::task'));
  assert.ok(!result.mergedLabels.includes('agent::executing'));
});

test('GitHubProvider._updateLabels: combined patch path skips fast endpoint', async () => {
  const gh = makeFakeGh({
    'GET /issues/42': {
      status: 200,
      json: {
        number: 42,
        id: 42,
        node_id: 'n',
        title: 't',
        body: '',
        labels: [],
        assignees: [],
        state: 'open',
      },
    },
  });
  const provider = new GitHubProvider({ owner: 'o', repo: 'r' }, { gh });
  const result = await provider._updateLabels(
    42,
    { add: ['x'] },
    /* hasOtherPatchFields */ true,
  );

  assert.equal(result.skipPatch, false);
  assert.ok(result.mergedLabels.includes('x'));
  // Did NOT call the /labels fast-path endpoint
  assert.ok(
    !gh.__exec.calls.some((c) =>
      (c.args[3] ?? '').endsWith('/issues/42/labels'),
    ),
  );
});

test('GitHubProvider: getTicket memoizes within an instance', async () => {
  let execCount = 0;
  const gh = makeFakeGh({
    'GET /issues/77': {
      status: 200,
      json: {
        number: 77,
        id: 770,
        node_id: 'node_77',
        title: 'Memo Ticket',
        body: '',
        labels: [{ name: 'type::task' }],
        assignees: [],
        state: 'open',
      },
    },
  });
  // Wrap exec.calls observer.
  const origExec = gh.__exec;
  gh.api = async (opts) => {
    execCount += 1;
    return origExec({
      args: [
        'api',
        '-X',
        opts.method,
        opts.endpoint,
        ...(opts.body ? ['--input', '-'] : []),
      ],
      input: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  };

  const provider = new GitHubProvider({ owner: 'owner', repo: 'repo' }, { gh });
  await provider.getTicket(77);
  await provider.getTicket(77);
  await provider.getTicket(77);
  assert.equal(execCount, 1, 'only one REST round-trip for repeated reads');
});

test('GitHubProvider: primeTicketCache + invalidateTicket', async () => {
  let execCount = 0;
  const gh = makeFakeGh({
    'GET /issues/88': {
      status: 200,
      json: {
        number: 88,
        id: 880,
        node_id: 'node_88',
        title: 'Primed',
        body: '',
        labels: [],
        assignees: [],
        state: 'open',
      },
    },
  });
  const origExec = gh.__exec;
  gh.api = async (opts) => {
    execCount += 1;
    return origExec({
      args: [
        'api',
        '-X',
        opts.method,
        opts.endpoint,
        ...(opts.body ? ['--input', '-'] : []),
      ],
      input: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  };

  const provider = new GitHubProvider({ owner: 'owner', repo: 'repo' }, { gh });
  provider.primeTicketCache([
    { id: 88, title: 'Primed', body: '', labels: [] },
  ]);

  await provider.getTicket(88);
  assert.equal(execCount, 0, 'primed entry served from cache');

  provider.invalidateTicket(88);
  await provider.getTicket(88);
  assert.equal(execCount, 1, 'invalidated entry triggers a re-fetch');
});

test('GitHubProvider: getSubTickets paginates the GraphQL subIssues query', async () => {
  // Build a custom exec that distinguishes REST issue lookups, REST list
  // (the getTickets reverse-search), and GraphQL pages by inspecting argv.
  const calls = [];
  const exec = async ({ args, input }) => {
    calls.push({ args, input });
    const method = args[2] ?? 'GET';
    const endpoint = args[3] ?? '';

    // Parent issue REST fetch
    if (method === 'GET' && /\/issues\/1(\?|$)/.test(endpoint)) {
      return {
        stdout: JSON.stringify({
          number: 1,
          id: 1,
          node_id: 'epic-node',
          title: 'Parent',
          body: '',
          labels: [{ name: 'type::epic' }],
          assignees: [],
          state: 'open',
        }),
        stderr: '',
        code: 0,
      };
    }
    // Reverse-lookup list call
    if (method === 'GET' && /\/issues\?/.test(endpoint)) {
      return { stdout: JSON.stringify([]), stderr: '', code: 0 };
    }
    // GraphQL — emulate two-page pagination
    if (method === 'POST' && endpoint === 'graphql') {
      const body = input ? JSON.parse(input) : {};
      const cursor = body.variables?.cursor;
      if (!cursor) {
        return {
          stdout: JSON.stringify({
            data: {
              node: {
                subIssues: {
                  pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
                  nodes: [
                    {
                      number: 10,
                      databaseId: 1010,
                      id: 'node-10',
                      title: 'Child 10',
                      body: '',
                      state: 'OPEN',
                      labels: { nodes: [{ name: 'type::task' }] },
                      assignees: { nodes: [] },
                    },
                  ],
                },
              },
            },
          }),
          stderr: '',
          code: 0,
        };
      }
      return {
        stdout: JSON.stringify({
          data: {
            node: {
              subIssues: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    number: 11,
                    databaseId: 1011,
                    id: 'node-11',
                    title: 'Child 11',
                    body: '',
                    state: 'CLOSED',
                    labels: { nodes: [{ name: 'type::task' }] },
                    assignees: { nodes: [{ login: 'alice' }] },
                  },
                ],
              },
            },
          },
        }),
        stderr: '',
        code: 0,
      };
    }
    return { stdout: '{}', stderr: '', code: 0 };
  };
  const gh = createGh(exec);
  gh.__exec = exec;

  const provider = new GitHubProvider({ owner: 'o', repo: 'r' }, { gh });
  const subs = await provider.getSubTickets(1);

  // Both pages returned
  const ids = subs.map((t) => t.id).sort((a, b) => a - b);
  assert.deepEqual(ids, [10, 11]);

  // State normalised to lowercase
  const child11 = subs.find((t) => t.id === 11);
  assert.equal(child11.state, 'closed');
  assert.deepEqual(child11.assignees, ['alice']);
  assert.ok(child11.labelSet instanceof Set);
  assert.ok(child11.labelSet.has('type::task'));

  // No REST fan-out per child — cache seeded by the GraphQL call.
  const restChildCalls = calls.filter(
    (c) => /\/issues\/1[01]$/.test(c.args[3] ?? '') && c.args[3] !== 'graphql',
  );
  assert.equal(
    restChildCalls.length,
    0,
    'Per-child REST fan-out should be eliminated',
  );

  // GraphQL was called twice (two pages).
  const gqlCalls = calls.filter(
    (c) => (c.args[3] ?? '') === 'graphql' && c.args[2] === 'POST',
  );
  assert.equal(gqlCalls.length, 2);
});

test('GitHubProvider: getTicket returns labelSet in sync with labels', async () => {
  const gh = makeFakeGh({
    'GET /issues/42': {
      status: 200,
      json: {
        number: 42,
        id: 4200,
        node_id: 'n-42',
        title: 'T',
        body: '',
        labels: [{ name: 'type::task' }, { name: 'agent::done' }],
        assignees: [],
        state: 'closed',
      },
    },
  });

  const provider = new GitHubProvider({ owner: 'o', repo: 'r' }, { gh });
  const t = await provider.getTicket(42);
  assert.ok(t.labelSet instanceof Set);
  assert.equal(t.labelSet.size, t.labels.length);
  for (const l of t.labels) assert.ok(t.labelSet.has(l));
});

// Restore fetch
test('GitHubProvider: cleanup', () => {
  global.fetch = originalFetch;
});

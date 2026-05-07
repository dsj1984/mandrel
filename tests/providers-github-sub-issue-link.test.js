/**
 * Sub-issue link resilience tests (v5.32.5).
 *
 * Pins the two behaviours the silent-failure fix exists to provide:
 *
 *   1. `addSubIssue` retries on a transient (rate-limit) error and the next
 *      call succeeds — `createTicket` returns `subIssueLinked: true` and no
 *      "sub-issue link failed" warning is emitted.
 *
 *   2. `reconcileSubIssueLinks` relinks an orphan whose body footer carries
 *      `parent: #<n>` but whose native API sub-issue link is missing.
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

function createProvider(httpStubs) {
  return new GitHubProvider(
    { owner: 'o', repo: 'r', operatorHandle: '@t' },
    { token: 'x', http: httpStubs },
  );
}

describe('createTicket — addSubIssue retry on transient rate-limit', () => {
  let originalWarn;
  let warnings;
  beforeEach(() => {
    warnings = [];
    originalWarn = console.warn;
    console.warn = (...args) => {
      warnings.push(args.join(' '));
    };
  });
  afterEach(() => {
    console.warn = originalWarn;
  });

  it('retries on first-call rate-limit error and links the ticket', async () => {
    let addSubIssueCalls = 0;
    const provider = createProvider({
      // POST /issues → returned issue payload; GET /issues/<parent> → parent ticket.
      rest: async (endpoint, opts = {}) => {
        const method = opts.method ?? 'GET';
        if (method === 'POST' && endpoint.endsWith('/issues')) {
          return {
            number: 793,
            id: 7930,
            node_id: 'NODE_793',
            html_url: 'https://github.com/o/r/issues/793',
          };
        }
        if (method === 'GET' && endpoint.includes('/issues/728')) {
          return {
            number: 728,
            id: 7280,
            node_id: 'NODE_728',
            title: 'Story 728',
            body: '',
            labels: [],
            state: 'open',
          };
        }
        throw new Error(`unexpected REST call: ${method} ${endpoint}`);
      },
      graphql: async (query) => {
        if (!/addSubIssue/.test(query)) return {};
        addSubIssueCalls += 1;
        if (addSubIssueCalls === 1) {
          // Mirror the http-client's surfaced shape for a GraphQL-200 secondary RL.
          throw new Error(
            '[GitHubProvider] GraphQL request failed (403): {"message":"You have exceeded a secondary rate limit"}',
          );
        }
        return {
          addSubIssue: { issue: { number: 728 }, subIssue: { number: 793 } },
        };
      },
    });

    const result = await provider.createTicket(728, {
      epicId: 700,
      title: 'Task 793',
      body: 'Body',
      labels: ['type::task'],
    });

    assert.equal(result.id, 793);
    assert.equal(result.subIssueLinked, true);
    assert.equal(result.subIssueError, null);
    assert.equal(addSubIssueCalls, 2, 'expected one retry');

    // The retry-attempt notice is fine, but the legacy swallow-warn path must not fire.
    const swallowed = warnings.filter((w) =>
      w.includes('sub-issue link failed for #'),
    );
    assert.deepEqual(
      swallowed,
      [],
      'eventual success must not log the swallow-warn message',
    );
  });
});

describe('reconcileSubIssueLinks — relinks orphans whose footer is correct', () => {
  it('calls addSubIssue for a child whose API parent is missing', async () => {
    const epicId = 700;
    const orphanId = 793;
    const orphanNodeId = 'NODE_793';
    const parentId = 728;
    const parentNodeId = 'NODE_728';

    const addSubIssueCalls = [];

    // restPaginated returns the Epic's children (text-search); rest fetches
    // individual tickets; graphql handles native subIssues query + addSubIssue
    // mutation.
    const provider = createProvider({
      restPaginated: async (endpoint) => {
        if (endpoint.includes('/issues?')) {
          return [
            {
              number: orphanId,
              id: orphanId * 10,
              node_id: orphanNodeId,
              title: 'Orphan Task',
              body: `Body\n\n---\nparent: #${parentId}\nEpic: #${epicId}`,
              labels: [{ name: 'type::task' }],
              state: 'open',
            },
          ];
        }
        return [];
      },
      rest: async (endpoint) => {
        if (endpoint.includes(`/issues/${parentId}`)) {
          return {
            number: parentId,
            id: parentId * 10,
            node_id: parentNodeId,
            title: 'Parent Story',
            body: '',
            labels: [{ name: 'type::story' }],
            state: 'open',
          };
        }
        if (endpoint.includes(`/issues/${orphanId}`)) {
          return {
            number: orphanId,
            id: orphanId * 10,
            node_id: orphanNodeId,
            title: 'Orphan Task',
            body: `Body\n\n---\nparent: #${parentId}\nEpic: #${epicId}`,
            labels: [{ name: 'type::task' }],
            state: 'open',
          };
        }
        throw new Error(`unexpected REST call: ${endpoint}`);
      },
      graphql: async (query, variables) => {
        if (/subIssues\(first/.test(query)) {
          // Parent currently has zero native sub-issue links.
          return {
            node: {
              subIssues: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [],
              },
            },
          };
        }
        if (/addSubIssue/.test(query)) {
          addSubIssueCalls.push(variables);
          return {
            addSubIssue: {
              issue: { number: parentId },
              subIssue: { number: orphanId },
            },
          };
        }
        throw new Error(`unexpected GraphQL: ${query}`);
      },
    });

    const result = await provider.reconcileSubIssueLinks(epicId);

    assert.equal(result.totalExpected, 1);
    assert.equal(result.alreadyLinked, 0);
    assert.equal(result.reconciled, 1);
    assert.equal(result.failed, 0);
    assert.equal(addSubIssueCalls.length, 1);
    assert.equal(addSubIssueCalls[0].parentId, parentNodeId);
    assert.equal(addSubIssueCalls[0].subIssueId, orphanNodeId);
  });

  it('counts an already-linked child without re-issuing the mutation', async () => {
    const epicId = 700;
    const childId = 793;
    const parentId = 728;
    const parentNodeId = 'NODE_728';
    const childNodeId = 'NODE_793';

    let addSubIssueCalls = 0;
    const provider = createProvider({
      restPaginated: async () => [
        {
          number: childId,
          id: childId * 10,
          node_id: childNodeId,
          title: 'Linked Task',
          body: `---\nparent: #${parentId}\nEpic: #${epicId}`,
          labels: [{ name: 'type::task' }],
          state: 'open',
        },
      ],
      rest: async (endpoint) => {
        if (endpoint.includes(`/issues/${parentId}`)) {
          return {
            number: parentId,
            id: parentId * 10,
            node_id: parentNodeId,
            title: 'Parent',
            body: '',
            labels: [],
            state: 'open',
          };
        }
        return {
          number: childId,
          id: childId * 10,
          node_id: childNodeId,
          title: 'Linked Task',
          body: `---\nparent: #${parentId}`,
          labels: [],
          state: 'open',
        };
      },
      graphql: async (query) => {
        if (/subIssues\(first/.test(query)) {
          return {
            node: {
              subIssues: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    number: childId,
                    databaseId: childId * 10,
                    id: childNodeId,
                    title: 'Linked Task',
                    body: '',
                    state: 'OPEN',
                    labels: { nodes: [] },
                    assignees: { nodes: [] },
                  },
                ],
              },
            },
          };
        }
        if (/addSubIssue/.test(query)) {
          addSubIssueCalls += 1;
          return {};
        }
        return {};
      },
    });

    const result = await provider.reconcileSubIssueLinks(epicId);
    assert.equal(result.totalExpected, 1);
    assert.equal(result.alreadyLinked, 1);
    assert.equal(result.reconciled, 0);
    assert.equal(result.failed, 0);
    assert.equal(
      addSubIssueCalls,
      0,
      'must not re-link an already-linked child',
    );
  });
});

describe('reconcileSubIssueLinks — bounded parallelism (cap=4)', () => {
  it('never has more than 4 addSubIssue mutations in flight concurrently', async () => {
    const epicId = 700;
    // Build 12 orphans under one parent — outer parent loop is a 1-element
    // map, but the inner per-child loop is what we observe here.
    const parentId = 800;
    const parentNodeId = 'NODE_PARENT';
    const orphans = Array.from({ length: 12 }, (_, i) => ({
      id: 900 + i,
      nodeId: `NODE_${900 + i}`,
    }));

    let inFlight = 0;
    let peak = 0;
    let resolveGate;
    const gate = new Promise((r) => {
      resolveGate = r;
    });

    const provider = createProvider({
      restPaginated: async () =>
        orphans.map((o) => ({
          number: o.id,
          id: o.id * 10,
          node_id: o.nodeId,
          title: `Orphan ${o.id}`,
          body: `---\nparent: #${parentId}\nEpic: #${epicId}`,
          labels: [{ name: 'type::task' }],
          state: 'open',
        })),
      rest: async (endpoint) => {
        if (endpoint.includes(`/issues/${parentId}`)) {
          return {
            number: parentId,
            id: parentId * 10,
            node_id: parentNodeId,
            title: 'Parent',
            body: '',
            labels: [],
            state: 'open',
          };
        }
        const match = endpoint.match(/\/issues\/(\d+)/);
        if (match) {
          const n = Number(match[1]);
          const o = orphans.find((x) => x.id === n);
          if (o) {
            return {
              number: o.id,
              id: o.id * 10,
              node_id: o.nodeId,
              title: `Orphan ${o.id}`,
              body: `---\nparent: #${parentId}`,
              labels: [],
              state: 'open',
            };
          }
        }
        throw new Error(`unexpected REST: ${endpoint}`);
      },
      graphql: async (query) => {
        if (/subIssues\(first/.test(query)) {
          return {
            node: {
              subIssues: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [],
              },
            },
          };
        }
        if (/addSubIssue/.test(query)) {
          inFlight += 1;
          if (inFlight > peak) peak = inFlight;
          await gate;
          inFlight -= 1;
          return {
            addSubIssue: {
              issue: { number: parentId },
              subIssue: { number: 0 },
            },
          };
        }
        return {};
      },
    });

    const work = provider.reconcileSubIssueLinks(epicId);
    // Let the bounded inner-loop saturate before releasing the gate.
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setImmediate(r));
    }
    resolveGate();
    const result = await work;

    assert.equal(result.totalExpected, 12);
    assert.equal(result.reconciled, 12);
    assert.ok(
      peak <= 4,
      `peak addSubIssue concurrency must be <= 4, observed ${peak}`,
    );
    assert.ok(peak > 1, 'expected real parallelism (peak > 1)');
  });
});

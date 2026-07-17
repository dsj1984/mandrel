/**
 * Unit tests for `.agents/scripts/providers/github/sub-issues.js`.
 *
 * Covers the native GitHub Sub-Issues link surface (add / remove / native-walk)
 * plus the reconciliation walker. Uses a fake `ghGraphql` hook that routes on
 * query identity so no subprocess fires.
 *
 * Story #2462 / Task #2480 — SubIssueGateway is the third slice of the
 * seven-gateway split.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');

const subIssuesMod = await import(
  pathToFileURL(
    path.join(
      ROOT,
      '.agents',
      'scripts',
      'providers',
      'github',
      'sub-issues.js',
    ),
  ).href
);
const errorsMod = await import(
  pathToFileURL(
    path.join(ROOT, '.agents', 'scripts', 'providers', 'github', 'errors.js'),
  ).href
);
const cacheMod = await import(
  pathToFileURL(
    path.join(ROOT, '.agents', 'scripts', 'providers', 'github', 'cache.js'),
  ).href
);

const { SubIssueGateway } = subIssuesMod;
const { ADD_SUB_ISSUE_MUTATION, REMOVE_SUB_ISSUE_MUTATION, SUB_ISSUES_QUERY } =
  errorsMod;
const { createInlineTicketCache } = cacheMod;

describe('providers/github/sub-issues.js — SubIssueGateway', () => {
  it('addSubIssue: resolves the parent ticket and posts the ADD mutation', async () => {
    const calls = [];
    const ghGraphql = async (query, variables) => {
      calls.push({ query, variables });
      return { ok: true };
    };
    const gateway = new SubIssueGateway({
      ghGraphql,
      hooks: {
        getTicket: async (id) => ({ id, nodeId: `node_${id}` }),
        invalidateTicket: () => {},
      },
    });
    const out = await gateway.addSubIssue(1, 'child_node_99');
    assert.deepEqual(out, { ok: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].query, ADD_SUB_ISSUE_MUTATION);
    assert.deepEqual(calls[0].variables, {
      parentId: 'node_1',
      subIssueId: 'child_node_99',
      replaceParent: false,
    });
  });

  it('addSubIssue: invalidates the parent in the cache after success', async () => {
    const invalidated = [];
    const ghGraphql = async () => ({ ok: true });
    const gateway = new SubIssueGateway({
      ghGraphql,
      hooks: {
        getTicket: async (id) => ({ id, nodeId: `node_${id}` }),
        invalidateTicket: (id) => invalidated.push(id),
      },
    });
    await gateway.addSubIssue(7, 'child_x');
    assert.deepEqual(invalidated, [7]);
  });

  it('addSubIssue: retries on transient errors then throws after the budget', async () => {
    let attempts = 0;
    const ghGraphql = async () => {
      attempts++;
      const err = new Error('upstream blip');
      err.code = 502;
      throw err;
    };
    const classifyGithubError = (err) =>
      err?.code === 502 ? 'transient' : 'unknown';
    // Stub setTimeout — call the resolver synchronously so the retry loop
    // completes without burning real wall-clock time.
    const realSetTimeout = global.setTimeout;
    global.setTimeout = (fn) => {
      fn();
      return 0;
    };
    try {
      const gateway = new SubIssueGateway({
        ghGraphql,
        classifyGithubError,
        hooks: {
          getTicket: async (id) => ({ id, nodeId: `node_${id}` }),
          invalidateTicket: () => {},
        },
      });
      await assert.rejects(() => gateway.addSubIssue(1, 'child'), /upstream/);
      assert.equal(attempts, 6); // SUB_ISSUE_RETRY_MAX_ATTEMPTS
    } finally {
      global.setTimeout = realSetTimeout;
    }
  });

  it('removeSubIssue: resolves parent + child and posts the REMOVE mutation', async () => {
    const calls = [];
    const ghGraphql = async (query, variables) => {
      calls.push({ query, variables });
      return { removed: true };
    };
    const invalidated = [];
    const gateway = new SubIssueGateway({
      ghGraphql,
      hooks: {
        getTicket: async (id) => ({ id, nodeId: `node_${id}` }),
        invalidateTicket: (id) => invalidated.push(id),
      },
    });
    const out = await gateway.removeSubIssue(1, 2);
    assert.deepEqual(out, { removed: true });
    assert.equal(calls[0].query, REMOVE_SUB_ISSUE_MUTATION);
    assert.deepEqual(calls[0].variables, {
      parentId: 'node_1',
      subIssueId: 'node_2',
    });
    assert.deepEqual(invalidated, [1, 2]);
  });

  it('getNativeSubIssues: paginates and primes the cache', async () => {
    const seen = [];
    const pages = [
      {
        node: {
          subIssues: {
            nodes: [
              { number: 10, title: 'T10', labels: { nodes: [] } },
              { number: 11, title: 'T11', labels: { nodes: [] } },
            ],
            pageInfo: { hasNextPage: true, endCursor: 'c1' },
          },
        },
      },
      {
        node: {
          subIssues: {
            nodes: [{ number: 12, title: 'T12', labels: { nodes: [] } }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    ];
    let page = 0;
    const ghGraphql = async () => pages[page++];
    const cache = createInlineTicketCache();
    const gateway = new SubIssueGateway({
      ghGraphql,
      cache,
    });
    const ids = await gateway.getNativeSubIssues('parent_node', 1);
    seen.push(...ids);
    assert.deepEqual(seen, [10, 11, 12]);
    assert.equal(cache.has(10), true);
    assert.equal(cache.has(12), true);
  });

  it('getNativeSubIssues: returns [] when the feature is disabled', async () => {
    const ghGraphql = async () => {
      const err = new Error('feature off');
      err.feature = 'sub_issues';
      throw err;
    };
    const classify = () => 'feature-disabled';
    const gateway = new SubIssueGateway({
      ghGraphql,
      classifyGithubError: classify,
    });
    const ids = await gateway.getNativeSubIssues('parent_node', 1);
    assert.deepEqual(ids, []);
  });

  it('reconcileSubIssueLinks: backfills missing links and reports the totals', async () => {
    const children = [
      { id: 100, body: 'parent: #1', nodeId: 'node_100' },
      { id: 101, body: 'parent: #1', nodeId: 'node_101' },
      { id: 102, body: 'unrelated', nodeId: 'node_102' },
    ];
    const ghGraphql = async (query) => {
      if (query === SUB_ISSUES_QUERY) {
        // Pretend #100 is already linked; #101 is missing.
        return {
          node: {
            subIssues: {
              nodes: [{ number: 100, title: 'T100', labels: { nodes: [] } }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        };
      }
      // The add mutation just succeeds.
      return { ok: true };
    };
    const gateway = new SubIssueGateway({
      ghGraphql,
      cache: createInlineTicketCache(),
      hooks: {
        getTickets: async () => children,
        getTicket: async (id) => {
          if (id === 1) return { id: 1, nodeId: 'node_1' };
          const found = children.find((c) => c.id === id);
          return found ?? { id, nodeId: `node_${id}` };
        },
        invalidateTicket: () => {},
      },
    });
    const summary = await gateway.reconcileSubIssueLinks(1);
    assert.equal(summary.totalExpected, 2); // #100 + #101 (parent: #1)
    assert.equal(summary.alreadyLinked, 1);
    assert.equal(summary.reconciled, 1);
    assert.equal(summary.failed, 0);
  });
});

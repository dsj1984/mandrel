/**
 * Tests for the `getSubTickets` strategy decomposition in providers/github.js.
 *
 * The facade orchestrates three private strategies:
 *   - `_getNativeSubIssues`  (GraphQL sub-issues, primary)
 *   - `_getChecklistChildren` (pure markdown parse, secondary)
 *   - `_getReferencedChildren` (REST reverse-search; runs for any parent type)
 *
 * These tests exercise each strategy in isolation + the dedupe/fallback
 * orchestration behaviour on top.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const { GitHubProvider } = await import(
  pathToFileURL(path.join(ROOT, '.agents', 'scripts', 'providers', 'github.js'))
    .href
);

function createProviderWithStubs(stubs = {}) {
  const provider = new GitHubProvider(
    { owner: 'o', repo: 'r', operatorHandle: '@t' },
    {
      token: 'x',
      http: {
        graphql: stubs.graphql ?? (async () => ({})),
        rest: stubs.rest ?? (async () => ({})),
        restPaginated: stubs.restPaginated ?? (async () => []),
      },
    },
  );
  return provider;
}

describe('_getChecklistChildren', () => {
  it('parses GitHub checklist references from a body', () => {
    const provider = createProviderWithStubs();
    const body = [
      'Intro',
      '- [ ] #10',
      '- [x] #20',
      '- [X] #30',
      'noise',
      '- [ ] #10', // duplicate — strategy does not dedupe itself
    ].join('\n');
    const ids = provider._getChecklistChildren(body);
    assert.deepEqual(ids, [10, 20, 30, 10]);
  });

  it('returns [] for empty / null body', () => {
    const provider = createProviderWithStubs();
    assert.deepEqual(provider._getChecklistChildren(''), []);
    assert.deepEqual(provider._getChecklistChildren(null), []);
    assert.deepEqual(provider._getChecklistChildren(undefined), []);
  });
});

describe('_getReferencedChildren', () => {
  it('scans for Story parents via getTickets (Tasks reference parent: #N)', async () => {
    const provider = createProviderWithStubs({
      restPaginated: async () => [
        {
          number: 808,
          id: 808,
          node_id: 'n808',
          title: 't808',
          body: 'parent: #733\n',
          labels: [],
          state: 'open',
        },
        {
          number: 809,
          id: 809,
          node_id: 'n809',
          title: 't809',
          body: 'parent: #733\n',
          labels: [],
          state: 'open',
        },
      ],
    });
    const ids = await provider._getReferencedChildren(733);
    assert.deepEqual(ids.sort(), [808, 809]);
  });

  it('scans for Epic parents via getTickets', async () => {
    const provider = createProviderWithStubs({
      restPaginated: async () => [
        {
          number: 101,
          id: 1,
          node_id: 'n1',
          title: 'c1',
          body: 'parent: #5\n',
          labels: [],
          state: 'open',
        },
        {
          number: 102,
          id: 2,
          node_id: 'n2',
          title: 'c2',
          body: 'Epic: #5\n',
          labels: [],
          state: 'open',
        },
      ],
    });
    const ids = await provider._getReferencedChildren(5);
    assert.deepEqual(ids.sort(), [101, 102]);
  });

  it('swallows errors and returns [] (non-fatal tertiary)', async () => {
    const provider = createProviderWithStubs({
      restPaginated: async () => {
        throw new Error('rate limit');
      },
    });
    const ids = await provider._getReferencedChildren(5);
    assert.deepEqual(ids, []);
  });
});

describe('_getNativeSubIssues', () => {
  it('collects ids across GraphQL pages and seeds the cache', async () => {
    let call = 0;
    const provider = createProviderWithStubs({
      graphql: async () => {
        call++;
        if (call === 1) {
          return {
            node: {
              subIssues: {
                pageInfo: { hasNextPage: true, endCursor: 'c1' },
                nodes: [
                  {
                    number: 1,
                    databaseId: 1,
                    id: 'g1',
                    title: 'a',
                    state: 'OPEN',
                    labels: { nodes: [] },
                    assignees: { nodes: [] },
                  },
                ],
              },
            },
          };
        }
        return {
          node: {
            subIssues: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  number: 2,
                  databaseId: 2,
                  id: 'g2',
                  title: 'b',
                  state: 'CLOSED',
                  labels: { nodes: [] },
                  assignees: { nodes: [] },
                },
              ],
            },
          },
        };
      },
    });
    const ids = await provider._getNativeSubIssues('parent-node', 5);
    assert.deepEqual(ids, [1, 2]);
    // Cache seeded with lowercased state.
    assert.equal(provider._cache.peek(1).state, 'open');
    assert.equal(provider._cache.peek(2).state, 'closed');
  });

  it('returns [] when sub-issues feature is disabled (feature-disabled)', async () => {
    const provider = createProviderWithStubs({
      graphql: async () => {
        throw new Error("Field 'subIssues' doesn't exist on type 'Issue'");
      },
    });
    const ids = await provider._getNativeSubIssues('parent-node', 5);
    assert.deepEqual(ids, []);
  });

  it('propagates non-feature-disabled GraphQL errors', async () => {
    const provider = createProviderWithStubs({
      graphql: async () => {
        throw new Error('500 Internal Server Error');
      },
    });
    await assert.rejects(
      () => provider._getNativeSubIssues('parent-node', 5),
      /500/,
    );
  });
});

describe('getSubTickets — orchestration', () => {
  it('dedupes across strategies and preserves source order (native → checklist → reverse)', async () => {
    const provider = createProviderWithStubs({
      graphql: async () => ({
        node: {
          subIssues: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                number: 10,
                databaseId: 10,
                id: 'g10',
                title: 'n10',
                state: 'OPEN',
                labels: { nodes: [] },
                assignees: { nodes: [] },
              },
              {
                number: 11,
                databaseId: 11,
                id: 'g11',
                title: 'n11',
                state: 'OPEN',
                labels: { nodes: [] },
                assignees: { nodes: [] },
              },
            ],
          },
        },
      }),
      rest: async (url) => {
        // Parent fetch.
        if (url.endsWith('/issues/5')) {
          return {
            number: 5,
            id: 5,
            node_id: 'parent-node',
            title: 'E',
            body: '- [ ] #11\n- [ ] #12\n',
            labels: [{ name: 'type::epic' }],
            state: 'open',
          };
        }
        // Individual ticket fetches during final hydration — return minimal shape.
        const match = /\/issues\/(\d+)$/.exec(url);
        if (match) {
          const num = Number.parseInt(match[1], 10);
          return {
            number: num,
            id: num,
            node_id: `node-${num}`,
            title: `t${num}`,
            body: '',
            labels: [],
            state: 'open',
          };
        }
        return {};
      },
      restPaginated: async () => [
        // Reverse-scan for epic #5 finds #12 (dup with checklist) and #13 (new).
        {
          number: 12,
          id: 12,
          node_id: 'n12',
          title: 'c12',
          body: 'parent: #5\n',
          labels: [],
          state: 'open',
        },
        {
          number: 13,
          id: 13,
          node_id: 'n13',
          title: 'c13',
          body: 'Epic: #5\n',
          labels: [],
          state: 'open',
        },
      ],
    });

    const subTickets = await provider.getSubTickets(5);
    const ids = subTickets.map((t) => t.id);
    // Expected order: native (10, 11), then new-from-checklist (12),
    // then new-from-reverse (13). Dedupe drops repeated 11 and 12.
    assert.deepEqual(ids, [10, 11, 12, 13]);
  });

  it('falls back to checklist when native sub-issues are feature-disabled', async () => {
    const provider = createProviderWithStubs({
      graphql: async () => {
        throw new Error('feature not available on this repository');
      },
      rest: async (url) => {
        if (url.endsWith('/issues/5')) {
          return {
            number: 5,
            id: 5,
            node_id: 'parent-node',
            title: 'E',
            body: '- [ ] #20\n- [x] #21\n',
            labels: [{ name: 'type::story' }],
            state: 'open',
          };
        }
        const match = /\/issues\/(\d+)$/.exec(url);
        if (match) {
          const num = Number.parseInt(match[1], 10);
          return {
            number: num,
            id: num,
            node_id: `n${num}`,
            title: `t${num}`,
            body: '',
            labels: [],
            state: 'open',
          };
        }
        return {};
      },
    });
    const ids = (await provider.getSubTickets(5)).map((t) => t.id);
    assert.deepEqual(ids, [20, 21]);
  });

  it('caps final child ticket hydration fanout', async () => {
    const childIds = Array.from({ length: 20 }, (_, i) => 100 + i);
    let inFlight = 0;
    let maxInFlight = 0;
    const provider = createProviderWithStubs({
      graphql: async () => {
        throw new Error('feature not available on this repository');
      },
      rest: async (url) => {
        if (url.endsWith('/issues/5')) {
          return {
            number: 5,
            id: 5,
            node_id: 'parent-node',
            title: 'Story',
            body: childIds.map((id) => `- [ ] #${id}`).join('\n'),
            labels: [{ name: 'type::story' }],
            state: 'open',
          };
        }
        const match = /\/issues\/(\d+)$/.exec(url);
        if (match) {
          inFlight += 1;
          if (inFlight > maxInFlight) maxInFlight = inFlight;
          await new Promise((r) => setImmediate(r));
          await new Promise((r) => setImmediate(r));
          inFlight -= 1;
          const num = Number.parseInt(match[1], 10);
          return {
            number: num,
            id: num,
            node_id: `n${num}`,
            title: `t${num}`,
            body: '',
            labels: [],
            state: 'open',
          };
        }
        return {};
      },
    });

    const ids = (await provider.getSubTickets(5)).map((t) => t.id);

    assert.deepEqual(ids, childIds);
    assert.equal(maxInFlight, 8);
  });

  it('warns on per-child fetch failures instead of swallowing them silently (failure-signal preservation)', async () => {
    // Story #1001 Task #1012: per-child `.catch(() => null)` used to drop
    // rate-limit / not-found errors into the void. The new contract still
    // returns a partial result (orchestrator-friendly) but emits a stderr
    // warn naming the failed child so the operator and aggregators can see
    // the gap.
    const provider = createProviderWithStubs({
      graphql: async () => {
        throw new Error('feature not available on this repository');
      },
      rest: async (url) => {
        if (url.endsWith('/issues/5')) {
          return {
            number: 5,
            id: 5,
            node_id: 'parent-node',
            title: 'Story',
            body: '- [ ] #401\n- [ ] #402\n',
            labels: [{ name: 'type::story' }],
            state: 'open',
          };
        }
        if (url.endsWith('/issues/401')) {
          throw new Error('rate limit exceeded');
        }
        if (url.endsWith('/issues/402')) {
          return {
            number: 402,
            id: 402,
            node_id: 'n402',
            title: 't402',
            body: '',
            labels: [],
            state: 'open',
          };
        }
        return {};
      },
    });

    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      const ids = (await provider.getSubTickets(5)).map((t) => t.id);
      // #401 dropped (failed fetch), #402 still returned (best-effort).
      assert.deepEqual(ids, [402]);
      assert.ok(
        warnings.some((w) =>
          /getSubTickets: child #401 fetch failed \(parent #5\): rate limit exceeded/.test(
            w,
          ),
        ),
        'a stderr warn must surface the per-child fetch failure',
      );
    } finally {
      console.warn = originalWarn;
    }
  });
});

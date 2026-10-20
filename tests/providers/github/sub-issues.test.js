/**
 * Unit tests for `.agents/scripts/providers/github/sub-issues.js`.
 *
 * Covers the native GitHub Sub-Issues read walk. Uses a fake `ghGraphql`
 * hook that routes on query identity so no subprocess fires.
 *
 * Story #2462 / Task #2480 — SubIssueGateway is the third slice of the
 * seven-gateway split. Story #5008 removed the add / remove / reconcile
 * write surface, leaving the paginated read.
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
const cacheMod = await import(
  pathToFileURL(
    path.join(ROOT, '.agents', 'scripts', 'providers', 'github', 'cache.js'),
  ).href
);

const loggerMod = await import(
  pathToFileURL(path.join(ROOT, '.agents', 'scripts', 'lib', 'Logger.js')).href
);

const { SubIssueGateway } = subIssuesMod;
const { createTestProvider, makeGh } = await import('./_helpers.js');
const { createSubIssueRestFallback } = await import(
  pathToFileURL(
    path.join(
      ROOT,
      '.agents',
      'scripts',
      'providers',
      'github',
      'sub-issues-rest.js',
    ),
  ).href
);
const { createInlineTicketCache } = cacheMod;
const { Logger } = loggerMod;

/**
 * Run `fn` with `Logger.error` captured. Swapping the method rather than
 * raising the level keeps the assertion independent of `AGENT_LOG_LEVEL`.
 *
 * @param {() => Promise<unknown>} fn
 * @returns {Promise<string[]>}
 */
async function captureErrors(fn) {
  const lines = [];
  const original = Logger.error;
  Logger.error = (message) => lines.push(String(message));
  try {
    await fn();
  } finally {
    Logger.error = original;
  }
  return lines;
}

/**
 * Run `fn` with `Logger.warn` and `Logger.error` captured.
 *
 * @param {() => Promise<unknown>} fn
 * @returns {Promise<{ warn: string[], error: string[] }>}
 */
async function captureWarnAndError(fn) {
  const logs = { warn: [], error: [] };
  const original = { warn: Logger.warn, error: Logger.error };
  Logger.warn = (m) => logs.warn.push(String(m));
  Logger.error = (m) => logs.error.push(String(m));
  try {
    await fn();
  } finally {
    Logger.warn = original.warn;
    Logger.error = original.error;
  }
  return logs;
}

/** The cloud proxy's GraphQL refusal, shaped as the gh transport throws it. */
function graphqlBlockedError() {
  return Object.assign(new Error('gh-exec: gh exited with code 1'), {
    stderr:
      'HTTP 403: GitHub GraphQL is not available from Claude Code sessions (https://api.github.com/graphql)',
  });
}

/**
 * A fake gh facade serving `/issues/{n}/sub_issues` from `childrenByParent`.
 *
 * @param {Record<number, object[]>} childrenByParent
 */
function makeRestGh(childrenByParent) {
  const endpoints = [];
  return {
    endpoints,
    async api({ method, endpoint }) {
      endpoints.push(`${method} ${endpoint}`);
      const m = /\/issues\/(\d+)\/sub_issues\?page=(\d+)/.exec(endpoint);
      const rows = m && Number(m[2]) === 1 ? childrenByParent[m[1]] : [];
      return { stdout: JSON.stringify(rows ?? []) };
    },
  };
}

function restRow(number) {
  return {
    number,
    id: number * 1000,
    node_id: `I_${number}`,
    title: `T${number}`,
    body: '',
    state: 'open',
    labels: [{ name: 'type::story' }],
    assignees: [],
  };
}

describe('providers/github/sub-issues.js — SubIssueGateway', () => {
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

  it("getNativeSubIssues: names gh's own reason, not just the exit code (Story #5210)", async () => {
    const err = Object.assign(new Error('gh-exec: gh exited with code 1'), {
      stderr:
        'HTTP 403: You have exceeded a secondary rate limit\nhttps://api.github.com/graphql',
    });
    const gateway = new SubIssueGateway({
      ghGraphql: async () => {
        throw err;
      },
      // Pin the category so this test asserts the RENDERING, not the
      // classification (which `errors.test.js` owns).
      classifyGithubError: () => 'permanent',
    });

    const lines = await captureErrors(async () => {
      await assert.rejects(() =>
        gateway.getNativeSubIssues('parent_node', 1891),
      );
    });

    assert.equal(lines.length, 1);
    assert.match(lines[0], /parent #1891/);
    assert.match(
      lines[0],
      /https:\/\/api\.github\.com\/graphql/,
      "describeGhFailure appends the LAST stderr line, gh's actionable one",
    );
  });

  it('getNativeSubIssues: degrades to the bare message when no stderr was captured', async () => {
    const gateway = new SubIssueGateway({
      ghGraphql: async () => {
        throw new Error('something opaque');
      },
      classifyGithubError: () => 'permanent',
    });

    const lines = await captureErrors(async () => {
      await assert.rejects(() => gateway.getNativeSubIssues('parent_node', 7));
    });

    assert.match(lines[0], /something opaque/);
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

  describe('GraphQL refused by the cloud proxy (Story #5794)', () => {
    it('reads the same child numbers from REST and primes the cache', async () => {
      const gh = makeRestGh({ 42: [restRow(43), restRow(44)] });
      const cache = createInlineTicketCache();
      const gateway = new SubIssueGateway({
        ghGraphql: async () => {
          throw graphqlBlockedError();
        },
        cache,
        restFallback: createSubIssueRestFallback(
          { gh, owner: 'o', repo: 'r', cache },
          { blocked: false },
        ),
      });

      let ids;
      await captureWarnAndError(async () => {
        ids = await gateway.getNativeSubIssues('parent_node', 42);
      });

      assert.deepEqual(ids, [43, 44]);
      assert.equal(cache.has(43), true);
      assert.equal(cache.has(44), true);
      assert.match(
        gh.endpoints[0],
        /^GET \/repos\/o\/r\/issues\/42\/sub_issues\?/,
      );
    });

    it('N parents print exactly one warning and no errors; later parents skip GraphQL', async () => {
      const gh = makeRestGh({
        1: [restRow(10)],
        2: [restRow(20)],
        3: [restRow(30), restRow(31)],
      });
      let graphqlCalls = 0;
      const gateway = new SubIssueGateway({
        ghGraphql: async () => {
          graphqlCalls += 1;
          throw graphqlBlockedError();
        },
        restFallback: createSubIssueRestFallback(
          { gh, owner: 'o', repo: 'r' },
          { blocked: false },
        ),
      });

      const results = [];
      const logs = await captureWarnAndError(async () => {
        for (const id of [1, 2, 3]) {
          results.push(await gateway.getNativeSubIssues(`node_${id}`, id));
        }
      });

      assert.deepEqual(results, [[10], [20], [30, 31]]);
      assert.equal(graphqlCalls, 1, 'GraphQL is tried once per process');
      assert.equal(logs.error.length, 0);
      assert.equal(logs.warn.length, 1);
      assert.match(logs.warn[0], /REST/);
    });

    it('an ordinary 403 keeps the error path and does not trip the latch', async () => {
      const gh = makeRestGh({ 5: [restRow(6)] });
      const plain403 = Object.assign(new Error('gh exited with code 1'), {
        stderr: 'HTTP 403: Resource not accessible by integration',
      });
      const gateway = new SubIssueGateway({
        ghGraphql: async () => {
          throw plain403;
        },
        restFallback: createSubIssueRestFallback(
          { gh, owner: 'o', repo: 'r' },
          { blocked: false },
        ),
      });

      const logs = await captureWarnAndError(async () => {
        await assert.rejects(() => gateway.getNativeSubIssues('n', 5));
        await assert.rejects(() => gateway.getNativeSubIssues('n', 5));
      });

      assert.equal(logs.error.length, 2);
      assert.equal(gh.endpoints.length, 0, 'no REST fallback for a plain 403');
    });

    // The one case on the process-wide latch: a composed provider owns it.
    it('the composed provider falls back to REST end to end', async () => {
      const gh = makeGh({
        'POST graphql': {
          status: 403,
          json: 'GitHub GraphQL is not available from Claude Code sessions',
        },
        'GET /issues/9/sub_issues': { status: 200, json: [restRow(91)] },
      });
      const provider = createTestProvider({ gh });
      let ids;
      await captureWarnAndError(async () => {
        ids = await provider.getNativeSubIssues('node_9', 9);
      });
      assert.deepEqual(ids, [91]);
    });
  });
});

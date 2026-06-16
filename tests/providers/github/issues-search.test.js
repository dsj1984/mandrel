/**
 * Unit tests for IssuesGateway.searchIssues + the GitHubProvider delegation
 * (Story #4195).
 *
 * searchIssues backs the `/audit-to-stories` dedup port. It deliberately uses
 * the REST search API (`GET /search/issues`), NOT GraphQL — transient GraphQL
 * 401s are a known failure mode in this repo and would make the dedup gate
 * silently no-op. These tests assert:
 *   1. The REST endpoint shape: `/search/issues?q=<sha> repo:o/r type:issue`.
 *   2. The trimmed `{ number, state, body }` projection over `items[]`.
 *   3. Both open and closed issues are returned (no `state:` qualifier), so a
 *      closed-fingerprint match can surface as a re-occurrence.
 *   4. The public `GitHubProvider.searchIssues` delegates to the gateway.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');

const { IssuesGateway } = await import(
  pathToFileURL(
    path.join(ROOT, '.agents', 'scripts', 'providers', 'github', 'issues.js'),
  ).href
);
const { GitHubProvider } = await import(
  pathToFileURL(path.join(ROOT, '.agents', 'scripts', 'providers', 'github.js'))
    .href
);

/**
 * Build a gateway whose injected gh facade records the endpoint it was asked
 * for and replays a canned `/search/issues` payload.
 */
function makeGateway(items) {
  const calls = [];
  const gh = {
    api: async ({ method, endpoint }) => {
      calls.push({ method, endpoint });
      return { stdout: JSON.stringify({ total_count: items.length, items }) };
    },
  };
  const gateway = new IssuesGateway({ gh, owner: 'octo', repo: 'demo' });
  return { gateway, calls };
}

describe('IssuesGateway.searchIssues', () => {
  it('queries the REST /search/issues endpoint scoped to repo + type:issue', async () => {
    const { gateway, calls } = makeGateway([]);
    const sha = 'a'.repeat(40);

    await gateway.searchIssues({ query: sha });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'GET');
    assert.ok(
      calls[0].endpoint.startsWith('/search/issues?q='),
      `expected REST search endpoint, got ${calls[0].endpoint}`,
    );
    const decoded = decodeURIComponent(
      calls[0].endpoint.slice('/search/issues?q='.length),
    );
    assert.ok(decoded.includes(sha), 'query must carry the fingerprint sha');
    assert.ok(decoded.includes('repo:octo/demo'), 'query must scope the repo');
    assert.ok(decoded.includes('type:issue'), 'query must exclude PRs');
    // No state qualifier — open AND closed must be returned so a closed
    // fingerprint match can classify as regression-of-closed.
    assert.ok(!/\bstate:|is:open|is:closed/.test(decoded));
  });

  it('projects items[] onto { number, state, body } and normalises missing fields', async () => {
    const { gateway } = makeGateway([
      { number: 10, state: 'open', body: 'open body', title: 'ignored' },
      { number: 20, state: 'closed', body: 'closed body' },
      { number: 30 }, // missing state/body → normalised
    ]);

    const hits = await gateway.searchIssues({ query: 'b'.repeat(40) });

    assert.deepEqual(hits, [
      { number: 10, state: 'open', body: 'open body' },
      { number: 20, state: 'closed', body: 'closed body' },
      { number: 30, state: 'open', body: '' },
    ]);
  });

  it('honours explicit owner/repo overrides', async () => {
    const { gateway, calls } = makeGateway([]);
    await gateway.searchIssues({
      query: 'c'.repeat(40),
      owner: 'other',
      repo: 'fork',
    });
    const decoded = decodeURIComponent(calls[0].endpoint);
    assert.ok(decoded.includes('repo:other/fork'));
  });

  it('returns [] when the search payload has no items', async () => {
    const gh = { api: async () => ({ stdout: JSON.stringify({}) }) };
    const gateway = new IssuesGateway({ gh, owner: 'o', repo: 'r' });
    const hits = await gateway.searchIssues({ query: 'd'.repeat(40) });
    assert.deepEqual(hits, []);
  });

  it('throws on an empty query', async () => {
    const { gateway } = makeGateway([]);
    await assert.rejects(() => gateway.searchIssues({ query: '' }), /query/);
    await assert.rejects(() => gateway.searchIssues({}), /query/);
  });
});

describe('GitHubProvider.searchIssues delegation', () => {
  it('forwards to the issues gateway', async () => {
    const provider = new GitHubProvider(
      { owner: 'octo', repo: 'demo' },
      { token: 'ghp_test', gh: { api: async () => ({ stdout: '{}' }) } },
    );
    // Replace the gateway with a sentinel-returning stub to prove delegation.
    let received;
    provider.issues = {
      searchIssues: async (args) => {
        received = args;
        return [{ number: 1, state: 'open', body: 'x' }];
      },
    };

    const out = await provider.searchIssues({ query: 'sha', owner: 'o' });
    assert.deepEqual(out, [{ number: 1, state: 'open', body: 'x' }]);
    assert.deepEqual(received, { query: 'sha', owner: 'o' });
  });
});

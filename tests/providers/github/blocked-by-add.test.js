/**
 * Unit tests for `.agents/scripts/providers/github/blocked-by-add.js`.
 *
 * Story #4067 — after Phase 8 decomposition, `depends_on` slug edges are
 * translated into native GitHub "blocked by" dependency edges. Contract:
 *
 *   - Reads existing blocked-by edges for each dependent story (idempotency).
 *   - POSTs only the missing edges with `{ issue_id: <integer db id> }`.
 *   - Non-fatal: per-edge failures warn and are counted; the function never
 *     throws.
 *   - No-ops when no `depends_on` edges are present.
 *   - Skips stories/slugs that have no mapped issue number.
 *   - Skips blockers whose `getTicket` result has no `internalId`.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');

const { applyBlockedByDependencies } = await import(
  pathToFileURL(
    path.join(
      ROOT,
      '.agents',
      'scripts',
      'providers',
      'github',
      'blocked-by-add.js',
    ),
  ).href
);

/**
 * Build a minimal `gh` fake that records calls to `api`.
 *
 * @param {{
 *   getResponses?: Record<string, unknown>,
 *   postShouldFail?: boolean,
 * }} [opts]
 */
function makeGh({ getResponse = [], postShouldFail = false } = {}) {
  const calls = [];
  return {
    calls,
    api: async ({ method, endpoint, body }) => {
      calls.push({ method, endpoint, body });
      if (method === 'GET') {
        return { stdout: JSON.stringify(getResponse), stderr: '', code: 0 };
      }
      if (postShouldFail) {
        throw new Error('API unavailable');
      }
      return { stdout: JSON.stringify({ id: 999 }), stderr: '', code: 0 };
    },
  };
}

describe('providers/github/blocked-by-add.js — applyBlockedByDependencies', () => {
  const owner = 'org';
  const repo = 'repo';

  it('no-ops when no story has depends_on edges', async () => {
    const gh = makeGh();
    const result = await applyBlockedByDependencies({
      stories: [{ slug: 'story-a', dependsOn: [] }],
      slugToIssueNumber: { 'story-a': 10 },
      getTicket: async () => ({ internalId: 100 }),
      owner,
      repo,
      gh,
    });
    assert.deepEqual(result, {
      edgesAdded: 0,
      edgesSkipped: 0,
      edgesFailed: 0,
      storiesProcessed: 0,
    });
    assert.equal(gh.calls.length, 0);
  });

  it('no-ops when stories array is empty', async () => {
    const gh = makeGh();
    const result = await applyBlockedByDependencies({
      stories: [],
      slugToIssueNumber: {},
      getTicket: async () => ({ internalId: 100 }),
      owner,
      repo,
      gh,
    });
    assert.deepEqual(result, {
      edgesAdded: 0,
      edgesSkipped: 0,
      edgesFailed: 0,
      storiesProcessed: 0,
    });
    assert.equal(gh.calls.length, 0);
  });

  it('POSTs a new blocked-by edge when none exist', async () => {
    const gh = makeGh({ getResponse: [] });
    const result = await applyBlockedByDependencies({
      stories: [{ slug: 'story-b', dependsOn: ['story-a'] }],
      slugToIssueNumber: { 'story-a': 10, 'story-b': 20 },
      getTicket: async (n) => ({ internalId: n * 10 }),
      owner,
      repo,
      gh,
    });
    assert.deepEqual(result, {
      edgesAdded: 1,
      edgesSkipped: 0,
      edgesFailed: 0,
      storiesProcessed: 1,
    });
    // One GET for existing edges, one POST for the missing edge.
    assert.equal(gh.calls.length, 2);
    const getCall = gh.calls.find((c) => c.method === 'GET');
    assert.ok(
      getCall.endpoint.includes('/issues/20/dependencies/blocked_by'),
      'GET must target the dependent story (20)',
    );
    const postCall = gh.calls.find((c) => c.method === 'POST');
    assert.ok(
      postCall.endpoint.includes('/issues/20/dependencies/blocked_by'),
      'POST must target the dependent story (20)',
    );
    // blocker internalId = 10 * 10 = 100
    assert.deepEqual(postCall.body, { issue_id: 100 });
  });

  it('skips an edge that already exists', async () => {
    // Existing blocked-by list contains id=100 (the blocker's db id).
    const gh = makeGh({ getResponse: [{ id: 100 }] });
    const result = await applyBlockedByDependencies({
      stories: [{ slug: 'story-b', dependsOn: ['story-a'] }],
      slugToIssueNumber: { 'story-a': 10, 'story-b': 20 },
      getTicket: async (n) => ({ internalId: n * 10 }),
      owner,
      repo,
      gh,
    });
    assert.deepEqual(result, {
      edgesAdded: 0,
      edgesSkipped: 1,
      edgesFailed: 0,
      storiesProcessed: 1,
    });
    // GET happened but no POST.
    const postCalls = gh.calls.filter((c) => c.method === 'POST');
    assert.equal(postCalls.length, 0);
  });

  it('counts a failed POST as edgesFailed without throwing', async () => {
    const gh = makeGh({ getResponse: [], postShouldFail: true });
    const result = await applyBlockedByDependencies({
      stories: [{ slug: 'story-b', dependsOn: ['story-a'] }],
      slugToIssueNumber: { 'story-a': 10, 'story-b': 20 },
      getTicket: async (n) => ({ internalId: n * 10 }),
      owner,
      repo,
      gh,
    });
    assert.deepEqual(result, {
      edgesAdded: 0,
      edgesSkipped: 0,
      edgesFailed: 1,
      storiesProcessed: 1,
    });
  });

  it('skips a depends_on slug with no mapped issue number, counts as edgesFailed', async () => {
    const gh = makeGh({ getResponse: [] });
    const result = await applyBlockedByDependencies({
      stories: [{ slug: 'story-b', dependsOn: ['unknown-slug'] }],
      slugToIssueNumber: { 'story-b': 20 },
      getTicket: async (n) => ({ internalId: n * 10 }),
      owner,
      repo,
      gh,
    });
    assert.deepEqual(result, {
      edgesAdded: 0,
      edgesSkipped: 0,
      edgesFailed: 1,
      storiesProcessed: 1,
    });
  });

  it('skips the whole story when its own slug has no mapped issue number', async () => {
    const gh = makeGh({ getResponse: [] });
    const result = await applyBlockedByDependencies({
      stories: [{ slug: 'no-map', dependsOn: ['story-a'] }],
      slugToIssueNumber: { 'story-a': 10 },
      getTicket: async (n) => ({ internalId: n * 10 }),
      owner,
      repo,
      gh,
    });
    assert.deepEqual(result, {
      edgesAdded: 0,
      edgesSkipped: 0,
      edgesFailed: 0,
      storiesProcessed: 0,
    });
    assert.equal(gh.calls.length, 0);
  });

  it('counts a getTicket failure as edgesFailed without throwing', async () => {
    const gh = makeGh({ getResponse: [] });
    const result = await applyBlockedByDependencies({
      stories: [{ slug: 'story-b', dependsOn: ['story-a'] }],
      slugToIssueNumber: { 'story-a': 10, 'story-b': 20 },
      getTicket: async () => {
        throw new Error('network error');
      },
      owner,
      repo,
      gh,
    });
    assert.deepEqual(result, {
      edgesAdded: 0,
      edgesSkipped: 0,
      edgesFailed: 1,
      storiesProcessed: 1,
    });
  });

  it('counts as edgesFailed when getTicket returns a ticket with no internalId', async () => {
    const gh = makeGh({ getResponse: [] });
    const result = await applyBlockedByDependencies({
      stories: [{ slug: 'story-b', dependsOn: ['story-a'] }],
      slugToIssueNumber: { 'story-a': 10, 'story-b': 20 },
      getTicket: async () => ({ internalId: null }),
      owner,
      repo,
      gh,
    });
    assert.deepEqual(result, {
      edgesAdded: 0,
      edgesSkipped: 0,
      edgesFailed: 1,
      storiesProcessed: 1,
    });
  });

  it('handles multiple stories each with multiple depends_on', async () => {
    const gh = makeGh({ getResponse: [] });
    const result = await applyBlockedByDependencies({
      stories: [
        { slug: 'story-c', dependsOn: ['story-a', 'story-b'] },
        { slug: 'story-d', dependsOn: ['story-a'] },
      ],
      slugToIssueNumber: {
        'story-a': 10,
        'story-b': 20,
        'story-c': 30,
        'story-d': 40,
      },
      getTicket: async (n) => ({ internalId: n * 10 }),
      owner,
      repo,
      gh,
    });
    assert.deepEqual(result, {
      edgesAdded: 3,
      edgesSkipped: 0,
      edgesFailed: 0,
      storiesProcessed: 2,
    });
    const postCalls = gh.calls.filter((c) => c.method === 'POST');
    assert.equal(postCalls.length, 3);
  });

  it('POSTs issue_id as an integer (not a string)', async () => {
    const gh = makeGh({ getResponse: [] });
    await applyBlockedByDependencies({
      stories: [{ slug: 'story-b', dependsOn: ['story-a'] }],
      slugToIssueNumber: { 'story-a': 10, 'story-b': 20 },
      getTicket: async () => ({ internalId: 777 }),
      owner,
      repo,
      gh,
    });
    const postCall = gh.calls.find((c) => c.method === 'POST');
    assert.strictEqual(typeof postCall.body.issue_id, 'number');
    assert.strictEqual(postCall.body.issue_id, 777);
  });

  it('gracefully handles a GET failure by assuming no existing edges', async () => {
    let getCallCount = 0;
    const gh = {
      calls: [],
      api: async ({ method, endpoint, body }) => {
        gh.calls.push({ method, endpoint, body });
        if (method === 'GET') {
          getCallCount++;
          throw new Error('GET failed');
        }
        return { stdout: JSON.stringify({ id: 999 }), stderr: '', code: 0 };
      },
    };
    const result = await applyBlockedByDependencies({
      stories: [{ slug: 'story-b', dependsOn: ['story-a'] }],
      slugToIssueNumber: { 'story-a': 10, 'story-b': 20 },
      getTicket: async () => ({ internalId: 100 }),
      owner,
      repo,
      gh,
    });
    // GET failed → treats as empty → falls through to POST.
    assert.strictEqual(getCallCount, 1);
    assert.deepEqual(result, {
      edgesAdded: 1,
      edgesSkipped: 0,
      edgesFailed: 0,
      storiesProcessed: 1,
    });
  });
});

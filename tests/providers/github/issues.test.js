/**
 * Unit tests for `.agents/scripts/providers/github/issues.js` — IssuesGateway.
 *
 * Covers getSubTickets strategy ordering: native + checklist run first;
 * _getReferencedChildren is only called when both produce empty results.
 *
 * Story #3657 — Unconditional full-repo issue scan inside every `getSubTickets`.
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

/** Minimal stub ticket used across tests. */
const makeParent = (overrides = {}) => ({
  id: 1,
  nodeId: 'node-parent-1',
  body: '',
  labels: [],
  ...overrides,
});

/** Build a basic IssuesGateway with injectable hooks. */
function makeGateway({
  parent = makeParent(),
  nativeIds = [],
  referencedIds = [],
  onGetReferencedChildren = undefined,
} = {}) {
  const referencedChildrenCalls = [];

  const hooks = {
    getTicket: async (id) => {
      if (id === parent.id) return parent;
      return { id, nodeId: `node-${id}`, body: '', labels: [] };
    },
    getNativeSubIssues: async () => nativeIds,
    getTickets: async () => {
      referencedChildrenCalls.push(true);
      if (onGetReferencedChildren) return onGetReferencedChildren();
      return referencedIds.map((rid) => ({ id: rid }));
    },
    primeTicketCache: undefined,
  };

  const gateway = new IssuesGateway({ gh: null, owner: 'o', repo: 'r', hooks });
  return { gateway, referencedChildrenCalls };
}

describe('IssuesGateway — getSubTickets strategy ordering', () => {
  it('skips reverse-search when native sub-issues returns results', async () => {
    const { gateway, referencedChildrenCalls } = makeGateway({
      nativeIds: [10, 11],
      referencedIds: [99],
    });

    const tickets = await gateway.getSubTickets(1);
    const ids = tickets.map((t) => t.id).sort((a, b) => a - b);

    // Only native results — reverse-search must NOT have been called.
    assert.deepEqual(ids, [10, 11]);
    assert.equal(
      referencedChildrenCalls.length,
      0,
      '_getReferencedChildren must NOT fire when native returns results',
    );
  });

  it('skips reverse-search when checklist links in body return results', async () => {
    const parent = makeParent({ body: '- [ ] #20\n- [x] #21' });
    const { gateway, referencedChildrenCalls } = makeGateway({
      parent,
      nativeIds: [],
      referencedIds: [99],
    });

    const tickets = await gateway.getSubTickets(1);
    const ids = tickets.map((t) => t.id).sort((a, b) => a - b);

    assert.deepEqual(ids, [20, 21]);
    assert.equal(
      referencedChildrenCalls.length,
      0,
      '_getReferencedChildren must NOT fire when checklist yields results',
    );
  });

  it('falls through to reverse-search only when both native and checklist are empty', async () => {
    const { gateway, referencedChildrenCalls } = makeGateway({
      nativeIds: [],
      referencedIds: [30, 31],
    });

    const tickets = await gateway.getSubTickets(1);
    const ids = tickets.map((t) => t.id).sort((a, b) => a - b);

    assert.deepEqual(ids, [30, 31]);
    assert.equal(
      referencedChildrenCalls.length,
      1,
      '_getReferencedChildren MUST fire exactly once when strategy 1 is empty',
    );
  });

  it('deduplicates ids across native, checklist, and reverse-search', async () => {
    // Native returns #10; checklist also mentions #10.
    const parent = makeParent({ body: '- [ ] #10\n- [ ] #12' });
    const { gateway, referencedChildrenCalls } = makeGateway({
      parent,
      nativeIds: [10, 11],
      referencedIds: [99],
    });

    const tickets = await gateway.getSubTickets(1);
    const ids = tickets.map((t) => t.id).sort((a, b) => a - b);

    // #10 appears in both native and checklist — must appear only once.
    assert.deepEqual(ids, [10, 11, 12]);
    // Reverse-search suppressed because native was non-empty.
    assert.equal(referencedChildrenCalls.length, 0);
  });

  it('returns empty array when all three strategies produce nothing', async () => {
    const { gateway, referencedChildrenCalls } = makeGateway({
      nativeIds: [],
      referencedIds: [],
    });

    const tickets = await gateway.getSubTickets(1);
    assert.deepEqual(tickets, []);
    // Reverse-search still ran (strategy-1 was empty).
    assert.equal(referencedChildrenCalls.length, 1);
  });

  it('honours opts.fresh when hydrating child tickets', async () => {
    const freshOpts = [];
    const parent = makeParent();
    const hooks = {
      getTicket: async (id, opts) => {
        if (id === parent.id) return parent;
        if (opts) freshOpts.push(opts);
        return { id, nodeId: `node-${id}`, body: '', labels: [] };
      },
      getNativeSubIssues: async () => [40],
      getTickets: async () => [],
    };
    const gateway = new IssuesGateway({
      gh: null,
      owner: 'o',
      repo: 'r',
      hooks,
    });

    await gateway.getSubTickets(1, { fresh: true });
    assert.ok(
      freshOpts.length > 0 && freshOpts.every((o) => o.fresh === true),
      'fresh: true must be forwarded to child getTicket calls',
    );
  });
});

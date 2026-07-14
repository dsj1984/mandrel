/**
 * GitHubProvider facade — issues surface.
 *
 * Tests GitHubProvider's issue methods (listIssues/getEpics, getEpic,
 * getTicket, getTicketDependencies, createTicket, updateTicket) with a mocked
 * gh-exec facade — no live API calls. Split from the former root monolith
 * `tests/providers-github.test.js` (Story #4084).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createTestProvider, makeGh } from './_helpers.js';

// ---------------------------------------------------------------------------
// listIssues & getEpics
// ---------------------------------------------------------------------------
describe('GitHubProvider — listIssues() & getEpics()', () => {
  const mockIssues = [
    {
      number: 101,
      title: 'Epic 1',
      labels: [{ name: 'type::story' }],
      state: 'open',
    },
    {
      number: 102,
      title: 'Epic 2',
      labels: ['type::story'],
      state: 'closed',
      state_reason: 'completed',
    },
    {
      number: 104,
      title: 'A PR',
      labels: ['type::story'],
      state: 'open',
      pull_request: {},
    },
  ];

  it('listIssues() returns the story-only getEpics stub result', async () => {
    const gh = makeGh({ 'GET /issues': { status: 200, json: mockIssues } });
    const provider = createTestProvider({ gh });
    const epics = await provider.listIssues({ state: 'all' });

    assert.deepEqual(epics, []);
    assert.equal(gh.__exec.calls.length, 0);
  });

  it('getEpics() returns [] without querying a deleted type label', async () => {
    const gh = makeGh({ 'GET /issues': { status: 200, json: mockIssues } });
    const provider = createTestProvider({ gh });
    const epics = await provider.getEpics();

    assert.deepEqual(epics, []);
    assert.equal(gh.__exec.calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// getEpic
// ---------------------------------------------------------------------------
describe('GitHubProvider — getEpic()', () => {
  it('returns the raw body without linked-issue parsing (legacy Planning Artifacts lines are inert)', async () => {
    // Story #4324 retired the context-ticket classes: the Epic body is the
    // single planning document. A historical `## Planning Artifacts` list
    // (PRD / Tech Spec refs) rides along verbatim in `body` and no
    // `linkedIssues` slot is derived from it.
    const legacyBody =
      'Goal description\n\n## Planning Artifacts\n- [ ] PRD: #11\n- [ ] Tech Spec: #12\n';
    const gh = makeGh({
      'GET /issues/10': {
        status: 200,
        json: {
          number: 10,
          title: 'Epic: Build v5',
          body: legacyBody,
          labels: [{ name: 'type::story' }],
        },
      },
    });
    const provider = createTestProvider({ gh });
    const epic = await provider.getEpic(10);

    assert.equal(epic.id, 10);
    assert.equal(epic.title, 'Epic: Build v5');
    assert.deepEqual(epic.labels, ['type::story']);
    assert.equal(epic.body, legacyBody);
    assert.equal('linkedIssues' in epic, false);
  });

  it('does not attach linkedIssues for a plain body', async () => {
    const gh = makeGh({
      'GET /issues/10': {
        status: 200,
        json: {
          number: 10,
          title: 'Simple Epic',
          body: 'No linked docs here',
          labels: [],
        },
      },
    });
    const provider = createTestProvider({ gh });
    const epic = await provider.getEpic(10);
    assert.equal(epic.body, 'No linked docs here');
    assert.equal('linkedIssues' in epic, false);
  });

  it('handles null body', async () => {
    const gh = makeGh({
      'GET /issues/10': {
        status: 200,
        json: { number: 10, title: 'No Body', body: null, labels: [] },
      },
    });
    const provider = createTestProvider({ gh });
    const epic = await provider.getEpic(10);
    assert.equal(epic.body, '');
    assert.equal('linkedIssues' in epic, false);
  });

  it('throws on API error', async () => {
    const gh = makeGh({
      'GET /issues/999': { status: 404, json: { message: 'Not Found' } },
    });
    const provider = createTestProvider({ gh });
    // gh-exec error surface — the canonical mid-tier message includes the
    // exit code; downstream consumers handle classification via the typed
    // errors in lib/gh-exec.js.
    await assert.rejects(provider.getEpic(999), /code 404/);
  });
});

// ---------------------------------------------------------------------------
// getTicket
// ---------------------------------------------------------------------------
describe('GitHubProvider — getTicket()', () => {
  it('returns ticket with all metadata', async () => {
    const gh = makeGh({
      'GET /issues/42': {
        status: 200,
        json: {
          number: 42,
          title: 'Fix the thing',
          body: 'Detailed description',
          labels: [{ name: 'bug' }, { name: 'agent::ready' }],
          assignees: [{ login: 'alice' }, { login: 'bob' }],
          state: 'open',
        },
      },
    });
    const provider = createTestProvider({ gh });
    const ticket = await provider.getTicket(42);

    assert.equal(ticket.id, 42);
    assert.equal(ticket.title, 'Fix the thing');
    assert.deepEqual(ticket.labels, ['bug', 'agent::ready']);
    assert.deepEqual(ticket.assignees, ['alice', 'bob']);
    assert.equal(ticket.state, 'open');
  });
});

// ---------------------------------------------------------------------------
// getTicketDependencies
// ---------------------------------------------------------------------------
describe('GitHubProvider — getTicketDependencies()', () => {
  it('parses blocked by and blocks patterns', async () => {
    const gh = makeGh({
      'GET /issues/5': {
        status: 200,
        json: {
          number: 5,
          title: 'Dependent task',
          body: 'This is blocked by #3\nAlso depends on #4\nblocks #6',
          labels: [],
          assignees: [],
          state: 'open',
        },
      },
    });
    const provider = createTestProvider({ gh });
    const deps = await provider.getTicketDependencies(5);

    assert.deepEqual(deps.blockedBy, [3, 4]);
    assert.deepEqual(deps.blocks, [6]);
  });

  it('returns empty arrays when no dependencies', async () => {
    const gh = makeGh({
      'GET /issues/5': {
        status: 200,
        json: {
          number: 5,
          title: 'Independent task',
          body: 'No deps here',
          labels: [],
          assignees: [],
          state: 'open',
        },
      },
    });
    const provider = createTestProvider({ gh });
    const deps = await provider.getTicketDependencies(5);

    assert.deepEqual(deps.blockedBy, []);
    assert.deepEqual(deps.blocks, []);
  });
});

// ---------------------------------------------------------------------------
// createTicket
// ---------------------------------------------------------------------------
describe('GitHubProvider — createTicket()', () => {
  it('creates a ticket linked to the epic', async () => {
    const gh = makeGh({
      'POST /repos/test-owner/test-repo/issues': {
        status: 201,
        json: {
          number: 20,
          html_url: 'https://github.com/test-owner/test-repo/issues/20',
        },
      },
      // addSubIssue reads the parent via getTicket — return a stub.
      'GET /issues/10': {
        status: 200,
        json: {
          number: 10,
          node_id: 'parent-node',
          title: 'Parent Epic',
          body: '',
          labels: [],
          assignees: [],
          state: 'open',
        },
      },
      // Sub-issue link mutation — return a successful GraphQL payload.
      'POST graphql': {
        status: 200,
        json: { data: { addSubIssue: { issue: { number: 10 } } } },
      },
    });
    const provider = createTestProvider({ gh });
    const result = await provider.createTicket(10, {
      title: 'New task',
      body: 'Task description',
      labels: ['type::task'],
    });

    assert.equal(result.id, 20);
    assert.ok(result.url.includes('/issues/20'));

    // Find the POST /issues call and inspect its stdin body.
    const createCall = gh.__exec.calls.find(
      (c) => c.args[2] === 'POST' && /\/issues$/.test(c.args[3] ?? ''),
    );
    assert.ok(createCall, 'POST /issues call should have happened');
    const sentBody = JSON.parse(createCall.input);
    assert.ok(sentBody.body.includes('parent: #10'));
  });

  it('includes dependency references in the body', async () => {
    const gh = makeGh({
      'POST /repos/test-owner/test-repo/issues': {
        status: 201,
        json: { number: 21, html_url: 'http://x', node_id: 'n21' },
      },
      'GET /issues/10': {
        status: 200,
        json: {
          number: 10,
          node_id: 'parent-node',
          title: 'P',
          body: '',
          labels: [],
          assignees: [],
          state: 'open',
        },
      },
      'POST graphql': {
        status: 200,
        json: { data: { addSubIssue: { issue: { number: 10 } } } },
      },
    });
    const provider = createTestProvider({ gh });
    await provider.createTicket(10, {
      title: 'Dependent task',
      body: 'Depends on stuff',
      labels: [],
      dependencies: [5, 6],
    });

    const createCall = gh.__exec.calls.find(
      (c) => c.args[2] === 'POST' && /\/issues$/.test(c.args[3] ?? ''),
    );
    const sentBody = JSON.parse(createCall.input);
    assert.ok(sentBody.body.includes('blocked by #5'));
    assert.ok(sentBody.body.includes('blocked by #6'));
  });
});

// ---------------------------------------------------------------------------
// updateTicket
// ---------------------------------------------------------------------------
describe('GitHubProvider — updateTicket()', () => {
  it('patches body and assignees', async () => {
    const gh = makeGh({
      'PATCH /issues/42': { status: 200, json: {} },
    });
    const provider = createTestProvider({ gh });
    await provider.updateTicket(42, {
      body: 'Updated body',
      assignees: ['alice'],
    });

    assert.equal(gh.__exec.calls.length, 1);
    const sentBody = JSON.parse(gh.__exec.calls[0].input);
    assert.equal(sentBody.body, 'Updated body');
    assert.deepEqual(sentBody.assignees, ['alice']);
  });

  it('batches label additions and removals via GET and PATCH', async () => {
    const gh = makeGh({
      'GET /issues/42': {
        status: 200,
        json: {
          number: 42,
          labels: [{ name: 'agent::ready' }, { name: 'bug' }],
        },
      },
      'PATCH /issues/42': { status: 200, json: {} },
    });
    const provider = createTestProvider({ gh });
    await provider.updateTicket(42, {
      labels: {
        add: ['agent::executing'],
        remove: ['agent::ready'],
      },
    });

    // Should have made 2 calls: GET + PATCH
    assert.equal(gh.__exec.calls.length, 2);
    assert.equal(gh.__exec.calls[0].args[2], 'GET');
    assert.ok(gh.__exec.calls[0].args[3].includes('/issues/42'));
    assert.equal(gh.__exec.calls[1].args[2], 'PATCH');
    assert.ok(gh.__exec.calls[1].args[3].includes('/issues/42'));

    const patchBody = JSON.parse(gh.__exec.calls[1].input);
    assert.ok(patchBody.labels.includes('bug'));
    assert.ok(patchBody.labels.includes('agent::executing'));
    assert.equal(patchBody.labels.includes('agent::ready'), false);
  });
});

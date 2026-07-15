/**
 * Unit tests for `.agents/scripts/providers/github/mappers.js`.
 *
 * Covers the REST and GraphQL payload shapes for the live mappers:
 *   - issueToTicket           (REST Issue → normalized ticket)
 *   - issueToEpic             (REST Issue → Epic; raw body, no link parsing)
 *   - issueToListItem         (REST Issue → list item)
 *   - subIssueNodeToTicket    (GraphQL node → ticket; labels.nodes shape)
 *
 * Mappers are pure — this suite must run without `gh` installed (no I/O,
 * no execSync).
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');

const mappersMod = await import(
  pathToFileURL(
    path.join(ROOT, '.agents', 'scripts', 'providers', 'github', 'mappers.js'),
  ).href
);

const { issueToTicket, issueToEpic, issueToListItem, subIssueNodeToTicket } =
  mappersMod;

describe('providers/github/mappers.js — REST payload shapes', () => {
  it('issueToTicket maps REST Issue with array-of-objects labels', () => {
    const issue = {
      number: 42,
      id: 1001,
      node_id: 'NODE_42',
      title: 'Test ticket',
      body: 'body',
      labels: [{ name: 'type::task' }, { name: 'agent::ready' }],
      assignees: [{ login: 'alice' }, { login: 'bob' }],
      state: 'open',
    };
    const t = issueToTicket(issue);
    assert.deepStrictEqual(t, {
      id: 42,
      internalId: 1001,
      nodeId: 'NODE_42',
      title: 'Test ticket',
      body: 'body',
      labels: ['type::task', 'agent::ready'],
      labelSet: new Set(['type::task', 'agent::ready']),
      assignees: ['alice', 'bob'],
      state: 'open',
    });
  });

  it('issueToTicket handles array-of-strings labels and missing body/assignees', () => {
    const t = issueToTicket({
      number: 1,
      id: 2,
      node_id: 'N',
      title: 'T',
      labels: ['x', 'y'],
    });
    assert.deepStrictEqual(t.labels, ['x', 'y']);
    assert.strictEqual(t.body, '');
    assert.deepStrictEqual(t.assignees, []);
  });

  it('issueToTicket returns empty labels for missing labels field', () => {
    const t = issueToTicket({ number: 1, id: 2, node_id: 'N', title: 'T' });
    assert.deepStrictEqual(t.labels, []);
    assert.ok(t.labelSet instanceof Set);
    assert.strictEqual(t.labelSet.size, 0);
  });

  it('issueToEpic returns the raw body without linked-issue parsing (legacy Planning Artifacts lines are inert)', () => {
    // Story #4324 retired the context-ticket classes: the Epic body is the
    // single planning document, so a historical `## Planning Artifacts`
    // list (PRD / Tech Spec issue refs) is carried verbatim in `body` and
    // no `linkedIssues` slot is derived from it.
    const legacyBody =
      '## Planning Artifacts\n- [ ] PRD: #200\n- [ ] Tech Spec: #201\n';
    const epic = issueToEpic({
      number: 100,
      id: 9999,
      node_id: 'EPIC_NODE',
      title: 'Epic title',
      body: legacyBody,
      labels: [{ name: 'type::story' }],
    });
    assert.strictEqual(epic.id, 100);
    assert.strictEqual(epic.title, 'Epic title');
    assert.strictEqual(epic.body, legacyBody);
    assert.strictEqual(Object.hasOwn(epic, 'linkedIssues'), false);
  });

  it('issueToEpic does not attach linkedIssues for a plain body either', () => {
    const epic = issueToEpic({
      number: 1,
      id: 1,
      node_id: 'N',
      title: 'plain',
      body: '',
      labels: [],
    });
    assert.strictEqual(epic.body, '');
    assert.strictEqual(Object.hasOwn(epic, 'linkedIssues'), false);
  });

  it('issueToListItem mirrors issueToTicket without assignees', () => {
    const li = issueToListItem({
      number: 7,
      id: 70,
      node_id: 'NL_7',
      title: 'list',
      body: '',
      labels: [{ name: 'a' }],
      state: 'open',
    });
    assert.strictEqual(li.id, 7);
    assert.strictEqual(li.state, 'open');
    assert.strictEqual(Object.hasOwn(li, 'assignees'), false);
  });
});

describe('providers/github/mappers.js — GraphQL payload shapes', () => {
  it('subIssueNodeToTicket maps a sub-issue node with `labels.nodes`', () => {
    const node = {
      number: 200,
      databaseId: 5050,
      id: 'GQL_NODE',
      title: 'Child',
      body: 'child body',
      state: 'OPEN',
      labels: {
        nodes: [{ name: 'type::task' }, { name: 'meta::framework-gap' }],
      },
      assignees: { nodes: [{ login: 'carol' }] },
    };
    const t = subIssueNodeToTicket(node);
    assert.deepStrictEqual(t, {
      id: 200,
      internalId: 5050,
      nodeId: 'GQL_NODE',
      title: 'Child',
      body: 'child body',
      labels: ['type::task', 'meta::framework-gap'],
      labelSet: new Set(['type::task', 'meta::framework-gap']),
      assignees: ['carol'],
      state: 'open',
    });
  });

  it('subIssueNodeToTicket leaves non-string state untouched', () => {
    const t = subIssueNodeToTicket({
      number: 1,
      databaseId: 1,
      id: 'N',
      title: 'x',
      state: undefined,
    });
    assert.strictEqual(t.state, undefined);
  });

  it('subIssueNodeToTicket handles missing assignees.nodes', () => {
    const t = subIssueNodeToTicket({
      number: 1,
      databaseId: 1,
      id: 'N',
      title: 'x',
      state: 'OPEN',
    });
    assert.deepStrictEqual(t.assignees, []);
  });
});

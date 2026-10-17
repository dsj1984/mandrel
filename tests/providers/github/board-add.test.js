/**
 * Unit tests for `.agents/scripts/providers/github/board-add.js`.
 *
 * Story #3822 — the shared "add issue to the Projects V2 board" helper
 * is the single source of truth for the post-create board-add step used
 * by `createTicket` and `createIssue`. The contract under test:
 *
 *   - adds the issue (calls the `addItemToProject` hook with the
 *     `node_id`) when a project number resolves;
 *   - no-ops cleanly when no project number resolves, when the hook is
 *     absent, or when there is no `node_id`;
 *   - never throws — a failing hook warns and returns
 *     `{ added: false, reason: 'error' }`.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');

const { classify } = await import(
  pathToFileURL(path.join(ROOT, '.agents', 'scripts', 'lib', 'gh-exec.js')).href
);
const { Logger } = await import(
  pathToFileURL(path.join(ROOT, '.agents', 'scripts', 'lib', 'Logger.js')).href
);
const { resetBoardAccessLatch } = await import(
  pathToFileURL(
    path.join(
      ROOT,
      '.agents',
      'scripts',
      'lib',
      'orchestration',
      'board-access-latch.js',
    ),
  ).href
);

const { addIssueToBoard } = await import(
  pathToFileURL(
    path.join(
      ROOT,
      '.agents',
      'scripts',
      'providers',
      'github',
      'board-add.js',
    ),
  ).href
);

describe('providers/github/board-add.js — addIssueToBoard', () => {
  it('adds the issue to the board when a project number resolves', async () => {
    const calls = [];
    const out = await addIssueToBoard({
      nodeId: 'node_42',
      issueNumber: 42,
      getProjectNumber: () => 1,
      addItemToProject: async (nodeId) => {
        calls.push(nodeId);
      },
    });
    assert.deepEqual(out, { added: true });
    assert.deepEqual(calls, ['node_42']);
  });

  it('no-ops without touching the hook when no project number resolves', async () => {
    const calls = [];
    const out = await addIssueToBoard({
      nodeId: 'node_42',
      issueNumber: 42,
      getProjectNumber: () => null,
      addItemToProject: async (nodeId) => {
        calls.push(nodeId);
      },
    });
    assert.deepEqual(out, { added: false, reason: 'no-project-number' });
    assert.deepEqual(calls, []);
  });

  it('no-ops when the getProjectNumber hook is absent', async () => {
    const calls = [];
    const out = await addIssueToBoard({
      nodeId: 'node_42',
      addItemToProject: async (nodeId) => {
        calls.push(nodeId);
      },
    });
    assert.deepEqual(out, { added: false, reason: 'no-project-number' });
    assert.deepEqual(calls, []);
  });

  it('no-ops when the addItemToProject hook is absent', async () => {
    const out = await addIssueToBoard({
      nodeId: 'node_42',
      getProjectNumber: () => 1,
    });
    assert.deepEqual(out, { added: false, reason: 'no-add-hook' });
  });

  it('no-ops when the issue has no node_id', async () => {
    const calls = [];
    const out = await addIssueToBoard({
      nodeId: null,
      getProjectNumber: () => 1,
      addItemToProject: async (nodeId) => {
        calls.push(nodeId);
      },
    });
    assert.deepEqual(out, { added: false, reason: 'no-node-id' });
    assert.deepEqual(calls, []);
  });

  it('is non-fatal: a failing hook returns reason "error" instead of throwing', async () => {
    const out = await addIssueToBoard({
      nodeId: 'node_42',
      issueNumber: 42,
      getProjectNumber: () => 1,
      addItemToProject: async () => {
        throw new Error('board unavailable');
      },
    });
    assert.deepEqual(out, { added: false, reason: 'error' });
  });

  it('reports insufficient-scope (never throws) for a scope-shaped add failure', async () => {
    const out = await addIssueToBoard({
      nodeId: 'node_42',
      issueNumber: 42,
      getProjectNumber: () => 1,
      addItemToProject: async () => {
        throw new Error(
          'GraphQL errors: [{"type":"INSUFFICIENT_SCOPES","message":"Your token has not been granted the required scopes to execute this query."}]',
        );
      },
    });
    assert.deepEqual(out, {
      added: false,
      reason: 'insufficient-scope',
      scope: 'project',
    });
  });

  it('reports insufficient-scope and warns once per logger for a gh-exec scope refusal', async (t) => {
    resetBoardAccessLatch();
    const warned = [];
    t.mock.method(Logger, 'warn', (m) => warned.push(String(m)));
    const ghErr = classify({
      args: ['api', 'graphql'],
      stdout: '',
      stderr:
        'gh: Your token has not been granted the required scopes to execute this query. (INSUFFICIENT_SCOPES)\n',
      code: 1,
    });
    const add = (n) =>
      addIssueToBoard({
        nodeId: `node_${n}`,
        issueNumber: n,
        getProjectNumber: () => 1,
        addItemToProject: async () => {
          throw ghErr;
        },
      });
    const outs = [await add(1), await add(2), await add(3)];
    for (const out of outs) {
      assert.deepEqual(out, {
        added: false,
        reason: 'insufficient-scope',
        scope: 'project',
      });
    }
    assert.equal(warned.length, 1, warned.join('\n'));
    assert.match(warned[0], /"project" scope/);
    // A reset re-arms the latch for the logger that already warned.
    resetBoardAccessLatch();
    await add(4);
    assert.equal(warned.length, 2);
  });
});

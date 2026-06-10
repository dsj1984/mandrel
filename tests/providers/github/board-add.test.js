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
});

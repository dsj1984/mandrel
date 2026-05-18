/**
 * Unit tests for `.agents/scripts/providers/github/prs.js`.
 *
 * Covers PR create + view + post-add-to-project hook flow. Uses a fake
 * gh-exec facade that routes on `gh.pr.create` and `gh.pr.view` shapes.
 *
 * Story #2462 / Task #2479 — PullRequestGateway is the sixth slice of
 * the seven-gateway split.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');

const prsMod = await import(
  pathToFileURL(
    path.join(ROOT, '.agents', 'scripts', 'providers', 'github', 'prs.js'),
  ).href
);

const { PullRequestGateway } = prsMod;

function makeFakeGh({ createOut, viewOut } = {}) {
  const calls = { create: [], view: [] };
  return {
    pr: {
      create: async (args) => {
        calls.create.push(args);
        return { stdout: createOut ?? 'https://example/pr/1\n', stderr: '' };
      },
      view: async (url, fields) => {
        calls.view.push({ url, fields });
        return { stdout: viewOut ?? '{}', stderr: '' };
      },
    },
    __calls: calls,
  };
}

describe('providers/github/prs.js — PullRequestGateway', () => {
  it('createPullRequest: invokes gh pr create + pr view and returns the canonical envelope', async () => {
    const gh = makeFakeGh({
      createOut: 'https://example/pr/77\n',
      viewOut: JSON.stringify({ number: 77, url: 'api/77', id: 'pr_node_77' }),
    });
    const gateway = new PullRequestGateway({
      gh,
      hooks: {
        getTicket: async (id) => ({ id, title: `Ticket ${id}` }),
      },
    });
    const out = await gateway.createPullRequest('feature-x', 42);
    assert.equal(out.number, 77);
    assert.equal(out.htmlUrl, 'https://example/pr/77');
    assert.equal(out.nodeId, 'pr_node_77');
    assert.equal(out.url, 'api/77');
    // The create argv carried the ticket title and the canonical link footer.
    const createArgs = gh.__calls.create[0];
    assert.ok(createArgs.includes('--title'));
    assert.ok(createArgs.includes('Ticket 42'));
    assert.ok(createArgs.includes('Closes #42'));
  });

  it('createPullRequest: calls addItemToProject when projectNumber is configured', async () => {
    const gh = makeFakeGh({
      createOut: 'https://example/pr/9\n',
      viewOut: JSON.stringify({ number: 9, url: 'api/9', id: 'node_pr_9' }),
    });
    const projectCalls = [];
    const gateway = new PullRequestGateway({
      gh,
      hooks: {
        getTicket: async (id) => ({ id, title: 't' }),
        getProjectNumber: () => 7,
        addItemToProject: async (nodeId) => projectCalls.push(nodeId),
      },
    });
    await gateway.createPullRequest('br', 9);
    assert.deepEqual(projectCalls, ['node_pr_9']);
  });

  it('createPullRequest: warns but does not throw when addItemToProject fails', async () => {
    const gh = makeFakeGh({
      createOut: 'https://example/pr/9\n',
      viewOut: JSON.stringify({ number: 9, url: 'api/9', id: 'node_pr_9' }),
    });
    const gateway = new PullRequestGateway({
      gh,
      hooks: {
        getTicket: async (id) => ({ id, title: 't' }),
        getProjectNumber: () => 1,
        addItemToProject: async () => {
          throw new Error('project unreachable');
        },
      },
    });
    const out = await gateway.createPullRequest('br', 9);
    // The PR still resolves cleanly even when project add throws.
    assert.equal(out.number, 9);
  });

  it('createPullRequest: skips the project hook when projectNumber is null', async () => {
    const gh = makeFakeGh({
      createOut: 'https://example/pr/9\n',
      viewOut: JSON.stringify({ number: 9, url: 'api/9', id: 'node_pr_9' }),
    });
    const calls = [];
    const gateway = new PullRequestGateway({
      gh,
      hooks: {
        getTicket: async () => ({ id: 9, title: 't' }),
        getProjectNumber: () => null,
        addItemToProject: async (nodeId) => calls.push(nodeId),
      },
    });
    await gateway.createPullRequest('br', 9);
    assert.deepEqual(calls, []);
  });
});

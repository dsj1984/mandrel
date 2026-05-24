/**
 * Contract test for `.agents/scripts/lib/orchestration/pr-base-guard.js`
 * and its wiring into `PullRequestGateway.createPullRequest`.
 *
 * Story #2960 — refuse PR creation against `main` when the Story body
 * declares an `Epic: #N` parent. The framework's `createPullRequest`
 * gateway MUST throw the documented error rather than shell out to
 * `gh pr create --base main`.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');

const guardMod = await import(
  pathToFileURL(
    path.join(
      ROOT,
      '.agents',
      'scripts',
      'lib',
      'orchestration',
      'pr-base-guard.js',
    ),
  ).href
);

const prsMod = await import(
  pathToFileURL(
    path.join(ROOT, '.agents', 'scripts', 'providers', 'github', 'prs.js'),
  ).href
);

const { assertStoryPrBaseAllowed } = guardMod;
const { PullRequestGateway } = prsMod;

function makeFakeGh() {
  const calls = { create: [], view: [] };
  return {
    pr: {
      create: async (args) => {
        calls.create.push(args);
        return { stdout: 'https://example/pr/999\n', stderr: '' };
      },
      view: async (url, fields) => {
        calls.view.push({ url, fields });
        return {
          stdout: JSON.stringify({ number: 999, url: 'api/999', id: 'node' }),
          stderr: '',
        };
      },
    },
    __calls: calls,
  };
}

describe('orchestration/pr-base-guard — assertStoryPrBaseAllowed', () => {
  it('is a no-op when the Story body has no Epic parent reference', () => {
    assert.doesNotThrow(() =>
      assertStoryPrBaseAllowed({
        storyId: 100,
        storyBody: 'A standalone Story.\n\nNo parent here.',
        baseBranch: 'main',
      }),
    );
  });

  it('is a no-op when the body is empty / falsy', () => {
    assert.doesNotThrow(() =>
      assertStoryPrBaseAllowed({
        storyId: 100,
        storyBody: null,
        baseBranch: 'main',
      }),
    );
    assert.doesNotThrow(() =>
      assertStoryPrBaseAllowed({
        storyId: 100,
        storyBody: '',
        baseBranch: 'main',
      }),
    );
  });

  it('allows base = epic/<N> when body declares Epic: #N', () => {
    assert.doesNotThrow(() =>
      assertStoryPrBaseAllowed({
        storyId: 2945,
        storyBody: '## Context\n\nEpic: #2880\n\nDetails…',
        baseBranch: 'epic/2880',
      }),
    );
  });

  it('refuses base = main when body declares Epic: #N', () => {
    assert.throws(
      () =>
        assertStoryPrBaseAllowed({
          storyId: 2945,
          storyBody: 'Epic: #2880\n',
          baseBranch: 'main',
        }),
      (err) => {
        assert.match(
          err.message,
          /Story #2945 is parented by Epic #2880 — merge into epic\/2880, not main\./,
        );
        assert.match(err.message, /\/single-story-deliver/);
        return true;
      },
    );
  });

  it('refuses any non-matching epic/<M> base (cross-Epic guard)', () => {
    assert.throws(
      () =>
        assertStoryPrBaseAllowed({
          storyId: 2945,
          storyBody: 'Epic: #2880\n',
          baseBranch: 'epic/9999',
        }),
      /merge into epic\/2880, not epic\/9999/,
    );
  });

  it('also recognises a `Parent: #N` reference (alias)', () => {
    assert.throws(
      () =>
        assertStoryPrBaseAllowed({
          storyId: 7,
          storyBody: 'Parent: #42\nEpic: #100\n',
          baseBranch: 'main',
        }),
      /Story #7 is parented by Epic #100/,
    );
  });
});

describe('providers/github/prs.js — PullRequestGateway base-guard wiring', () => {
  it('refuses `gh pr create --base main` for a Story whose body has Epic: #N', async () => {
    const gh = makeFakeGh();
    const gateway = new PullRequestGateway({
      gh,
      hooks: {
        getTicket: async (id) => ({
          id,
          title: `Story ${id}`,
          body: '## Context\n\nEpic: #2880\n\nWork details.',
        }),
      },
    });

    await assert.rejects(
      gateway.createPullRequest('story-2945', 2945, 'main'),
      (err) => {
        assert.match(
          err.message,
          /Story #2945 is parented by Epic #2880 — merge into epic\/2880, not main\./,
        );
        return true;
      },
    );

    // The guard fires BEFORE the gh shell, so no PR was ever opened.
    assert.equal(
      gh.__calls.create.length,
      0,
      'gh pr create must not be invoked when the guard fires',
    );
  });

  it('permits PR creation when base = epic/<N> matches the parent', async () => {
    const gh = makeFakeGh();
    const gateway = new PullRequestGateway({
      gh,
      hooks: {
        getTicket: async (id) => ({
          id,
          title: `Story ${id}`,
          body: 'Epic: #2880',
        }),
      },
    });
    const out = await gateway.createPullRequest(
      'story-2945',
      2945,
      'epic/2880',
    );
    assert.equal(out.number, 999);
    assert.equal(gh.__calls.create.length, 1);
    const args = gh.__calls.create[0];
    const baseIdx = args.indexOf('--base');
    assert.equal(args[baseIdx + 1], 'epic/2880');
  });

  it('permits PR creation against main for a standalone Story (no Epic parent)', async () => {
    const gh = makeFakeGh();
    const gateway = new PullRequestGateway({
      gh,
      hooks: {
        getTicket: async (id) => ({
          id,
          title: `Standalone Story ${id}`,
          body: 'A standalone refactor with no parent.',
        }),
      },
    });
    const out = await gateway.createPullRequest('story-9000', 9000, 'main');
    assert.equal(out.number, 999);
    assert.equal(gh.__calls.create.length, 1);
  });
});

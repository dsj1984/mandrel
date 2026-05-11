/**
 * Provider Factory Tests
 *
 * Tests the factory function that resolves orchestration.provider
 * to a concrete ITicketingProvider class.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const LIB = path.join(ROOT, '.agents', 'scripts', 'lib');

// Dynamic import to handle Windows paths
const { createProvider } = await import(
  pathToFileURL(path.join(LIB, 'provider-factory.js')).href
);
const { ITicketingProvider } = await import(
  pathToFileURL(path.join(LIB, 'ITicketingProvider.js')).href
);
const { createGh } = await import(
  pathToFileURL(path.join(LIB, 'gh-exec.js')).href
);

// ---------------------------------------------------------------------------
// Factory resolution
// ---------------------------------------------------------------------------
describe('createProvider — factory resolution', () => {
  it('returns a GitHubProvider for provider: "github"', () => {
    const orchestration = {
      provider: 'github',
      github: {
        owner: 'test-owner',
        repo: 'test-repo',
        projectNumber: null,
        operatorHandle: '@test',
      },
    };

    const provider = createProvider(orchestration, { token: 'test-token' });
    assert.ok(provider instanceof ITicketingProvider);
    assert.equal(provider.owner, 'test-owner');
    assert.equal(provider.repo, 'test-repo');
  });

  it('throws when orchestration is null', () => {
    assert.throws(
      () => createProvider(null),
      /orchestration is not configured/,
    );
  });

  it('throws when orchestration is undefined', () => {
    assert.throws(
      () => createProvider(undefined),
      /orchestration is not configured/,
    );
  });

  it('throws when provider is missing', () => {
    assert.throws(
      () => createProvider({ github: {} }),
      /orchestration\.provider is required/,
    );
  });

  it('throws for unsupported provider', () => {
    assert.throws(
      () => createProvider({ provider: 'jira' }),
      /Unsupported provider "jira"/,
    );
  });

  it('includes supported providers in error message', () => {
    try {
      createProvider({ provider: 'linear' });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(err.message.includes('github'));
    }
  });

  it('throws when provider-specific config block is missing', () => {
    assert.throws(
      () => createProvider({ provider: 'github' }),
      /orchestration\.github config block is required/,
    );
  });
});

// ---------------------------------------------------------------------------
// gh-exec routing (Task #1377)
//
// The factory is the only resolution path — there is no migration flag, no
// parallel export. Verify that the instance it returns is actually backed by
// the rewritten gh-exec surface by intercepting the exec boundary and
// asserting that method bodies (getTicket, postComment) translate to
// `gh api -X <METHOD> /repos/.../issues/...` argv shapes. If a future change
// re-introduces a parallel transport (e.g. an octokit/fetch HTTP client),
// these assertions will catch it because the fake exec would never be called.
// ---------------------------------------------------------------------------
describe('createProvider — gh-exec routing', () => {
  function fakeGh(routes) {
    const calls = [];
    const exec = async ({ args, input }) => {
      calls.push({ args, input });
      if (args[0] !== 'api') {
        throw new Error(`[fakeGh] unexpected non-api argv: ${args.join(' ')}`);
      }
      const method = args[2] ?? 'GET';
      const endpoint = args[3] ?? '';
      for (const [key, value] of Object.entries(routes)) {
        const [routeMethod, routeFragment] = key.split(' ');
        if (method === routeMethod && endpoint.includes(routeFragment)) {
          return { stdout: JSON.stringify(value), stderr: '', code: 0 };
        }
      }
      throw new Error(`[fakeGh] no route for ${method} ${endpoint}`);
    };
    return { gh: createGh(exec), calls };
  }

  it('returns an instance whose getTicket routes through gh-exec', async () => {
    const { gh, calls } = fakeGh({
      'GET /repos/test-owner/test-repo/issues/42': {
        number: 42,
        id: 4242,
        node_id: 'I_node42',
        title: 'Routed via gh-exec',
        body: '',
        labels: [],
        assignees: [],
        state: 'open',
      },
    });

    const provider = createProvider(
      {
        provider: 'github',
        github: {
          owner: 'test-owner',
          repo: 'test-repo',
          projectNumber: null,
          operatorHandle: '@test',
        },
      },
      { gh },
    );

    const ticket = await provider.getTicket(42);

    assert.equal(ticket.id, 42);
    assert.equal(ticket.title, 'Routed via gh-exec');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, [
      'api',
      '-X',
      'GET',
      '/repos/test-owner/test-repo/issues/42',
    ]);
  });

  it('returns an instance whose postComment routes through gh-exec', async () => {
    const { gh, calls } = fakeGh({
      'POST /repos/test-owner/test-repo/issues/42/comments': {
        id: 999,
        body: 'ok',
      },
    });

    const provider = createProvider(
      {
        provider: 'github',
        github: {
          owner: 'test-owner',
          repo: 'test-repo',
          projectNumber: null,
          operatorHandle: '@test',
        },
      },
      { gh },
    );

    const result = await provider.postComment(42, {
      type: 'progress',
      body: 'hello',
    });

    assert.equal(result.commentId, 999);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args[0], 'api');
    assert.equal(calls[0].args[2], 'POST');
    assert.equal(
      calls[0].args[3],
      '/repos/test-owner/test-repo/issues/42/comments',
    );
    // Body should carry the visible progress badge.
    const body = JSON.parse(calls[0].input);
    assert.match(body.body, /Progress/);
    assert.match(body.body, /hello/);
  });

  it('exposes the projects-v2-graphql shim via resolveOrCreateProject', () => {
    const provider = createProvider({
      provider: 'github',
      github: {
        owner: 'test-owner',
        repo: 'test-repo',
        projectNumber: null,
        operatorHandle: '@test',
      },
    });
    // Method must exist (sourced from projects-v2-graphql shim).
    assert.equal(typeof provider.resolveOrCreateProject, 'function');
    assert.equal(typeof provider.ensureStatusField, 'function');
    assert.equal(typeof provider.ensureProjectViews, 'function');
    assert.equal(typeof provider.ensureProjectFields, 'function');
  });
});

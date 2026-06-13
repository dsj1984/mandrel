/**
 * GitHubProvider facade — pull requests surface.
 *
 * Tests GitHubProvider.createPullRequest() with a mocked gh-exec facade — no
 * live API calls. Split from the former root monolith
 * `tests/providers-github.test.js` (Story #4084).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createTestProvider, makeGh } from './_helpers.js';

// ---------------------------------------------------------------------------
// createPullRequest
// ---------------------------------------------------------------------------
describe('GitHubProvider — createPullRequest()', () => {
  it('creates PR with Closes reference via gh pr create', async () => {
    // Story #1359 (Task #1371) rewrites this on `gh.pr.create` + a follow-
    // up `gh.pr.view` to harvest the {number, url, id} envelope. The
    // issue read (`getTicket`) is the same gh.api path Story #1357 landed.
    const gh = makeGh({
      'GET /issues/42': {
        status: 200,
        json: {
          number: 42,
          title: 'Fix the thing',
          body: '',
          labels: [],
          assignees: [],
          state: 'open',
        },
      },
      'pr create': {
        status: 200,
        // `gh pr create` emits the html_url on stdout (plain text, not JSON).
        stdout: 'https://github.com/test-owner/test-repo/pull/15\n',
      },
      'pr view': {
        status: 200,
        json: {
          number: 15,
          url: 'https://api.github.com/repos/test-owner/test-repo/pulls/15',
          id: 'PR_node_15',
        },
      },
    });

    const provider = createTestProvider({ gh });
    const result = await provider.createPullRequest('feature/fix-42', 42);

    assert.equal(result.number, 15);
    assert.ok(result.htmlUrl.includes('/pull/15'));
    assert.equal(result.nodeId, 'PR_node_15');

    const prCreate = gh.__exec.calls.find(
      (c) => c.args[0] === 'pr' && c.args[1] === 'create',
    );
    assert.ok(prCreate, 'expected `gh pr create` to fire');
    // The argv carries --title/--body/--base/--head explicitly so the
    // `Closes #N` body reaches the API without shell interpolation.
    assert.deepEqual(prCreate.args, [
      'pr',
      'create',
      '--title',
      'Fix the thing',
      '--body',
      'Closes #42',
      '--base',
      'main',
      '--head',
      'feature/fix-42',
    ]);

    // `gh pr view` is invoked against the URL the create call returned,
    // with --json number,url,id.
    const prView = gh.__exec.calls.find(
      (c) => c.args[0] === 'pr' && c.args[1] === 'view',
    );
    assert.ok(prView, 'expected follow-up `gh pr view` to fire');
    assert.equal(
      prView.args[2],
      'https://github.com/test-owner/test-repo/pull/15',
    );
    assert.ok(prView.args.includes('--json'));
    assert.ok(prView.args.includes('number,url,id'));
  });
});

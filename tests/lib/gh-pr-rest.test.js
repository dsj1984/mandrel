/**
 * tests/lib/gh-pr-rest.test.js — the REST `pr` facade (Story #5793): the
 * `gh pr` surface over repo-scoped REST for a session whose GitHub proxy
 * refuses GraphQL, plus the REST readers built on it (required checks, the
 * merge-queue probe).
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  createGh,
  GhExecError,
  GhNotFoundError,
  setGraphqlAvailability,
} from '../../.agents/scripts/lib/gh-exec.js';
import {
  createRestPr,
  parseApiJson,
  REST_MERGE_ON_GREEN,
  readBranchRules,
} from '../../.agents/scripts/lib/gh-pr-rest.js';
import { readMergeQueueState } from '../../.agents/scripts/lib/orchestration/merge-queue.js';
import { readProbeRunEvidence } from '../../.agents/scripts/lib/orchestration/required-checks.js';

const PULL = Object.freeze({
  number: 7,
  html_url: 'https://github.com/o/r/pull/7',
  title: 'feat: x',
  state: 'open',
  merged: false,
  merged_at: null,
  created_at: '2026-10-20T00:00:00Z',
  node_id: 'PR_node7',
  draft: false,
  mergeable_state: 'clean',
  auto_merge: null,
  head: { sha: 'abc1234', ref: 'story-7', repo: { full_name: 'o/r' } },
  base: { ref: 'main', repo: { full_name: 'o/r' } },
});

/**
 * A recording `api` answering by `METHOD endpoint`; a function answer is
 * called with the request, an Error answer is thrown.
 */
function recordingApi(routes) {
  const calls = [];
  const api = async (req) => {
    calls.push(req);
    const key = `${req.method} ${req.endpoint}`;
    if (!Object.hasOwn(routes, key)) throw new Error(`unrouted: ${key}`);
    const answer = routes[key];
    const value = typeof answer === 'function' ? answer(req) : answer;
    if (value instanceof Error) throw value;
    return { stdout: value === undefined ? '' : JSON.stringify(value) };
  };
  return { api, calls };
}

const PULL_ROUTE = 'GET repos/{owner}/{repo}/pulls/7';
const RUNS_ROUTE =
  'GET repos/{owner}/{repo}/commits/abc1234/check-runs?per_page=100';
const STATUS_ROUTE = 'GET repos/{owner}/{repo}/commits/abc1234/status';

function rest(routes) {
  const rec = recordingApi(routes);
  return { pr: createRestPr({ api: rec.api, GhExecError }), calls: rec.calls };
}

function refused(stderr) {
  return new GhExecError('gh-exec: gh exited with code 1', {
    args: [],
    stderr,
    code: 1,
  });
}

describe('createRestPr — view', () => {
  it('maps the requested fields to gh camelCase rows', async () => {
    const { pr } = rest({ [PULL_ROUTE]: PULL });
    const row = await pr.view(7, [
      'number',
      'url',
      'state',
      'mergedAt',
      'createdAt',
      'id',
      'headRefOid',
      'mergeStateStatus',
      'autoMergeRequest',
      'reviewDecision',
    ]);
    assert.deepEqual(row, {
      number: 7,
      url: PULL.html_url,
      state: 'OPEN',
      mergedAt: null,
      createdAt: PULL.created_at,
      id: 'PR_node7',
      headRefOid: 'abc1234',
      mergeStateStatus: 'CLEAN',
      autoMergeRequest: null,
      reviewDecision: null,
    });
  });

  it('reads MERGED from `merged`, upper-cases every mergeable_state, and maps auto_merge', async () => {
    for (const [mergeable, expected] of [
      ['behind', 'BEHIND'],
      ['dirty', 'DIRTY'],
      ['blocked', 'BLOCKED'],
      ['unstable', 'UNSTABLE'],
      [undefined, 'UNKNOWN'],
    ]) {
      const { pr } = rest({
        [PULL_ROUTE]: {
          ...PULL,
          merged: true,
          mergeable_state: mergeable,
          auto_merge: { merge_method: 'squash', enabled_by: { login: 'bot' } },
        },
      });
      const row = await pr.view('https://github.com/o/r/pull/7', [
        'state',
        'mergeStateStatus',
        'autoMergeRequest',
      ]);
      assert.equal(row.state, 'MERGED');
      assert.equal(row.mergeStateStatus, expected);
      assert.equal(row.autoMergeRequest.mergeMethod, 'SQUASH');
      assert.equal(row.autoMergeRequest.enabledAt, null);
    }
  });

  it('builds statusCheckRollup from check runs plus commit statuses', async () => {
    const { pr } = rest({
      [PULL_ROUTE]: PULL,
      [RUNS_ROUTE]: {
        check_runs: [
          {
            name: 'test',
            status: 'completed',
            conclusion: 'failure',
            details_url: 'https://github.com/o/r/actions/runs/99/job/1',
            completed_at: '2026-10-20T00:01:00Z',
          },
          { name: 'lint', status: 'in_progress', conclusion: null },
        ],
      },
      [STATUS_ROUTE]: {
        statuses: [{ context: 'ci/legacy', state: 'success' }],
      },
    });
    const { statusCheckRollup } = await pr.view('7', ['statusCheckRollup']);
    assert.deepEqual(
      statusCheckRollup.map((n) => [
        n.__typename,
        n.name ?? n.context,
        n.status ?? n.state,
        n.conclusion,
      ]),
      [
        ['CheckRun', 'test', 'COMPLETED', 'FAILURE'],
        ['CheckRun', 'lint', 'IN_PROGRESS', ''],
        ['StatusContext', 'ci/legacy', 'SUCCESS', undefined],
      ],
    );
    assert.equal(
      statusCheckRollup[0].detailsUrl,
      'https://github.com/o/r/actions/runs/99/job/1',
    );
  });

  it('throws naming an unmapped field, a missing field list, or a non-number ref', async () => {
    const { pr } = rest({ [PULL_ROUTE]: PULL });
    await assert.rejects(
      pr.view(7, ['commits']),
      /field commits has no REST mapping/,
    );
    await assert.rejects(pr.view(7, []), /needs --json fields/);
    await assert.rejects(
      pr.view('story-7', ['url']),
      /needs a PR number or URL/,
    );
  });
});

describe('createRestPr — list', () => {
  it('lists by head with the owner placeholder and maps rows', async () => {
    const { pr, calls } = rest({
      'GET repos/{owner}/{repo}/pulls?head={owner}:story-7&state=all': [PULL],
    });
    const rows = await pr.list(
      ['--head', 'story-7', '--state', 'all'],
      ['number', 'url', 'state', 'mergedAt'],
    );
    assert.deepEqual(rows, [
      { number: 7, url: PULL.html_url, state: 'OPEN', mergedAt: null },
    ]);
    assert.equal(calls.length, 1);
  });

  it('reads a merged row as MERGED and filters --state merged', async () => {
    const merged = {
      ...PULL,
      state: 'closed',
      merged_at: '2026-10-20T01:00:00Z',
    };
    const closed = { ...PULL, number: 8, state: 'closed' };
    const { pr } = rest({
      'GET repos/{owner}/{repo}/pulls?head={owner}:story-7&state=closed': [
        merged,
        closed,
      ],
    });
    const rows = await pr.list(
      ['--head', 'story-7', '--state', 'merged'],
      ['state'],
    );
    assert.deepEqual(rows, [{ state: 'MERGED' }]);
  });

  it('re-reads each row when a detail-only field is requested', async () => {
    const { pr, calls } = rest({
      'GET repos/{owner}/{repo}/pulls?base=main&state=open&per_page=5': [
        { number: 7 },
      ],
      [PULL_ROUTE]: PULL,
    });
    const rows = await pr.list(
      ['--base', 'main', '--limit', '5'],
      ['mergeStateStatus'],
    );
    assert.deepEqual(rows, [{ mergeStateStatus: 'CLEAN' }]);
    assert.equal(calls.at(-1).endpoint, 'repos/{owner}/{repo}/pulls/7');
  });

  it('throws naming a flag it does not map', async () => {
    const { pr } = rest({});
    await assert.rejects(
      pr.list(['--author', 'me'], ['url']),
      (err) => err instanceof GhExecError && /--author/.test(err.message),
    );
  });
});

describe('createRestPr — create / edit / updateBranch', () => {
  it('opens the PR with POST …/pulls and prints its URL like gh', async () => {
    const { pr, calls } = rest({
      'POST repos/{owner}/{repo}/pulls': PULL,
    });
    const out = await pr.create([
      '--base',
      'main',
      '--head',
      'story-7',
      '--title',
      'feat: x',
      '--body',
      'why',
    ]);
    assert.equal(out.stdout.trim(), PULL.html_url);
    assert.deepEqual(calls[0].body, {
      title: 'feat: x',
      head: 'story-7',
      base: 'main',
      body: 'why',
    });
  });

  it('edits title and body only, and updates a branch with PUT', async () => {
    const { pr, calls } = rest({
      'PATCH repos/{owner}/{repo}/pulls/7': PULL,
      'PUT repos/{owner}/{repo}/pulls/7/update-branch': {},
    });
    await pr.edit(7, ['--title', 'new']);
    assert.deepEqual(calls[0].body, { title: 'new' });
    await pr.updateBranch(7);
    assert.equal(calls[1].method, 'PUT');
    await assert.rejects(pr.edit(7, ['--add-label', 'x']), /--add-label/);
    await assert.rejects(pr.updateBranch(7, ['--rebase']), /--rebase/);
  });
});

describe('createRestPr — merge', () => {
  it('arms through the CCR auto-merge route', async () => {
    const { pr, calls } = rest({
      'PUT repos/{owner}/{repo}/pulls/7/ccr/auto_merge': {},
    });
    const out = await pr.merge(7, ['--auto', '--squash', '--delete-branch']);
    assert.equal(out.code, 0);
    assert.equal(out.mergeOnGreen, undefined);
    assert.deepEqual(calls[0].body, { merge_method: 'squash' });
  });

  it('resolves a CCR refusal to merge-on-green instead of throwing', async () => {
    const { pr } = rest({
      'PUT repos/{owner}/{repo}/pulls/7/ccr/auto_merge': refused(
        'gh: Not Found (HTTP 404)',
      ),
    });
    const out = await pr.merge(7, ['--auto', '--squash', '--delete-branch']);
    assert.equal(out.mergeOnGreen, true);
    assert.match(out.detail, /404/);
    assert.equal(REST_MERGE_ON_GREEN, 'rest-merge-on-green');
  });

  it('disarms with DELETE on the CCR route', async () => {
    const { pr, calls } = rest({
      'DELETE repos/{owner}/{repo}/pulls/7/ccr/auto_merge': undefined,
    });
    await pr.merge(7, ['--disable-auto']);
    assert.equal(calls[0].method, 'DELETE');
  });

  it('squash-merges pinned to the head SHA, then deletes the head ref', async () => {
    const { pr, calls } = rest({
      [PULL_ROUTE]: PULL,
      'PUT repos/{owner}/{repo}/pulls/7/merge': { merged: true, sha: 'm1' },
      'DELETE repos/{owner}/{repo}/git/refs/heads/story-7': refused(
        'gh: Reference does not exist (HTTP 422)',
      ),
    });
    const out = await pr.merge(7, [
      '--squash',
      '--delete-branch',
      '--match-head-commit',
      'pinned9',
    ]);
    assert.equal(out.merged, true);
    assert.deepEqual(calls[1].body, { merge_method: 'squash', sha: 'pinned9' });
    assert.equal(
      calls[2].method,
      'DELETE',
      'a failed ref delete is best-effort',
    );
  });

  it('defaults the pin to the head the PR reports, and leaves a fork head alone', async () => {
    const fork = {
      ...PULL,
      head: { ...PULL.head, repo: { full_name: 'someone/r' } },
    };
    const { pr, calls } = rest({
      [PULL_ROUTE]: fork,
      'PUT repos/{owner}/{repo}/pulls/7/merge': { merged: true },
    });
    await pr.merge(7, ['--squash', '--delete-branch']);
    assert.deepEqual(calls[1].body, { merge_method: 'squash', sha: 'abc1234' });
    assert.equal(calls.length, 2);
  });

  it('refuses a merge method and a flag it does not map', async () => {
    const { pr } = rest({});
    await assert.rejects(pr.merge(7, ['--rebase']), /--rebase/);
    await assert.rejects(pr.merge(7, []), /supports --squash only/);
  });
});

describe('createRestPr — endpoint discipline (AC-6)', () => {
  it('issues only repos/{owner}/{repo}/… endpoints across the whole surface', async () => {
    const seen = [];
    const api = async (req) => {
      seen.push(req.endpoint);
      if (req.endpoint.endsWith('/ccr/auto_merge') && req.method === 'PUT') {
        throw refused('HTTP 403');
      }
      if (req.endpoint.includes('/pulls?'))
        return { stdout: JSON.stringify([PULL]) };
      if (req.endpoint.endsWith('/check-runs?per_page=100')) {
        return { stdout: '{"check_runs":[]}' };
      }
      if (req.endpoint.endsWith('/status'))
        return { stdout: '{"statuses":[]}' };
      return { stdout: JSON.stringify(PULL) };
    };
    const pr = createRestPr({ api, GhExecError });
    await pr.view(7, ['statusCheckRollup', 'url']);
    await pr.list(
      ['--head', 'story-7', '--state', 'all'],
      ['mergeStateStatus'],
    );
    await pr.create([
      '--base',
      'main',
      '--head',
      'story-7',
      '--title',
      't',
      '--body',
      'b',
    ]);
    await pr.edit(7, ['--body', 'b']);
    await pr.merge(7, ['--auto', '--squash']);
    await pr.merge(7, ['--disable-auto']);
    await pr.merge(7, ['--squash', '--delete-branch']);
    await pr.updateBranch(7);
    assert.ok(seen.length > 8);
    for (const endpoint of seen) {
      assert.ok(
        endpoint.startsWith('repos/{owner}/{repo}/'),
        `non-repo-scoped endpoint: ${endpoint}`,
      );
      assert.doesNotMatch(endpoint, /graphql|search\//);
    }
  });
});

describe('parseApiJson / readBranchRules', () => {
  it('parses stdout, passes parsed values through, and reads an empty body as null', () => {
    assert.deepEqual(parseApiJson({ stdout: '[1]' }), [1]);
    assert.deepEqual(parseApiJson([2]), [2]);
    assert.equal(parseApiJson({ stdout: '  ' }), null);
    assert.deepEqual(parseApiJson('{"a":1}'), { a: 1 });
  });

  it('reads the base rulesets, and a non-array answer as none', async () => {
    const { api, calls } = recordingApi({
      'GET repos/{owner}/{repo}/rules/branches/release/1': [
        { type: 'merge_queue' },
      ],
      'GET repos/{owner}/{repo}/rules/branches/main': { message: 'odd' },
    });
    assert.deepEqual(
      await readBranchRules({ api, base: 'release/1', timeoutMs: 5 }),
      [{ type: 'merge_queue' }],
    );
    assert.deepEqual(calls[0].execOpts, { timeoutMs: 5 });
    assert.deepEqual(await readBranchRules({ api, base: 'main' }), []);
  });
});

/** A `createGh` facade over a recording exec that answers REST routes. */
function restFacade(routes) {
  const argvs = [];
  const exec = async ({ args, input }) => {
    argvs.push(args);
    const [, , method, endpoint] = args;
    const key = `${method} ${endpoint}`;
    if (!Object.hasOwn(routes, key)) throw new Error(`unrouted: ${key}`);
    const value = routes[key];
    if (value instanceof Error) throw value;
    void input;
    return { stdout: JSON.stringify(value), stderr: '', code: 0 };
  };
  return { gh: createGh(exec), argvs };
}

describe('REST readers built on the facade', () => {
  afterEach(() => setGraphqlAvailability(null));

  it('readMergeQueueState reads a merge_queue rule on the base over REST', async () => {
    setGraphqlAvailability({ verdict: 'unavailable' });
    const { gh, argvs } = restFacade({
      [PULL_ROUTE]: PULL,
      'GET repos/{owner}/{repo}/rules/branches/main': [{ type: 'merge_queue' }],
    });
    const state = await readMergeQueueState({ prNumber: 7, gh });
    assert.deepEqual(state, {
      queueRequired: true,
      inQueue: null,
      prNodeId: 'PR_node7',
    });
    assert.ok(argvs.every((a) => a[0] === 'api' && a[3] !== 'graphql'));
  });

  it('readMergeQueueState reports an error, not a guess, with no PR number', async () => {
    setGraphqlAvailability({ verdict: 'unavailable' });
    const { gh } = restFacade({});
    const state = await readMergeQueueState({ prNodeId: 'PR_x', gh });
    assert.equal(state.queueRequired, null);
    assert.match(state.error, /PR number unavailable/);
  });

  it('required checks over REST union rulesets with classic protection', async () => {
    setGraphqlAvailability({ verdict: 'unavailable' });
    const { gh } = restFacade({
      [PULL_ROUTE]: PULL,
      'GET repos/{owner}/{repo}/rules/branches/main': [
        {
          type: 'required_status_checks',
          parameters: { required_status_checks: [{ context: 'test' }] },
        },
        { type: 'deletion' },
      ],
      'GET repos/{owner}/{repo}/branches/main/protection/required_status_checks':
        { contexts: ['lint'], checks: [{ context: 'lint' }] },
    });
    const evidence = await readProbeRunEvidence({
      view: {
        id: 'PR_rest1',
        headRefOid: 'h1',
        mergeStateStatus: 'BLOCKED',
        statusCheckRollup: [
          { name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' },
          { name: 'advisory', status: 'COMPLETED', conclusion: 'FAILURE' },
        ],
      },
      checksStatus: 'failure',
      prNumber: 7,
      gh,
    });
    assert.equal(evidence.attribution, 'github');
    assert.equal(evidence.requiredRunFailed, true);
  });

  it('required checks over REST read no classic protection (404) as none', async () => {
    setGraphqlAvailability({ verdict: 'unavailable' });
    const { gh } = restFacade({
      [PULL_ROUTE]: PULL,
      'GET repos/{owner}/{repo}/rules/branches/main': [],
      'GET repos/{owner}/{repo}/branches/main/protection/required_status_checks':
        new GhNotFoundError('gh-exec: resource not found', { args: [] }),
    });
    const evidence = await readProbeRunEvidence({
      view: {
        id: 'PR_rest2',
        headRefOid: 'h2',
        mergeStateStatus: 'BLOCKED',
        statusCheckRollup: [
          { name: 'advisory', status: 'COMPLETED', conclusion: 'FAILURE' },
        ],
      },
      checksStatus: 'failure',
      prNumber: 7,
      gh,
    });
    assert.equal(evidence.attribution, 'github');
    assert.equal(evidence.requiredRunFailed, false, 'nothing is required');
  });
});

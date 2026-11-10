/**
 * orchestrate-inventory — the classifier over fixture snapshots, the bounded
 * reads over a fake `gh`, the sweep diff, and the `delivery.orchestrate`
 * config block.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { getAgentrcValidator } from '../.agents/scripts/lib/config-settings-schema.js';
import { buildEnvelope } from '../.agents/scripts/lib/orchestrate/classify.js';
import {
  conflictState,
  resolveConflict,
} from '../.agents/scripts/lib/orchestrate/conflicts.js';
import {
  renderInventory,
  runInventory,
} from '../.agents/scripts/lib/orchestrate/inventory.js';
import { makeTempDir } from '../.agents/scripts/lib/test-temp.js';
import { parseInventoryArgv } from '../.agents/scripts/orchestrate-inventory.js';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const NOW = Date.parse('2026-11-10T12:00:00Z');
const minutesAgo = (m) => new Date(NOW - m * 60_000).toISOString();
const STATES = [
  'ejected',
  'conflicted-real',
  'conflicted-driver-only',
  'red-inherited',
  'red-own-failure',
  'waiting-on-runner',
  'green-not-queued',
  'stale',
  'moving',
];

const pass = (name) => ({ name, phase: 'done', red: false, note: null });
const fail = (name, note = null) => ({ name, phase: 'done', red: true, note });
const queued = (name) => ({ name, phase: 'queued', red: false, note: null });
const running = (name) => ({ name, phase: 'running', red: false, note: null });

function row(number, over = {}) {
  return {
    number,
    storyId: number,
    author: 'dev',
    assignees: ['dev'],
    headSha: `sha${number}`,
    labels: [],
    draft: false,
    conflicting: false,
    autoMerge: true,
    inQueue: false,
    queueEvent: null,
    checks: [pass('lint'), pass('test')],
    paths: [`src/own-${number}.js`],
    pathCount: 1,
    pushedAt: minutesAgo(5),
    activityAt: minutesAgo(5),
    ...over,
  };
}

function snapshot(prs, over = {}) {
  return {
    base: { branch: 'main', sha: 'basesha0000', checks: [pass('lint')] },
    required: ['lint', 'test'],
    queueReadable: true,
    runners: { queued: 0, inProgress: 0, oldestWaitMin: null },
    merged: [],
    degraded: [],
    prs,
    ...over,
  };
}

const classify = (prs, over, opts = {}) =>
  buildEnvelope(snapshot(prs, over), { now: NOW, ...opts });
const stateOf = (env, n) => env.prs.find((p) => p.number === n).state;
const ejection = (headSha) => ({
  type: 'removed',
  at: minutesAgo(30),
  reason: 'failed checks',
  headSha,
});

describe('classifier precedence (AC-1)', () => {
  const cases = [
    ['ejected', row(1, { queueEvent: ejection('sha1'), conflicting: true })],
    [
      'conflicted-real',
      row(2, {
        conflicting: true,
        checks: [fail('test')],
        conflict: { clean: false, paths: [{ path: 'a.js', driver: false }] },
      }),
    ],
    [
      'conflicted-driver-only',
      row(3, {
        conflicting: true,
        checks: [fail('test')],
        conflict: {
          clean: false,
          paths: [{ path: 'baselines/x.json', driver: true }],
        },
      }),
    ],
    ['red-own-failure', row(5, { checks: [fail('test'), queued('lint')] })],
    ['waiting-on-runner', row(6, { checks: [pass('lint'), queued('test')] })],
    ['green-not-queued', row(7, { autoMerge: false })],
    [
      'stale',
      row(8, {
        checks: [pass('lint'), running('test')],
        activityAt: minutesAgo(46),
      }),
    ],
    ['moving', row(9, { checks: [pass('lint'), running('test')] })],
  ];

  for (const [state, pr] of cases) {
    it(`classifies ${state} ahead of every later rule`, () => {
      assert.equal(stateOf(classify([pr]), pr.number), state);
    });
  }

  it('classifies red-inherited ahead of red-own-failure', () => {
    const env = classify([row(4, { checks: [fail('lint'), pass('test')] })], {
      base: { branch: 'main', sha: 'b', checks: [fail('lint')] },
    });
    assert.equal(stateOf(env, 4), 'red-inherited');
  });

  it('places every PR of a mixed fleet in exactly one known state', () => {
    const env = classify(cases.map(([, pr]) => pr));
    assert.equal(env.prs.length, cases.length);
    for (const pr of env.prs) assert.ok(STATES.includes(pr.state), pr.state);
    assert.equal(env.kind, 'orchestrate-inventory');
  });

  it('a green PR with auto-merge armed, or a draft, is moving, not green-not-queued', () => {
    const env = classify([row(10), row(11, { autoMerge: false, draft: true })]);
    assert.equal(stateOf(env, 10), 'moving');
    assert.equal(stateOf(env, 11), 'moving');
  });

  it('a required check that never reported keeps the PR from green', () => {
    const env = classify([
      row(12, { autoMerge: false, checks: [pass('lint')] }),
    ]);
    assert.notEqual(stateOf(env, 12), 'green-not-queued');
  });

  it('carries ownership as fields, not a state', () => {
    const env = classify([
      row(13, { storyId: null, author: 'dependabot', assignees: [] }),
    ]);
    const [pr] = env.prs;
    assert.equal(pr.storyId, null);
    assert.equal(pr.author, 'dependabot');
    assert.deepEqual(pr.assignees, []);
  });
});

describe('inherited failures (AC-2)', () => {
  const red = (n, paths, note = 'boom') =>
    row(n, { checks: [fail('test', note), pass('lint')], paths });

  it('a failure also red on the base branch is red-inherited, listed once', () => {
    const env = classify([red(1, ['a.js'])], {
      base: { branch: 'main', sha: 'b', checks: [fail('test', 'boom')] },
    });
    assert.equal(stateOf(env, 1), 'red-inherited');
    assert.deepEqual(env.inherited, [
      { sig: 'test: boom', onBase: true, prs: [1] },
    ]);
  });

  it('the same failure on two PRs sharing no path is red-inherited on both', () => {
    const env = classify([red(1, ['a.js']), red(2, ['b.js'])]);
    assert.equal(stateOf(env, 1), 'red-inherited');
    assert.equal(stateOf(env, 2), 'red-inherited');
    assert.deepEqual(env.inherited, [
      { sig: 'test: boom', onBase: false, prs: [1, 2] },
    ]);
  });

  it('the same failure on PRs that share a path is each one own failure', () => {
    const env = classify([red(1, ['a.js']), red(2, ['a.js', 'b.js'])]);
    assert.equal(stateOf(env, 1), 'red-own-failure');
    assert.equal(stateOf(env, 2), 'red-own-failure');
    assert.deepEqual(env.inherited, []);
  });

  it('a failure on a single PR is red-own-failure', () => {
    const env = classify([red(1, ['a.js']), red(2, ['b.js'], 'other')]);
    assert.equal(stateOf(env, 1), 'red-own-failure');
    assert.deepEqual(env.prs[0].red, ['test: boom']);
  });

  it('a non-required red check does not make a PR red', () => {
    const env = classify([
      row(1, { checks: [pass('lint'), pass('test'), fail('advisory')] }),
    ]);
    assert.equal(stateOf(env, 1), 'moving');
  });
});

describe('conflicts (AC-3)', () => {
  it('all conflicted paths driver-merged, or a clean local merge, is driver-only', () => {
    assert.deepEqual(
      conflictState({
        clean: false,
        paths: [{ path: 'baselines/a.json', driver: true }],
      }),
      { state: 'conflicted-driver-only', paths: [] },
    );
    assert.equal(
      conflictState({ clean: true, paths: [] }).state,
      'conflicted-driver-only',
    );
  });

  it('any other conflicted path is conflicted-real and is listed', () => {
    const env = classify([
      row(1, {
        conflicting: true,
        conflict: {
          clean: false,
          paths: [
            { path: 'baselines/a.json', driver: true },
            { path: 'src/x.js', driver: false },
          ],
        },
      }),
    ]);
    assert.equal(env.prs[0].state, 'conflicted-real');
    assert.deepEqual(env.prs[0].conflicted, ['src/x.js']);
    assert.equal(env.prs[0].conflictedCount, 1);
  });

  it('an unreadable local merge is conflicted-real with unknown paths', () => {
    assert.deepEqual(conflictState(null), {
      state: 'conflicted-real',
      paths: null,
    });
  });

  it('resolveConflict reads merge-tree and check-attr from the main checkout', () => {
    const calls = [];
    const spawn = (_cwd, ...args) => {
      calls.push(args);
      if (args[0] === 'merge-tree') {
        return {
          status: 1,
          stdout: 'treeoid\nbaselines/a.json\nsrc/x.js',
          stderr: '',
        };
      }
      if (args[0] === 'check-attr') {
        return {
          status: 0,
          stdout:
            'baselines/a.json: merge: mandrel-baseline\nsrc/x.js: merge: unspecified',
          stderr: '',
        };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const got = resolveConflict({
      cwd: REPO_ROOT,
      base: 'main',
      number: 7,
      headSha: 'abc',
      spawn,
    });
    assert.deepEqual(got, {
      clean: false,
      paths: [
        { path: 'baselines/a.json', driver: true },
        { path: 'src/x.js', driver: false },
      ],
    });
    assert.deepEqual(calls[0], [
      'fetch',
      '--no-tags',
      '--quiet',
      'origin',
      'main',
      'refs/pull/7/head',
    ]);
  });

  it('resolveConflict reports a clean local merge, and null when git cannot tell', () => {
    const ok = () => ({ status: 0, stdout: 'tree', stderr: '' });
    assert.deepEqual(
      resolveConflict({
        cwd: REPO_ROOT,
        base: 'main',
        number: 1,
        headSha: 'a',
        spawn: ok,
      }),
      { clean: true, paths: [] },
    );
    const fetchFails = () => ({ status: 128, stdout: '', stderr: 'no' });
    assert.equal(
      resolveConflict({
        cwd: REPO_ROOT,
        base: 'main',
        number: 1,
        headSha: 'a',
        spawn: fetchFails,
      }),
      null,
    );
  });

  it('this repository drives baselines/*.json through a custom merge driver', () => {
    const attrs = readFileSync(path.join(REPO_ROOT, '.gitattributes'), 'utf8');
    assert.match(attrs, /baselines\/\*\.json\s+merge=mandrel-baseline/);
  });
});

describe('requeue and the release veto (AC-4)', () => {
  const ejected = (over = {}) =>
    row(1, { autoMerge: false, queueEvent: ejection('old'), ...over });

  it('is eligible once the head moved and required checks are green', () => {
    const env = classify([ejected()], undefined, {
      requeueCommand: { cmd: 'gh', args: ['pr', 'merge', '{pr}', '--auto'] },
    });
    assert.deepEqual(env.prs[0].requeue, {
      eligible: true,
      blockedBy: [],
      command: { cmd: 'gh', args: ['pr', 'merge', '1', '--auto'] },
    });
  });

  it('is ineligible while the head has not moved or checks are not green', () => {
    const env = classify([
      ejected({ headSha: 'old', checks: [pass('lint'), running('test')] }),
    ]);
    assert.deepEqual(env.prs[0].requeue, {
      eligible: false,
      blockedBy: ['head-not-moved', 'checks-not-green'],
      command: null,
    });
  });

  it('a release-labelled PR is ineligible while the veto command exits non-zero', async () => {
    const vetoRuns = [];
    const pull = graphqlPr(1, {
      labels: { nodes: [{ name: 'autorelease: pending' }] },
      isInMergeQueue: false,
      autoMergeRequest: null,
      timelineItems: {
        nodes: [
          {
            __typename: 'RemovedFromMergeQueueEvent',
            createdAt: minutesAgo(30),
            reason: 'failed checks',
            beforeCommit: { oid: 'old' },
          },
        ],
      },
    });
    const config = {
      github: { owner: 'o', repo: 'r' },
      delivery: {
        orchestrate: {
          releaseVeto: {
            prLabel: 'autorelease: pending',
            cmd: 'node',
            args: ['veto.js'],
          },
        },
      },
    };
    const env = await runInventory({
      config,
      cwd: REPO_ROOT,
      gh: fakeGh({ prs: [pull] }).gh,
      now: NOW,
      runVeto: (veto, cwd) => {
        vetoRuns.push({ veto, cwd });
        return true;
      },
    });
    assert.equal(env.prs[0].state, 'ejected');
    assert.equal(env.prs[0].veto, 'held');
    assert.deepEqual(env.prs[0].requeue.blockedBy, ['release-veto']);
    assert.equal(env.prs[0].requeue.eligible, false);
    assert.deepEqual(vetoRuns, [
      {
        veto: {
          cmd: 'node',
          args: ['veto.js'],
          prLabel: 'autorelease: pending',
        },
        cwd: REPO_ROOT,
      },
    ]);
  });

  it('the default veto runner holds when its command exits non-zero', async () => {
    const pull = graphqlPr(2, { labels: { nodes: [{ name: 'release' }] } });
    const env = await runInventory({
      config: {
        github: { owner: 'o', repo: 'r' },
        delivery: {
          orchestrate: {
            releaseVeto: {
              prLabel: 'release',
              cmd: process.execPath,
              args: ['-e', 'process.exitCode = 3'],
            },
          },
        },
      },
      cwd: REPO_ROOT,
      gh: fakeGh({ prs: [pull] }).gh,
      now: NOW,
    });
    assert.equal(env.prs[0].veto, 'held');
  });
});

function check(name, conclusion, annotation) {
  return {
    __typename: 'CheckRun',
    name,
    status: 'COMPLETED',
    conclusion,
    startedAt: minutesAgo(10),
    completedAt: minutesAgo(9),
    annotations: { nodes: annotation ? [{ message: annotation }] : [] },
  };
}

function graphqlPr(number, over = {}) {
  return {
    number,
    isDraft: false,
    headRefName: `story-${number}`,
    headRefOid: `head${number}`,
    mergeable: 'MERGEABLE',
    isInMergeQueue: false,
    author: { login: 'dev' },
    autoMergeRequest: { enabledAt: minutesAgo(20) },
    labels: { nodes: [] },
    files: { totalCount: 1, nodes: [{ path: `src/${number}.js` }] },
    closingIssuesReferences: {
      nodes: [{ number, assignees: { nodes: [{ login: 'dev' }] } }],
    },
    timelineItems: { nodes: [] },
    commits: {
      nodes: [
        {
          commit: {
            committedDate: minutesAgo(10),
            statusCheckRollup: {
              contexts: {
                nodes: [check('lint', 'SUCCESS'), check('test', 'SUCCESS')],
              },
            },
          },
        },
      ],
    },
    ...over,
  };
}

/** A `gh` facade that answers from fixtures and logs every request. */
function fakeGh({ prs = [], transport = 'graphql', merged = [] } = {}) {
  const calls = [];
  const out = (value) => ({ stdout: JSON.stringify(value) });
  const restPulls = prs.map((p) => ({
    number: p.number,
    head: { ref: p.headRefName, sha: p.headRefOid },
    user: { login: p.author.login },
    labels: p.labels.nodes,
    draft: false,
    auto_merge: null,
    updated_at: minutesAgo(5),
  }));
  const gh = {
    prTransport: async () => transport,
    pr: {
      list: async (flags, fields) => {
        calls.push({ list: flags, fields });
        return merged;
      },
    },
    api: async ({ endpoint, body }) => {
      calls.push({ endpoint, query: body?.query ?? null });
      if (endpoint === 'graphql') {
        return out({
          data: {
            repository: {
              ref: {
                target: {
                  oid: 'basesha',
                  statusCheckRollup: {
                    contexts: { nodes: [check('lint', 'SUCCESS')] },
                  },
                },
              },
              pullRequests: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: prs,
              },
            },
          },
        });
      }
      if (endpoint.includes('/rules/branches/')) {
        return out([
          {
            type: 'required_status_checks',
            parameters: {
              required_status_checks: [
                { context: 'lint' },
                { context: 'test' },
              ],
            },
          },
        ]);
      }
      if (endpoint.includes('/protection/')) return out({ contexts: [] });
      if (endpoint.includes('/actions/runs')) {
        return out({
          workflow_runs: [
            { status: 'queued', created_at: minutesAgo(12) },
            { status: 'in_progress', created_at: minutesAgo(3) },
          ],
        });
      }
      if (/\/pulls\?state=open/.test(endpoint)) return out(restPulls);
      if (/\/pulls\/\d+\/files/.test(endpoint)) {
        return out([{ filename: 'src/x.js' }]);
      }
      if (/\/pulls\/\d+$/.test(endpoint)) {
        return out({ mergeable_state: 'clean', changed_files: 1 });
      }
      if (endpoint.includes('/check-runs')) {
        return out({
          check_runs: [
            {
              name: 'lint',
              status: 'completed',
              conclusion: 'success',
              head_sha: 'basesha',
            },
            { name: 'test', status: 'completed', conclusion: 'success' },
          ],
        });
      }
      if (/\/issues\/\d+$/.test(endpoint)) {
        return out({ assignees: [{ login: 'dev' }] });
      }
      throw new Error(`unexpected endpoint ${endpoint}`);
    },
  };
  return { gh, calls };
}

const longPath = (n, i) =>
  `.agents/scripts/lib/orchestration/some-deeply-nested-module-${n}-${i}.js`;

describe('size budget and no job logs (AC-5)', () => {
  it('a 30-PR fleet fits in 16384 bytes', async () => {
    const prs = Array.from({ length: 30 }, (_, i) => {
      const n = 6000 + i;
      return graphqlPr(n, {
        mergeable: i % 3 === 0 ? 'CONFLICTING' : 'MERGEABLE',
        files: {
          totalCount: 240,
          nodes: Array.from({ length: 100 }, (_, j) => ({
            path: longPath(j % 7 === 0 ? 0 : n, j),
          })),
        },
        commits: {
          nodes: [
            {
              commit: {
                committedDate: minutesAgo(90),
                statusCheckRollup: {
                  contexts: {
                    nodes: Array.from({ length: 12 }, (_, k) =>
                      check(
                        k < 2 ? ['lint', 'test'][k] : `job-${k}`,
                        'FAILURE',
                        `assertion failed in a very long annotation message number ${k} for PR ${n} `.repeat(
                          3,
                        ),
                      ),
                    ),
                  },
                },
              },
            },
          ],
        },
      });
    });
    const spawn = (_cwd, ...args) => {
      if (args[0] === 'merge-tree') {
        const paths = Array.from({ length: 40 }, (_, j) => longPath(9, j));
        return { status: 1, stdout: `tree\n${paths.join('\n')}`, stderr: '' };
      }
      if (args[0] === 'check-attr') {
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const env = await runInventory({
      config: { github: { owner: 'o', repo: 'r' } },
      cwd: REPO_ROOT,
      gh: fakeGh({ prs }).gh,
      now: NOW,
      spawn,
    });
    assert.equal(env.prs.length, 30);
    const bytes = Buffer.byteLength(JSON.stringify(env));
    assert.ok(bytes <= 16384, `envelope is ${bytes} bytes`);
    assert.ok(env.overlaps.length <= 10);
  });

  it('no orchestrate source requests a job log, and a sweep never asks for one', async () => {
    const sources = [
      '.agents/scripts/orchestrate-inventory.js',
      '.agents/scripts/lib/orchestrate/inventory.js',
      '.agents/scripts/lib/orchestrate/classify.js',
      '.agents/scripts/lib/orchestrate/conflicts.js',
      '.agents/scripts/lib/orchestrate/inherited-failure.js',
    ].map((p) => readFileSync(path.join(REPO_ROOT, p), 'utf8'));
    for (const text of sources) {
      assert.doesNotMatch(text, /--log|\/logs\b|'run', 'view'|jobs\//);
    }
    const { gh, calls } = fakeGh({ prs: [graphqlPr(1)] });
    await runInventory({ config: {}, cwd: REPO_ROOT, gh, now: NOW });
    for (const call of calls) {
      assert.doesNotMatch(String(call.endpoint ?? ''), /logs|\/jobs/);
    }
    assert.equal(calls.filter((c) => c.endpoint === 'graphql').length, 1);
  });
});

describe('degraded transport (AC-6)', () => {
  it('over REST names merge-queue degraded and classifies nothing ejected or green-not-queued', async () => {
    const pull = graphqlPr(1, { autoMergeRequest: null });
    const { gh, calls } = fakeGh({ prs: [pull], transport: 'rest' });
    const env = await runInventory({
      config: {},
      cwd: REPO_ROOT,
      gh,
      now: NOW,
    });
    assert.deepEqual(env.degraded, ['merge-queue']);
    assert.equal(env.prs.length, 1);
    assert.equal(env.prs[0].state, 'moving');
    assert.deepEqual(env.prs[0].assignees, ['dev']);
    assert.ok(calls.every((c) => c.endpoint !== 'graphql'));
  });

  it('a missing queue reading never yields ejected or green-not-queued', () => {
    const env = classify(
      [
        row(1, { inQueue: null, queueEvent: ejection('x') }),
        row(2, { inQueue: null, autoMerge: false }),
      ],
      { queueReadable: false },
    );
    for (const pr of env.prs) {
      assert.ok(!['ejected', 'green-not-queued'].includes(pr.state));
    }
  });

  it('a failed optional read is named, not fatal', async () => {
    const { gh } = fakeGh({ prs: [graphqlPr(1)] });
    const api = gh.api;
    gh.api = async (req) => {
      if (req.endpoint.includes('/actions/runs')) throw new Error('403');
      return api(req);
    };
    const env = await runInventory({
      config: {},
      cwd: REPO_ROOT,
      gh,
      now: NOW,
    });
    assert.deepEqual(env.degraded, ['runners']);
    assert.equal(env.runners, null);
  });
});

describe('sweeps over a run ledger (AC-8)', () => {
  it('an unchanged fleet reports no changes; a moved PR reports both states', async () => {
    const ledgerFile = path.join(makeTempDir('orchestrate-'), 'ledger.ndjson');
    const sweep = (prs, now) =>
      runInventory({
        config: {},
        cwd: REPO_ROOT,
        runId: 'r1',
        ledgerFile,
        gh: fakeGh({ prs }).gh,
        now,
      });
    const first = await sweep([graphqlPr(1), graphqlPr(2)], NOW);
    assert.deepEqual(first.changes, [
      { number: 1, from: null, to: 'moving' },
      { number: 2, from: null, to: 'moving' },
    ]);
    const second = await sweep([graphqlPr(1), graphqlPr(2)], NOW + 60_000);
    assert.deepEqual(second.changes, []);
    const third = await sweep(
      [graphqlPr(1), graphqlPr(2, { autoMergeRequest: null })],
      NOW + 120_000,
    );
    assert.deepEqual(third.changes, [
      { number: 2, from: 'moving', to: 'green-not-queued' },
    ]);
  });

  it('without a run id changes[] is empty and nothing is written', async () => {
    const env = await runInventory({
      config: {},
      cwd: REPO_ROOT,
      gh: fakeGh({ prs: [graphqlPr(1)] }).gh,
      now: NOW,
    });
    assert.deepEqual(env.changes, []);
    assert.deepEqual(env.landed, []);
  });

  it('lists Story PRs merged since the previous sweep as landed', async () => {
    const ledgerFile = path.join(makeTempDir('orchestrate-'), 'ledger.ndjson');
    const merged = [
      { number: 9, headRefName: 'story-90', mergedAt: minutesAgo(-1) },
      { number: 8, headRefName: 'dependabot/x', mergedAt: minutesAgo(-1) },
      { number: 7, headRefName: 'story-70', mergedAt: minutesAgo(600) },
    ];
    const env = await runInventory({
      config: {},
      cwd: REPO_ROOT,
      runId: 'r1',
      ledgerFile,
      gh: fakeGh({ merged }).gh,
      now: NOW,
    });
    assert.deepEqual(env.landed, [{ number: 9, storyId: 90 }]);
    assert.deepEqual(env.runners, {
      queued: 1,
      inProgress: 1,
      oldestWaitMin: 12,
    });
  });

  it('renders one terminal line per PR and each change', () => {
    const env = classify([row(1, { checks: [fail('test')] })]);
    env.changes = [{ number: 1, from: null, to: 'red-own-failure' }];
    const text = renderInventory(env);
    assert.match(text, /#1 red-own-failure Story #1 — test/);
    assert.match(text, /changed #1: \(new\) -> red-own-failure/);
  });
});

describe('CLI and config (AC-10)', () => {
  it('parses the inventory flags', () => {
    const args = parseInventoryArgv(['--run-id', 'r1', '--json']);
    assert.equal(args.runId, 'r1');
    assert.equal(args.json, true);
    assert.throws(() => parseInventoryArgv(['--bogus']));
  });

  const validate = getAgentrcValidator();
  const docWith = (orchestrate) => ({
    project: {
      paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
    },
    delivery: { orchestrate },
  });

  it('accepts a populated delivery.orchestrate block', () => {
    const ok = validate(
      docWith({
        requeueCommand: { cmd: 'gh', args: ['pr', 'merge', '{pr}', '--auto'] },
        releaseVeto: { prLabel: 'autorelease: pending', cmd: 'node' },
      }),
    );
    assert.equal(ok, true, JSON.stringify(validate.errors));
  });

  it('rejects an unknown key under delivery.orchestrate or inside a command', () => {
    assert.equal(validate(docWith({ sweepInterval: 15 })), false);
    assert.equal(
      validate(docWith({ requeueCommand: { cmd: 'x', shell: true } })),
      false,
    );
    assert.equal(validate(docWith({ releaseVeto: { cmd: 'x' } })), false);
  });
});

// tests/cli/ui-sources.test.js — the board sources' read side: per-Story
// liveness and stage time on `readState`, and the `readStory` detail.
// Every dependency is injected; the only file I/O is a per-test temp root.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { runDispatch } from '../../.agents/scripts/dispatch.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';
import { createSources } from '../../lib/cli/ui/sources.js';
import { makeDispatchBoard } from '../helpers/dispatch-board.js';

const SENTINEL = 'ghp_SENTINEL_never_echo_0123456789';
const STARTED = '2026-11-18T00:00:00.000Z';

let tempRoot;
beforeEach(() => {
  tempRoot = makeTempDir('mandrel-ui-sources-');
});
afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

const stageComment = (storyId, stage, history = []) => ({
  body: `\`\`\`json\n${JSON.stringify({ kind: 'delivery-stage', storyId, stage, prNumber: null, updatedAt: STARTED, history })}\n\`\`\``,
});

function sourcesOver(tickets, { records = {}, comments = {}, alive = [] }) {
  const board = makeDispatchBoard(tickets);
  for (const [id, record] of Object.entries(records)) {
    board.records.set(Number(id), record);
  }
  board.deps.provider.getTicketComments = async (id) => comments[id] ?? [];
  const config = {
    ...board.deps.config,
    github: { ...board.deps.config.github, owner: 'o', repo: 'r' },
    project: { paths: { tempRoot } },
    delivery: { environments: { local: { target: 'local' } } },
  };
  const probes = [];
  const sources = createSources({
    cwd: 'project-root',
    env: { GITHUB_TOKEN: SENTINEL },
    resolveConfigImpl: () => config,
    createProviderImpl: () => board.deps.provider,
    readRecordImpl: (id) => board.records.get(id) ?? null,
    kill: (pid, signal) => {
      probes.push([pid, signal]);
      if (!alive.includes(pid)) {
        throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      }
    },
    dispatch: (argv, deps) => runDispatch(argv, { ...board.deps, ...deps }),
  });
  return { sources, probes, board };
}

const executing = (id) => ({
  id,
  labels: ['type::story', 'agent::executing', 'env::local'],
});

describe('readState (AC-3)', () => {
  it('reports working, exited and unknown processes and the stage time', async () => {
    const { sources, probes } = sourcesOver(
      [
        executing(1),
        executing(2),
        executing(3),
        { id: 4, labels: ['type::story', 'agent::blocked', 'env::local'] },
        { id: 5, labels: ['type::story', 'agent::ready'] },
      ],
      {
        records: {
          1: { storyId: 1, pid: 101, startedAt: STARTED },
          2: { storyId: 2, pid: 102, startedAt: STARTED },
          3: { storyId: 3, startedAt: STARTED, sessionUrl: 'https://c' },
          5: { storyId: 5, pid: 105, startedAt: STARTED },
        },
        comments: { 1: [stageComment(1, 'check')] },
        alive: [101],
      },
    );
    const state = await sources.readState();
    const byId = Object.fromEntries(state.stories.map((s) => [s.id, s]));
    assert.deepEqual(byId[1].process, { state: 'working', startedAt: STARTED });
    assert.equal(byId[1].stage, 'check');
    assert.equal(byId[1].stageUpdatedAt, STARTED);
    assert.equal(byId[2].process.state, 'exited');
    assert.equal(byId[3].process.state, 'unknown');
    assert.deepEqual(byId[4].process, { state: 'unknown', startedAt: null });
    assert.equal(byId[4].stageUpdatedAt, null);
    assert.equal('process' in byId[5], false, 'Ready is not in flight');
    assert.deepEqual(probes, [
      [101, 0],
      [102, 0],
    ]);
  });
});

describe('readStory (AC-5, AC-6, AC-7)', () => {
  function logIn(dir, lines) {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'story-1.log');
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    return file;
  }

  it('returns the detail fields, the resume command and the log tail', async () => {
    const logPath = logIn(path.join(tempRoot, 'dispatch'), [
      JSON.stringify({ type: 'result', subtype: 'success' }),
    ]);
    const record = {
      storyId: 1,
      environment: 'local',
      pid: 101,
      startedAt: STARTED,
      logPath,
      argv: ['claude', '-p', '/mandrel-deliver 1'],
      sessionId: 'sess-1',
    };
    const history = [{ stage: 'build', at: STARTED }];
    const { sources } = sourcesOver([executing(1)], {
      records: { 1: record },
      comments: { 1: [stageComment(1, 'build', history)] },
      alive: [101],
    });
    const detail = await sources.readStory(1, await sources.readState());
    assert.deepEqual(detail, {
      id: 1,
      title: 'Story 1',
      column: 'delivering',
      environment: 'local',
      projectStatus: null,
      labels: ['type::story', 'agent::executing', 'env::local'],
      assignees: [],
      epic: null,
      dependsOn: [],
      issueUrl: 'https://github.com/o/r/issues/1',
      pr: null,
      stage: 'build',
      history,
      process: { state: 'working', startedAt: STARTED },
      record: {
        pid: 101,
        startedAt: STARTED,
        argv: record.argv,
        sessionId: 'sess-1',
        sessionUrl: null,
      },
      resumeCommand: 'claude --resume sess-1',
      logTail: ['result: success'],
    });
    const text = JSON.stringify(detail);
    assert.equal(text.includes(logPath), false, 'no log path leaves');
    assert.equal(text.includes(SENTINEL), false);
  });

  it('has no resume command, record or tail without a record', async () => {
    const { sources } = sourcesOver([executing(1)], {});
    const detail = await sources.readStory(1, await sources.readState());
    assert.equal(detail.resumeCommand, null);
    assert.equal(detail.record, null);
    assert.deepEqual(detail.logTail, []);
    assert.deepEqual(detail.history, []);
  });

  it('reads no log outside the dispatch directory', async () => {
    const logPath = logIn(path.join(tempRoot, 'elsewhere'), ['secret']);
    const { sources } = sourcesOver([executing(1)], {
      records: { 1: { storyId: 1, pid: 101, startedAt: STARTED, logPath } },
    });
    const detail = await sources.readStory(1, await sources.readState());
    assert.deepEqual(detail.logTail, []);
  });

  it('is null for a Story not on the board', async () => {
    const { sources } = sourcesOver([executing(1)], {});
    assert.equal(await sources.readStory(99, await sources.readState()), null);
  });
});

describe('readStory for a cloud record', () => {
  it('has no resume command: a routine-fired session is not resumable locally', async () => {
    const { sources } = sourcesOver([executing(1)], {
      records: {
        1: {
          storyId: 1,
          startedAt: STARTED,
          sessionId: 'sess-cloud',
          sessionUrl: 'https://claude.ai/code/sess-cloud',
        },
      },
    });
    const detail = await sources.readStory(1, await sources.readState());
    assert.equal(detail.resumeCommand, null);
    assert.equal(detail.record.sessionUrl, 'https://claude.ai/code/sess-cloud');
  });
});

describe('readConnections accounts (AC-1, AC-2, AC-3)', () => {
  const STATUS = {
    loggedIn: true,
    authMethod: 'claude.ai',
    apiProvider: 'firstParty',
    email: 'dev@example.test',
    orgId: 'org-uuid-secret',
    orgName: 'Example Org',
    subscriptionType: 'max',
    configDirectory: 'config-dir-value',
  };

  function connectionsSources(clock) {
    const calls = [];
    const runner = async (cmd, args) => {
      calls.push([cmd, ...args].join(' '));
      if (cmd === 'gh') return { status: 0, stdout: 'octocat\n', stderr: '' };
      const json = args[0] === 'auth';
      return {
        status: 0,
        stdout: json ? JSON.stringify(STATUS) : '2.1.300',
        stderr: '',
      };
    };
    const config = {
      delivery: {
        environments: {
          local: { target: 'local' },
          cloud: {
            target: 'claude-cloud',
            routine: 'trig_1',
            tokenEnv: 'CLOUD_TOKEN',
          },
        },
      },
    };
    const sources = createSources({
      cwd: 'project-root',
      env: { GITHUB_TOKEN: SENTINEL },
      runner,
      now: () => clock.at,
      readJson: () => null,
      resolveConfigImpl: () => config,
    });
    return { sources, calls };
  }

  it('reports the login, the whitelisted account and each cloud routine', async () => {
    const { sources } = connectionsSources({ at: 0 });
    const report = await sources.readConnections();
    assert.deepEqual(report.github, {
      ok: true,
      source: 'environment',
      login: 'octocat',
    });
    assert.deepEqual(report.claude, {
      ok: true,
      account: {
        email: 'dev@example.test',
        orgName: 'Example Org',
        subscriptionType: 'max',
        authMethod: 'claude.ai',
      },
    });
    assert.deepEqual(
      report.environments.map((e) => [e.name, e.online, e.reason, e.routine]),
      [
        ['local', true, null, null],
        ['cloud', false, 'cloud token not set', 'trig_1'],
      ],
    );
    const text = JSON.stringify(report);
    for (const dropped of ['org-uuid-secret', 'config-dir-value', SENTINEL]) {
      assert.equal(text.includes(dropped), false, dropped);
    }
  });

  it('probes the accounts at most once per 60 s across requests', async () => {
    const clock = { at: 0 };
    const { sources, calls } = connectionsSources(clock);
    const accountProbes = () =>
      calls.filter((c) => c.startsWith('gh api') || c.includes('auth status'))
        .length;
    await sources.readConnections();
    clock.at = 30_000;
    await sources.readConnections();
    assert.equal(accountProbes(), 2);
    clock.at = 60_000;
    await sources.readConnections();
    assert.equal(accountProbes(), 4);
  });
});

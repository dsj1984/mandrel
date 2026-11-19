// tests/dispatch.test.js — `.agents/scripts/dispatch.js` end to end over an
// in-memory board: every action, every refusal, and the read model's drops.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { runDispatch } from '../.agents/scripts/dispatch.js';
import { launchLocal } from '../.agents/scripts/lib/dispatch/launch-local.js';
import { makeDispatchBoard } from './helpers/dispatch-board.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(
  __dirname,
  '..',
  '.agents',
  'scripts',
  'dispatch.js',
);

const DEFAULT_ARGV = (id) => [
  'claude',
  '-p',
  `/mandrel-deliver ${id}`,
  '--session-id',
  '{sessionId}',
  '--name',
  `◐ Delivery #${id}`,
  '--output-format',
  'stream-json',
  '--verbose',
];

/** Launch options when nothing is configured and no override label is set. */
const CLAUDE_DEFAULTS = {
  model: { value: null, source: 'claude-default' },
  effort: { value: null, source: 'claude-default' },
};

const ready = (id, extra = {}) => ({
  id,
  labels: ['type::story', 'agent::ready'],
  ...extra,
});

async function run(board, argv) {
  const { out, deps } = board.capture();
  const code = await runDispatch(argv, deps);
  return { code, envelope: JSON.parse(out.join('')) };
}

describe('dispatch (AC-5)', () => {
  it('labels the Story, launches {id}-substituted argv, writes the record and exits 0', async () => {
    const board = makeDispatchBoard([ready(7)]);
    const { code, envelope } = await run(board, ['--env', 'local', '7']);
    assert.equal(code, 0);
    assert.deepEqual(envelope, {
      ok: true,
      action: 'dispatch',
      storyId: 7,
      environment: 'local',
      launchOptions: CLAUDE_DEFAULTS,
      pid: 907,
      logPath: 'log-7',
    });
    assert.ok(board.store.get(7).labels.includes('env::local'));
    assert.deepEqual(board.writes[0], { ensureLabels: ['env::local'] });
    assert.deepEqual(board.records.get(7).argv, DEFAULT_ARGV(7));
    assert.equal(board.launches.length, 1);
  });

  it('AC-1: the real local launch records the session id its argv carries', async () => {
    const board = makeDispatchBoard([ready(7)]);
    const spawned = [];
    const { deps } = board.capture();
    const code = await runDispatch(['--env', 'local', '7'], {
      ...deps,
      launchImpl: (args) =>
        launchLocal(args, {
          spawnImpl: async (file, argv) => {
            spawned.push([file, ...argv]);
            return { pid: 55 };
          },
          fsImpl: { mkdirSync: () => {} },
          uuid: () => 'uuid-1',
        }),
    });
    assert.equal(code, 0);
    const expected = DEFAULT_ARGV(7).map((p) =>
      p === '{sessionId}' ? 'uuid-1' : p,
    );
    assert.deepEqual(spawned, [expected]);
    assert.equal(board.records.get(7).sessionId, 'uuid-1');
    assert.deepEqual(board.records.get(7).argv, expected);
  });
});

describe('refusals (AC-6)', () => {
  const cases = [
    ['unknown-environment', [ready(7)], ['--env', 'nope', '7']],
    [
      'epic',
      [{ id: 7, labels: ['type::epic'], children: [8, 9] }, ready(8), ready(9)],
      ['--env', 'local', '7'],
    ],
    [
      'not-ready',
      [{ id: 7, labels: ['type::story', 'agent::review-spec'] }],
      ['--env', 'local', '7'],
    ],
    [
      'already-dispatched',
      [{ id: 7, labels: ['type::story', 'agent::executing', 'env::local'] }],
      ['--env', 'local', '7'],
    ],
    [
      'foreign-lease',
      [ready(7, { assignees: ['someone'] })],
      ['--env', 'local', '7'],
    ],
    [
      'unmet-dependency',
      [
        ready(7, { body: 'x\n\n---\nblocked by #3\n' }),
        { id: 3, labels: ['type::story', 'agent::ready'] },
      ],
      ['--env', 'local', '7'],
    ],
    [
      'at-capacity',
      [
        ready(7),
        { id: 8, labels: ['type::story', 'agent::executing', 'env::local'] },
      ],
      ['--env', 'local', '7'],
    ],
    ['not-blocked', [ready(7)], ['--resume', '7']],
    [
      'wrong-environment',
      [{ id: 7, labels: ['type::story', 'agent::blocked', 'env::local'] }],
      ['--resume', '--env', 'other', '7'],
    ],
    [
      'closing',
      [{ id: 7, labels: ['type::story', 'agent::closing', 'env::local'] }],
      ['--stop', '7'],
    ],
  ];
  for (const [reason, tickets, argv] of cases) {
    it(`${reason}: exits 2 with the refusal, writes no label and starts nothing`, async () => {
      const board = makeDispatchBoard(tickets);
      const { code, envelope } = await run(board, argv);
      assert.equal(code, 2);
      assert.equal(envelope.ok, false);
      assert.equal(envelope.reason, reason);
      assert.equal(typeof envelope.detail, 'string');
      assert.deepEqual(board.writes, []);
      assert.deepEqual(board.launches, []);
      assert.deepEqual(board.kills, []);
    });
  }

  it('an unmet dependency names the blocking ids', async () => {
    const board = makeDispatchBoard([
      ready(7, { body: '---\nblocked by #3\n' }),
      { id: 3, labels: ['type::story', 'agent::ready'] },
    ]);
    const { envelope } = await run(board, ['--env', 'local', '7']);
    assert.match(envelope.detail, /#3/);
  });

  it('a closed dependency is met', async () => {
    const board = makeDispatchBoard([
      ready(7, { body: '---\nblocked by #3\n' }),
      { id: 3, labels: ['type::story', 'agent::done'], state: 'closed' },
    ]);
    const { code } = await run(board, ['--env', 'local', '7']);
    assert.equal(code, 0);
  });
});

describe('launch failure (AC-7)', () => {
  it('removes the env:: label it applied and exits 1', async () => {
    const board = makeDispatchBoard([ready(7)], {
      launchError: new Error('spawn claude ENOENT'),
    });
    const { code, envelope } = await run(board, ['--env', 'local', '7']);
    assert.equal(code, 1);
    assert.equal(envelope.ok, false);
    assert.match(envelope.error, /ENOENT/);
    assert.equal(board.store.get(7).labels.includes('env::local'), false);
    assert.equal(board.records.size, 0);
  });
});

describe('--resume (AC-9)', () => {
  it('relaunches a blocked Story in its labelled environment without touching agent::*', async () => {
    const board = makeDispatchBoard([
      {
        id: 7,
        labels: ['type::story', 'agent::blocked', 'env::local'],
        assignees: ['me'],
      },
    ]);
    const { code, envelope } = await run(board, ['--resume', '7']);
    assert.equal(code, 0);
    assert.equal(envelope.action, 'resume');
    assert.equal(envelope.environment, 'local');
    assert.equal(board.launches.length, 1);
    assert.deepEqual(board.store.get(7).labels, [
      'type::story',
      'agent::blocked',
      'env::local',
    ]);
    assert.equal(
      board.writes.some((w) => w.transition),
      false,
    );
  });
});

describe('AC-2: a record written before session ids', () => {
  const legacy = {
    storyId: 7,
    environment: 'local',
    pid: 4321,
    startedAt: '2026-11-01T00:00:00.000Z',
    logPath: 'log-7',
    argv: ['claude', '-p', '/mandrel-deliver 7'],
  };

  it('still stops its process', async () => {
    const board = makeDispatchBoard([
      { id: 7, labels: ['type::story', 'agent::executing', 'env::local'] },
    ]);
    board.records.set(7, legacy);
    const { code, envelope } = await run(board, ['--stop', '7']);
    assert.equal(code, 0);
    assert.equal(envelope.pid, 4321);
    assert.deepEqual(board.kills, [4321]);
  });

  it('still resumes', async () => {
    const board = makeDispatchBoard([
      { id: 7, labels: ['type::story', 'agent::blocked', 'env::local'] },
    ]);
    board.records.set(7, legacy);
    const { code } = await run(board, ['--resume', '7']);
    assert.equal(code, 0);
    assert.equal(board.launches.length, 1);
  });
});

describe('--stop (AC-10)', () => {
  it('kills the recorded process, releases the lease, returns to ready and drops the label', async () => {
    const board = makeDispatchBoard([
      {
        id: 7,
        labels: ['type::story', 'agent::executing', 'env::local'],
        assignees: ['me'],
      },
    ]);
    board.records.set(7, { storyId: 7, pid: 4321 });
    const { code, envelope } = await run(board, ['--stop', '7']);
    assert.equal(code, 0);
    assert.deepEqual(envelope, {
      ok: true,
      action: 'stop',
      storyId: 7,
      environment: 'local',
      pid: 4321,
    });
    assert.deepEqual(board.kills, [4321]);
    const t = board.store.get(7);
    assert.deepEqual(t.assignees, []);
    assert.deepEqual(t.labels, ['type::story', 'agent::ready']);
    assert.equal(board.records.has(7), false);
  });

  it('a dispatched-not-started Story needs no transition', async () => {
    const board = makeDispatchBoard([
      { id: 7, labels: ['type::story', 'agent::ready', 'env::local'] },
    ]);
    const { code } = await run(board, ['--stop', '7']);
    assert.equal(code, 0);
    assert.equal(
      board.writes.some((w) => w.transition),
      false,
    );
    assert.deepEqual(board.store.get(7).labels, [
      'type::story',
      'agent::ready',
    ]);
  });
});

describe('--dry-run (AC-11)', () => {
  it('prints the verdict and the argv, with no GitHub write and no spawn', async () => {
    const board = makeDispatchBoard([ready(7)]);
    const { code, envelope } = await run(board, [
      '--env',
      'local',
      '--dry-run',
      '7',
    ]);
    assert.equal(code, 0);
    assert.deepEqual(envelope, {
      ok: true,
      action: 'dispatch',
      storyId: 7,
      environment: 'local',
      dryRun: true,
      launchOptions: CLAUDE_DEFAULTS,
      argv: DEFAULT_ARGV(7),
    });
    assert.deepEqual(board.writes, []);
    assert.deepEqual(board.launches, []);
  });

  it('a dry-run stop kills nothing and writes nothing', async () => {
    const board = makeDispatchBoard([
      { id: 7, labels: ['type::story', 'agent::executing', 'env::local'] },
    ]);
    board.records.set(7, { storyId: 7, pid: 1 });
    const { code } = await run(board, ['--stop', '--dry-run', '7']);
    assert.equal(code, 0);
    assert.deepEqual(board.writes, []);
    assert.deepEqual(board.kills, []);
  });
});

describe('--status --json (AC-12)', () => {
  const tickets = [
    ready(1),
    ready(2, { body: '---\nblocked by #1\n' }),
    {
      id: 3,
      labels: ['type::story', 'agent::executing', 'env::local'],
      assignees: ['me'],
    },
    {
      id: 4,
      labels: ['type::story', 'agent::blocked', 'env::local'],
      assignees: ['me'],
    },
    { id: 5, labels: ['type::story', 'agent::closing', 'env::local'] },
    { id: 6, labels: ['type::story', 'agent::review-spec'] },
    { id: 9, labels: ['type::story', 'agent::done'], state: 'closed' },
  ];

  it('returns the documented shape', async () => {
    const { code, envelope } = await run(makeDispatchBoard(tickets), [
      '--status',
      '--json',
    ]);
    assert.equal(code, 0);
    assert.deepEqual(Object.keys(envelope).sort(), [
      'doneShown',
      'doneTotal',
      'environments',
      'launchChoices',
      'stories',
    ]);
    assert.equal(envelope.doneShown, 1);
    assert.equal(envelope.doneTotal, null);
    assert.deepEqual(envelope.environments, [
      {
        name: 'local',
        target: 'local',
        capacity: 1,
        load: 3,
        online: true,
        model: null,
        effort: null,
      },
    ]);
    assert.deepEqual(envelope.launchChoices, {
      models: ['opus', 'sonnet', 'haiku'],
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    });
    assert.deepEqual(envelope.stories[0].overrides, {
      model: null,
      effort: null,
    });
    assert.deepEqual(
      envelope.stories.map((s) => [s.id, s.column]),
      [
        [1, 'ready'],
        [2, 'ready'],
        [3, 'delivering'],
        [4, 'blocked'],
        [5, 'delivering'],
        [6, 'planning'],
        [9, 'done'],
      ],
    );
  });

  it('every drop verdict equals what the same action returns from the command', async () => {
    const { envelope } = await run(makeDispatchBoard(tickets), [
      '--status',
      '--json',
    ]);
    for (const story of envelope.stories) {
      const blocked = story.state === 'agent::blocked';
      const envArgv = blocked
        ? ['--resume', '--env', 'local', '--dry-run', String(story.id)]
        : ['--env', 'local', '--dry-run', String(story.id)];
      for (const [target, argv] of [
        ['local', envArgv],
        ['ready', ['--stop', '--dry-run', String(story.id)]],
      ]) {
        const drop = story.drops[target];
        const { code, envelope: cmd } = await run(
          makeDispatchBoard(tickets),
          argv,
        );
        assert.equal(cmd.ok, drop.ok, `#${story.id} → ${target}`);
        assert.equal(code, drop.ok ? 0 : 2, `#${story.id} → ${target}`);
        assert.equal(cmd.action, drop.action);
        if (drop.ok) assert.equal(cmd.environment, drop.environment);
        else assert.deepEqual(cmd, drop);
      }
    }
  });

  it('AC-1: --done-limit reaches the fetch and caps the Done Stories', async () => {
    const closed = Array.from({ length: 60 }, (_, i) => ({
      id: 100 + i,
      labels: ['type::story', 'agent::done'],
      state: 'closed',
      closedAt: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
    }));
    const board = makeDispatchBoard(closed);
    const { out, deps } = board.capture();
    const asked = [];
    const fetchBoardImpl = deps.fetchBoardImpl;
    deps.fetchBoardImpl = async (args) => {
      asked.push(args.doneLimit);
      return { ...(await fetchBoardImpl(args)), closedTotal: 60 };
    };
    for (const argv of [[], ['--done-limit', '50']]) {
      out.length = 0;
      const code = await runDispatch(['--status', '--json', ...argv], deps);
      assert.equal(code, 0);
      const envelope = JSON.parse(out.join(''));
      const done = envelope.stories.filter((s) => s.column === 'done');
      assert.equal(done.length, envelope.doneShown);
      assert.equal(done[0].id, 159, 'most recently closed first');
      assert.equal(envelope.doneTotal, 60);
    }
    assert.deepEqual(asked, [20, 50]);
  });

  for (const value of ['0', '25', '200', 'ten', '20.0', '']) {
    it(`AC-1: --done-limit ${JSON.stringify(value)} exits 2 with a usage message`, async () => {
      const { code, envelope } = await run(makeDispatchBoard(tickets), [
        '--status',
        '--json',
        '--done-limit',
        value,
      ]);
      assert.equal(code, 2);
      assert.equal(envelope.ok, false);
      assert.equal(envelope.reason, 'invalid-done-limit');
      assert.match(envelope.detail, /10, 20, 50, 100 \(see --help\)/);
    });
  }

  it('prints a human table without --json', async () => {
    const board = makeDispatchBoard(tickets);
    const { out, deps } = board.capture();
    assert.equal(await runDispatch(['--status'], deps), 0);
    assert.match(out.join(''), /^Environments:/);
  });
});

describe('launch options (model and effort)', () => {
  const withEnvironments = (environments, extra = {}) => ({
    github: { operatorHandle: '@me' },
    delivery: { environments, ...extra },
  });

  async function runWith(board, argv, config, more = {}) {
    const { out, deps } = board.capture();
    const code = await runDispatch(argv, { ...deps, config, ...more });
    return { code, envelope: JSON.parse(out.join('')) };
  }

  const localSonnet = withEnvironments({
    local: { target: 'local', model: 'sonnet' },
  });

  it('AC-3: no model, effort or override spawns exactly the pre-change argv', async () => {
    const board = makeDispatchBoard([ready(7)]);
    const { envelope } = await run(board, ['--env', 'local', '--dry-run', '7']);
    assert.deepEqual(envelope.argv, DEFAULT_ARGV(7));
  });

  it('AC-4: the environment model reaches the argv; an override label beats it', async () => {
    const plain = await runWith(
      makeDispatchBoard([ready(7)]),
      ['--env', 'local', '--dry-run', '7'],
      localSonnet,
    );
    assert.deepEqual(plain.envelope.argv, [
      ...DEFAULT_ARGV(7),
      '--model=sonnet',
    ]);
    assert.deepEqual(plain.envelope.launchOptions.model, {
      value: 'sonnet',
      source: 'environment',
    });
    const board = makeDispatchBoard([
      ready(7, {
        labels: ['type::story', 'agent::ready', 'model::opus', 'effort::max'],
      }),
    ]);
    const { code, envelope } = await runWith(
      board,
      ['--env', 'local', '7'],
      localSonnet,
    );
    assert.equal(code, 0);
    assert.deepEqual(envelope.launchOptions, {
      model: { value: 'opus', source: 'override' },
      effort: { value: 'max', source: 'override' },
    });
    assert.deepEqual(board.records.get(7).argv, [
      ...DEFAULT_ARGV(7),
      '--model=opus',
      '--effort=max',
    ]);
  });

  it('AC-4: model and effort resolve independently', async () => {
    const config = withEnvironments({
      local: { target: 'local', model: 'sonnet', effort: 'low' },
    });
    const board = makeDispatchBoard([
      ready(7, { labels: ['type::story', 'agent::ready', 'effort::high'] }),
    ]);
    const { envelope } = await runWith(
      board,
      ['--env', 'local', '--dry-run', '7'],
      config,
    );
    assert.deepEqual(envelope.argv.slice(-2), [
      '--model=sonnet',
      '--effort=high',
    ]);
  });

  const invalid = [
    ['a model outside the allowlist', ['model::gpt-5']],
    ['an effort outside the levels', ['effort::extreme']],
    ['two model labels', ['model::opus', 'model::sonnet']],
    ['two effort labels', ['effort::low', 'effort::max']],
  ];
  for (const [name, extra] of invalid) {
    for (const [mode, argv, labels] of [
      ['dispatch', ['--env', 'local', '7'], ['agent::ready']],
      ['dry run', ['--env', 'local', '--dry-run', '7'], ['agent::ready']],
      ['resume', ['--resume', '7'], ['agent::blocked', 'env::local']],
    ]) {
      it(`AC-6: ${name} refuses a ${mode} before any write or launch`, async () => {
        const board = makeDispatchBoard([
          {
            id: 7,
            labels: ['type::story', ...labels, ...extra],
            assignees: ['me'],
          },
        ]);
        const { code, envelope } = await run(board, argv);
        assert.equal(code, 2);
        assert.equal(envelope.ok, false);
        assert.equal(envelope.reason, 'invalid-launch-option');
        assert.equal(typeof envelope.detail, 'string');
        assert.deepEqual(board.writes, []);
        assert.deepEqual(board.launches, []);
      });
    }
  }

  it('AC-6: delivery.dispatchModels widens the allowlist', async () => {
    const board = makeDispatchBoard([
      ready(7, { labels: ['type::story', 'agent::ready', 'model::fable'] }),
    ]);
    const { code, envelope } = await runWith(
      board,
      ['--env', 'local', '--dry-run', '7'],
      withEnvironments({}, { dispatchModels: ['fable'] }),
    );
    assert.equal(code, 0);
    assert.ok(envelope.argv.includes('--model=fable'));
  });

  it('AC-7: a cloud fire body stays { text }, sources read routine and overrides are reported ignored', async () => {
    const config = withEnvironments({
      cloud: { target: 'claude-cloud', routine: 'trig_abc', tokenEnv: 'TOK' },
    });
    const labels = ['type::story', 'agent::ready', 'model::opus'];
    const dry = await runWith(
      makeDispatchBoard([ready(7, { labels })]),
      ['--env', 'cloud', '--dry-run', '7'],
      config,
      { env: { TOK: 'secret' } },
    );
    assert.deepEqual(JSON.parse(dry.envelope.request.body), {
      text: 'mandrel-deliver 7',
    });
    const expected = {
      model: { value: null, source: 'routine' },
      effort: { value: null, source: 'routine' },
      ignoredOverrides: ['model::opus'],
    };
    assert.deepEqual(dry.envelope.launchOptions, expected);
    const fired = await runWith(
      makeDispatchBoard([ready(7, { labels })]),
      ['--env', 'cloud', '7'],
      config,
      {
        env: { TOK: 'secret' },
        launchCloudImpl: async ({ storyId, environment }) => ({
          storyId,
          environment: environment.name,
          sessionUrl: 'https://claude.ai/code/session_1',
          commentPosted: true,
        }),
      },
    );
    assert.equal(fired.code, 0);
    assert.deepEqual(fired.envelope.launchOptions, expected);
  });
});

describe('usage errors', () => {
  for (const argv of [
    ['7'],
    ['--env', 'local'],
    ['--env', 'local', 'x'],
    ['--stop', '--resume', '7'],
    ['--bogus'],
  ]) {
    it(`${argv.join(' ')} exits 1 with an error envelope`, async () => {
      const board = makeDispatchBoard([ready(7)]);
      const { code, envelope } = await run(board, argv);
      assert.equal(code, 1);
      assert.equal(envelope.ok, false);
      assert.equal(typeof envelope.error, 'string');
      assert.deepEqual(board.writes, []);
    });
  }
});

describe('--help (AC-13)', () => {
  it('runDispatch prints the usage and does no work', async () => {
    const board = makeDispatchBoard([ready(7)]);
    const { out, deps } = board.capture();
    let touched = false;
    const code = await runDispatch(['--help'], {
      ...deps,
      config: undefined,
      resolveConfigImpl: () => {
        touched = true;
      },
    });
    assert.equal(code, 0);
    assert.equal(touched, false);
    assert.match(out.join(''), /^Usage: mandrel dispatch/);
  });

  it('the script exits 0 on --help with a usage block', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--help'], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Usage: mandrel dispatch/);
  });
});

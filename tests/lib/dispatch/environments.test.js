import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getAgentrcValidator } from '../../../.agents/scripts/lib/config-settings-schema.js';
import {
  commandFor,
  computeLoads,
  environmentOf,
  envLabel,
  resolveEnvironments,
} from '../../../.agents/scripts/lib/dispatch/environments.js';
import { gateLaunch } from '../../../.agents/scripts/lib/dispatch/launch-options.js';

/** The argv a launch spawns: the command with override labels for `options` filled in. */
function argvFor(command, id, sessionId, { model, effort } = {}) {
  const labels = [model && `model::${model}`, effort && `effort::${effort}`];
  const gated = gateLaunch(
    { ok: true, action: 'dispatch', environment: 'e' },
    [{ name: 'e', target: 'local', command }],
    { labels: labels.filter(Boolean) },
  );
  return commandFor(gated.launch.environment.command, id, sessionId);
}

const DEFAULT_COMMAND = [
  'claude',
  '-p',
  '/mandrel-deliver {id}',
  '--session-id',
  '{sessionId}',
  '--name',
  '◐ Delivery #{id}',
  '--output-format',
  'stream-json',
  '--verbose',
  '--model={model}',
  '--effort={effort}',
];

/** The argv the default command spawned before `{model}`/`{effort}` existed. */
const PRE_CHANGE_ARGV = (id) => [
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

describe('resolveEnvironments', () => {
  it('resolves exactly one local environment with capacity 1 when none is configured', () => {
    for (const config of [
      undefined,
      {},
      { delivery: {} },
      { delivery: { environments: {} } },
    ]) {
      assert.deepEqual(resolveEnvironments(config), [
        {
          name: 'local',
          target: 'local',
          capacity: 1,
          online: true,
          command: DEFAULT_COMMAND,
          model: null,
          effort: null,
        },
      ]);
    }
  });

  it('applies defaults to configured entries and keeps an explicit command', () => {
    const envs = resolveEnvironments({
      delivery: {
        environments: {
          box: { target: 'local', model: 'sonnet', effort: 'high' },
          big: { target: 'local', capacity: 3, command: ['run', '{id}'] },
        },
      },
    });
    assert.deepEqual(envs, [
      {
        name: 'box',
        target: 'local',
        capacity: 1,
        online: true,
        command: DEFAULT_COMMAND,
        model: 'sonnet',
        effort: 'high',
      },
      {
        name: 'big',
        target: 'local',
        capacity: 3,
        online: true,
        command: ['run', '{id}'],
        model: null,
        effort: null,
      },
    ]);
  });
});

describe('labels and load', () => {
  const envs = resolveEnvironments({});

  it('round-trips the env:: label', () => {
    assert.equal(envLabel('local'), 'env::local');
    assert.equal(environmentOf(['type::story', 'env::local']), 'local');
    assert.equal(environmentOf(['type::story']), null);
  });

  it('counts open labelled Stories in ready/executing/closing/blocked only', () => {
    const tickets = [
      { state: 'open', labels: ['env::local', 'agent::executing'] },
      { state: 'open', labels: ['env::local', 'agent::ready'] },
      { state: 'open', labels: ['env::local', 'agent::blocked'] },
      { state: 'open', labels: ['env::local', 'agent::closing'] },
      { state: 'closed', labels: ['env::local', 'agent::done'] },
      { state: 'open', labels: ['env::local', 'agent::review-spec'] },
      { state: 'open', labels: ['agent::executing'] },
      { state: 'open', labels: ['env::other', 'agent::executing'] },
    ];
    assert.deepEqual(computeLoads(envs, tickets), { local: 4 });
  });

  it('substitutes {id} in every argv element', () => {
    assert.deepEqual(commandFor(['a{id}', '/x {id} {id}', 'b'], 42), [
      'a42',
      '/x 42 42',
      'b',
    ]);
  });

  it('AC-2: substitutes {sessionId} in any command, keeping it for a dry run', () => {
    const custom = ['run', '--sid={sessionId}', '{id}'];
    assert.deepEqual(commandFor(custom, 7, 'u-1'), ['run', '--sid=u-1', '7']);
    assert.deepEqual(commandFor(custom, 7), ['run', '--sid={sessionId}', '7']);
  });

  it('AC-3: the default command with nothing resolved is the pre-change argv', () => {
    assert.deepEqual(argvFor(DEFAULT_COMMAND, 7), PRE_CHANGE_ARGV(7));
    assert.deepEqual(
      argvFor(DEFAULT_COMMAND, 7, undefined, { model: null, effort: null }),
      PRE_CHANGE_ARGV(7),
    );
  });

  it('AC-4: fills --model and --effort when they resolve', () => {
    assert.deepEqual(
      argvFor(DEFAULT_COMMAND, 7, 'u-1', {
        model: 'opus',
        effort: 'max',
      }).slice(-2),
      ['--model=opus', '--effort=max'],
    );
  });

  it('AC-5: a custom command takes the placeholders, drops unresolved elements, and gains nothing', () => {
    const custom = ['run', '{id}', '--m', '{model}', 'e={effort}'];
    assert.deepEqual(argvFor(custom, 7, 'u', { model: 'sonnet' }), [
      'run',
      '7',
      '--m',
      'sonnet',
    ]);
    assert.deepEqual(
      argvFor(['run', '{id}'], 7, 'u', { model: 'opus', effort: 'max' }),
      ['run', '7'],
    );
  });
});

describe('delivery.environments schema (AC-3)', () => {
  const validate = getAgentrcValidator();
  const withEnvs = (environments) => ({
    project: {
      paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
    },
    delivery: { environments },
  });

  it('accepts a populated map', () => {
    const ok = validate(
      withEnvs({
        local: { target: 'local' },
        'box-2': {
          target: 'local',
          capacity: 2,
          command: ['claude', '-p', 'x {id}'],
        },
        fast: { target: 'local', model: 'sonnet', effort: 'high' },
      }),
    );
    assert.equal(ok, true, JSON.stringify(validate.errors));
  });

  it('AC-1: accepts delivery.dispatchModels', () => {
    const config = withEnvs({ local: { target: 'local' } });
    config.delivery.dispatchModels = ['fable', 'claude-opus-4-1'];
    assert.equal(validate(config), true, JSON.stringify(validate.errors));
  });

  const badDispatchModels = {
    'a leading dash': ['-x'],
    'a space': ['a b'],
    'a duplicate': ['fable', 'fable'],
    'more than 43 characters': ['m'.repeat(44)],
  };
  for (const [what, dispatchModels] of Object.entries(badDispatchModels)) {
    it(`AC-1: rejects delivery.dispatchModels with ${what}`, () => {
      const config = withEnvs({ local: { target: 'local' } });
      config.delivery.dispatchModels = dispatchModels;
      assert.equal(validate(config), false);
    });
  }

  const rejects = {
    'an unknown target': { local: { target: 'cloud' } },
    'a name outside the pattern': { Bad_Name: { target: 'local' } },
    'a capacity below 1': { local: { target: 'local', capacity: 0 } },
    'a non-array command': {
      local: { target: 'local', command: 'claude -p x' },
    },
    'an unknown property on an entry': {
      local: { target: 'local', shell: true },
    },
    'an effort outside the levels': {
      local: { target: 'local', effort: 'extreme' },
    },
    'a model starting with -': { local: { target: 'local', model: '-rf' } },
    'a model containing a space': {
      local: { target: 'local', model: 'son net' },
    },
    'a model longer than 43 characters': {
      local: { target: 'local', model: 'm'.repeat(44) },
    },
    'a model on a claude-cloud entry': {
      c: {
        target: 'claude-cloud',
        routine: 'trig_1',
        tokenEnv: 'T',
        model: 'opus',
      },
    },
    'an effort on a claude-cloud entry': {
      c: {
        target: 'claude-cloud',
        routine: 'trig_1',
        tokenEnv: 'T',
        effort: 'max',
      },
    },
  };
  for (const [what, environments] of Object.entries(rejects)) {
    it(`rejects ${what}`, () => {
      assert.equal(validate(withEnvs(environments)), false);
      const paths = validate.errors.map((e) => e.instancePath).join(' ');
      assert.match(paths, /^\/delivery\/environments/);
    });
  }
});

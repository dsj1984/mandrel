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
          command: ['claude', '-p', '/mandrel-deliver {id}'],
        },
      ]);
    }
  });

  it('applies defaults to configured entries and keeps an explicit command', () => {
    const envs = resolveEnvironments({
      delivery: {
        environments: {
          box: { target: 'local' },
          big: { target: 'local', capacity: 3, command: ['run', '{id}'] },
        },
      },
    });
    assert.deepEqual(envs, [
      {
        name: 'box',
        target: 'local',
        capacity: 1,
        command: ['claude', '-p', '/mandrel-deliver {id}'],
      },
      { name: 'big', target: 'local', capacity: 3, command: ['run', '{id}'] },
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
      }),
    );
    assert.equal(ok, true, JSON.stringify(validate.errors));
  });

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
  };
  for (const [what, environments] of Object.entries(rejects)) {
    it(`rejects ${what}`, () => {
      assert.equal(validate(withEnvs(environments)), false);
      const paths = validate.errors.map((e) => e.instancePath).join(' ');
      assert.match(paths, /^\/delivery\/environments/);
    });
  }
});

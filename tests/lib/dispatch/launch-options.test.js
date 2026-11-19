import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EFFORT_LEVELS,
  gateLaunch,
  launchChoices,
  modelChoices,
  overridesOf,
  resolveLaunchOptions,
} from '../../../.agents/scripts/lib/dispatch/launch-options.js';

const CHOICES = ['opus', 'sonnet', 'haiku'];
const local = (extra = {}) => ({ target: 'local', ...extra });

describe('modelChoices', () => {
  it('lists the built-ins when nothing is configured', () => {
    assert.deepEqual(modelChoices(undefined), CHOICES);
    assert.deepEqual(launchChoices({}), {
      models: CHOICES,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    });
  });

  it('adds dispatchModels then environment models, deduplicated, skipping invalid values', () => {
    const config = {
      delivery: {
        dispatchModels: ['fable', 'sonnet'],
        environments: {
          a: { target: 'local', model: 'claude-opus-4-1' },
          b: { target: 'local' },
          c: { target: 'local', model: 'fable' },
          d: { target: 'local', model: '-bad' },
        },
      },
    };
    assert.deepEqual(modelChoices(config), [
      ...CHOICES,
      'fable',
      'claude-opus-4-1',
    ]);
  });
});

describe('labels', () => {
  it('reads the raw override values', () => {
    assert.deepEqual(overridesOf(['type::story', 'model::opus']), {
      model: 'opus',
      effort: null,
    });
    assert.deepEqual(overridesOf(undefined), { model: null, effort: null });
  });
});

describe('resolveLaunchOptions', () => {
  it('falls back to Claude Code defaults with nothing set', () => {
    assert.deepEqual(resolveLaunchOptions(local(), [], CHOICES), {
      ok: true,
      model: { value: null, source: 'claude-default' },
      effort: { value: null, source: 'claude-default' },
    });
  });

  it('takes the environment value, and an override beats it, independently', () => {
    const env = local({ model: 'sonnet', effort: 'low' });
    assert.deepEqual(resolveLaunchOptions(env, ['model::opus'], CHOICES), {
      ok: true,
      model: { value: 'opus', source: 'override' },
      effort: { value: 'low', source: 'environment' },
    });
  });

  it('names no value before an environment is chosen', () => {
    const result = resolveLaunchOptions(null, ['effort::high'], CHOICES);
    assert.deepEqual(result.model, { value: null, source: 'environment' });
    assert.deepEqual(result.effort, { value: 'high', source: 'override' });
  });

  it('reports a cloud routine and lists the overrides it ignores', () => {
    const cloud = { target: 'claude-cloud' };
    const routine = { value: null, source: 'routine' };
    assert.deepEqual(
      resolveLaunchOptions(cloud, ['effort::max', 'type::story'], CHOICES),
      {
        ok: true,
        model: routine,
        effort: routine,
        ignoredOverrides: ['effort::max'],
      },
    );
    assert.equal(
      'ignoredOverrides' in resolveLaunchOptions(cloud, [], CHOICES),
      false,
    );
  });

  const refusals = {
    'a model outside the allowlist': ['model::gpt'],
    'an empty model': ['model::'],
    'an effort outside the levels': ['effort::extreme'],
    'two model labels': ['model::opus', 'model::haiku'],
    'two effort labels': ['effort::low', 'effort::high'],
  };
  for (const [what, labels] of Object.entries(refusals)) {
    it(`fails closed on ${what}`, () => {
      const result = resolveLaunchOptions(local(), labels, CHOICES);
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'invalid-launch-option');
      assert.match(result.detail, /model::|effort::/);
    });
  }

  it('accepts every effort level', () => {
    for (const level of EFFORT_LEVELS) {
      const result = resolveLaunchOptions(
        local(),
        [`effort::${level}`],
        CHOICES,
      );
      assert.equal(result.effort.value, level);
    }
  });
});

describe('gateLaunch', () => {
  const environments = [
    { name: 'local', target: 'local', command: ['c', '--model={model}'] },
  ];
  const verdict = { ok: true, action: 'dispatch', environment: 'local' };

  it('passes a refusal or a stop through unchanged', () => {
    const refused = { ok: false, reason: 'x' };
    assert.equal(gateLaunch(refused, environments, { labels: [] }), refused);
    const stop = { ok: true, action: 'stop', environment: 'local' };
    assert.equal(
      gateLaunch(stop, environments, { labels: ['model::x'] }),
      stop,
    );
  });

  it('fills the launch command and carries the launch options', () => {
    const gated = gateLaunch(verdict, environments, {
      labels: ['model::opus'],
    });
    assert.deepEqual(gated.launch.environment.command, ['c', '--model=opus']);
    assert.equal(gated.launch.launchOptions.model.source, 'override');
    assert.equal(environments[0].command[1], '--model={model}');
  });

  it('turns an invalid override into a refusal', () => {
    assert.deepEqual(
      gateLaunch(verdict, environments, { labels: ['effort::huge'] }).reason,
      'invalid-launch-option',
    );
  });
});

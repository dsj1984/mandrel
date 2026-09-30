// tests/delivery-routing-config.test.js
//
// Unit tier: the `delivery.routing` accessor mirrors the framework-defaults
// pattern of `lib/config/ci.js#getCiDelivery`. Stage 6 dropped
// `singleDelivery`; Story #5313 dropped `freshCriticSampleRate`. These tests
// pin role-scoped agents, the ceremony profile, and the retired keys' absence.

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  applyAgentModel,
  getAgentModels,
  ROLE_AGENT_NAMES,
  resolveStoryWorkerModel,
} from '../.agents/scripts/lib/config/agent-models.js';
import {
  DELIVERY_ROUTING_DEFAULTS,
  getDeliveryRouting,
} from '../.agents/scripts/lib/config/delivery-routing.js';
import { getAgentrcValidator } from '../.agents/scripts/lib/config-settings-schema.js';

describe('getDeliveryRouting — defaults', () => {
  test('does not expose the retired singleDelivery kill-switch', () => {
    assert.equal('singleDelivery' in getDeliveryRouting({}), false);
    assert.equal('singleDelivery' in DELIVERY_ROUTING_DEFAULTS, false);
  });
});

describe('getDeliveryRouting — roleScopedAgents (Epic #4478, M7-B)', () => {
  test('roleScopedAgents defaults to TRUE when unset', () => {
    assert.equal(getDeliveryRouting({}).roleScopedAgents, true);
    assert.equal(getDeliveryRouting(null).roleScopedAgents, true);
    assert.equal(getDeliveryRouting(undefined).roleScopedAgents, true);
    assert.equal(DELIVERY_ROUTING_DEFAULTS.roleScopedAgents, true);
  });

  test('a non-boolean roleScopedAgents falls back to the default', () => {
    assert.equal(
      getDeliveryRouting({ delivery: { routing: { roleScopedAgents: 'yes' } } })
        .roleScopedAgents,
      true,
    );
  });

  test('reads false — the kill-switch (falls back to general-purpose)', () => {
    assert.equal(
      getDeliveryRouting({ delivery: { routing: { roleScopedAgents: false } } })
        .roleScopedAgents,
      false,
    );
    assert.equal(
      getDeliveryRouting({ routing: { roleScopedAgents: false } })
        .roleScopedAgents,
      false,
    );
    assert.equal(
      getDeliveryRouting({ roleScopedAgents: false }).roleScopedAgents,
      false,
    );
  });
});

describe('getDeliveryRouting — freshCriticSampleRate is retired (Story #5313)', () => {
  test('the accessor exposes no sampling rate and the defaults carry none', () => {
    assert.equal('freshCriticSampleRate' in getDeliveryRouting({}), false);
    assert.equal('freshCriticSampleRate' in DELIVERY_ROUTING_DEFAULTS, false);
  });

  test('a leftover rate in the config is ignored, not resolved', () => {
    const routing = getDeliveryRouting({
      delivery: { routing: { freshCriticSampleRate: 0.5 } },
    });
    assert.equal('freshCriticSampleRate' in routing, false);
    assert.equal(routing.ceremonyProfile, 'standard');
  });
});

describe('delivery.routing.agentModels (Story #5519)', () => {
  const MIN = {
    project: {
      paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
    },
  };
  const withModels = (agentModels) => ({
    ...MIN,
    delivery: { routing: { agentModels } },
  });

  test('defaults to an empty map — every role keeps its frontmatter default', () => {
    assert.deepEqual(getAgentModels({}), {});
    assert.deepEqual(getAgentModels(null), {});
  });

  test('the known roles are the four shipped role files', () => {
    assert.deepEqual([...ROLE_AGENT_NAMES].sort(), [
      'acceptance-critic',
      'auditor',
      'plan-critic',
      'story-worker',
    ]);
  });

  test('the validator accepts a known role and rejects an unknown one', () => {
    const validate = getAgentrcValidator();
    assert.equal(validate(withModels({ 'story-worker': 'sonnet' })), true);
    assert.equal(validate(withModels({ auditor: 'claude-opus-4-1' })), true);
    assert.equal(validate(withModels({ 'story-wroker': 'sonnet' })), false);
    assert.equal(validate(withModels({ auditor: 'x $(y)' })), false);
  });

  test('the accessor drops an unknown role or unsafe value', () => {
    assert.deepEqual(
      getAgentModels(
        withModels({ 'story-worker': 'sonnet', bogus: 'opus', auditor: 'a b' }),
      ),
      { 'story-worker': 'sonnet' },
    );
    assert.deepEqual(getAgentModels(withModels(['x'])), {});
  });

  test('the story-worker model: override, then frontmatter default, then inherit', () => {
    const resolve = (content, config = MIN) =>
      resolveStoryWorkerModel(
        { config, mainRepo: '/repo' },
        { readFileFn: () => content },
      );
    assert.equal(resolve('---\nname: a\nmodel: sonnet\n---\nb'), 'sonnet');
    assert.equal(
      resolve(
        '---\nname: a\nmodel: sonnet\n---\n',
        withModels({ 'story-worker': 'haiku' }),
      ),
      'haiku',
    );
    assert.equal(resolve('---\nname: a\n---\nmodel: opus\n'), 'inherit');
    assert.equal(resolve('no frontmatter'), 'inherit');
    assert.equal(
      resolveStoryWorkerModel(
        { config: MIN, mainRepo: '/repo' },
        {
          readFileFn: () => {
            throw new Error('ENOENT');
          },
        },
      ),
      'inherit',
    );
  });

  test('applyAgentModel replaces a declared model or appends one', () => {
    assert.equal(
      applyAgentModel('---\nname: a\nmodel: inherit\n---\nbody\n', 'sonnet'),
      '---\nname: a\nmodel: sonnet\n---\nbody\n',
    );
    assert.equal(
      applyAgentModel('---\nname: a\n---\nbody\n', 'opus'),
      '---\nname: a\nmodel: opus\n---\nbody\n',
    );
    assert.equal(applyAgentModel('body only\n', 'opus'), 'body only\n');
  });
});

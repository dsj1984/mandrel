import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveEnvironments } from '../../../.agents/scripts/lib/dispatch/environments.js';
import { decide } from '../../../.agents/scripts/lib/dispatch/verdict.js';

const environments = resolveEnvironments({});

const story = (labels, extra = {}) => ({
  id: 7,
  state: 'open',
  labels: ['type::story', ...labels],
  assignees: [],
  ...extra,
});

const base = (overrides) => ({
  environments,
  loads: { local: 0 },
  unmetDependencies: [],
  operator: 'me',
  ...overrides,
});

describe('decide — dispatch', () => {
  it('allows an agent::ready Story into an environment with room', () => {
    assert.deepEqual(
      decide(
        base({
          action: 'dispatch',
          story: story(['agent::ready']),
          envName: 'local',
        }),
      ),
      { ok: true, action: 'dispatch', environment: 'local', applyLabel: true },
    );
  });

  const refusals = [
    [
      'unknown-environment',
      { story: story(['agent::ready']), envName: 'nope' },
    ],
    [
      'epic',
      { story: story(['type::epic']), envName: 'local', children: [8, 9] },
    ],
    ['not-ready', { story: story(['agent::review-spec']), envName: 'local' }],
    [
      'already-dispatched',
      { story: story(['agent::executing', 'env::local']), envName: 'local' },
    ],
    [
      'foreign-lease',
      {
        story: story(['agent::ready'], { assignees: ['someone'] }),
        envName: 'local',
      },
    ],
    [
      'unmet-dependency',
      {
        story: story(['agent::ready']),
        envName: 'local',
        unmetDependencies: [3],
      },
    ],
    [
      'at-capacity',
      { story: story(['agent::ready']), envName: 'local', loads: { local: 1 } },
    ],
  ];
  for (const [reason, input] of refusals) {
    it(`refuses with ${reason}`, () => {
      const verdict = decide(base({ action: 'dispatch', ...input }));
      assert.equal(verdict.ok, false);
      assert.equal(verdict.reason, reason);
      assert.equal(typeof verdict.detail, 'string');
    });
  }

  it('names the children of an Epic', () => {
    const verdict = decide(
      base({
        action: 'dispatch',
        story: story(['type::epic']),
        envName: 'local',
        children: [8, 9],
      }),
    );
    assert.match(verdict.detail, /#8, #9/);
  });

  it('treats the operator lease as its own, case-insensitively', () => {
    const verdict = decide(
      base({
        action: 'dispatch',
        story: story(['agent::ready'], { assignees: ['ME'] }),
        envName: 'local',
      }),
    );
    assert.equal(verdict.ok, true);
  });
});

describe('decide — resume', () => {
  it('resumes a blocked Story in the environment its label names, adding no label', () => {
    assert.deepEqual(
      decide(
        base({
          action: 'resume',
          story: story(['agent::blocked', 'env::local']),
        }),
      ),
      { ok: true, action: 'resume', environment: 'local', applyLabel: false },
    );
  });

  it('refuses a Story that is not blocked with not-blocked', () => {
    const verdict = decide(
      base({
        action: 'resume',
        story: story(['agent::executing', 'env::local']),
      }),
    );
    assert.equal(verdict.reason, 'not-blocked');
  });

  it('refuses a different --env with wrong-environment', () => {
    const verdict = decide(
      base({
        action: 'resume',
        story: story(['agent::blocked', 'env::local']),
        envName: 'other',
      }),
    );
    assert.equal(verdict.reason, 'wrong-environment');
  });
});

describe('decide — stop', () => {
  it('stops a held Story', () => {
    assert.deepEqual(
      decide(
        base({
          action: 'stop',
          story: story(['agent::executing', 'env::local']),
        }),
      ),
      { ok: true, action: 'stop', environment: 'local', applyLabel: false },
    );
  });

  it('refuses a Story in agent::closing with closing', () => {
    const verdict = decide(
      base({ action: 'stop', story: story(['agent::closing', 'env::local']) }),
    );
    assert.equal(verdict.reason, 'closing');
  });

  it('refuses a Story no environment holds with wrong-environment', () => {
    const verdict = decide(
      base({ action: 'stop', story: story(['agent::ready']) }),
    );
    assert.equal(verdict.reason, 'wrong-environment');
  });
});

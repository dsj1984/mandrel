/**
 * limits-override.test.js — regression test for limits override resolution.
 *
 * Story #4163 collapsed the never-overridden `planning.maxTickets` operator
 * knob to a framework constant (`LIMITS_DEFAULTS.maxTickets`). The knob is
 * gone from the AJV schema, so a config that still declares it fails the
 * load-time validation gate; and `getLimits` resolves `maxTickets` from the
 * constant regardless of config. This regression test pins both halves of
 * that contract.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { Volume } from 'memfs';
import { LIMITS_DEFAULTS } from '../../../.agents/scripts/lib/config/limits.js';
import {
  getLimits,
  PROJECT_ROOT,
  resolveConfig,
} from '../../../.agents/scripts/lib/config-resolver.js';
import { setupFsMock } from '../fs-mock.js';

const REQ_PATHS = Object.freeze({
  agentRoot: '.agents',
  docsRoot: 'docs',
  tempRoot: 'temp',
});

describe('limits-override regression — maxTickets is a framework constant (Story #4163)', () => {
  let vol;

  beforeEach((t) => {
    vol = new Volume();
    setupFsMock(t, vol);
    resolveConfig({ bustCache: true });
  });

  function writeFixture(root, planning) {
    vol.mkdirSync(root, { recursive: true });
    vol.writeFileSync(
      path.join(root, '.agentrc.json'),
      JSON.stringify({
        project: { paths: REQ_PATHS },
        planning,
      }),
    );
  }

  it('rejects a config that still declares the removed planning.maxTickets knob', () => {
    const root = path.resolve(
      PROJECT_ROOT,
      '.worktrees/story-4163-fixture-rejects',
    );
    writeFixture(root, { maxTickets: 75 });

    assert.throws(
      () => resolveConfig({ bustCache: true, cwd: root }),
      /maxTickets|additional propert/i,
      'a config declaring the removed planning.maxTickets knob must fail validation',
    );
  });

  it('getLimits resolves maxTickets to the framework constant regardless of config', () => {
    const root = path.resolve(
      PROJECT_ROOT,
      '.worktrees/story-4163-fixture-constant',
    );
    // A valid (knob-free) config still resolves the constant budget.
    writeFixture(root, { riskHeuristics: ['no destructive ops'] });

    const resolved = resolveConfig({ bustCache: true, cwd: root });
    const limits = getLimits(resolved);
    assert.equal(
      limits.maxTickets,
      LIMITS_DEFAULTS.maxTickets,
      `getLimits(resolveConfig()).maxTickets must be the framework constant (${LIMITS_DEFAULTS.maxTickets}); got ${limits.maxTickets}`,
    );
    assert.equal(limits.maxTickets, 80);
  });
});

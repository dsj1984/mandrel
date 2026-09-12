/**
 * limits-override.test.js — regression test for limits override resolution.
 *
 * Story #4163 collapsed the never-overridden `planning.maxTickets` operator
 * knob to a framework constant, and Story #5312 deleted the constant itself:
 * the reviewability budget never fired on a real plan. The knob stays gone
 * from the AJV schema, so a config that still declares it fails the
 * load-time validation gate; and `getLimits` neither reads nor returns it.
 * This regression test pins both halves of that contract.
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

describe('limits-override regression — maxTickets is gone (Story #4163 → #5312)', () => {
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
      JSON.stringify({ project: { paths: REQ_PATHS }, planning }),
    );
  }

  it('rejects a config that still declares the removed planning.maxTickets knob', () => {
    const root = path.resolve(
      PROJECT_ROOT,
      '.worktrees/story-4163-fixture-rejected',
    );
    writeFixture(root, { maxTickets: 75 });
    assert.throws(
      () => resolveConfig({ bustCache: true, cwd: root }),
      /maxTickets|additional propert/i,
      'a config declaring the removed planning.maxTickets knob must fail validation',
    );
  });

  it('getLimits returns no maxTickets at all', () => {
    const root = path.resolve(
      PROJECT_ROOT,
      '.worktrees/story-4163-fixture-constant',
    );
    // A valid (knob-free) config resolves a limits surface with no budget.
    writeFixture(root, { navigation: { routeGlobs: ['pages/**'] } });

    const resolved = resolveConfig({ bustCache: true, cwd: root });
    const limits = getLimits(resolved);
    assert.equal('maxTickets' in limits, false);
    assert.equal('maxTickets' in LIMITS_DEFAULTS, false);
  });
});

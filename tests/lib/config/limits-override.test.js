/**
 * limits-override.test.js — regression test for limits override resolution.
 *
 * Post-reshape (Epic #1720 Story #1739) `maxTickets` lives under
 * `planning.maxTickets` (was `agentSettings.limits.maxTickets`).
 * `getLimits(resolveConfig())` must surface the operator override
 * end-to-end. Epic #2880 deleted the legacy output-side shim; the
 * canonical `planning.maxTickets` reader is the only supported path.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { Volume } from 'memfs';
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

const OVERRIDE_VALUE = 75;

describe('limits-override regression — post-reshape', () => {
  let vol;

  beforeEach((t) => {
    vol = new Volume();
    setupFsMock(t, vol);
    resolveConfig({ bustCache: true });
  });

  function writeFixture(root) {
    vol.mkdirSync(root, { recursive: true });
    vol.writeFileSync(
      path.join(root, '.agentrc.json'),
      JSON.stringify({
        project: { paths: REQ_PATHS },
        planning: { maxTickets: OVERRIDE_VALUE },
      }),
    );
  }

  it('getLimits(resolveConfig()) honours planning.maxTickets', () => {
    const root = path.resolve(
      PROJECT_ROOT,
      '.worktrees/story-1739-fixture-wrapper',
    );
    writeFixture(root);

    const resolved = resolveConfig({ bustCache: true, cwd: root });
    // Canonical `planning` block at the top level is the only supported path.
    assert.equal(typeof resolved.planning, 'object');
    assert.equal(resolved.planning.maxTickets, OVERRIDE_VALUE);

    const limits = getLimits(resolved);
    assert.equal(
      limits.maxTickets,
      OVERRIDE_VALUE,
      `getLimits(resolveConfig()).maxTickets must reflect the .agentrc.json override (${OVERRIDE_VALUE}); got ${limits.maxTickets}`,
    );
  });
});

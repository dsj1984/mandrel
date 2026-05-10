/**
 * limits-override.test.js — Story #1154 / Task #1172 regression test.
 *
 * Locks in the resolver-wrapper-key contract:
 *   - `resolveConfig()` returns `{ agentSettings, ... }` (NOT `{ settings, ... }`).
 *   - `getLimits(resolveConfig())` reads the operator's
 *     `agentSettings.limits.maxTickets` override end-to-end.
 *   - `getLimits(resolveConfig().agentSettings)` works against the bare bag too
 *     (the canonical two-shape accessor contract documented on every
 *     `lib/config/*.js` accessor).
 *
 * Why this exists. Prior to Story #1154 the resolver returned `settings:` while
 * every accessor (`getLimits`, `getQuality`, ...) read from `agentSettings:`.
 * Destructure sites silently fell through to defaults — `maxTickets: 75` set in
 * `.agentrc.json` resolved to the framework default 40 with no warning. The
 * Story renamed the wrapper key and swept ~50 destructure sites; this test
 * fails fast if either side regresses (the wrapper renamed back, an accessor
 * loses its `agentSettings` lookup, etc.).
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

// Schema-required `paths.*` roots so the AJV gate doesn't reject the
// fixture before we get to assert on `limits`.
const REQ_PATHS = Object.freeze({
  agentRoot: '.agents',
  docsRoot: 'docs',
  tempRoot: 'temp',
});

const OVERRIDE_VALUE = 75;

describe('limits-override regression — Story #1154', () => {
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
        agentSettings: {
          paths: REQ_PATHS,
          limits: { maxTickets: OVERRIDE_VALUE },
        },
      }),
    );
  }

  it('getLimits(resolveConfig()) honours agentSettings.limits.maxTickets', () => {
    const root = path.resolve(
      PROJECT_ROOT,
      '.worktrees/story-1154-fixture-wrapper',
    );
    writeFixture(root);

    const resolved = resolveConfig({ bustCache: true, cwd: root });
    // Sanity: the wrapper exposes `agentSettings`, NOT `settings`. Asserting
    // both directions makes the failure mode obvious if the rename regresses.
    assert.equal(
      typeof resolved.agentSettings,
      'object',
      'resolveConfig() must return an `agentSettings` key (Story #1154)',
    );
    assert.equal(
      resolved.settings,
      undefined,
      'resolveConfig() must NOT return a legacy `settings` key (Story #1154 rename)',
    );

    const limits = getLimits(resolved);
    assert.equal(
      limits.maxTickets,
      OVERRIDE_VALUE,
      `getLimits(resolveConfig()).maxTickets must reflect the .agentrc.json override (${OVERRIDE_VALUE}); got ${limits.maxTickets}`,
    );
  });

  it('getLimits(resolveConfig().agentSettings) honours the override against the bare bag', () => {
    const root = path.resolve(
      PROJECT_ROOT,
      '.worktrees/story-1154-fixture-bare',
    );
    writeFixture(root);

    const resolved = resolveConfig({ bustCache: true, cwd: root });
    // Bare-bag shape — what every accessor's two-shape contract calls
    // out: callers may pass either the wrapper or the unwrapped bag.
    const limits = getLimits(resolved.agentSettings);
    assert.equal(
      limits.maxTickets,
      OVERRIDE_VALUE,
      `getLimits(resolveConfig().agentSettings).maxTickets must reflect the override (${OVERRIDE_VALUE}); got ${limits.maxTickets}`,
    );
  });
});

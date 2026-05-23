import assert from 'node:assert/strict';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { Volume } from 'memfs';
import {
  PROJECT_ROOT,
  resolveConfig,
  resolveWorktreeEnabled,
  WORKTREE_ISOLATION_DEFAULTS,
} from '../../.agents/scripts/lib/config-resolver.js';
import { setupFsMock } from './fs-mock.js';

/**
 * Regression: `resolveWorktreeEnabled()` does
 * `Boolean(config.delivery.worktreeIsolation?.enabled)`, so an omitted
 * field resolves to `false` and silently disables worktrees. The fix
 * is `applyDefaults()` enriching the canonical block with
 * WORKTREE_ISOLATION_DEFAULTS at load time.
 */
describe('config-resolver — worktreeIsolation defaults', () => {
  let vol;

  beforeEach((t) => {
    vol = new Volume();
    setupFsMock(t, vol);
    resolveConfig({ bustCache: true });
  });

  it('applies WORKTREE_ISOLATION_DEFAULTS when delivery.worktreeIsolation is omitted', () => {
    vol.mkdirSync(PROJECT_ROOT, { recursive: true });
    vol.writeFileSync(
      path.join(PROJECT_ROOT, '.agentrc.json'),
      JSON.stringify({
        project: {
          paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
        },
        github: { owner: 'org', repo: 'repo', operatorHandle: '@me' },
      }),
    );
    const config = resolveConfig({ bustCache: true });
    const wi = config.delivery.worktreeIsolation;
    assert.equal(wi.enabled, true);
    assert.equal(wi.root, WORKTREE_ISOLATION_DEFAULTS.root);
    assert.equal(
      wi.nodeModulesStrategy,
      WORKTREE_ISOLATION_DEFAULTS.nodeModulesStrategy,
    );
    assert.deepEqual(wi.bootstrapFiles, [
      ...WORKTREE_ISOLATION_DEFAULTS.bootstrapFiles,
    ]);
    // And `resolveWorktreeEnabled()` must return true via the defaulted block.
    assert.equal(resolveWorktreeEnabled({ config }, {}), true);
  });
});

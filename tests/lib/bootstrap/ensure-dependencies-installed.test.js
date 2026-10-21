// tests/lib/bootstrap/ensure-dependencies-installed.test.js
/**
 * Unit tests for the bootstrap step that installs a consumer's dependencies.
 *
 * The step decides whether to spawn a package-manager install at all, which
 * manager to spawn, and whether a non-zero exit is fatal. All four outcomes
 * are pinned here against injected `fsImpl` / `spawnImpl` seams
 * (testing-standards § Unit) — no install is ever run.
 *
 * It previously had no test of its own and was covered only incidentally by
 * the suite of an unrelated module that Story #5114 deleted; this file makes
 * that coverage explicit rather than borrowed.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { applyProjectBootstrap } from '../../../.agents/scripts/lib/bootstrap/project-bootstrap.js';

/** The `install` phase's result, driven through the public entry point. */
async function ensureDependenciesInstalled(ctx) {
  const report = await applyProjectBootstrap({
    ...ctx,
    onlyPhases: ['install'],
  });
  return report.install;
}

const PROJECT_ROOT = '/consumer';
const SENTINEL = path.join(PROJECT_ROOT, 'node_modules', 'ajv', 'package.json');

/**
 * @param {{ present?: string[], status?: number }} options
 * @returns {{ ctx: object, spawns: Array<{ manager: string, args: string[] }> }}
 */
function makeCtx({ present = [], status = 0 } = {}) {
  const spawns = [];
  return {
    spawns,
    ctx: {
      projectRoot: PROJECT_ROOT,
      quiet: true,
      fsImpl: { existsSync: (p) => present.includes(p) },
      spawnImpl: (manager, args) => {
        spawns.push({ manager, args });
        return { status };
      },
    },
  };
}

describe('ensureDependenciesInstalled — skip paths', () => {
  it('skips when the ajv sentinel is already present', async () => {
    const { ctx, spawns } = makeCtx({ present: [SENTINEL] });

    const result = await ensureDependenciesInstalled(ctx);

    assert.equal(result.ran, false);
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'already-installed');
    assert.equal(spawns.length, 0);
  });

  it('skips on the skipInstall flag even with no node_modules', async () => {
    const { ctx, spawns } = makeCtx();

    const result = await ensureDependenciesInstalled({
      ...ctx,
      skipInstall: true,
    });

    assert.equal(result.ran, false);
    assert.equal(result.reason, 'skip-install-flag');
    assert.equal(spawns.length, 0);
  });
});

describe('ensureDependenciesInstalled — install paths', () => {
  it('runs the detected manager when the sentinel is absent', async () => {
    const { ctx, spawns } = makeCtx();

    const result = await ensureDependenciesInstalled(ctx);

    assert.equal(result.ran, true);
    assert.equal(result.skipped, false);
    assert.equal(spawns.length, 1);
    assert.deepEqual(spawns[0].args, ['install']);
  });

  it('defaults to npm when no lockfile identifies a manager', async () => {
    const { ctx } = makeCtx();
    assert.equal((await ensureDependenciesInstalled(ctx)).manager, 'npm');
  });

  it('selects pnpm from its lockfile', async () => {
    const { ctx, spawns } = makeCtx({
      present: [path.join(PROJECT_ROOT, 'pnpm-lock.yaml')],
    });

    assert.equal((await ensureDependenciesInstalled(ctx)).manager, 'pnpm');
    assert.equal(spawns[0].manager, 'pnpm');
  });

  it('throws with the exit code when the install fails', async () => {
    const { ctx } = makeCtx({ status: 7 });

    await assert.rejects(ensureDependenciesInstalled(ctx), /install failed/);
    await assert.rejects(ensureDependenciesInstalled(ctx), /exit 7/);
  });
});

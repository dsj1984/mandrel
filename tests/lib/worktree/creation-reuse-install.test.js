import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ensure } from '../../../.agents/scripts/lib/worktree/lifecycle/creation.js';

function quietLogger() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

/**
 * Build a ctx bag whose `git worktree list --porcelain` output reports an
 * existing worktree for the story, so `ensure` takes the reuse path.
 */
function reuseCtx({ wtRoot, wtPath, branch, installDependencies }) {
  const porcelain = [
    `worktree ${wtPath}`,
    'HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    `branch refs/heads/${branch}`,
    '',
  ].join('\n');
  return {
    repoRoot: path.dirname(wtRoot),
    worktreeRoot: wtRoot,
    platform: 'linux',
    config: { nodeModulesStrategy: 'per-worktree' },
    logger: quietLogger(),
    listCache: { list: null, ts: 0 },
    git: { gitSpawn: () => ({ status: 0, stdout: porcelain, stderr: '' }) },
    maybeWarnWindowsPath: () => null,
    copyBootstrapFiles: () => {},
    installDependencies,
  };
}

test('ensure (reuse): retries install when the prior install failed (no node_modules)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cre-'));
  try {
    const wtRoot = path.join(tmp, '.worktrees');
    const wtPath = path.join(wtRoot, 'story-7');
    fs.mkdirSync(wtPath, { recursive: true });
    fs.writeFileSync(path.join(wtPath, 'package.json'), '{}');
    // no node_modules → prior install failed/interrupted

    const installCalls = [];
    const ctx = reuseCtx({
      wtRoot,
      wtPath,
      branch: 'story-7',
      installDependencies: (_ctx, p) => {
        installCalls.push(p);
        return { status: 'installed' };
      },
    });

    const res = await ensure(ctx, 7, 'story-7');
    assert.equal(res.created, false);
    assert.deepEqual(installCalls, [wtPath]);
    assert.deepEqual(res.installStatus, { status: 'installed' });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('ensure (reuse): skips install when a completed install is present', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cre-'));
  try {
    const wtRoot = path.join(tmp, '.worktrees');
    const wtPath = path.join(wtRoot, 'story-8');
    const nm = path.join(wtPath, 'node_modules');
    fs.mkdirSync(nm, { recursive: true });
    fs.writeFileSync(path.join(wtPath, 'package.json'), '{}');
    fs.writeFileSync(path.join(nm, '.package-lock.json'), '{}');

    const installCalls = [];
    const ctx = reuseCtx({
      wtRoot,
      wtPath,
      branch: 'story-8',
      installDependencies: (_ctx, p) => {
        installCalls.push(p);
        return { status: 'installed' };
      },
    });

    const res = await ensure(ctx, 8, 'story-8');
    assert.equal(res.created, false);
    assert.deepEqual(installCalls, []);
    assert.deepEqual(res.installStatus, {
      status: 'skipped',
      reason: 'worktree-reused',
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

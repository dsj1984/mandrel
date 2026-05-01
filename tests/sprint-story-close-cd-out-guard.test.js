import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkCdOutGuard } from '../.agents/scripts/story-close.js';

test('checkCdOutGuard pure helper', async (t) => {
  await t.test('returns ok when --cwd was not set (single-tree mode)', () => {
    const result = checkCdOutGuard({
      cwdExplicit: false,
      mainCwd: '/repo',
      storyId: 746,
      currentCwd: '/repo/.worktrees/story-746',
    });
    assert.deepStrictEqual(result, { ok: true });
  });

  await t.test('returns ok when cwd is the main repo, not the worktree', () => {
    const result = checkCdOutGuard({
      cwdExplicit: true,
      mainCwd: '/repo',
      storyId: 746,
      currentCwd: '/repo',
    });
    assert.deepStrictEqual(result, { ok: true });
  });

  await t.test('returns ok when cwd is a sibling worktree', () => {
    const result = checkCdOutGuard({
      cwdExplicit: true,
      mainCwd: '/repo',
      storyId: 746,
      currentCwd: '/repo/.worktrees/story-999',
    });
    assert.deepStrictEqual(result, { ok: true });
  });

  await t.test('rejects when cwd matches the worktree being reaped', () => {
    const result = checkCdOutGuard({
      cwdExplicit: true,
      mainCwd: '/repo',
      storyId: 746,
      currentCwd: '/repo/.worktrees/story-746',
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /Refusing to close/);
    assert.match(result.message, /Current cwd:.*story-746/);
    assert.match(result.message, /Main repo:.*\/repo/);
    assert.match(
      result.message,
      /Run instead:\s+cd "\/repo".*story-close\.js --story 746/,
    );
  });

  await t.test('honors a non-default worktreeRoot from orchestration', () => {
    const result = checkCdOutGuard({
      cwdExplicit: true,
      mainCwd: '/repo',
      storyId: 42,
      worktreeRoot: 'custom-trees',
      currentCwd: '/repo/custom-trees/story-42',
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /story-42/);
  });
});

test('story-close cd-out guard (subprocess)', async (t) => {
  await t.test(
    'exits 1 with the remediation message when CWD is the worktree being reaped',
    () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-out-guard-'));
      try {
        const wt = path.join(tmp, '.worktrees', 'story-999');
        fs.mkdirSync(wt, { recursive: true });
        const SCRIPT = path.resolve('.agents/scripts/story-close.js');
        const result = spawnSync(
          'node',
          [SCRIPT, '--story', '999', '--cwd', tmp],
          { cwd: wt, encoding: 'utf8' },
        );
        assert.equal(result.status, 1);
        const output = result.stdout + result.stderr;
        assert.match(output, /Refusing to close/);
        assert.match(output, /story-999/);
        assert.match(output, /Run instead:\s+cd "/);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  );

  await t.test(
    'does not fire in single-tree mode (no --cwd, no AGENT_WORKTREE_ROOT)',
    () => {
      // Single-tree mode never reaches the guard's reject branch. Verify by
      // calling the script with no --cwd from a tmp dir; it should fail for
      // a different reason (e.g. ticket fetch / config) but the output must
      // not contain the cd-out guard's remediation message.
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-out-guard-st-'));
      try {
        const SCRIPT = path.resolve('.agents/scripts/story-close.js');
        const env = { ...process.env };
        delete env.AGENT_WORKTREE_ROOT;
        const result = spawnSync('node', [SCRIPT, '--story', '999'], {
          cwd: tmp,
          encoding: 'utf8',
          env,
        });
        const output = result.stdout + result.stderr;
        assert.doesNotMatch(
          output,
          /Refusing to close while CWD is the worktree/,
        );
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  );
});

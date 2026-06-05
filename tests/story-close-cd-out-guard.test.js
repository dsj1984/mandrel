import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  checkCdOutGuard,
  describeAutoRefreshOutcome,
} from '../.agents/scripts/story-close.js';

test('describeAutoRefreshOutcome pure helper', async (t) => {
  await t.test('amended (legacy) → progress envelope with SHA', () => {
    const e = describeAutoRefreshOutcome({ status: 'amended', sha: 'abc1234' });
    assert.strictEqual(e.channel, 'progress');
    assert.strictEqual(e.label, 'AUTO-REFRESH');
    assert.match(e.message, /abc1234/);
  });
  await t.test('committed (Story #2205) → progress envelope with SHA', () => {
    const e = describeAutoRefreshOutcome({
      status: 'committed',
      sha: 'def5678',
    });
    assert.strictEqual(e.channel, 'progress');
    assert.strictEqual(e.label, 'AUTO-REFRESH');
    assert.match(e.message, /def5678/);
  });
  await t.test(
    'refused with dedup → progress envelope marks already present',
    () => {
      const e = describeAutoRefreshOutcome({
        status: 'refused',
        refusalReasons: ['a', 'b'],
        dedup: true,
      });
      assert.strictEqual(e.channel, 'progress');
      assert.match(e.message, /2 cap breach/);
      assert.match(e.message, /already present/);
    },
  );
  await t.test('refused with signalAppended', () => {
    const e = describeAutoRefreshOutcome({
      status: 'refused',
      refusalReasons: ['a'],
      dedup: false,
      signalAppended: true,
    });
    assert.match(e.message, /appended/);
  });
  await t.test('refused without signal', () => {
    const e = describeAutoRefreshOutcome({
      status: 'refused',
      refusalReasons: [],
      dedup: false,
      signalAppended: false,
    });
    assert.match(e.message, /not written/);
  });
  await t.test('failed → warn channel with reason + detail', () => {
    const e = describeAutoRefreshOutcome({
      status: 'failed',
      reason: 'oops',
      detail: 'why',
    });
    assert.strictEqual(e.channel, 'warn');
    assert.match(e.message, /oops/);
    assert.match(e.message, /why/);
  });
  await t.test('unknown status → null', () => {
    assert.strictEqual(describeAutoRefreshOutcome({ status: 'noop' }), null);
    assert.strictEqual(describeAutoRefreshOutcome(null), null);
  });
});

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

  await t.test(
    'fires when currentCwd and mainCwd differ only by a symlinked prefix (Story #3672)',
    () => {
      // Regression for the macOS false-negative: the derived `workCwd`
      // (built from the verbatim `--cwd` arg via path.resolve, symlinks NOT
      // resolved) and `process.cwd()` (OS-canonicalized) point at the same
      // worktree but carry different string prefixes (`/tmp` vs
      // `/private/tmp`). Inject a realpath seam that canonicalizes both
      // operands to one fixed string per story segment, proving the guard
      // realpath's BOTH sides before comparing — platform-independently
      // (the seam keys off the trailing `story-<id>` segment, so it does not
      // care whether the host's path.resolve produced POSIX or Windows
      // separators on the way in).
      const realpath = (p) =>
        /story-746$/.test(p) ? '/private/tmp/repo/.worktrees/story-746' : p;
      const result = checkCdOutGuard({
        cwdExplicit: true,
        mainCwd: '/tmp/repo',
        storyId: 746,
        currentCwd: '/private/tmp/repo/.worktrees/story-746',
        realpath,
      });
      assert.equal(result.ok, false);
      assert.match(result.message, /Refusing to close/);
      assert.match(result.message, /story-746/);
    },
  );

  await t.test(
    'stays ok for a sibling worktree even after symlink canonicalization (Story #3672)',
    () => {
      // The canonicalized worktree prefix matches, but the story segment
      // differs — the guard must still let a sibling worktree through.
      // Canonicalize the two distinct story segments to two distinct strings.
      const realpath = (p) => {
        if (/story-746$/.test(p))
          return '/private/tmp/repo/.worktrees/story-746';
        if (/story-999$/.test(p))
          return '/private/tmp/repo/.worktrees/story-999';
        return p;
      };
      const result = checkCdOutGuard({
        cwdExplicit: true,
        mainCwd: '/tmp/repo',
        storyId: 746,
        currentCwd: '/private/tmp/repo/.worktrees/story-999',
        realpath,
      });
      assert.deepStrictEqual(result, { ok: true });
    },
  );

  await t.test(
    'falls back to path.resolve when realpath throws on a missing path (Story #3672)',
    () => {
      // realpathSync throws on not-yet-existing paths; the guard must fall
      // back to path.resolve so a worktree dir that does not exist yet still
      // compares correctly. Both operands resolve to the same worktree, so
      // the fallback must still produce matching strings and the guard fires.
      const realpath = () => {
        throw new Error('ENOENT');
      };
      const result = checkCdOutGuard({
        cwdExplicit: true,
        mainCwd: '/repo',
        storyId: 746,
        currentCwd: '/repo/.worktrees/story-746',
        realpath,
      });
      assert.equal(result.ok, false);
      assert.match(result.message, /Refusing to close/);
    },
  );
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
        // story-close.js spawns descendants (e.g. analyze-execution)
        // which inherit cwd=tmp. On Windows those descendants can keep
        // a handle on tmp after spawnSync returns, so even a retried
        // rmSync may EBUSY/EPERM. Cleanup is best-effort — the OS reaps
        // %TEMP% — and biome rightly forbids re-throwing inside finally
        // because it would overwrite a real assertion failure from try.
        // Swallow any cleanup error silently.
        try {
          fs.rmSync(tmp, {
            recursive: true,
            force: true,
            maxRetries: 10,
            retryDelay: 100,
          });
        } catch {
          // intentional: leave %TEMP% leftovers to the OS rather than
          // mask the real test outcome with a teardown failure.
        }
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
        // story-close.js spawns descendants (e.g. analyze-execution)
        // which inherit cwd=tmp. On Windows those descendants can keep
        // a handle on tmp after spawnSync returns, so even a retried
        // rmSync may EBUSY/EPERM. Cleanup is best-effort — the OS reaps
        // %TEMP% — and biome rightly forbids re-throwing inside finally
        // because it would overwrite a real assertion failure from try.
        // Swallow any cleanup error silently.
        try {
          fs.rmSync(tmp, {
            recursive: true,
            force: true,
            maxRetries: 10,
            retryDelay: 100,
          });
        } catch {
          // intentional: leave %TEMP% leftovers to the OS rather than
          // mask the real test outcome with a teardown failure.
        }
      }
    },
  );
});

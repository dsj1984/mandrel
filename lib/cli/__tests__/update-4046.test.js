// lib/cli/__tests__/update-4046.test.js
/**
 * Unit tests for Story #4046 fixes in lib/cli/update.js:
 *   A1b — explicit `mandrel update` always probes the registry (bypasses cache)
 *   A1c — STEP_PLAN includes sync-commands between runSync and runMigrations
 *
 * Tier: unit (testing-standards § Unit). All I/O — filesystem, network, and
 * child-process — is mocked via injectable seams.
 *
 * Security (security-baseline § 5 — Data Leakage & Logging): fixtures carry
 * only version strings and file paths; no tokens or credentials.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import run, { runUpdate } from '../update.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Capture stdout/stderr writes and the exit code. */
function makeCapture() {
  const out = [];
  const err = [];
  let exitCode = null;
  return {
    out,
    err,
    get exitCode() {
      return exitCode;
    },
    write: (s) => out.push(s),
    writeErr: (s) => err.push(s),
    exit: (code) => {
      exitCode = code;
    },
  };
}

// ---------------------------------------------------------------------------
// A1c — STEP_PLAN ordering in --dry-run output
// ---------------------------------------------------------------------------

describe('runUpdate — STEP_PLAN includes sync-commands (A1c)', () => {
  it('--dry-run output lists sync-commands between runSync and runMigrations', async () => {
    const cap = makeCapture();
    await runUpdate({
      argv: ['--dry-run'],
      currentVersion: '1.43.0',
      resolveTargetVersion: async () => '1.44.0',
      npmUpdate: async () => {},
      write: cap.write,
      writeErr: cap.writeErr,
      exit: cap.exit,
    });

    const joined = cap.out.join('');
    // All six core steps plus changelog must appear (sync-agents added by
    // Story #4528/#4530).
    assert.match(joined, /npm-update/);
    assert.match(joined, /runSync/);
    assert.match(joined, /sync-commands/);
    assert.match(joined, /sync-agents/);
    assert.match(joined, /runMigrations/);
    assert.match(joined, /doctor/);
    assert.match(joined, /surface changelog/);
    assert.match(joined, /Dry run: no files written/);

    // sync-commands must appear AFTER runSync and BEFORE runMigrations;
    // sync-agents must appear AFTER sync-commands and BEFORE runMigrations.
    const syncIdx = joined.indexOf('runSync');
    const syncCmdIdx = joined.indexOf('sync-commands');
    const syncAgentsIdx = joined.indexOf('sync-agents');
    const migrateIdx = joined.indexOf('runMigrations');
    assert.ok(
      syncIdx < syncCmdIdx,
      'runSync must precede sync-commands in the step plan',
    );
    assert.ok(
      syncCmdIdx < syncAgentsIdx,
      'sync-commands must precede sync-agents in the step plan',
    );
    assert.ok(
      syncAgentsIdx < migrateIdx,
      'sync-agents must precede runMigrations in the step plan',
    );
  });

  it('dry-run does not hard-code a step outside STEP_PLAN', async () => {
    const cap = makeCapture();
    await runUpdate({
      argv: ['--dry-run'],
      currentVersion: '1.43.0',
      resolveTargetVersion: async () => '1.44.0',
      npmUpdate: async () => {},
      write: cap.write,
      writeErr: cap.writeErr,
      exit: cap.exit,
    });

    const joined = cap.out.join('');
    // The step count in the output should match STEP_PLAN length (7 steps:
    // npm-update, runSync, sync-commands, sync-agents, runMigrations,
    // doctor, surface changelog). Verify the step-list lines match.
    const stepLines = joined.split('\n').filter((l) => /^\s+\d+\./.test(l));
    assert.equal(
      stepLines.length,
      7,
      `expected 7 numbered step lines; got:\n${stepLines.join('\n')}`,
    );
  });
});

// ---------------------------------------------------------------------------
// A1c — sync-commands spawned in re-exec path before runMigrations
// ---------------------------------------------------------------------------

describe('runUpdate — re-exec path spawns sync-commands before migrate (A1c)', () => {
  it('spawns sync → sync-commands → sync-agents → migrate → doctor in that order', async () => {
    const cap = makeCapture();
    const spawnCalls = [];

    const result = await runUpdate({
      argv: [],
      currentVersion: '1.43.0',
      resolveTargetVersion: async () => '1.44.0',
      npmUpdate: async () => {},
      spawnPhase: async (phase, _args, _opts) => {
        spawnCalls.push(phase);
        return { ok: true, stdout: '', stderr: '' };
      },
      cwd: () => '/fake/cwd',
      resolveBinScript: () => '/fake/cwd/node_modules/mandrel/bin/mandrel.js',
      surfaceChangelog: async () => {},
      write: cap.write,
      writeErr: cap.writeErr,
      exit: cap.exit,
    });

    assert.deepEqual(spawnCalls, [
      'sync',
      'sync-commands',
      'sync-agents',
      'migrate',
      'doctor',
    ]);
    assert.deepEqual(result.stepsRun, [
      'npm-update',
      'runSync',
      'sync-commands',
      'sync-agents',
      'runMigrations',
      'doctor',
    ]);
    assert.equal(result.ok, true);
  });

  it('throws when sync-commands phase exits non-zero', async () => {
    const cap = makeCapture();

    await assert.rejects(
      () =>
        runUpdate({
          argv: [],
          currentVersion: '1.43.0',
          resolveTargetVersion: async () => '1.44.0',
          npmUpdate: async () => {},
          spawnPhase: async (phase) => {
            if (phase === 'sync-commands') {
              return { ok: false, stdout: '', stderr: 'error' };
            }
            return { ok: true, stdout: '', stderr: '' };
          },
          cwd: () => '/fake/cwd',
          resolveBinScript: () =>
            '/fake/cwd/node_modules/mandrel/bin/mandrel.js',
          surfaceChangelog: async () => {},
          write: cap.write,
          writeErr: cap.writeErr,
          exit: cap.exit,
        }),
      /mandrel sync-commands.*new binary exited non-zero/,
    );
  });
});

// ---------------------------------------------------------------------------
// A1b — explicit update bypasses the 24h cache
// ---------------------------------------------------------------------------

describe('run default export — cache bypass on explicit update (A1b)', () => {
  it('probes the registry even when a fresh cache exists', async () => {
    const cap = makeCapture();
    let runnerCallCount = 0;

    // Build a fresh cache (written just now — within 24h).
    const freshCheckedAt = new Date().toISOString();
    const cacheContents = JSON.stringify({
      latestVersion: '1.44.0',
      checkedAt: freshCheckedAt,
    });

    const cacheMap = new Map([
      ['/virtual/temp/version-check.json', cacheContents],
    ]);
    const written = [];

    const fakeFsForUpdate = {
      readFileSync(p, _enc) {
        if (!cacheMap.has(p)) {
          const e = Object.assign(new Error(`ENOENT: ${p}`), {
            code: 'ENOENT',
          });
          throw e;
        }
        return cacheMap.get(p);
      },
      writeFileSync(p, content) {
        written.push({ p, content });
        // Persist the refresh so the cache is updated.
        cacheMap.set(p, content);
      },
      mkdirSync() {},
      existsSync(p) {
        return cacheMap.has(p);
      },
    };

    // versionRunner is called only on a cache miss or forced bypass.
    const fakeRunner = () => {
      runnerCallCount += 1;
      return '1.44.0';
    };

    await run(['--dry-run'], {
      currentVersion: '1.43.0',
      cachePath: '/virtual/temp/version-check.json',
      fs: fakeFsForUpdate,
      versionRunner: fakeRunner,
      // No npmUpdate needed for dry-run; no install happens.
      write: cap.write,
      writeErr: cap.writeErr,
      exit: cap.exit,
    });

    // The runner MUST have been called even though the cache was fresh —
    // explicit update bypasses the 24h window (Story #4046 A1b).
    assert.equal(
      runnerCallCount,
      1,
      'versionRunner must be invoked on an explicit update even when cache is fresh',
    );
    // The cache was refreshed with the probed version.
    assert.equal(
      written.length,
      1,
      'cache must be refreshed after the registry probe',
    );
  });

  it('still performs the registry probe when cache is absent', async () => {
    const cap = makeCapture();
    let runnerCallCount = 0;

    const fakeFsForUpdate = {
      readFileSync() {
        const e = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        throw e;
      },
      writeFileSync() {},
      mkdirSync() {},
      existsSync() {
        return false;
      },
    };

    const fakeRunner = () => {
      runnerCallCount += 1;
      return '1.44.0';
    };

    await run(['--dry-run'], {
      currentVersion: '1.43.0',
      cachePath: '/virtual/temp/version-check.json',
      fs: fakeFsForUpdate,
      versionRunner: fakeRunner,
      write: cap.write,
      writeErr: cap.writeErr,
      exit: cap.exit,
    });

    assert.equal(runnerCallCount, 1);
  });
});

// lib/cli/__tests__/update-drift.test.js
/**
 * Unit tests for Story #4065: drift-aware no-op short-circuit in
 * lib/cli/update.js.
 *
 * The no-op short-circuit previously gated only on the installed package
 * version. When `installedVersion === newestPublished` it returned immediately,
 * leaving a drifted `.agents/` unhealed. This file verifies the new behaviour:
 *
 *   1. Version current + drift detected  → runUpdate invokes sync phase(s) and
 *      returns `action: 'resynced'` (or `action: 'dry-run'` under --dry-run).
 *   2. Version current + no drift        → runUpdate still returns
 *      `action: 'up-to-date'` with `stepsRun: []` (true no-op preserved).
 *   3. --dry-run + drift                 → reports that a heal will run;
 *      emits no "Already up to date" message; writes nothing.
 *
 * Tier: unit (testing-standards § Unit). All seams including `checkDrift` are
 * injected; no real filesystem, package, or network call occurs.
 *
 * Security (security-baseline § 5): fixtures contain only version strings and
 * boolean drift signals; no credentials, tokens, or env values.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runUpdate } from '../update.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Capture stdout/stderr writes and exit code. */
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

/**
 * Minimal seam set for a "version already current" scenario. The injected
 * `checkDrift` toggle lets us probe both the drifted and non-drifted branches
 * without touching the real filesystem.
 *
 * @param {{ drifted?: boolean }} [opts]
 */
function makeUpToDateSeams({ drifted = false } = {}) {
  const calls = [];
  return {
    calls,
    currentVersion: '1.61.0',
    resolveTargetVersion: async () => {
      calls.push('resolveTargetVersion');
      return '1.61.0'; // same as current — no-op path
    },
    checkDrift: async () => {
      calls.push(`checkDrift:${drifted}`);
      return drifted;
    },
    // npmUpdate, runSync, etc. must NOT be called on the up-to-date/resync path —
    // inject them as call-recording stubs so we can assert they were never invoked.
    npmUpdate: async (v) => {
      calls.push(`npmUpdate:${v}`);
    },
    runSync: (_opts) => {
      calls.push('runSync');
      return {};
    },
    runMigrations: ({ fromVersion, toVersion }) => {
      calls.push(`runMigrations:${fromVersion}->${toVersion}`);
      return {};
    },
    runDoctor: async () => {
      calls.push('runDoctor');
      return { ok: true, results: [] };
    },
    surfaceChangelog: async (v) => {
      calls.push(`surfaceChangelog:${v}`);
    },
  };
}

// ---------------------------------------------------------------------------
// AC: version current + drift → sync phases run, action: 'resynced'
// ---------------------------------------------------------------------------

describe('runUpdate — drift-aware no-op (Story #4065)', () => {
  it('invokes the sync phase(s) and returns resynced when version is current but drift detected (in-process path)', async () => {
    const seams = makeUpToDateSeams({ drifted: true });
    const cap = makeCapture();

    const result = await runUpdate({
      argv: [],
      ...seams,
      write: cap.write,
      writeErr: cap.writeErr,
      exit: cap.exit,
    });

    // checkDrift must have been called.
    assert.ok(
      seams.calls.includes('checkDrift:true'),
      'checkDrift should be called on the up-to-date path',
    );

    // npm-update and migrations must NOT run — version is already current.
    assert.ok(
      !seams.calls.some((c) => String(c).startsWith('npmUpdate:')),
      'npmUpdate must NOT be called when version is already current',
    );
    assert.ok(
      !seams.calls.some((c) => String(c).startsWith('runMigrations:')),
      'runMigrations must NOT be called when version is already current',
    );
    assert.ok(
      !seams.calls.includes('runDoctor'),
      'runDoctor must NOT be called on the resync path (in-process)',
    );

    // runSync must have been called (in-process path; no spawnPhase injected).
    assert.ok(
      seams.calls.includes('runSync'),
      'runSync should be called to heal the drift',
    );

    assert.equal(result.ok, true);
    assert.equal(result.action, 'resynced');
    assert.deepEqual(result.stepsRun, ['runSync']);
    assert.equal(cap.exitCode, null);

    // Output should mention drift healing, not "Already up to date".
    const stdout = cap.out.join('');
    assert.ok(
      !stdout.includes('Already up to date'),
      'should NOT print "Already up to date" when drift is detected',
    );
    assert.match(stdout, /[Hh]eal/);
  });

  it('returns up-to-date when version is current AND no drift (true no-op preserved)', async () => {
    const seams = makeUpToDateSeams({ drifted: false });
    const cap = makeCapture();

    const result = await runUpdate({
      argv: [],
      ...seams,
      write: cap.write,
      writeErr: cap.writeErr,
      exit: cap.exit,
    });

    assert.equal(result.ok, true);
    assert.equal(result.action, 'up-to-date');
    assert.deepEqual(result.stepsRun, []);
    assert.equal(cap.exitCode, null);

    // The "Already up to date" message must still appear for the true no-op.
    assert.match(cap.out.join(''), /Already up to date/);

    // npmUpdate, runSync, runMigrations, runDoctor must NOT be called.
    assert.ok(
      !seams.calls.some((c) => String(c).startsWith('npmUpdate:')),
      'npmUpdate must not be called',
    );
    assert.ok(!seams.calls.includes('runSync'), 'runSync must not be called');
    assert.ok(
      !seams.calls.some((c) => String(c).startsWith('runMigrations:')),
      'runMigrations must not be called',
    );
    assert.ok(
      !seams.calls.includes('runDoctor'),
      'runDoctor must not be called',
    );
  });

  it('invokes spawnPhase for sync + sync-commands on the re-exec drift-heal path', async () => {
    const spawnCalls = [];
    const cap = makeCapture();

    const result = await runUpdate({
      argv: [],
      currentVersion: '1.61.0',
      resolveTargetVersion: async () => '1.61.0',
      checkDrift: async () => true, // drift present
      npmUpdate: async () => {},
      spawnPhase: async (phase, args, opts) => {
        spawnCalls.push({ phase, args, cwd: opts.cwd });
        return { ok: true, stdout: '', stderr: '' };
      },
      surfaceChangelog: async () => {},
      write: cap.write,
      writeErr: cap.writeErr,
      exit: cap.exit,
      cwd: () => '/fake/consumer',
    });

    // Exactly sync + sync-commands, no migrate, no doctor on the heal path.
    const phaseNames = spawnCalls.map((c) => c.phase);
    assert.deepEqual(phaseNames, ['sync', 'sync-commands']);

    assert.equal(result.ok, true);
    assert.equal(result.action, 'resynced');
    assert.deepEqual(result.stepsRun, ['runSync', 'sync-commands']);
    assert.equal(cap.exitCode, null);
  });

  it('throws when spawnPhase sync exits non-zero on the drift-heal path', async () => {
    const cap = makeCapture();

    await assert.rejects(
      () =>
        runUpdate({
          argv: [],
          currentVersion: '1.61.0',
          resolveTargetVersion: async () => '1.61.0',
          checkDrift: async () => true,
          npmUpdate: async () => {},
          spawnPhase: async (phase) => {
            if (phase === 'sync')
              return { ok: false, stdout: '', stderr: 'boom' };
            return { ok: true, stdout: '', stderr: '' };
          },
          write: cap.write,
          writeErr: cap.writeErr,
          exit: cap.exit,
          cwd: () => '/fake/consumer',
        }),
      /mandrel sync.*installed binary exited non-zero/,
    );
  });

  it('throws when spawnPhase sync-commands exits non-zero on the drift-heal path', async () => {
    const cap = makeCapture();

    await assert.rejects(
      () =>
        runUpdate({
          argv: [],
          currentVersion: '1.61.0',
          resolveTargetVersion: async () => '1.61.0',
          checkDrift: async () => true,
          npmUpdate: async () => {},
          spawnPhase: async (phase) => {
            if (phase === 'sync-commands')
              return { ok: false, stdout: '', stderr: 'commands failed' };
            return { ok: true, stdout: '', stderr: '' };
          },
          write: cap.write,
          writeErr: cap.writeErr,
          exit: cap.exit,
          cwd: () => '/fake/consumer',
        }),
      /mandrel sync-commands.*installed binary exited non-zero/,
    );
  });

  // ---
  // AC: --dry-run + drift → reports heal will run (not "Already up to date")
  // ---

  it('--dry-run with drift: reports sync heal planned (not "Already up to date"), writes nothing', async () => {
    const seams = makeUpToDateSeams({ drifted: true });
    const cap = makeCapture();

    const result = await runUpdate({
      argv: ['--dry-run'],
      ...seams,
      write: cap.write,
      writeErr: cap.writeErr,
      exit: cap.exit,
    });

    assert.equal(result.action, 'dry-run');
    assert.equal(result.dryRun, true);
    assert.deepEqual(result.stepsRun, []);
    assert.equal(cap.exitCode, null);

    const stdout = cap.out.join('');
    // Must NOT say "Already up to date" when drift is detected.
    assert.ok(
      !stdout.includes('Already up to date'),
      'should NOT print "Already up to date" on dry-run with drift',
    );
    // Must mention the heal plan.
    assert.match(stdout, /drift/i);
    assert.match(stdout, /[Dd]ry run/);

    // No effectful seams called.
    assert.ok(
      !seams.calls.some((c) => String(c).startsWith('npmUpdate:')),
      'npmUpdate must not be called on dry-run',
    );
    assert.ok(
      !seams.calls.includes('runSync'),
      'runSync must not be called on dry-run',
    );
  });

  it('--dry-run without drift: still prints "Already up to date"', async () => {
    const seams = makeUpToDateSeams({ drifted: false });
    const cap = makeCapture();

    const result = await runUpdate({
      argv: ['--dry-run'],
      ...seams,
      write: cap.write,
      writeErr: cap.writeErr,
      exit: cap.exit,
    });

    assert.equal(result.action, 'up-to-date');
    assert.match(cap.out.join(''), /Already up to date/);
    assert.deepEqual(result.stepsRun, []);
  });

  // ---
  // AC: checkDrift is only called on the up-to-date path (not on version bump)
  // ---

  it('does NOT call checkDrift when a real version bump is needed', async () => {
    const driftCalls = [];
    const cap = makeCapture();

    await runUpdate({
      argv: [],
      currentVersion: '1.60.0',
      resolveTargetVersion: async () => '1.61.0', // newer → take bump path
      checkDrift: async () => {
        driftCalls.push('called');
        return true;
      },
      npmUpdate: async () => {},
      runSync: () => ({}),
      runMigrations: () => ({}),
      runDoctor: async () => ({ ok: true, results: [] }),
      surfaceChangelog: async () => {},
      write: cap.write,
      writeErr: cap.writeErr,
      exit: cap.exit,
    });

    assert.deepEqual(
      driftCalls,
      [],
      'checkDrift must NOT be called when a version bump is available',
    );
  });
});

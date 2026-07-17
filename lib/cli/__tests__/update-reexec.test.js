// lib/cli/__tests__/update-reexec.test.js
/**
 * Unit tests for the Story #4034 re-exec fix in lib/cli/update.js, updated
 * for Story #4046 A1c (sync-commands step added to STEP_PLAN) and Story
 * #4528/#4530 (sync-agents step added).
 *
 * After `npm-update` lands the new version, the post-install phases
 * (sync, sync-commands, sync-agents, migrate, doctor) MUST run from the
 * newly-installed binary rather than in the still-running old process. The
 * `spawnPhase` seam is the injectable boundary that makes this fully
 * testable without a real npm install.
 *
 * Coverage contract (Story #4034 + Story #4046 A1c + Story #4528/#4530;
 * Story #4182 made `spawnPhase` the sole post-install path — No-Shim):
 *   - Post-install phases run through `spawnPhase` (the re-exec boundary).
 *   - Phases are spawned in the correct order:
 *     sync → sync-commands → sync-agents → migrate → doctor.
 *   - `mandrel migrate` receives `--from <current>` and `--to <target>`.
 *   - `sync-commands` runs after `sync` and before `migrate` so the
 *     `commands-in-sync` doctor check validates the post-sync state.
 *   - The bin path passed to `spawnPhase` is the resolved `bin/mandrel.js`
 *     *script* (Story #4613), never the `node_modules/.bin/mandrel` shim.
 *   - A failing sync phase throws and exits non-zero (never silently continues).
 *   - A failing sync-commands phase throws and exits non-zero.
 *   - A failing migrate phase throws and exits non-zero.
 *   - A non-zero doctor phase maps to `action: 'doctor-failed'` + exit 1.
 *   - `resolveNewBinScriptPath` resolves `<packageRoot>/bin/mandrel.js` and
 *     never returns the `.bin` shim (the pnpm EACCES fix).
 *   - `defaultSpawnPhase` spawns node against the bin script, routes
 *     stdout/stderr through the write sinks, and throws on spawn error.
 *
 * Tier: unit (testing-standards § Unit). All seams — including `spawnPhase`
 * — are injected; no real child process, filesystem, or network call occurs.
 *
 * Security (security-baseline § 5 — Data Leakage & Logging): fixtures carry
 * only version strings and paths; no tokens, credentials, or env values.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  defaultSpawnPhase,
  resolveNewBinScriptPath,
  runUpdate,
} from '../update.js';

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

/**
 * The bin **script** path the re-exec resolves to (Story #4613). runUpdate now
 * resolves `<packageRoot>/bin/mandrel.js` via `resolveBinScript` and spawns
 * node against it, so the seam returns a deterministic script path anchored at
 * the fake consumer's `node_modules/mandrel/` rather than the retired
 * `node_modules/.bin/mandrel` shim.
 */
const FAKE_BIN_SCRIPT = path.join(
  '/fake/consumer',
  'node_modules',
  'mandrel',
  'bin',
  'mandrel.js',
);

/**
 * Build a minimal seam set for a minor-ahead non-dry-run run.
 * `spawnPhase` replaces the in-process runSync/runMigrations/runDoctor.
 */
function makeReExecSeams({
  target = '1.44.0',
  current = '1.43.0',
  spawnResults = {},
} = {}) {
  const calls = [];
  return {
    calls,
    currentVersion: current,
    resolveBinScript: () => FAKE_BIN_SCRIPT,
    resolveTargetVersion: async () => {
      calls.push('resolve');
      return target;
    },
    npmUpdate: async (version) => {
      calls.push(`npm-update:${version}`);
    },
    spawnPhase: async (phase, args, opts) => {
      calls.push({ phase, args, binPath: opts.binPath, cwd: opts.cwd });
      const result = spawnResults[phase] ?? {
        ok: true,
        stdout: '',
        stderr: '',
      };
      return result;
    },
    surfaceChangelog: async (version) => {
      calls.push(`changelog:${version}`);
    },
    cwd: () => '/fake/consumer',
  };
}

// ---------------------------------------------------------------------------
// AC: spawnPhase is invoked for post-install phases when injected
// ---------------------------------------------------------------------------

describe('runUpdate — re-exec path via spawnPhase', () => {
  it('routes post-install phases through spawnPhase, not in-process seams', async () => {
    const cap = makeCapture();
    const seams = makeReExecSeams({ target: '1.44.0', current: '1.43.0' });

    const result = await runUpdate({
      argv: [],
      ...seams,
      write: cap.write,
      writeErr: cap.writeErr,
      exit: cap.exit,
    });

    // npm-update ran, then all five phases were spawned via spawnPhase
    // (sync → sync-commands → sync-agents → migrate → doctor — Story #4046
    // A1c; sync-agents added by Story #4528/#4530).
    const phaseNames = seams.calls
      .filter((c) => typeof c === 'object' && c.phase)
      .map((c) => c.phase);
    assert.deepEqual(phaseNames, [
      'sync',
      'sync-commands',
      'sync-agents',
      'migrate',
      'doctor',
    ]);

    // The in-process runSync/runMigrations/runDoctor were NOT invoked directly
    // (there are no 'runSync' / 'runMigrations' / 'runDoctor' string entries).
    assert.ok(
      !seams.calls.some(
        (c) => c === 'runSync' || c === 'runMigrations' || c === 'runDoctor',
      ),
      'in-process seams must NOT be called when spawnPhase is injected',
    );

    assert.equal(result.ok, true);
    assert.equal(result.action, 'updated');
    assert.deepEqual(result.stepsRun, [
      'npm-update',
      'runSync',
      'sync-commands',
      'sync-agents',
      'runMigrations',
      'doctor',
    ]);
    assert.equal(cap.exitCode, null);
  });

  it('passes correct ordered argv to each phase: sync→sync-commands→sync-agents→migrate(--from,--to)→doctor', async () => {
    const cap = makeCapture();
    const seams = makeReExecSeams({ target: '1.50.0', current: '1.43.0' });

    await runUpdate({
      argv: [],
      ...seams,
      write: cap.write,
      writeErr: cap.writeErr,
      exit: cap.exit,
    });

    const phases = seams.calls.filter((c) => typeof c === 'object' && c.phase);
    // sync, sync-commands, sync-agents, migrate, doctor = 5 phases
    // (Story #4046 A1c; sync-agents added by Story #4528/#4530)
    assert.equal(phases.length, 5);

    assert.equal(phases[0].phase, 'sync');
    assert.deepEqual(phases[0].args, []);

    assert.equal(phases[1].phase, 'sync-commands');
    assert.deepEqual(phases[1].args, []);

    assert.equal(phases[2].phase, 'sync-agents');
    assert.deepEqual(phases[2].args, []);

    assert.equal(phases[3].phase, 'migrate');
    assert.deepEqual(phases[3].args, ['--from', '1.43.0', '--to', '1.50.0']);

    assert.equal(phases[4].phase, 'doctor');
    assert.deepEqual(phases[4].args, []);
  });

  it('resolves the new bin script path (not the node_modules/.bin shim)', async () => {
    const cap = makeCapture();
    const seams = makeReExecSeams({ target: '1.44.0', current: '1.43.0' });

    await runUpdate({
      argv: [],
      ...seams,
      write: cap.write,
      writeErr: cap.writeErr,
      exit: cap.exit,
    });

    const phases = seams.calls.filter((c) => typeof c === 'object' && c.phase);
    // sync, sync-commands, sync-agents, migrate, doctor = 5 phases
    // (Story #4046 A1c; sync-agents added by Story #4528/#4530)
    assert.equal(phases.length, 5);
    for (const p of phases) {
      assert.equal(
        p.binPath,
        FAKE_BIN_SCRIPT,
        `phase '${p.phase}' binPath should resolve to the new bin script`,
      );
      // Story #4613 — the re-exec must NOT target the .bin shim; pnpm links it
      // straight at a non-executable .js, so a direct spawn fails with EACCES.
      assert.ok(
        !p.binPath.includes(path.join('node_modules', '.bin')),
        `phase '${p.phase}' must not target the node_modules/.bin shim`,
      );
      assert.ok(
        p.binPath.endsWith(path.join('bin', 'mandrel.js')),
        `phase '${p.phase}' binPath should be a resolvable .js script`,
      );
      assert.equal(p.cwd, '/fake/consumer');
    }
  });

  it('throws when sync phase exits non-zero (never silently materialises stale payload)', async () => {
    const cap = makeCapture();
    const seams = makeReExecSeams({
      target: '1.44.0',
      current: '1.43.0',
      spawnResults: { sync: { ok: false, stdout: '', stderr: 'sync failed' } },
    });

    await assert.rejects(
      () =>
        runUpdate({
          argv: [],
          ...seams,
          write: cap.write,
          writeErr: cap.writeErr,
          exit: cap.exit,
        }),
      /mandrel sync.*new binary exited non-zero/,
    );

    // sync-commands, migrate and doctor must NOT have been called after sync failure.
    const phases = seams.calls.filter((c) => typeof c === 'object' && c.phase);
    assert.deepEqual(
      phases.map((p) => p.phase),
      ['sync'],
    );
  });

  it('throws when sync-commands phase exits non-zero', async () => {
    const cap = makeCapture();
    const seams = makeReExecSeams({
      target: '1.44.0',
      current: '1.43.0',
      spawnResults: {
        'sync-commands': {
          ok: false,
          stdout: '',
          stderr: 'sync-commands failed',
        },
      },
    });

    await assert.rejects(
      () =>
        runUpdate({
          argv: [],
          ...seams,
          write: cap.write,
          writeErr: cap.writeErr,
          exit: cap.exit,
        }),
      /mandrel sync-commands.*new binary exited non-zero/,
    );

    // migrate and doctor must NOT have been called after sync-commands failure.
    const phases = seams.calls.filter((c) => typeof c === 'object' && c.phase);
    assert.deepEqual(
      phases.map((p) => p.phase),
      ['sync', 'sync-commands'],
    );
  });

  it('throws when migrate phase exits non-zero', async () => {
    const cap = makeCapture();
    const seams = makeReExecSeams({
      target: '1.44.0',
      current: '1.43.0',
      spawnResults: {
        migrate: { ok: false, stdout: '', stderr: 'migrate failed' },
      },
    });

    await assert.rejects(
      () =>
        runUpdate({
          argv: [],
          ...seams,
          write: cap.write,
          writeErr: cap.writeErr,
          exit: cap.exit,
        }),
      /mandrel migrate.*new binary exited non-zero/,
    );

    // doctor must NOT have been called after migrate failure.
    const phases = seams.calls.filter((c) => typeof c === 'object' && c.phase);
    assert.deepEqual(
      phases.map((p) => p.phase),
      ['sync', 'sync-commands', 'sync-agents', 'migrate'],
    );
  });

  it('maps non-zero doctor to doctor-failed + exit 1', async () => {
    const cap = makeCapture();
    const seams = makeReExecSeams({
      target: '1.44.0',
      current: '1.43.0',
      spawnResults: {
        doctor: {
          ok: false,
          stdout: '',
          stderr: 'agents-drift: drift detected',
        },
      },
    });

    const result = await runUpdate({
      argv: [],
      ...seams,
      write: cap.write,
      writeErr: cap.writeErr,
      exit: cap.exit,
    });

    assert.equal(result.ok, false);
    assert.equal(result.action, 'doctor-failed');
    assert.equal(cap.exitCode, 1);
    assert.match(cap.err.join(''), /doctor reported failures/);
  });

  it('still runs the changelog seam after a successful re-exec cycle', async () => {
    const cap = makeCapture();
    const seams = makeReExecSeams({ target: '1.44.0', current: '1.43.0' });

    await runUpdate({
      argv: [],
      ...seams,
      write: cap.write,
      writeErr: cap.writeErr,
      exit: cap.exit,
    });

    assert.ok(
      seams.calls.includes('changelog:1.44.0'),
      'changelog seam must fire after successful re-exec phases',
    );
  });
});

// ---------------------------------------------------------------------------
// AC (Story #4182 — No-Shim): spawnPhase is the SOLE post-install path. The
// retired in-process runSync/runMigrations/runDoctor fallback no longer exists,
// so a live upgrade without spawnPhase has no path to materialise the payload.
// ---------------------------------------------------------------------------

describe('runUpdate — no in-process fallback (No-Shim, Story #4182)', () => {
  it('does not silently materialise via an in-process path when spawnPhase is absent on a live upgrade', async () => {
    const cap = makeCapture();

    // npm-update applies, but with no spawnPhase there is no longer any
    // in-process seam to run sync/migrate/doctor — the orchestrator can no
    // longer reach `action: 'updated'` without the re-exec boundary.
    await assert.rejects(
      () =>
        runUpdate({
          argv: [],
          currentVersion: '1.43.0',
          resolveTargetVersion: async () => '1.44.0',
          npmUpdate: async () => {},
          // spawnPhase intentionally omitted.
          surfaceChangelog: async () => {},
          cwd: () => '/fake/consumer',
          resolveBinScript: () => FAKE_BIN_SCRIPT,
          write: cap.write,
          writeErr: cap.writeErr,
          exit: cap.exit,
        }),
      TypeError,
      'a live upgrade with no spawnPhase must fail rather than fall back to a retired in-process path',
    );
  });
});

// ---------------------------------------------------------------------------
// AC (Story #4613): resolveNewBinScriptPath resolves the bin *script* — not
// the node_modules/.bin shim — so the re-exec is layout-agnostic under pnpm.
// ---------------------------------------------------------------------------

describe('resolveNewBinScriptPath', () => {
  it('resolves <packageRoot>/bin/mandrel.js from the consumer root', () => {
    const p = resolveNewBinScriptPath('/some/project', {
      resolvePackageRoot: (fromDir) => {
        assert.equal(
          fromDir,
          '/some/project',
          'resolution must be anchored at the consumer project root',
        );
        return path.join('/some', 'project', 'node_modules', 'mandrel');
      },
    });
    assert.equal(
      p,
      path.join(
        '/some',
        'project',
        'node_modules',
        'mandrel',
        'bin',
        'mandrel.js',
      ),
    );
  });

  it('never returns the node_modules/.bin shim (pnpm EACCES fix)', () => {
    const p = resolveNewBinScriptPath('/project', {
      resolvePackageRoot: () =>
        path.join('/project', 'node_modules', 'mandrel'),
    });
    assert.ok(
      !p.includes(path.join('node_modules', '.bin')),
      `expected no node_modules/.bin shim, got: ${p}`,
    );
    assert.ok(
      p.endsWith(path.join('bin', 'mandrel.js')),
      `expected a resolvable .js script, got: ${p}`,
    );
  });

  it('carries no platform-conditional .cmd suffix', () => {
    const p = resolveNewBinScriptPath('/project', {
      resolvePackageRoot: () =>
        path.join('/project', 'node_modules', 'mandrel'),
    });
    // Spawning node against a .js script is identical on every platform, so the
    // resolved target is `.js` regardless of process.platform (no `.cmd` shim).
    assert.ok(
      p.endsWith('.js') && !p.endsWith('.cmd'),
      `expected a .js script with no .cmd shim, got: ${p}`,
    );
  });
});

// ---------------------------------------------------------------------------
// AC: defaultSpawnPhase routes output through write sinks and throws on error
// ---------------------------------------------------------------------------

describe('defaultSpawnPhase — output routing and error handling', () => {
  it('routes child stdout through the write sink', () => {
    const out = [];
    const err = [];
    const fakeSpawn = (_bin, _args, _opts) => ({
      status: 0,
      stdout: 'Materialized 832 files\n',
      stderr: '',
      error: undefined,
    });

    defaultSpawnPhase('sync', [], {
      binPath: '/fake/bin/mandrel',
      cwd: '/project',
      write: (s) => out.push(s),
      writeErr: (s) => err.push(s),
      spawnFn: fakeSpawn,
    });

    assert.deepEqual(out, ['Materialized 832 files\n']);
    assert.deepEqual(err, []);
  });

  it('routes child stderr through the writeErr sink', () => {
    const out = [];
    const err = [];
    const fakeSpawn = () => ({
      status: 0,
      stdout: '',
      stderr: 'warning: something\n',
      error: undefined,
    });

    defaultSpawnPhase('doctor', [], {
      binPath: '/fake/bin/mandrel',
      cwd: '/project',
      write: (s) => out.push(s),
      writeErr: (s) => err.push(s),
      spawnFn: fakeSpawn,
    });

    assert.deepEqual(out, []);
    assert.deepEqual(err, ['warning: something\n']);
  });

  it('returns ok:false when child exits non-zero', () => {
    const fakeSpawn = () => ({
      status: 1,
      stdout: '',
      stderr: 'drift detected',
      error: undefined,
    });

    const result = defaultSpawnPhase('doctor', [], {
      binPath: '/fake/bin/mandrel',
      cwd: '/project',
      write: () => {},
      writeErr: () => {},
      spawnFn: fakeSpawn,
    });

    assert.equal(result.ok, false);
  });

  it('returns ok:true when child exits 0', () => {
    const fakeSpawn = () => ({
      status: 0,
      stdout: 'all good',
      stderr: '',
      error: undefined,
    });

    const result = defaultSpawnPhase('sync', [], {
      binPath: '/fake/bin/mandrel',
      cwd: '/project',
      write: () => {},
      writeErr: () => {},
      spawnFn: fakeSpawn,
    });

    assert.equal(result.ok, true);
  });

  it('throws a descriptive error when the spawn itself fails (ENOENT)', () => {
    const fakeSpawn = () => ({
      status: null,
      stdout: '',
      stderr: '',
      error: new Error('spawnSync mandrel ENOENT'),
    });

    assert.throws(
      () =>
        defaultSpawnPhase('sync', [], {
          binPath: '/fake/bin/mandrel',
          cwd: '/project',
          write: () => {},
          writeErr: () => {},
          spawnFn: fakeSpawn,
        }),
      /failed to spawn.*mandrel sync.*new binary.*ENOENT/,
    );
  });

  it('spawns node against the bin script with the correct argv vector', () => {
    const calls = [];
    const fakeSpawn = (bin, args, opts) => {
      calls.push({ bin, args, opts });
      return { status: 0, stdout: '', stderr: '', error: undefined };
    };

    const binScript = path.join('/nm', 'mandrel', 'bin', 'mandrel.js');
    defaultSpawnPhase('migrate', ['--from', '1.43.0', '--to', '1.44.0'], {
      binPath: binScript,
      cwd: '/proj',
      write: () => {},
      writeErr: () => {},
      spawnFn: fakeSpawn,
    });

    assert.equal(calls.length, 1);
    // Story #4613 — the child is `node <binScript> <phase> …`, not a direct
    // spawn of the bin. This is what makes the re-exec pnpm/layout-agnostic:
    // node reads a plain .js file, so the exec bit and shebang are irrelevant.
    assert.equal(calls[0].bin, process.execPath);
    assert.deepEqual(calls[0].args, [
      binScript,
      'migrate',
      '--from',
      '1.43.0',
      '--to',
      '1.44.0',
    ]);
    assert.equal(calls[0].opts.cwd, '/proj');
    // No shell flag on any platform — the win32-only branch was retired.
    assert.equal(calls[0].opts.shell, undefined);
  });
});

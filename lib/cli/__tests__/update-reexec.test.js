// lib/cli/__tests__/update-reexec.test.js
/**
 * Unit tests for the Story #4034 re-exec fix in lib/cli/update.js.
 *
 * After `npm-update` lands the new version, the post-install phases
 * (sync, migrate, doctor) MUST run from the newly-installed binary rather
 * than in the still-running old process. The `spawnPhase` seam is the
 * injectable boundary that makes this fully testable without a real npm
 * install.
 *
 * Coverage contract (Story #4034):
 *   - When `spawnPhase` is injected, post-install phases run through it
 *     (re-exec path) instead of the in-process runSync/runMigrations/runDoctor.
 *   - Phases are spawned in the correct order: sync → migrate → doctor.
 *   - `mandrel migrate` receives `--from <current>` and `--to <target>`.
 *   - The new bin path passed to `spawnPhase` is resolved from the cwd's
 *     `node_modules/.bin/mandrel` (the production path).
 *   - A failing sync phase throws and exits non-zero (never silently continues).
 *   - A failing migrate phase throws and exits non-zero.
 *   - A non-zero doctor phase maps to `action: 'doctor-failed'` + exit 1.
 *   - `resolveNewBinPath` returns the correct platform path.
 *   - `defaultSpawnPhase` routes stdout/stderr through the write sinks and
 *     throws on spawn error.
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

import { defaultSpawnPhase, resolveNewBinPath, runUpdate } from '../update.js';

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

    // npm-update ran, then all three phases were spawned via spawnPhase.
    const phaseNames = seams.calls
      .filter((c) => typeof c === 'object' && c.phase)
      .map((c) => c.phase);
    assert.deepEqual(phaseNames, ['sync', 'migrate', 'doctor']);

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
      'runMigrations',
      'doctor',
    ]);
    assert.equal(cap.exitCode, null);
  });

  it('passes correct ordered argv to each phase: sync→migrate(--from,--to)→doctor', async () => {
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
    assert.equal(phases.length, 3);

    assert.equal(phases[0].phase, 'sync');
    assert.deepEqual(phases[0].args, []);

    assert.equal(phases[1].phase, 'migrate');
    assert.deepEqual(phases[1].args, ['--from', '1.43.0', '--to', '1.50.0']);

    assert.equal(phases[2].phase, 'doctor');
    assert.deepEqual(phases[2].args, []);
  });

  it('resolves new bin path from cwd/node_modules/.bin/mandrel', async () => {
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
    const expectedBin = resolveNewBinPath('/fake/consumer');
    for (const p of phases) {
      assert.equal(
        p.binPath,
        expectedBin,
        `phase '${p.phase}' binPath should resolve to new bin`,
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

    // migrate and doctor must NOT have been called after sync failure.
    const phases = seams.calls.filter((c) => typeof c === 'object' && c.phase);
    assert.deepEqual(
      phases.map((p) => p.phase),
      ['sync'],
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
      ['sync', 'migrate'],
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
// AC: in-process seams still work when spawnPhase is NOT injected
// (backward compatibility — pre-Story-#4034 tests must stay green)
// ---------------------------------------------------------------------------

describe('runUpdate — in-process backward-compat path (no spawnPhase)', () => {
  it('uses injected runSync/runMigrations/runDoctor when spawnPhase is absent', async () => {
    const calls = [];
    const cap = makeCapture();

    const result = await runUpdate({
      argv: [],
      currentVersion: '1.43.0',
      resolveTargetVersion: async () => '1.44.0',
      npmUpdate: async (v) => {
        calls.push(`npm-update:${v}`);
      },
      runSync: (_opts) => {
        calls.push('runSync');
        return {};
      },
      runMigrations: ({ fromVersion, toVersion }) => {
        calls.push(`runMigrations:${fromVersion}->${toVersion}`);
        return { applied: [], skipped: [] };
      },
      runDoctor: async () => {
        calls.push('runDoctor');
        return { ok: true, results: [] };
      },
      surfaceChangelog: async (v) => {
        calls.push(`changelog:${v}`);
      },
      write: cap.write,
      writeErr: cap.writeErr,
      exit: cap.exit,
    });

    assert.deepEqual(calls, [
      'npm-update:1.44.0',
      'runSync',
      'runMigrations:1.43.0->1.44.0',
      'runDoctor',
      'changelog:1.44.0',
    ]);
    assert.equal(result.ok, true);
    assert.equal(result.action, 'updated');
    assert.equal(cap.exitCode, null);
  });
});

// ---------------------------------------------------------------------------
// AC: resolveNewBinPath returns the correct platform path
// ---------------------------------------------------------------------------

describe('resolveNewBinPath', () => {
  it('returns node_modules/.bin/mandrel on POSIX', () => {
    // We cannot force-test win32 on non-win32 but we can verify the POSIX shape.
    if (process.platform !== 'win32') {
      const p = resolveNewBinPath('/some/project');
      assert.equal(
        p,
        path.join('/some', 'project', 'node_modules', '.bin', 'mandrel'),
      );
    }
  });

  it('returns a path that ends with mandrel or mandrel.cmd', () => {
    const p = resolveNewBinPath('/project');
    assert.ok(
      p.endsWith('mandrel') || p.endsWith('mandrel.cmd'),
      `expected path to end with mandrel[.cmd], got: ${p}`,
    );
  });

  it('contains node_modules/.bin in the path', () => {
    const p = resolveNewBinPath('/project');
    assert.ok(
      p.includes(path.join('node_modules', '.bin')),
      `expected node_modules/.bin in path, got: ${p}`,
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

  it('passes the correct argv vector to the spawn function', () => {
    const calls = [];
    const fakeSpawn = (bin, args, opts) => {
      calls.push({ bin, args, opts });
      return { status: 0, stdout: '', stderr: '', error: undefined };
    };

    defaultSpawnPhase('migrate', ['--from', '1.43.0', '--to', '1.44.0'], {
      binPath: '/nm/.bin/mandrel',
      cwd: '/proj',
      write: () => {},
      writeErr: () => {},
      spawnFn: fakeSpawn,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].bin, '/nm/.bin/mandrel');
    assert.deepEqual(calls[0].args, [
      'migrate',
      '--from',
      '1.43.0',
      '--to',
      '1.44.0',
    ]);
    assert.equal(calls[0].opts.cwd, '/proj');
    // Shell flag is win32-gated: true only on Windows.
    assert.equal(calls[0].opts.shell, process.platform === 'win32');
  });
});

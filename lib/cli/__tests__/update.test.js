// lib/cli/__tests__/update.test.js
/**
 * Unit tests for lib/cli/update.js — the `mandrel update` orchestrator.
 *
 * Every test drives runUpdate through injectable seams (currentVersion,
 * resolveTargetVersion, npmUpdate, spawnPhase, surfaceChangelog, write,
 * writeErr, exit). No real npm process, no real filesystem I/O, and no real
 * network call occur (testing-standards § Unit: all external network /
 * filesystem I/O MUST be mocked). Post-install phases (sync, sync-commands,
 * migrate, doctor) run through the `spawnPhase` re-exec boundary — the sole
 * post-install execution path since Story #4182 retired the in-process
 * runSync/runMigrations/runDoctor seam set (No-Shim).
 *
 * Coverage contract (Story #3503 AC — core update paths):
 *   - Module shape: runUpdate named export + default function export.
 *   - Happy path: a minor-ahead target drives the ordered phases
 *     sync → sync-commands → migrate → doctor (after npm-update) and reports
 *     success only when the injected doctor phase is all-pass.
 *   - --dry-run prints the planned target + step plan and invokes no
 *     effectful seam.
 *   - A failing doctor phase downgrades the run to a non-zero exit even
 *     after the bump applied.
 *   - up-to-date short-circuit performs no steps.
 *
 * Major-version resolution has its own file: update-version-resolution.test.js.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { runInstallCommand } from '../../../.agents/scripts/lib/install-cmd-parser.js';
import update, {
  defaultNpmUpdate,
  defaultVersionRunner,
  detectPackageManager,
  resolveInstallCmd,
  runUpdate,
} from '../update.js';

/**
 * Build an in-memory `node:fs` fake whose `existsSync` reports the given
 * basenames as present — enough surface for `detectPackageManager` to probe
 * lockfiles without touching the real filesystem (testing-standards § Unit:
 * mock all filesystem I/O).
 *
 * @param {string[]} present - lockfile basenames to report as present.
 */
function makeLockFs(present = []) {
  const set = new Set(present);
  return { existsSync: (p) => set.has(path.basename(String(p))) };
}

// ---------------------------------------------------------------------------
// Capture + seam helpers
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
 * Build the recording seam set for a happy-path run. Post-install phases run
 * through the `spawnPhase` re-exec boundary (the sole post-install path since
 * Story #4182). `doctorOk` toggles the injected `doctor` phase verdict so the
 * all-pass / failure branches are both exercised through the same harness; the
 * `migrate` phase records its `--from`/`--to` argv so the version range is
 * still asserted.
 */
function makeSeams({ target = '1.44.0', doctorOk = true } = {}) {
  const calls = [];
  return {
    calls,
    currentVersion: '1.43.0',
    resolveTargetVersion: async () => {
      calls.push('resolveTargetVersion');
      return target;
    },
    npmUpdate: async (version) => {
      calls.push(`npmUpdate:${version}`);
    },
    spawnPhase: async (phase, args) => {
      if (phase === 'migrate') {
        // Record the version range the way the old runMigrations seam did so
        // the from→to threading assertions still hold.
        const from = args[args.indexOf('--from') + 1];
        const to = args[args.indexOf('--to') + 1];
        calls.push(`migrate:${from}->${to}`);
      } else {
        calls.push(phase);
      }
      const ok = phase === 'doctor' ? doctorOk : true;
      return { ok, stdout: '', stderr: ok ? '' : 'agents-materialized failed' };
    },
    cwd: () => '/fake/consumer',
    surfaceChangelog: async (version) => {
      calls.push(`surfaceChangelog:${version}`);
    },
  };
}

// ---------------------------------------------------------------------------
// Module shape
// ---------------------------------------------------------------------------

describe('update module exports', () => {
  it('exports runUpdate as a named export', () => {
    assert.equal(typeof runUpdate, 'function');
  });

  it('exports a default function for bin/mandrel.js dispatch', () => {
    assert.equal(typeof update, 'function');
  });
});

// ---------------------------------------------------------------------------
// AC — ordered cycle drives npm-update → runSync → runMigrations → doctor
// ---------------------------------------------------------------------------

describe('runUpdate — happy path', () => {
  it('drives the steps in order and reports success on an all-pass doctor', async () => {
    const seams = makeSeams({ target: '1.44.0', doctorOk: true });
    const cap = makeCapture();

    const result = await runUpdate({
      argv: [],
      ...seams,
      write: cap.write,
      writeErr: cap.writeErr,
      exit: cap.exit,
    });

    // Ordered seam invocation: resolve → npm-update → sync → sync-commands →
    // sync-agents → migrate → doctor (the re-exec phase order — Story #4046
    // A1c; sync-agents added by Story #4528/#4530).
    assert.deepEqual(seams.calls, [
      'resolveTargetVersion',
      'npmUpdate:1.44.0',
      'sync',
      'sync-commands',
      'sync-agents',
      'migrate:1.43.0->1.44.0',
      'doctor',
      'surfaceChangelog:1.44.0',
    ]);
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

  it('threads the resolved target into the npm-update and migration seams', async () => {
    const seams = makeSeams({ target: '1.50.2' });
    const cap = makeCapture();

    await runUpdate({
      argv: [],
      ...seams,
      write: cap.write,
      writeErr: cap.writeErr,
      exit: cap.exit,
    });

    assert.ok(seams.calls.includes('npmUpdate:1.50.2'));
    assert.ok(seams.calls.includes('migrate:1.43.0->1.50.2'));
  });

  it('does not report success when doctor reports a failure', async () => {
    const seams = makeSeams({ target: '1.44.0', doctorOk: false });
    const cap = makeCapture();

    const result = await runUpdate({
      argv: [],
      ...seams,
      write: cap.write,
      writeErr: cap.writeErr,
      exit: cap.exit,
    });

    assert.equal(result.ok, false);
    assert.equal(result.action, 'doctor-failed');
    // The bump still applied — all six steps ran before the doctor verdict.
    assert.deepEqual(result.stepsRun, [
      'npm-update',
      'runSync',
      'sync-commands',
      'sync-agents',
      'runMigrations',
      'doctor',
    ]);
    assert.equal(cap.exitCode, 1);
    assert.match(cap.err.join(''), /doctor reported failures/);
  });
});

// ---------------------------------------------------------------------------
// AC — --dry-run prints the plan and writes nothing / invokes no seam
// ---------------------------------------------------------------------------

describe('runUpdate — --dry-run', () => {
  it('prints the planned target version and step plan', async () => {
    const seams = makeSeams({ target: '1.44.0' });
    const cap = makeCapture();

    const result = await runUpdate({
      argv: ['--dry-run'],
      ...seams,
      write: cap.write,
      writeErr: cap.writeErr,
      exit: cap.exit,
    });

    const joined = cap.out.join('');
    assert.match(joined, /1\.43\.0 → v1\.44\.0/);
    assert.match(joined, /npm-update/);
    assert.match(joined, /runSync/);
    assert.match(joined, /runMigrations/);
    assert.match(joined, /doctor/);
    assert.match(joined, /Dry run: no files written/);
    assert.equal(result.action, 'dry-run');
    assert.equal(result.dryRun, true);
  });

  it('invokes no effectful seam and never calls exit', async () => {
    const seams = makeSeams({ target: '1.44.0' });
    const cap = makeCapture();

    await runUpdate({
      argv: ['--dry-run'],
      ...seams,
      write: cap.write,
      writeErr: cap.writeErr,
      exit: cap.exit,
    });

    // resolveTargetVersion runs (the plan needs the target); nothing else.
    assert.deepEqual(seams.calls, ['resolveTargetVersion']);
    assert.equal(cap.exitCode, null);
  });
});

// ---------------------------------------------------------------------------
// up-to-date short-circuit
// ---------------------------------------------------------------------------

describe('runUpdate — already on the newest version', () => {
  it('performs no steps and reports up-to-date', async () => {
    const seams = makeSeams({ target: '1.43.0' });
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
    assert.deepEqual(seams.calls, ['resolveTargetVersion']);
    assert.match(cap.out.join(''), /Already up to date/);
  });
});

// ---------------------------------------------------------------------------
// Seam-required guards
// ---------------------------------------------------------------------------

describe('runUpdate — missing required seams', () => {
  it('throws when resolveTargetVersion is absent', async () => {
    await assert.rejects(
      () => runUpdate({ argv: [], currentVersion: '1.43.0' }),
      /resolveTargetVersion seam is required/,
    );
  });

  it('throws when npmUpdate is absent on a live (non-dry-run) bump', async () => {
    await assert.rejects(
      () =>
        runUpdate({
          argv: [],
          currentVersion: '1.43.0',
          resolveTargetVersion: async () => '1.44.0',
          write: () => {},
          writeErr: () => {},
          exit: () => {},
        }),
      /npmUpdate seam is required/,
    );
  });
});

// ---------------------------------------------------------------------------
// AC — win32 shell:true spawn shape (CVE-2024-27980) for the version probe
// ---------------------------------------------------------------------------

describe('defaultVersionRunner — win32 spawn shape', () => {
  it('passes shell matching the platform to spawnSync (CVE-2024-27980)', () => {
    const calls = [];
    const fakeSpawn = (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return { status: 0, stdout: '1.46.0\n', stderr: '' };
    };

    const version = defaultVersionRunner({ spawnSync: fakeSpawn });

    assert.equal(version, '1.46.0');
    assert.equal(calls.length, 1);
    // Fixed argv vector — the package name is a constant, never operator text.
    assert.equal(calls[0].cmd, 'npm');
    assert.deepEqual(calls[0].args, ['view', 'mandrel', 'version']);
    // The shell flag is win32-gated: true on Windows, false elsewhere.
    assert.equal(calls[0].opts.shell, process.platform === 'win32');
  });

  it('throws a descriptive error when the probe spawn errors (ENOENT)', () => {
    const fakeSpawn = () => ({
      status: null,
      stdout: '',
      stderr: '',
      error: new Error('spawnSync npm ENOENT'),
    });

    assert.throws(
      () => defaultVersionRunner({ spawnSync: fakeSpawn }),
      /failed to probe newest mandrel version: spawnSync npm ENOENT/,
    );
  });
});

// ---------------------------------------------------------------------------
// AC — win32 shell:true spawn shape for the install (via runInstallCommand)
// ---------------------------------------------------------------------------

describe('defaultNpmUpdate — win32 install spawn shape', () => {
  it('routes the install through runInstallCommand with the win32 shell flag', () => {
    const calls = [];
    const fakeSpawn = (bin, args, opts) => {
      calls.push({ bin, args, opts });
      return { status: 0, stderr: '' };
    };
    // Wire the real shared helper so the win32 shell handling under test is the
    // production tokenizer/spawner, not a re-implementation.
    const runInstall = (cmd, cwd) =>
      runInstallCommand(cmd, cwd, { spawnSync: fakeSpawn });

    defaultNpmUpdate('1.46.0', { runInstall, cwd: '/repo' });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].bin, 'npm');
    assert.deepEqual(calls[0].args, ['install', 'mandrel@1.46.0']);
    assert.equal(calls[0].opts.cwd, '/repo');
    assert.equal(calls[0].opts.shell, process.platform === 'win32');
  });

  it('throws when the install command exits non-zero', () => {
    const runInstall = () => ({ status: 1, stderr: 'boom' });
    assert.throws(
      () => defaultNpmUpdate('1.46.0', { runInstall }),
      /install command `npm install mandrel@1\.46\.0` exited 1: boom/,
    );
  });
});

// ---------------------------------------------------------------------------
// AC — --install-cmd override (default vs overridden argv)
// ---------------------------------------------------------------------------

describe('resolveInstallCmd — default vs override', () => {
  it('defaults to npm install mandrel@<target> when no override', () => {
    assert.equal(resolveInstallCmd('1.46.0'), 'npm install mandrel@1.46.0');
  });

  it('uses the operator override verbatim when supplied', () => {
    assert.equal(
      resolveInstallCmd('1.46.0', 'pnpm add mandrel@latest'),
      'pnpm add mandrel@latest',
    );
  });

  it('falls back to the default when the override is blank', () => {
    assert.equal(
      resolveInstallCmd('1.46.0', '   '),
      'npm install mandrel@1.46.0',
    );
  });
});

// ---------------------------------------------------------------------------
// AC-1/AC-2 — package-manager detection from the project lockfile
// ---------------------------------------------------------------------------

describe('detectPackageManager — lockfile probe', () => {
  it('detects pnpm and the workspace root from pnpm-lock.yaml + pnpm-workspace.yaml', () => {
    const fs = makeLockFs(['pnpm-lock.yaml', 'pnpm-workspace.yaml']);
    assert.deepEqual(detectPackageManager('/ws', fs), {
      packageManager: 'pnpm',
      workspaceRoot: true,
    });
  });

  it('detects pnpm without -w when no pnpm-workspace.yaml is present', () => {
    const fs = makeLockFs(['pnpm-lock.yaml']);
    assert.deepEqual(detectPackageManager('/proj', fs), {
      packageManager: 'pnpm',
      workspaceRoot: false,
    });
  });

  it('detects yarn from yarn.lock', () => {
    const fs = makeLockFs(['yarn.lock']);
    assert.deepEqual(detectPackageManager('/proj', fs), {
      packageManager: 'yarn',
      workspaceRoot: false,
    });
  });

  it('falls back to npm when only package-lock.json (or nothing) is present', () => {
    assert.deepEqual(
      detectPackageManager('/proj', makeLockFs(['package-lock.json'])),
      {
        packageManager: 'npm',
        workspaceRoot: false,
      },
    );
    assert.deepEqual(detectPackageManager('/proj', makeLockFs([])), {
      packageManager: 'npm',
      workspaceRoot: false,
    });
  });

  it('prefers pnpm over yarn when both lockfiles exist', () => {
    const fs = makeLockFs(['pnpm-lock.yaml', 'yarn.lock']);
    assert.equal(detectPackageManager('/proj', fs).packageManager, 'pnpm');
  });
});

// ---------------------------------------------------------------------------
// AC-1/AC-2/AC-3 — resolveInstallCmd builds the PM-aware command
// ---------------------------------------------------------------------------

describe('resolveInstallCmd — package-manager aware', () => {
  it('builds `pnpm add -D … -w` at a workspace root (AC-1)', () => {
    assert.equal(
      resolveInstallCmd('1.48.0', undefined, {
        packageManager: 'pnpm',
        workspaceRoot: true,
      }),
      'pnpm add -D mandrel@1.48.0 -w',
    );
  });

  it('omits -w for a non-root pnpm project', () => {
    assert.equal(
      resolveInstallCmd('1.48.0', undefined, { packageManager: 'pnpm' }),
      'pnpm add -D mandrel@1.48.0',
    );
  });

  it('builds `yarn add -D …` for a yarn project (AC-2)', () => {
    assert.equal(
      resolveInstallCmd('1.48.0', undefined, { packageManager: 'yarn' }),
      'yarn add -D mandrel@1.48.0',
    );
  });

  it('substitutes a {target} placeholder in an override (AC-3)', () => {
    assert.equal(
      resolveInstallCmd('1.48.0', 'pnpm add -D mandrel@{target} -w'),
      'pnpm add -D mandrel@1.48.0 -w',
    );
  });

  it('uses a placeholder-free override verbatim', () => {
    assert.equal(
      resolveInstallCmd('1.48.0', 'pnpm add mandrel@latest'),
      'pnpm add mandrel@latest',
    );
  });
});

// ---------------------------------------------------------------------------
// AC-1/AC-2 — defaultNpmUpdate resolves the command from the detected PM
// ---------------------------------------------------------------------------

describe('defaultNpmUpdate — package-manager detection', () => {
  it('runs `pnpm add -D … -w` in a pnpm workspace root (AC-1)', () => {
    const fs = makeLockFs(['pnpm-lock.yaml', 'pnpm-workspace.yaml']);
    const calls = [];
    const runInstall = (cmd, cwd) => {
      calls.push({ cmd, cwd });
      return { status: 0, stderr: '' };
    };

    defaultNpmUpdate('1.48.0', { runInstall, cwd: '/ws', fs });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, 'pnpm add -D mandrel@1.48.0 -w');
    assert.equal(calls[0].cwd, '/ws');
  });

  it('runs `yarn add -D …` when yarn.lock is present (AC-2)', () => {
    const fs = makeLockFs(['yarn.lock']);
    const calls = [];
    const runInstall = (cmd) => {
      calls.push(cmd);
      return { status: 0, stderr: '' };
    };

    defaultNpmUpdate('1.48.0', { runInstall, cwd: '/proj', fs });

    assert.deepEqual(calls, ['yarn add -D mandrel@1.48.0']);
  });

  it('keeps `npm install …` unchanged for an npm repo (AC-2)', () => {
    const fs = makeLockFs(['package-lock.json']);
    const calls = [];
    const runInstall = (cmd) => {
      calls.push(cmd);
      return { status: 0, stderr: '' };
    };

    defaultNpmUpdate('1.48.0', { runInstall, cwd: '/proj', fs });

    assert.deepEqual(calls, ['npm install mandrel@1.48.0']);
  });
});

// ---------------------------------------------------------------------------
// AC-4 — install failure surfaces a PM-specific node_modules repair hint
// ---------------------------------------------------------------------------

describe('defaultNpmUpdate — repair hint on failure (AC-4)', () => {
  it('names the detected package manager when the install exits non-zero', () => {
    const fs = makeLockFs(['pnpm-lock.yaml']);
    const runInstall = () => ({ status: 1, stderr: 'boom' });

    assert.throws(
      () => defaultNpmUpdate('1.48.0', { runInstall, cwd: '/ws', fs }),
      /exited 1: boom[\s\S]*run `pnpm install`/,
    );
  });

  it('includes the repair hint when the install spawn throws', () => {
    const fs = makeLockFs(['yarn.lock']);
    const runInstall = () => {
      throw new Error('ENOENT');
    };

    assert.throws(
      () => defaultNpmUpdate('1.48.0', { runInstall, cwd: '/ws', fs }),
      /failed to spawn: ENOENT[\s\S]*run `yarn install`/,
    );
  });
});

describe('runUpdate — --install-cmd flag threading', () => {
  /** A spawnPhase stub that succeeds for every post-install phase. */
  const okSpawn = async () => ({ ok: true, stdout: '', stderr: '' });

  it('threads no installCmd into npmUpdate by default', async () => {
    const seen = [];
    const cap = makeCapture();
    await runUpdate({
      argv: [],
      currentVersion: '1.43.0',
      resolveTargetVersion: async () => '1.44.0',
      npmUpdate: async (_target, opts) => {
        seen.push(opts);
      },
      spawnPhase: okSpawn,
      cwd: () => '/fake/consumer',
      write: cap.write,
      writeErr: cap.writeErr,
      exit: cap.exit,
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].installCmd, undefined);
  });

  it('threads the --install-cmd value into npmUpdate', async () => {
    const seen = [];
    const cap = makeCapture();
    await runUpdate({
      argv: ['--install-cmd', 'pnpm add mandrel@1.44.0'],
      currentVersion: '1.43.0',
      resolveTargetVersion: async () => '1.44.0',
      npmUpdate: async (_target, opts) => {
        seen.push(opts);
      },
      spawnPhase: okSpawn,
      cwd: () => '/fake/consumer',
      write: cap.write,
      writeErr: cap.writeErr,
      exit: cap.exit,
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].installCmd, 'pnpm add mandrel@1.44.0');
  });

  it('accepts the --install-cmd=<value> form', async () => {
    const seen = [];
    const cap = makeCapture();
    await runUpdate({
      argv: ['--install-cmd=yarn up mandrel@1.44.0'],
      currentVersion: '1.43.0',
      resolveTargetVersion: async () => '1.44.0',
      npmUpdate: async (_target, opts) => {
        seen.push(opts);
      },
      spawnPhase: okSpawn,
      cwd: () => '/fake/consumer',
      write: cap.write,
      writeErr: cap.writeErr,
      exit: cap.exit,
    });
    assert.equal(seen[0].installCmd, 'yarn up mandrel@1.44.0');
  });
});

// ---------------------------------------------------------------------------
// AC — default export wiring threads installCmd + runInstall (no real I/O)
// ---------------------------------------------------------------------------

describe('update default export — install routing', () => {
  // An in-memory fs that reports "no cache present" so isStale always invokes
  // the injected versionRunner and the cache refresh write goes nowhere real.
  function makeMemoryFs() {
    return {
      readFileSync: () => {
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      },
      writeFileSync: () => {},
      mkdirSync: () => {},
      existsSync: () => false,
    };
  }

  // Stub the spawn boundary (the sole post-install path) so the default
  // export's sync/sync-commands/migrate/doctor phases never run a real child
  // process. spawnFn is the injectable boundary the default export exposes via
  // `deps`; returning status 0 makes every phase (including doctor) pass.
  const okSpawnFn = () => ({ status: 0, stdout: '', stderr: '' });

  it('runs the overridden install command through the injected runInstall seam', async () => {
    const installs = [];
    await update(['--install-cmd', 'pnpm add mandrel@1.44.0'], {
      currentVersion: '1.43.0',
      fs: makeMemoryFs(),
      versionRunner: () => '1.44.0',
      runInstall: (cmd, cwd) => {
        installs.push({ cmd, cwd });
        return { status: 0, stderr: '' };
      },
      spawnFn: okSpawnFn,
      write: () => {},
      writeErr: () => {},
      exit: () => {},
    });
    assert.equal(installs.length, 1);
    assert.equal(installs[0].cmd, 'pnpm add mandrel@1.44.0');
  });

  it('runs the default npm install command when no override is given', async () => {
    const installs = [];
    await update([], {
      currentVersion: '1.43.0',
      fs: makeMemoryFs(),
      versionRunner: () => '1.44.0',
      runInstall: (cmd) => {
        installs.push(cmd);
        return { status: 0, stderr: '' };
      },
      spawnFn: okSpawnFn,
      write: () => {},
      writeErr: () => {},
      exit: () => {},
    });
    assert.deepEqual(installs, ['npm install mandrel@1.44.0']);
  });
});

// lib/cli/__tests__/update-version-resolution.test.js
/**
 * Unit tests for version resolution in lib/cli/update.js: the newest
 * published version — **including a major crossing** — is resolved and
 * applied like any other update. The former `--major` gate was removed per
 * the hard-cutover doctrine (.agents/rules/git-conventions.md § Contract
 * Cutovers): there is no refusal path and no `--major` flag.
 *
 * Every test drives runUpdate through injectable seams; no real npm process,
 * filesystem I/O, or network call occurs (testing-standards § Unit).
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { resolveCurrentVersionForUpdate, runUpdate } from '../update.js';

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
 * Build recording seams for a MAJOR crossing (1.43.0 → 2.0.0). Every effectful
 * seam records into `calls` so a test can assert the full ordered cycle ran.
 */
function makeMajorSeams({ target = '2.0.0', doctorOk = true } = {}) {
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
    // Post-install phases run through the spawnPhase re-exec boundary (the sole
    // post-install path since Story #4182). The migrate phase records its
    // version range; the doctor phase verdict is toggled by `doctorOk`.
    spawnPhase: async (phase, args) => {
      if (phase === 'migrate') {
        const from = args[args.indexOf('--from') + 1];
        const to = args[args.indexOf('--to') + 1];
        calls.push(`migrate:${from}->${to}`);
      } else {
        calls.push(phase);
      }
      const ok = phase === 'doctor' ? doctorOk : true;
      return { ok, stdout: '', stderr: ok ? '' : 'doctor failed' };
    },
    cwd: () => '/fake/consumer',
    surfaceChangelog: async (version) => {
      calls.push(`surfaceChangelog:${version}`);
    },
  };
}

// ---------------------------------------------------------------------------
// A major crossing is applied like any other update
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// resolveCurrentVersionForUpdate — the three-tier fallback (Story #4525/#4530)
// ---------------------------------------------------------------------------

const CONSUMER_ROOT = path.join(path.sep, 'consumer');

/** Minimal readFileSync-only fs fake keyed by absolute path. */
function makeFsFake(seed = {}) {
  const files = new Map(Object.entries(seed));
  return {
    readFileSync(p, _enc) {
      if (!files.has(p)) {
        const err = new Error(`ENOENT: no such file or directory, open '${p}'`);
        err.code = 'ENOENT';
        throw err;
      }
      return files.get(p);
    },
  };
}

describe('resolveCurrentVersionForUpdate — tier 1: consumer pin wins', () => {
  it('prefers the declared pin over node_modules resolution — the #4525 fix', () => {
    // The reported bug's exact shape: package.json pins ^1.87.0, but
    // node_modules resolves an inflated 2.0.0 (e.g. an out-of-band symlink).
    // The pin must win so planUpdate sees `updated`, not `resynced`.
    const fs = makeFsFake({
      [path.join(CONSUMER_ROOT, 'package.json')]: JSON.stringify({
        dependencies: { mandrel: '^1.87.0' },
      }),
    });
    const resolvePackageRoot = () => {
      throw new Error(
        'must not be called — the pin resolved, node_modules resolution is skipped',
      );
    };
    assert.equal(
      resolveCurrentVersionForUpdate(CONSUMER_ROOT, fs, { resolvePackageRoot }),
      '1.87.0',
    );
  });
});

describe('resolveCurrentVersionForUpdate — tier 2: node_modules fallback', () => {
  it('falls back to the resolved installed package version when there is no pin', () => {
    const installedRoot = path.join(CONSUMER_ROOT, 'node_modules', 'mandrel');
    const fs = makeFsFake({
      [path.join(CONSUMER_ROOT, 'package.json')]: JSON.stringify({
        dependencies: {},
      }),
      [path.join(installedRoot, 'package.json')]: JSON.stringify({
        version: '2.0.0',
      }),
    });
    const resolvePackageRoot = (fromDir) => {
      assert.equal(fromDir, CONSUMER_ROOT, 'anchored at the consumer root');
      return installedRoot;
    };
    assert.equal(
      resolveCurrentVersionForUpdate(CONSUMER_ROOT, fs, { resolvePackageRoot }),
      '2.0.0',
    );
  });

  it('also falls back when package.json is entirely absent (workspace/npx consumer)', () => {
    const installedRoot = path.join(CONSUMER_ROOT, 'node_modules', 'mandrel');
    const fs = makeFsFake({
      [path.join(installedRoot, 'package.json')]: JSON.stringify({
        version: '3.1.0',
      }),
    });
    const resolvePackageRoot = () => installedRoot;
    assert.equal(
      resolveCurrentVersionForUpdate(CONSUMER_ROOT, fs, { resolvePackageRoot }),
      '3.1.0',
    );
  });
});

// defaultCurrentVersion (the tier-3 fallback inside resolveCurrentVersionForUpdate)
// is not itself seam-injectable — it always reads THIS module's own two-dirs-up
// manifest via whichever `fs` was passed in. To exercise tier 3 without hitting
// the real filesystem, seed that exact real path into the fake.
const REPO_PACKAGE_JSON_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'package.json',
);

describe('resolveCurrentVersionForUpdate — tier 3: last-resort self-read', () => {
  it('falls through to defaultCurrentVersion when neither pin nor node_modules resolve', () => {
    // No package.json at the consumer root, and node_modules resolution
    // throws (package not installed). This must not throw — it degrades to
    // the module's own manifest rather than crashing `mandrel update`
    // outright.
    const fs = makeFsFake({
      [REPO_PACKAGE_JSON_PATH]: JSON.stringify({ version: '9.9.9-self' }),
    });
    const resolvePackageRoot = () => {
      const err = new Error("Cannot find module 'mandrel/package.json'");
      err.code = 'MODULE_NOT_FOUND';
      throw err;
    };
    assert.equal(
      resolveCurrentVersionForUpdate(CONSUMER_ROOT, fs, { resolvePackageRoot }),
      '9.9.9-self',
    );
  });

  it('throws only when even the self-read manifest is unreadable (fully corrupted install)', () => {
    const fs = makeFsFake({});
    const resolvePackageRoot = () => {
      throw new Error('not found');
    };
    assert.throws(() =>
      resolveCurrentVersionForUpdate(CONSUMER_ROOT, fs, { resolvePackageRoot }),
    );
  });
});

describe('runUpdate — major crossing applies like any other update', () => {
  it('applies a 1.x → 2.0 target, driving the ordered steps', async () => {
    const seams = makeMajorSeams({ target: '2.0.0', doctorOk: true });
    const cap = makeCapture();

    const result = await runUpdate({
      argv: [],
      ...seams,
      write: cap.write,
      writeErr: cap.writeErr,
      exit: cap.exit,
    });

    assert.equal(result.ok, true);
    assert.equal(result.action, 'updated');
    assert.deepEqual(result.stepsRun, [
      'npm-update',
      'runSync',
      'sync-commands',
      'runMigrations',
      'doctor',
    ]);
    assert.ok(seams.calls.includes('npmUpdate:2.0.0'));
    assert.ok(seams.calls.includes('migrate:1.43.0->2.0.0'));
    assert.equal(cap.exitCode, null);
  });

  it('applies a 1.x → 3.0 leap the same way', async () => {
    const seams = makeMajorSeams({ target: '3.0.0' });
    const cap = makeCapture();

    const result = await runUpdate({
      argv: [],
      ...seams,
      write: cap.write,
      writeErr: cap.writeErr,
      exit: cap.exit,
    });

    assert.equal(result.ok, true);
    assert.equal(result.action, 'updated');
    assert.ok(seams.calls.includes('npmUpdate:3.0.0'));
    assert.equal(cap.exitCode, null);
  });

  it('emits no runbook pointer or --major hint anywhere in the output', async () => {
    const seams = makeMajorSeams({ target: '2.0.0' });
    const cap = makeCapture();

    await runUpdate({
      argv: [],
      ...seams,
      write: cap.write,
      writeErr: cap.writeErr,
      exit: cap.exit,
    });

    const all = cap.out.join('') + cap.err.join('');
    assert.doesNotMatch(all, /upgrade-major/);
    assert.doesNotMatch(all, /--major/);
  });
});

// ---------------------------------------------------------------------------
// --dry-run on a major target previews without applying
// ---------------------------------------------------------------------------

describe('runUpdate — --dry-run on a major target', () => {
  it('prints the plan and invokes no effectful seam', async () => {
    const seams = makeMajorSeams({ target: '2.0.0' });
    const cap = makeCapture();

    const result = await runUpdate({
      argv: ['--dry-run'],
      ...seams,
      write: cap.write,
      writeErr: cap.writeErr,
      exit: cap.exit,
    });

    assert.equal(result.action, 'dry-run');
    assert.match(cap.out.join(''), /1\.43\.0 → v2\.0\.0/);
    assert.deepEqual(seams.calls, ['resolveTargetVersion']);
    assert.equal(cap.exitCode, null);
  });
});

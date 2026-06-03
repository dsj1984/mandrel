// lib/cli/__tests__/update.test.js
/**
 * Unit tests for lib/cli/update.js — the `mandrel update` orchestrator.
 *
 * Every test drives runUpdate through injectable seams (currentVersion,
 * resolveTargetVersion, npmUpdate, runSync, runMigrations, runDoctor,
 * surfaceChangelog, write, writeErr, exit). No real npm process, no real
 * filesystem I/O, and no real network call occur (testing-standards § Unit:
 * all external network / filesystem I/O MUST be mocked).
 *
 * Coverage contract (Story #3503 AC — non-major paths):
 *   - Module shape: runUpdate named export + default function export.
 *   - Happy path: a minor-ahead target drives the ordered steps
 *     npm-update → runSync → runMigrations → doctor and reports success only
 *     when the injected doctor result is all-pass.
 *   - --dry-run prints the planned target + step plan and invokes no
 *     effectful seam.
 *   - A failing doctor result downgrades the run to a non-zero exit even
 *     after the bump applied.
 *   - up-to-date short-circuit performs no steps.
 *
 * The major-gate AC has its own file: update-major.test.js.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import update, { runUpdate } from '../update.js';

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
 * Build the recording seam set for a happy-path run. `doctorOk` toggles the
 * injected doctor verdict so the all-pass / failure branches are both
 * exercised through the same harness.
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
    runSync: (_opts) => {
      calls.push('runSync');
      return { copied: 0, planned: 0, dryRun: false };
    },
    runMigrations: ({ fromVersion, toVersion }) => {
      calls.push(`runMigrations:${fromVersion}->${toVersion}`);
      return { applied: [], skipped: [] };
    },
    runDoctor: async () => {
      calls.push('runDoctor');
      return {
        ok: doctorOk,
        results: [
          { name: 'node-version', ok: true },
          { name: 'agents-materialized', ok: doctorOk },
        ],
      };
    },
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

describe('runUpdate — non-major happy path', () => {
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

    // Ordered seam invocation: resolve → npm-update → sync → migrate → doctor.
    assert.deepEqual(seams.calls, [
      'resolveTargetVersion',
      'npmUpdate:1.44.0',
      'runSync',
      'runMigrations:1.43.0->1.44.0',
      'runDoctor',
      'surfaceChangelog:1.44.0',
    ]);
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
    assert.ok(seams.calls.includes('runMigrations:1.43.0->1.50.2'));
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
    // The bump still applied — all four steps ran before doctor failed.
    assert.deepEqual(result.stepsRun, [
      'npm-update',
      'runSync',
      'runMigrations',
      'doctor',
    ]);
    assert.equal(cap.exitCode, 1);
    assert.match(cap.err.join(''), /doctor reported failures/);
    assert.match(cap.err.join(''), /agents-materialized/);
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

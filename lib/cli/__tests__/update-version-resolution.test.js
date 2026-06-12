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
import { describe, it } from 'node:test';

import { runUpdate } from '../update.js';

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
        results: [{ name: 'node-version', ok: doctorOk }],
      };
    },
    surfaceChangelog: async (version) => {
      calls.push(`surfaceChangelog:${version}`);
    },
  };
}

// ---------------------------------------------------------------------------
// A major crossing is applied like any other update
// ---------------------------------------------------------------------------

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
      'runMigrations',
      'doctor',
    ]);
    assert.ok(seams.calls.includes('npmUpdate:2.0.0'));
    assert.ok(seams.calls.includes('runMigrations:1.43.0->2.0.0'));
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

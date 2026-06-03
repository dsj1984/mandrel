// lib/cli/__tests__/update-major.test.js
/**
 * Unit tests for the major-version gate in lib/cli/update.js.
 *
 * Every test drives runUpdate through injectable seams; no real npm process,
 * filesystem I/O, or network call occurs (testing-standards § Unit).
 *
 * Coverage contract (Story #3503 AC — major gate):
 *   - When the newest version crosses a major boundary and `--major` is
 *     absent, run declines, prints the docs/upgrade-major.md runbook pointer,
 *     exits non-zero, and invokes NO npm-update / sync / migration / doctor
 *     seam.
 *   - When `--major` is passed, run applies the major target and prints the
 *     runbook inline.
 *   - --dry-run on a major target prints the plan without applying.
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
 * seam records into `calls` so a test can assert that none of them ran when
 * the gate refuses.
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
// AC — major boundary without --major is refused
// ---------------------------------------------------------------------------

describe('runUpdate — major gate without --major', () => {
  it('declines, exits non-zero, and invokes no effectful seam', async () => {
    const seams = makeMajorSeams({ target: '2.0.0' });
    const cap = makeCapture();

    const result = await runUpdate({
      argv: [],
      ...seams,
      write: cap.write,
      writeErr: cap.writeErr,
      exit: cap.exit,
    });

    assert.equal(result.ok, false);
    assert.equal(result.action, 'declined-major');
    assert.equal(result.major, true);
    assert.deepEqual(result.stepsRun, []);
    assert.equal(cap.exitCode, 1);

    // No npm-update / sync / migration / doctor seam fired — only the resolve.
    assert.deepEqual(seams.calls, ['resolveTargetVersion']);
  });

  it('prints the docs/upgrade-major.md runbook pointer and the available version', async () => {
    const seams = makeMajorSeams({ target: '2.0.0' });
    const cap = makeCapture();

    await runUpdate({
      argv: [],
      ...seams,
      write: cap.write,
      writeErr: cap.writeErr,
      exit: cap.exit,
    });

    const joined = cap.err.join('');
    assert.match(joined, /docs\/upgrade-major\.md/);
    assert.match(joined, /2\.0\.0/);
    assert.match(joined, /--major/);
  });

  it('gates a 1.x → 3.0 leap the same way', async () => {
    const seams = makeMajorSeams({ target: '3.0.0' });
    const cap = makeCapture();

    const result = await runUpdate({
      argv: [],
      ...seams,
      write: cap.write,
      writeErr: cap.writeErr,
      exit: cap.exit,
    });

    assert.equal(result.action, 'declined-major');
    assert.equal(cap.exitCode, 1);
    assert.deepEqual(seams.calls, ['resolveTargetVersion']);
  });
});

// ---------------------------------------------------------------------------
// AC — --major applies the major target and prints the runbook inline
// ---------------------------------------------------------------------------

describe('runUpdate — major gate with --major', () => {
  it('applies the major target, driving the ordered steps', async () => {
    const seams = makeMajorSeams({ target: '2.0.0', doctorOk: true });
    const cap = makeCapture();

    const result = await runUpdate({
      argv: ['--major'],
      ...seams,
      write: cap.write,
      writeErr: cap.writeErr,
      exit: cap.exit,
    });

    assert.equal(result.ok, true);
    assert.equal(result.action, 'updated');
    assert.equal(result.major, true);
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

  it('prints the runbook pointer inline on the applied-major path', async () => {
    const seams = makeMajorSeams({ target: '2.0.0' });
    const cap = makeCapture();

    await runUpdate({
      argv: ['--major'],
      ...seams,
      write: cap.write,
      writeErr: cap.writeErr,
      exit: cap.exit,
    });

    assert.match(cap.out.join(''), /docs\/upgrade-major\.md/);
  });
});

// ---------------------------------------------------------------------------
// --dry-run on a major target previews without applying
// ---------------------------------------------------------------------------

describe('runUpdate — --major --dry-run', () => {
  it('prints the plan and invokes no effectful seam', async () => {
    const seams = makeMajorSeams({ target: '2.0.0' });
    const cap = makeCapture();

    const result = await runUpdate({
      argv: ['--major', '--dry-run'],
      ...seams,
      write: cap.write,
      writeErr: cap.writeErr,
      exit: cap.exit,
    });

    assert.equal(result.action, 'dry-run');
    assert.match(cap.out.join(''), /1\.43\.0 → v2\.0\.0/);
    assert.match(cap.out.join(''), /major upgrade/);
    assert.deepEqual(seams.calls, ['resolveTargetVersion']);
    assert.equal(cap.exitCode, null);
  });
});

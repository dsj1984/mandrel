// lib/cli/__tests__/migrate.test.js
/**
 * Unit tests for lib/cli/migrate.js — the standalone `mandrel migrate`
 * subcommand (Story #3505, Epic #3437).
 *
 * Every test drives runMigrate through injectable seams (argv, runMigrations,
 * registry, ctx, write, writeErr, exit). No real filesystem I/O, no real
 * network call, and no shared mutable module state occur (testing-standards
 * § Unit: all external I/O MUST be mocked; pure-logic assertions only).
 *
 * Coverage contract (Story #3505 AC):
 *   - Module shape: runMigrate named export + default function export.
 *   - A live run parses --from/--to out of argv and forwards them to
 *     runMigrations.
 *   - --dry-run reports the steps that WOULD run and invokes no step's apply
 *     and no runMigrations call (writes nothing to disk).
 *   - Missing --from or --to is a usage error (non-zero exit).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import migrate, { runMigrate } from '../migrate.js';

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
 * Build a fixture registry with `detect`/`apply` recorders so the dry-run
 * (detect only, no apply) and live (detect → apply) paths are both
 * observable. `appliedNeeded` lists the versions whose detect returns true
 * (still needs applying); every other step is treated as already-present.
 */
function makeFixtureRegistry({ appliedNeeded = ['1.4.0', '1.5.0'] } = {}) {
  const calls = [];
  const registry = [
    { version: '1.3.0', description: 'pre-range step' },
    { version: '1.4.0', description: 'rename foo to bar' },
    { version: '1.5.0', description: 'move baseline file' },
    { version: '1.6.0', description: 'post-range step' },
  ].map((step) => ({
    ...step,
    detect: (_ctx) => {
      calls.push(`detect:${step.version}`);
      return appliedNeeded.includes(step.version);
    },
    apply: (_ctx) => {
      calls.push(`apply:${step.version}`);
    },
  }));
  return { registry, calls };
}

// ---------------------------------------------------------------------------
// Module shape
// ---------------------------------------------------------------------------

describe('migrate module exports', () => {
  it('exports runMigrate as a named export', () => {
    assert.equal(typeof runMigrate, 'function');
  });

  it('exports a default function for bin/mandrel.js dispatch', () => {
    assert.equal(typeof migrate, 'function');
  });
});

// ---------------------------------------------------------------------------
// AC — live run forwards parsed --from/--to to runMigrations
// ---------------------------------------------------------------------------

describe('runMigrate — live run', () => {
  it('parses --from/--to and forwards them to runMigrations', () => {
    const cap = makeCapture();
    const calls = [];
    const runMigrations = ({ fromVersion, toVersion }) => {
      calls.push(`runMigrations:${fromVersion}->${toVersion}`);
      return { applied: ['1.4.0'], skipped: [] };
    };

    const result = runMigrate({
      argv: ['--from', '1.3.0', '--to', '1.5.0'],
      runMigrations,
      registry: [],
      write: cap.write,
      writeErr: cap.writeErr,
      exit: cap.exit,
    });

    assert.deepEqual(calls, ['runMigrations:1.3.0->1.5.0']);
    assert.equal(result.ok, true);
    assert.equal(result.action, 'migrated');
    assert.deepEqual(result.applied, ['1.4.0']);
    assert.equal(cap.exitCode, null);
    assert.match(cap.out.join(''), /Applied 1 migration/);
  });

  it('accepts the --from=value / --to=value spelling', () => {
    const cap = makeCapture();
    const calls = [];
    const runMigrations = ({ fromVersion, toVersion }) => {
      calls.push(`runMigrations:${fromVersion}->${toVersion}`);
      return { applied: [], skipped: [] };
    };

    runMigrate({
      argv: ['--from=1.2.0', '--to=1.9.0'],
      runMigrations,
      registry: [],
      write: cap.write,
      writeErr: cap.writeErr,
      exit: cap.exit,
    });

    assert.deepEqual(calls, ['runMigrations:1.2.0->1.9.0']);
  });

  it('reports a no-op when no migrations applied', () => {
    const cap = makeCapture();
    const runMigrations = () => ({ applied: [], skipped: ['1.4.0'] });

    const result = runMigrate({
      argv: ['--from', '1.3.0', '--to', '1.5.0'],
      runMigrations,
      registry: [],
      write: cap.write,
      writeErr: cap.writeErr,
      exit: cap.exit,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.applied, []);
    assert.match(cap.out.join(''), /no migrations to apply/);
  });
});

// ---------------------------------------------------------------------------
// AC — --dry-run reports the plan, invokes no apply, writes nothing
// ---------------------------------------------------------------------------

describe('runMigrate — --dry-run', () => {
  it('reports the in-range steps that would apply / be skipped and never applies', () => {
    const cap = makeCapture();
    const { registry, calls } = makeFixtureRegistry({
      // 1.5.0 is in range but already present (detect → false ⇒ would skip).
      appliedNeeded: ['1.4.0'],
    });
    let runnerCalled = false;

    const result = runMigrate({
      argv: ['--from', '1.3.0', '--to', '1.5.0', '--dry-run'],
      runMigrations: () => {
        runnerCalled = true;
        return { applied: [], skipped: [] };
      },
      registry,
      write: cap.write,
      writeErr: cap.writeErr,
      exit: cap.exit,
    });

    // Range filter is fromVersion < v <= toVersion → only 1.4.0 and 1.5.0.
    assert.deepEqual(result.wouldApply, ['1.4.0']);
    assert.deepEqual(result.wouldSkip, ['1.5.0']);
    assert.equal(result.action, 'dry-run');
    assert.equal(result.ok, true);

    // Dry-run probes detect on in-range steps only — never apply, never the
    // live runner.
    assert.deepEqual(calls, ['detect:1.4.0', 'detect:1.5.0']);
    assert.equal(runnerCalled, false);
    assert.ok(!calls.some((c) => c.startsWith('apply:')));

    // Operator-facing plan output.
    const stdout = cap.out.join('');
    assert.match(stdout, /dry run v1\.3\.0 → v1\.5\.0/);
    assert.match(stdout, /would apply {2}1\.4\.0: rename foo to bar/);
    assert.match(stdout, /would skip {3}1\.5\.0: move baseline file/);
    assert.match(stdout, /no migrations applied, nothing written/);
    assert.equal(cap.exitCode, null);
  });

  it('reports an empty plan when no steps fall in range', () => {
    const cap = makeCapture();
    const { registry, calls } = makeFixtureRegistry();

    const result = runMigrate({
      // 1.6.0 < v <= 1.6.0 leaves only the 1.6.0 step out (exclusive lower);
      // 9.9.0 → 9.9.0 range catches nothing.
      argv: ['--from', '9.9.0', '--to', '9.9.0', '--dry-run'],
      runMigrations: () => ({ applied: [], skipped: [] }),
      registry,
      write: cap.write,
      writeErr: cap.writeErr,
      exit: cap.exit,
    });

    assert.deepEqual(result.wouldApply, []);
    assert.deepEqual(result.wouldSkip, []);
    assert.deepEqual(calls, []);
    assert.match(cap.out.join(''), /no migration steps in range/);
  });
});

// ---------------------------------------------------------------------------
// AC — missing bounds are a usage error
// ---------------------------------------------------------------------------

describe('runMigrate — usage validation', () => {
  it('exits non-zero when --to is missing', () => {
    const cap = makeCapture();
    let runnerCalled = false;

    const result = runMigrate({
      argv: ['--from', '1.3.0'],
      runMigrations: () => {
        runnerCalled = true;
        return { applied: [], skipped: [] };
      },
      registry: [],
      write: cap.write,
      writeErr: cap.writeErr,
      exit: cap.exit,
    });

    assert.equal(result.ok, false);
    assert.equal(result.action, 'usage-error');
    assert.equal(cap.exitCode, 1);
    assert.equal(runnerCalled, false);
    assert.match(cap.err.join(''), /both --from .* and --to .* are required/);
  });

  it('exits non-zero when --from is missing', () => {
    const cap = makeCapture();

    const result = runMigrate({
      argv: ['--to', '1.5.0'],
      runMigrations: () => ({ applied: [], skipped: [] }),
      registry: [],
      write: cap.write,
      writeErr: cap.writeErr,
      exit: cap.exit,
    });

    assert.equal(result.action, 'usage-error');
    assert.equal(cap.exitCode, 1);
  });
});

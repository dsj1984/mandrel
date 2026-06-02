/**
 * tests/cli/postinstall.test.js — unit tests for bin/postinstall.js
 *
 * The published-package `postinstall` hook (Story #3469) MUST run
 * `mandrel sync` best-effort and exit 0 even when the sync fails, logging a
 * "run `mandrel sync`" hint so `--ignore-scripts` / sandboxed installs degrade
 * to the doctor-detected state instead of failing the consumer's install.
 *
 * Tests drive `runPostinstall` through its injectable seams (`sync`,
 * `writeErr`, `exit`) so no real package resolution, filesystem I/O, or
 * process exit occurs (testing-standards § Unit).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runPostinstall } from '../../bin/postinstall.js';

describe('postinstall hook — success path', () => {
  it('invokes the sync materializer', () => {
    let called = false;
    runPostinstall({
      sync: () => {
        called = true;
      },
      writeErr: () => {},
      exit: () => {},
    });
    assert.equal(called, true);
  });

  it('exits 0 when sync succeeds', () => {
    let exitCode;
    runPostinstall({
      sync: () => {},
      writeErr: () => {},
      exit: (code) => {
        exitCode = code;
      },
    });
    assert.equal(exitCode, 0);
  });

  it('does not log a hint when sync succeeds', () => {
    let hint = '';
    runPostinstall({
      sync: () => {},
      writeErr: (s) => {
        hint += s;
      },
      exit: () => {},
    });
    assert.equal(hint, '');
  });
});

describe('postinstall hook — sync reports non-zero exit (e.g. package missing)', () => {
  it('still exits 0 (best-effort: never fail the install)', () => {
    let exitCode;
    runPostinstall({
      // Mimic runSync's missing-package path, which calls its injected exit(1).
      sync: ({ exit }) => exit(1),
      writeErr: () => {},
      exit: (code) => {
        exitCode = code;
      },
    });
    assert.equal(exitCode, 0);
  });

  it('logs a "run `mandrel sync`" hint', () => {
    let hint = '';
    runPostinstall({
      sync: ({ exit }) => exit(1),
      writeErr: (s) => {
        hint += s;
      },
      exit: () => {},
    });
    assert.match(hint, /mandrel sync/);
  });
});

describe('postinstall hook — sync throws (e.g. mid-copy fault)', () => {
  it('swallows the throw and exits 0', () => {
    let exitCode;
    runPostinstall({
      sync: () => {
        throw new Error('boom');
      },
      writeErr: () => {},
      exit: (code) => {
        exitCode = code;
      },
    });
    assert.equal(exitCode, 0);
  });

  it('logs the remediation hint after a thrown error', () => {
    let hint = '';
    runPostinstall({
      sync: () => {
        throw new Error('boom');
      },
      writeErr: (s) => {
        hint += s;
      },
      exit: () => {},
    });
    assert.match(hint, /mandrel sync/);
  });
});

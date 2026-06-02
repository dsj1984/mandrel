// tests/lib/orchestration/lifecycle/listeners/merge-watcher.test.js
/**
 * Focused unit tests for `readPriorAttempts` in the MergeWatcher
 * lifecycle listener.
 *
 * Story #3423: the method's CRAP score was jittering between its
 * committed baseline value (~8.3) and a fresh-run value (~29) because
 * no test exercised `readPriorAttempts` directly — its coverage was an
 * incidental side effect of other tests' execution ordering (the
 * resume-contract suite stubs `readPriorAttemptsFn`, so the real
 * function body never ran deterministically). These tests pin every
 * branch and edge case of `readPriorAttempts` so its line and branch
 * coverage — and therefore its CRAP — are stable across full-baseline
 * regenerations.
 *
 * The function takes injectable `readFileFn` / `existsFn` dependencies,
 * so every case here is pure (no real filesystem I/O) and fully
 * deterministic regardless of suite ordering.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  readPriorAttempts,
  resolveLedgerPath,
} from '../../../../../.agents/scripts/lib/orchestration/lifecycle/listeners/merge-watcher.js';

const TEMP_ROOT = '/tmp/merge-watcher';
const EPIC_ID = 2880;

/**
 * Build a `readPriorAttempts` call with injected filesystem doubles.
 * Captures the path each dependency was asked about so tests can pin
 * that the function routes through `resolveLedgerPath`.
 */
function callReadPriorAttempts({ exists, readImpl }) {
  const seen = { existsPath: null, readPath: null };
  const count = readPriorAttempts({
    tempRoot: TEMP_ROOT,
    epicId: EPIC_ID,
    existsFn: (file) => {
      seen.existsPath = file;
      return exists;
    },
    readFileFn: (file, enc) => {
      seen.readPath = file;
      seen.readEnc = enc;
      return readImpl(file, enc);
    },
  });
  return { count, seen };
}

describe('readPriorAttempts — missing / empty ledger', () => {
  it('returns 0 when the ledger file does not exist (existsFn=false)', () => {
    // Arrange: existsFn reports the ledger is absent (first-run case).
    let readCalled = false;
    // Act
    const { count, seen } = callReadPriorAttempts({
      exists: false,
      readImpl: () => {
        readCalled = true;
        return '';
      },
    });
    // Assert: no read attempted, count is 0, and the probed path is the
    // canonical ledger layout.
    assert.equal(count, 0);
    assert.equal(readCalled, false, 'must not read a non-existent ledger');
    assert.equal(
      seen.existsPath,
      resolveLedgerPath({ tempRoot: TEMP_ROOT, epicId: EPIC_ID }),
    );
  });

  it('returns 0 when readFileFn throws ENOENT (race: file vanished after existsFn)', () => {
    // Arrange: existsFn=true but the read races a delete → ENOENT.
    const enoent = Object.assign(new Error('no such file'), { code: 'ENOENT' });
    // Act
    const { count } = callReadPriorAttempts({
      exists: true,
      readImpl: () => {
        throw enoent;
      },
    });
    // Assert: ENOENT degrades to 0 rather than throwing.
    assert.equal(count, 0);
  });

  it('rethrows a non-ENOENT read error (e.g. EACCES)', () => {
    // Arrange: a permission error must surface, not be swallowed.
    const eacces = Object.assign(new Error('permission denied'), {
      code: 'EACCES',
    });
    // Act / Assert
    assert.throws(
      () =>
        callReadPriorAttempts({
          exists: true,
          readImpl: () => {
            throw eacces;
          },
        }),
      /permission denied/,
    );
  });

  it('returns 0 when the ledger exists but is empty', () => {
    // Arrange: empty file → falsy raw.
    const { count } = callReadPriorAttempts({
      exists: true,
      readImpl: () => '',
    });
    // Assert
    assert.equal(count, 0);
  });

  it('returns 0 when the ledger is whitespace-only', () => {
    // Arrange: only blank lines → every line trimmed to empty and skipped.
    const { count } = callReadPriorAttempts({
      exists: true,
      readImpl: () => '\n  \n\t\n',
    });
    // Assert
    assert.equal(count, 0);
  });
});

describe('readPriorAttempts — happy path counting', () => {
  it('counts every well-formed attempt record', () => {
    // Arrange: three valid NDJSON records.
    const raw = [
      JSON.stringify({ attempt: 1, observedAt: 'a', status: 'pending' }),
      JSON.stringify({ attempt: 2, observedAt: 'b', status: 'pending' }),
      JSON.stringify({ attempt: 3, observedAt: 'c', status: 'merged' }),
    ].join('\n');
    // Act
    const { count, seen } = callReadPriorAttempts({
      exists: true,
      readImpl: () => raw,
    });
    // Assert: count matches and the read used utf-8 on the ledger path.
    assert.equal(count, 3);
    assert.equal(seen.readEnc, 'utf-8');
    assert.equal(
      seen.readPath,
      resolveLedgerPath({ tempRoot: TEMP_ROOT, epicId: EPIC_ID }),
    );
  });

  it('tolerates a trailing newline without overcounting', () => {
    // Arrange: a trailing newline yields a final empty line that must
    // be skipped, not counted.
    const raw = `${JSON.stringify({ attempt: 1 })}\n`;
    // Act
    const { count } = callReadPriorAttempts({
      exists: true,
      readImpl: () => raw,
    });
    // Assert
    assert.equal(count, 1);
  });
});

describe('readPriorAttempts — malformed / partial records (defense)', () => {
  it('skips lines that are not valid JSON but counts the valid ones', () => {
    // Arrange: a truncated/garbage line interleaved with valid records.
    const raw = [
      JSON.stringify({ attempt: 1 }),
      '{ this is not json',
      JSON.stringify({ attempt: 2 }),
    ].join('\n');
    // Act
    const { count } = callReadPriorAttempts({
      exists: true,
      readImpl: () => raw,
    });
    // Assert: only the two parseable records count.
    assert.equal(count, 2);
  });

  it('skips records whose `attempt` is missing or not an integer', () => {
    // Arrange: records that parse as JSON but fail the integer guard.
    const raw = [
      JSON.stringify({ observedAt: 'x' }), // no attempt field
      JSON.stringify({ attempt: 'two' }), // non-integer attempt
      JSON.stringify({ attempt: 1.5 }), // non-integer attempt
      JSON.stringify({ attempt: null }), // non-integer attempt
      JSON.stringify({ attempt: 4 }), // the only valid one
    ].join('\n');
    // Act
    const { count } = callReadPriorAttempts({
      exists: true,
      readImpl: () => raw,
    });
    // Assert
    assert.equal(count, 1);
  });

  it('skips a non-object parsed line (e.g. a bare JSON number)', () => {
    // Arrange: `42` parses to a number; `record && Number.isInteger(...)`
    // short-circuits because a number has no `.attempt`.
    const raw = ['42', JSON.stringify({ attempt: 1 })].join('\n');
    // Act
    const { count } = callReadPriorAttempts({
      exists: true,
      readImpl: () => raw,
    });
    // Assert
    assert.equal(count, 1);
  });

  it('skips a JSON null line without throwing', () => {
    // Arrange: `null` parses but fails the `record &&` guard.
    const raw = ['null', JSON.stringify({ attempt: 1 })].join('\n');
    // Act
    const { count } = callReadPriorAttempts({
      exists: true,
      readImpl: () => raw,
    });
    // Assert
    assert.equal(count, 1);
  });
});

describe('readPriorAttempts — default dependency wiring', () => {
  it('defaults existsFn to a real check and returns 0 for an absent ledger', () => {
    // Arrange: a tempRoot/epicId pair whose ledger cannot exist on disk.
    // This exercises the default `existsFn = existsSync` parameter
    // without any injection, pinning the no-arg branch deterministically.
    // Act
    const count = readPriorAttempts({
      tempRoot: '/definitely/not/a/real/path/merge-watcher-3423',
      epicId: 999999,
    });
    // Assert
    assert.equal(count, 0);
  });
});

/**
 * cli-options.test.js — the `test-isolate` argv parse (Story #5316).
 *
 * This logic used to live in `.agents/scripts/test-isolate.js`, which no test
 * imports, so it sat at 0% coverage and scored CRAP 210 — the formula's
 * untested maximum at cyclomatic 14. These cases exist to make that number a
 * measurement of tested code rather than of silence, so they cover every
 * branch of the parse, not just the happy flags.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseIsolateArgv } from '../../../.agents/scripts/lib/test-isolate/cli-options.js';

describe('parseIsolateArgv — defaults', () => {
  it('returns the documented defaults for an empty argv', () => {
    assert.deepEqual(parseIsolateArgv([]), {
      pattern: undefined,
      workers: undefined,
      maxBisectDepth: 8,
      maxBisectTargets: 5,
      suiteConcurrency: 8,
      json: false,
      quiet: false,
    });
  });

  it('tolerates a missing argv entirely', () => {
    assert.equal(parseIsolateArgv().maxBisectDepth, 8);
  });

  it('returns a fresh object each call — no shared mutable defaults', () => {
    const first = parseIsolateArgv(['--json']);
    const second = parseIsolateArgv([]);
    assert.equal(first.json, true);
    assert.equal(second.json, false);
  });
});

describe('parseIsolateArgv — numeric flags', () => {
  for (const [flag, key] of [
    ['--workers', 'workers'],
    ['--max-bisect-depth', 'maxBisectDepth'],
    ['--max-bisect-targets', 'maxBisectTargets'],
    ['--suite-concurrency', 'suiteConcurrency'],
  ]) {
    it(`${flag} consumes the next entry as a number`, () => {
      assert.equal(parseIsolateArgv([flag, '3'])[key], 3);
    });
  }

  it('consumes the value so it is never mistaken for the pattern', () => {
    // The ladder this replaced advanced `i` past the value; a table dispatch
    // that forgot to would read "4" as the positional pattern.
    assert.equal(parseIsolateArgv(['--workers', '4']).pattern, undefined);
  });

  it('a trailing value-taking flag is ignored, not parsed as NaN', () => {
    const opts = parseIsolateArgv(['--workers']);
    assert.equal(opts.workers, undefined);
  });

  it('an empty-string value is ignored, matching the original truthiness test', () => {
    assert.equal(parseIsolateArgv(['--workers', '']).workers, undefined);
  });

  it('a non-numeric value becomes NaN rather than throwing', () => {
    assert.ok(Number.isNaN(parseIsolateArgv(['--workers', 'many']).workers));
  });

  it('the last occurrence of a repeated flag wins', () => {
    assert.equal(
      parseIsolateArgv(['--workers', '2', '--workers', '9']).workers,
      9,
    );
  });
});

describe('parseIsolateArgv — boolean flags', () => {
  it('--json and --quiet set their options', () => {
    const opts = parseIsolateArgv(['--json', '--quiet']);
    assert.equal(opts.json, true);
    assert.equal(opts.quiet, true);
  });

  it('leaves the other boolean untouched', () => {
    assert.equal(parseIsolateArgv(['--json']).quiet, false);
  });
});

describe('parseIsolateArgv — the positional pattern', () => {
  it('takes the first non-flag argument', () => {
    assert.equal(parseIsolateArgv(['tests/lib/**']).pattern, 'tests/lib/**');
  });

  it('ignores a second non-flag argument', () => {
    assert.equal(parseIsolateArgv(['first', 'second']).pattern, 'first');
  });

  it('never treats an unknown --flag as the pattern', () => {
    assert.equal(parseIsolateArgv(['--not-a-flag']).pattern, undefined);
  });

  it('accepts the pattern before or after flags', () => {
    assert.equal(
      parseIsolateArgv(['--quiet', 'tests/a.test.js']).pattern,
      'tests/a.test.js',
    );
    assert.equal(
      parseIsolateArgv(['tests/a.test.js', '--quiet']).pattern,
      'tests/a.test.js',
    );
  });

  it('parses a realistic full invocation', () => {
    const opts = parseIsolateArgv([
      'tests/lib/**',
      '--workers',
      '2',
      '--max-bisect-depth',
      '4',
      '--max-bisect-targets',
      '1',
      '--suite-concurrency',
      '6',
      '--json',
      '--quiet',
    ]);
    assert.deepEqual(opts, {
      pattern: 'tests/lib/**',
      workers: 2,
      maxBisectDepth: 4,
      maxBisectTargets: 1,
      suiteConcurrency: 6,
      json: true,
      quiet: true,
    });
  });
});

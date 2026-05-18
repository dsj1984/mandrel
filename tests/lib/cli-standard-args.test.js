/**
 * tests/lib/cli-standard-args.test.js — Task #2474 (Epic #2453, Story #2460).
 *
 * Pins the contract for `parseStandardCliArgs`, the shared dispatcher CLI
 * flag parser. Coverage targets the three contract surfaces called out
 * in the Task body:
 *
 *   1. Deterministic shape: every supported flag round-trips into a
 *      stable `values` slot.
 *   2. Schema-driven required-field enforcement (positive + negative).
 *   3. Unknown-flag rejection at parse time (no silent drop).
 *
 * Plus one assertion per flag to anchor the per-flag coercion (ticket /
 * string / boolean) so a future schema edit can't silently regress.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  FLAG_NAMES,
  parseStandardCliArgs,
  SUPPORTED_FLAGS,
} from '../../.agents/scripts/lib/cli/standard-args.js';

describe('parseStandardCliArgs — deterministic shape', () => {
  it('returns every supported flag with a stable default when argv is empty', () => {
    const { values, positionals } = parseStandardCliArgs([]);
    assert.deepEqual(positionals, []);
    assert.equal(values.epicId, null);
    assert.equal(values.storyId, null);
    assert.equal(values.taskId, null);
    assert.equal(values.changedSince, null);
    assert.equal(values.json, false);
    assert.equal(values.fullScope, false);
    assert.equal(values.dryRun, false);
  });

  it('values keys exactly match the alias declared in SUPPORTED_FLAGS', () => {
    const { values } = parseStandardCliArgs([]);
    const expectedKeys = FLAG_NAMES.map((n) => SUPPORTED_FLAGS[n].key).sort();
    assert.deepEqual(Object.keys(values).sort(), expectedKeys);
  });
});

describe('parseStandardCliArgs — per-flag coercion (one assertion per flag)', () => {
  it('--epic coerces to a positive integer (ticket)', () => {
    const { values } = parseStandardCliArgs(['--epic', '2453']);
    assert.equal(values.epicId, 2453);
  });

  it('--story coerces to a positive integer (ticket) and strips a leading #', () => {
    const { values } = parseStandardCliArgs(['--story', '#2460']);
    assert.equal(values.storyId, 2460);
  });

  it('--task coerces to a positive integer (ticket)', () => {
    const { values } = parseStandardCliArgs(['--task', '2474']);
    assert.equal(values.taskId, 2474);
  });

  it('--changed-since preserves the raw string (string)', () => {
    const { values } = parseStandardCliArgs(['--changed-since', 'origin/main']);
    assert.equal(values.changedSince, 'origin/main');
  });

  it('--json toggles a boolean (bare flag → true)', () => {
    const { values } = parseStandardCliArgs(['--json']);
    assert.equal(values.json, true);
  });

  it('--full-scope toggles a boolean (bare flag → true)', () => {
    const { values } = parseStandardCliArgs(['--full-scope']);
    assert.equal(values.fullScope, true);
  });

  it('--dry-run toggles a boolean (bare flag → true)', () => {
    const { values } = parseStandardCliArgs(['--dry-run']);
    assert.equal(values.dryRun, true);
  });
});

describe('parseStandardCliArgs — ticket coercion edge cases', () => {
  it('invalid ticket values resolve to null (not NaN)', () => {
    const { values } = parseStandardCliArgs(['--epic', 'not-a-number']);
    assert.equal(values.epicId, null);
  });

  it('negative ticket values resolve to null', () => {
    const { values } = parseStandardCliArgs(['--story', '-7']);
    assert.equal(values.storyId, null);
  });

  it('accepts multiple ticket flags side by side', () => {
    const { values } = parseStandardCliArgs([
      '--epic',
      '2453',
      '--story',
      '2460',
      '--task',
      '2474',
    ]);
    assert.equal(values.epicId, 2453);
    assert.equal(values.storyId, 2460);
    assert.equal(values.taskId, 2474);
  });
});

describe('parseStandardCliArgs — positional pass-through', () => {
  it('preserves positional arguments after a `--` separator', () => {
    const { values, positionals } = parseStandardCliArgs([
      '--epic',
      '2453',
      '--',
      'first',
      'second',
    ]);
    assert.equal(values.epicId, 2453);
    assert.deepEqual(positionals, ['first', 'second']);
  });

  it('collects bare positionals when no `--` separator is present', () => {
    const { positionals } = parseStandardCliArgs(['some-positional']);
    assert.deepEqual(positionals, ['some-positional']);
  });
});

describe('parseStandardCliArgs — required-field enforcement', () => {
  it('throws MISSING_REQUIRED_FLAG when a ticket flag is required but absent', () => {
    assert.throws(
      () => parseStandardCliArgs([], { story: { required: true } }),
      (err) => {
        assert.equal(err.code, 'MISSING_REQUIRED_FLAG');
        assert.equal(err.flag, 'story');
        return true;
      },
    );
  });

  it('throws MISSING_REQUIRED_FLAG when an unparseable ticket is supplied for a required flag', () => {
    assert.throws(
      () =>
        parseStandardCliArgs(['--story', 'garbage'], {
          story: { required: true },
        }),
      (err) => {
        assert.equal(err.code, 'MISSING_REQUIRED_FLAG');
        return true;
      },
    );
  });

  it('throws MISSING_REQUIRED_FLAG for a missing required string flag', () => {
    assert.throws(
      () => parseStandardCliArgs([], { 'changed-since': { required: true } }),
      (err) => err.code === 'MISSING_REQUIRED_FLAG' &&
        err.flag === 'changed-since',
    );
  });

  it('throws MISSING_REQUIRED_FLAG for a required boolean flag that is absent', () => {
    assert.throws(
      () => parseStandardCliArgs([], { 'dry-run': { required: true } }),
      (err) => err.code === 'MISSING_REQUIRED_FLAG' && err.flag === 'dry-run',
    );
  });

  it('does not throw when every required flag is satisfied', () => {
    const { values } = parseStandardCliArgs(
      ['--story', '2460', '--changed-since', 'HEAD', '--dry-run'],
      {
        story: { required: true },
        'changed-since': { required: true },
        'dry-run': { required: true },
      },
    );
    assert.equal(values.storyId, 2460);
    assert.equal(values.changedSince, 'HEAD');
    assert.equal(values.dryRun, true);
  });

  it('rejects schemas referencing unsupported flags so typos surface loudly', () => {
    assert.throws(
      () => parseStandardCliArgs([], { 'changed-sinec': { required: true } }),
      (err) => err.code === 'UNKNOWN_FLAG_IN_SCHEMA',
    );
  });
});

describe('parseStandardCliArgs — unknown-flag rejection', () => {
  it('throws UNKNOWN_FLAG on a `--foo` token whose name is not supported', () => {
    assert.throws(
      () => parseStandardCliArgs(['--unsupported', 'value']),
      (err) => {
        assert.equal(err.code, 'UNKNOWN_FLAG');
        assert.equal(err.flag, 'unsupported');
        return true;
      },
    );
  });

  it('throws UNKNOWN_FLAG on a `--foo=bar` shape too', () => {
    assert.throws(
      () => parseStandardCliArgs(['--mystery=42']),
      (err) => err.code === 'UNKNOWN_FLAG' && err.flag === 'mystery',
    );
  });

  it('rejects argv that is not an array', () => {
    assert.throws(
      () => parseStandardCliArgs('--story 2460'),
      /argv must be an array/,
    );
  });

  it('stops scanning for unknown flags after a `--` separator', () => {
    // Tokens after `--` are positionals; even if shaped like flags they
    // should not trip the unknown-flag walker.
    const { positionals } = parseStandardCliArgs([
      '--story',
      '2460',
      '--',
      '--would-be-unknown',
    ]);
    assert.deepEqual(positionals, ['--would-be-unknown']);
  });
});

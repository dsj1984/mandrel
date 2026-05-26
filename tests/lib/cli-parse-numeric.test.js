/**
 * tests/lib/cli-parse-numeric.test.js — Story #2993.
 *
 * Pins the contract for `parseRequiredPositiveInt` and
 * `parseRequiredNonNegativeInt`, extracted from
 * `lifecycle-emit-story-dispatch.js` so future scripts can share the
 * validators instead of hand-rolling another `Number.parseInt` dance.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  parseRequiredNonNegativeInt,
  parseRequiredPositiveInt,
} from '../../.agents/scripts/lib/cli/parse-numeric.js';

describe('parseRequiredPositiveInt', () => {
  it('parses a positive integer string', () => {
    assert.equal(parseRequiredPositiveInt('42', '--epic'), 42);
  });

  it('strips a leading # before parsing (ticket-style)', () => {
    assert.equal(parseRequiredPositiveInt('#2891', '--story'), 2891);
  });

  it('accepts a numeric input', () => {
    assert.equal(parseRequiredPositiveInt(7, '--attempt'), 7);
  });

  it('throws on undefined with the "is required" message', () => {
    assert.throws(
      () => parseRequiredPositiveInt(undefined, '--epic'),
      /--epic is required/,
    );
  });

  it('throws on null', () => {
    assert.throws(
      () => parseRequiredPositiveInt(null, '--story'),
      /--story is required/,
    );
  });

  it('throws on empty string', () => {
    assert.throws(
      () => parseRequiredPositiveInt('', '--epic'),
      /--epic is required/,
    );
  });

  it('throws on non-integer input with "must be a positive integer"', () => {
    assert.throws(
      () => parseRequiredPositiveInt('garbage', '--epic'),
      /--epic must be a positive integer/,
    );
  });

  it('throws on zero (must be >= 1)', () => {
    assert.throws(
      () => parseRequiredPositiveInt('0', '--attempt'),
      /--attempt must be a positive integer/,
    );
  });

  it('throws on a negative integer', () => {
    assert.throws(
      () => parseRequiredPositiveInt('-5', '--story'),
      /--story must be a positive integer/,
    );
  });

  it('prefixes the error with the tool label when supplied', () => {
    assert.throws(
      () => parseRequiredPositiveInt(undefined, '--epic', 'my-tool'),
      /^Error: my-tool: --epic is required$/,
    );
  });
});

describe('parseRequiredNonNegativeInt', () => {
  it('parses a positive integer string', () => {
    assert.equal(parseRequiredNonNegativeInt('3', '--wave'), 3);
  });

  it('accepts zero (>= 0 is the contract)', () => {
    assert.equal(parseRequiredNonNegativeInt('0', '--wave'), 0);
  });

  it('does NOT strip a leading # (non-ticket convention)', () => {
    assert.throws(
      () => parseRequiredNonNegativeInt('#3', '--wave'),
      /--wave must be a non-negative integer/,
    );
  });

  it('throws on undefined with the "is required" message', () => {
    assert.throws(
      () => parseRequiredNonNegativeInt(undefined, '--wave'),
      /--wave is required/,
    );
  });

  it('throws on null', () => {
    assert.throws(
      () => parseRequiredNonNegativeInt(null, '--wave'),
      /--wave is required/,
    );
  });

  it('throws on empty string', () => {
    assert.throws(
      () => parseRequiredNonNegativeInt('', '--wave'),
      /--wave is required/,
    );
  });

  it('throws on non-integer input with "must be a non-negative integer"', () => {
    assert.throws(
      () => parseRequiredNonNegativeInt('nope', '--wave'),
      /--wave must be a non-negative integer/,
    );
  });

  it('throws on a negative integer', () => {
    assert.throws(
      () => parseRequiredNonNegativeInt('-1', '--wave'),
      /--wave must be a non-negative integer/,
    );
  });

  it('prefixes the error with the tool label when supplied', () => {
    assert.throws(
      () => parseRequiredNonNegativeInt(undefined, '--wave', 'my-tool'),
      /^Error: my-tool: --wave is required$/,
    );
  });
});

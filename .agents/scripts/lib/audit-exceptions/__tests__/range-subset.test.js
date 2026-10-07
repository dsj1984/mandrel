import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { rangeIsSubset } from '../range-subset.js';

describe('rangeIsSubset', () => {
  const cases = [
    ['^4.3.2', '^4.3.2', true],
    ['^4.4.0', '^4.3.2', true],
    ['4.1.1', '^4.3.2', false],
    ['^4.1.0', '^4.3.2', false],
    ['~1.2.3', '^1.0.0', true],
    ['^1.2.3', '~1.2.0', false],
    ['^0.2.3', '^0.2.0', true],
    ['^0.3.0', '^0.2.0', false],
    ['^0.0.3', '0.0.3', true],
    ['1.x', '^1.0.0', true],
    ['1.2.x', '~1.2.0', true],
    ['>=1.2.0 <1.3.0', '~1.2.0', true],
    ['>=2.0.0', '^2.0.0', false],
    ['>1.2.3', '>=1.2.4', true],
    ['<=1.2', '<1.3.0', true],
    ['<2.0.0', '>=1.0.0', false],
    ['1.0.0 || 2.0.0', '^1.0.0 || ^2.0.0', true],
    ['*', '^1.0.0', false],
    ['^1.2.0', '*', true],
  ];
  for (const [inner, outer, expected] of cases) {
    it(`${inner} within ${outer} is ${expected}`, () => {
      assert.equal(rangeIsSubset(inner, outer), expected);
    });
  }

  it('answers null — never false — for shapes it cannot decide', () => {
    for (const range of [
      '1.2.3-beta.1',
      'latest',
      'npm:foo@^1',
      'workspace:*',
      '1.0.0 - 2.0.0',
      'file:../x',
    ]) {
      assert.equal(rangeIsSubset(range, '^1.0.0'), null, range);
      assert.equal(rangeIsSubset('^1.0.0', range), null, range);
    }
  });

  it('answers null when only a union of outer arms could cover an inner arm', () => {
    assert.equal(rangeIsSubset('^1.0.0', '^1.0.0 || ^2.0.0'), true);
    assert.equal(rangeIsSubset('>=1.0.0 <3.0.0', '^1.0.0 || ^2.0.0'), null);
  });

  it('rejects a non-string range', () => {
    assert.equal(rangeIsSubset(undefined, '^1.0.0'), null);
    assert.equal(rangeIsSubset(42, '^1.0.0'), null);
  });
});

describe('a concrete version', () => {
  it('is checked as the one-version range it is', () => {
    assert.equal(rangeIsSubset('4.3.5', '^4.3.2'), true);
    assert.equal(rangeIsSubset('4.1.1', '^4.3.2'), false);
    assert.equal(rangeIsSubset('5.0.0', '^4.3.2'), false);
  });
});

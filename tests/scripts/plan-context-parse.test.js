// tests/scripts/plan-context-parse.test.js
/**
 * Unit tests for `/mandrel-plan`'s `--tickets` parser. `parseTicketIds`
 * accepts the same `#`-prefixed spelling `parseAmendsId` does, dedupes in
 * first-seen order, and rejects empty, non-positive and non-numeric input.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  parseAmendsId,
  parseTicketIds,
} from '../../.agents/scripts/plan-context.js';

describe('plan-context parseTicketIds', () => {
  it('parses comma- and whitespace-separated ids', () => {
    assert.deepEqual(parseTicketIds('12, 34 56'), [12, 34, 56]);
  });

  it('strips a leading # per id, consistently with parseAmendsId', () => {
    assert.deepEqual(parseTicketIds('#12,#34'), [12, 34]);
    assert.deepEqual(parseTicketIds(' #7 '), [parseAmendsId(' #7 ')]);
  });

  it('dedupes in first-seen order, across # and bare spellings', () => {
    assert.deepEqual(parseTicketIds('5,#3,5,3,#5'), [5, 3]);
  });

  for (const empty of ['', '   ', ', ,', undefined, null]) {
    it(`rejects empty input ${JSON.stringify(empty)}`, () => {
      assert.throws(
        () => parseTicketIds(empty),
        /--tickets requires one or more positive issue ids/,
      );
    });
  }

  for (const bad of ['0', '-3', '12,0', '#0', '#']) {
    it(`rejects non-positive id input ${JSON.stringify(bad)}`, () => {
      assert.throws(() => parseTicketIds(bad), /positive integer ids/);
    });
  }

  for (const bad of ['abc', '12,x', '1.5', '##4', '4#']) {
    it(`rejects non-numeric id input ${JSON.stringify(bad)}`, () => {
      assert.throws(() => parseTicketIds(bad), /positive integer ids/);
    });
  }
});

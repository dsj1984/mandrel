import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createAjv,
  createAjv2020,
} from '../../../.agents/scripts/lib/util/ajv.js';

const DATE_TIME_OK = [
  '2026-10-18T06:01:00Z',
  '2026-10-18T06:01:00.123+02:00',
  '2026-10-18t06:01:00z',
  '2026-10-18 06:01:00-05:30',
  '2024-02-29T00:00:00Z',
  '2016-12-31T23:59:60Z',
  '2016-12-31T18:59:60-05:00',
];

const DATE_TIME_BAD = [
  '2026-10-18T06:01:00',
  '2026-02-30T00:00:00Z',
  '2025-02-29T00:00:00Z',
  '2026-10-18T24:00:00Z',
  '2026-10-18T06:60:00Z',
  '2026-10-18T06:01:60Z',
  '2026-10-18T06:01:00+24:00',
  '2026-10-18',
  '2026-10-18T06:01Z',
  'Sun, 18 Oct 2026 06:01:00 GMT',
];

const DATE_OK = ['2024-02-29', '2026-10-18', '2000-02-29', '2026-12-31'];
const DATE_BAD = [
  '2026-13-01',
  '2026-00-10',
  '2026-04-31',
  '1900-02-29',
  '2026-10-00',
  '2026-1-01',
  '2026-10-18T00:00:00Z',
];

for (const [name, factory] of [
  ['createAjv', createAjv],
  ['createAjv2020', createAjv2020],
]) {
  describe(`${name} formats`, () => {
    const ajv = factory({ allErrors: true, strict: true });
    const dateTime = ajv.compile({ type: 'string', format: 'date-time' });
    const date = ajv.compile({ type: 'string', format: 'date' });

    for (const v of DATE_TIME_OK) {
      it(`date-time accepts ${v}`, () => assert.equal(dateTime(v), true));
    }
    for (const v of DATE_TIME_BAD) {
      it(`date-time rejects ${v}`, () => assert.equal(dateTime(v), false));
    }
    for (const v of DATE_OK) {
      it(`date accepts ${v}`, () => assert.equal(date(v), true));
    }
    for (const v of DATE_BAD) {
      it(`date rejects ${v}`, () => assert.equal(date(v), false));
    }

    it('keeps the caller option bag', () => {
      assert.equal(ajv.opts.allErrors, true);
      assert.equal(ajv.opts.strict, true);
    });
  });
}

describe('createAjv defaults', () => {
  it('works with no option bag', () => {
    assert.equal(createAjv().validate({ format: 'date' }, '2026-10-18'), true);
    assert.equal(createAjv2020().validate({ format: 'date' }, 'x'), false);
  });
});

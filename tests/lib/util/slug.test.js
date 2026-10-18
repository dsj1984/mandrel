import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { slugifyLabel } from '../../../.agents/scripts/lib/util/slug.js';

describe('slugifyLabel', () => {
  it('lowercases and dash-joins runs outside [a-z0-9]', () => {
    assert.equal(
      slugifyLabel('  Hello, World!  ', { fallback: 'x' }),
      'hello-world',
    );
  });

  it('caps at max and trims a dash the cut exposes', () => {
    assert.equal(slugifyLabel('abc def', { max: 4, fallback: 'x' }), 'abc');
  });

  it('falls back when nothing survives, including null input', () => {
    assert.equal(slugifyLabel('!!!', { fallback: 'plan' }), 'plan');
    assert.equal(slugifyLabel(null, { max: 10, fallback: 'plan' }), 'plan');
  });
});

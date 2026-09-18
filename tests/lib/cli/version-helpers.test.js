import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  compareVersions,
  crossesMajor,
  parseVersion,
  resolveConsumerPinSpec,
  resolveConsumerPinVersion,
  satisfiesPinSpec,
} from '../../../lib/cli/version-helpers.js';

/**
 * Story #4780 — `satisfiesPinSpec` scored CRAP 60.7 because nothing reached
 * it: the caret/tilde/exact range table is what `mandrel doctor`'s
 * `pin-current` check decides on, and it was entirely unexercised.
 *
 * The filesystem-touching pair below is driven through the module's
 * `fsImpl` seam (`docs/contributing/test-seams.md` rules 1 and 5) — a plain stub
 * object passed as the final parameter, never a module mock.
 */

describe('parseVersion / compareVersions / crossesMajor', () => {
  it('coerces missing and non-numeric segments to 0', () => {
    assert.deepEqual(parseVersion('2.16.3'), [2, 16, 3]);
    assert.deepEqual(parseVersion('2.16'), [2, 16, 0]);
    assert.deepEqual(parseVersion('x.y.z'), [0, 0, 0]);
  });

  it('orders on major, then minor, then patch', () => {
    assert.ok(compareVersions('2.0.0', '1.9.9') > 0);
    assert.ok(compareVersions('1.2.3', '1.3.0') < 0);
    assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  });

  it('crossesMajor is true only when the major axis advances', () => {
    assert.equal(crossesMajor('2.16.0', '3.0.0'), true);
    assert.equal(crossesMajor('2.16.0', '2.99.9'), false);
    assert.equal(crossesMajor('3.0.0', '2.0.0'), false);
  });
});

describe('satisfiesPinSpec', () => {
  it('rejects anything below the spec version regardless of operator', () => {
    assert.equal(
      satisfiesPinSpec('1.2.2', { operator: '^', version: '1.2.3' }),
      false,
    );
    assert.equal(
      satisfiesPinSpec('1.2.2', { operator: '~', version: '1.2.3' }),
      false,
    );
    assert.equal(
      satisfiesPinSpec('1.2.2', { operator: '', version: '1.2.3' }),
      false,
    );
  });

  it('~1.2.3 admits the patch axis only', () => {
    const spec = { operator: '~', version: '1.2.3' };
    assert.equal(satisfiesPinSpec('1.2.3', spec), true);
    assert.equal(satisfiesPinSpec('1.2.99', spec), true);
    assert.equal(satisfiesPinSpec('1.3.0', spec), false);
    assert.equal(satisfiesPinSpec('2.2.3', spec), false);
  });

  it('^1.2.3 admits the whole 1.x line', () => {
    const spec = { operator: '^', version: '1.2.3' };
    assert.equal(satisfiesPinSpec('1.2.3', spec), true);
    assert.equal(satisfiesPinSpec('1.99.0', spec), true);
    assert.equal(satisfiesPinSpec('2.0.0', spec), false);
  });

  it('^0.2.3 pins the minor axis (0.x: minor is the API axis)', () => {
    const spec = { operator: '^', version: '0.2.3' };
    assert.equal(satisfiesPinSpec('0.2.3', spec), true);
    assert.equal(satisfiesPinSpec('0.2.99', spec), true);
    assert.equal(satisfiesPinSpec('0.3.0', spec), false);
    assert.equal(satisfiesPinSpec('1.0.0', spec), false);
  });

  it('^0.0.3 pins the patch axis exactly', () => {
    const spec = { operator: '^', version: '0.0.3' };
    assert.equal(satisfiesPinSpec('0.0.3', spec), true);
    assert.equal(satisfiesPinSpec('0.0.4', spec), false);
    assert.equal(satisfiesPinSpec('0.1.0', spec), false);
  });

  it('an empty operator is an exact match', () => {
    const spec = { operator: '', version: '2.16.0' };
    assert.equal(satisfiesPinSpec('2.16.0', spec), true);
    assert.equal(satisfiesPinSpec('2.16.1', spec), false);
  });

  it('ignores prerelease tags on both sides (numeric-tuple contract)', () => {
    assert.equal(
      satisfiesPinSpec('2.16.0-rc.1', { operator: '^', version: '2.16.0' }),
      true,
    );
  });
});

describe('resolveConsumerPinSpec / resolveConsumerPinVersion', () => {
  /** @param {string} json */
  const fsStub = (json) => ({
    readFileSync: () => {
      if (json === null) throw new Error('ENOENT');
      return json;
    },
  });

  it('reads the dependencies entry, splitting operator from base version', () => {
    const fsImpl = fsStub(
      JSON.stringify({ dependencies: { mandrel: '^2.16.0' } }),
    );
    assert.deepEqual(resolveConsumerPinSpec('/consumer', fsImpl), {
      operator: '^',
      version: '2.16.0',
    });
    assert.equal(resolveConsumerPinVersion('/consumer', fsImpl), '2.16.0');
  });

  it('falls back to devDependencies', () => {
    const fsImpl = fsStub(
      JSON.stringify({ devDependencies: { mandrel: '~1.4.2' } }),
    );
    assert.deepEqual(resolveConsumerPinSpec('/consumer', fsImpl), {
      operator: '~',
      version: '1.4.2',
    });
  });

  it('returns null for an unreadable package.json', () => {
    assert.equal(resolveConsumerPinSpec('/consumer', fsStub(null)), null);
    assert.equal(resolveConsumerPinVersion('/consumer', fsStub(null)), null);
  });

  it('returns null when package.json is not JSON', () => {
    assert.equal(
      resolveConsumerPinSpec('/consumer', fsStub('{ not json')),
      null,
    );
  });

  it('returns null when there is no mandrel entry at all', () => {
    assert.equal(
      resolveConsumerPinSpec(
        '/consumer',
        fsStub(JSON.stringify({ dependencies: {} })),
      ),
      null,
    );
  });

  it('returns null for a non-semver specifier (workspace:/latest/range)', () => {
    for (const declared of [
      'workspace:*',
      'latest',
      '>=2.0.0 <3.0.0',
      'file:../m',
    ]) {
      assert.equal(
        resolveConsumerPinSpec(
          '/consumer',
          fsStub(JSON.stringify({ dependencies: { mandrel: declared } })),
        ),
        null,
        `expected null for ${declared}`,
      );
    }
  });

  it('accepts an exact pin and a prerelease pin', () => {
    assert.deepEqual(
      resolveConsumerPinSpec(
        '/consumer',
        fsStub(JSON.stringify({ dependencies: { mandrel: '2.16.0' } })),
      ),
      { operator: '', version: '2.16.0' },
    );
    assert.deepEqual(
      resolveConsumerPinSpec(
        '/consumer',
        fsStub(JSON.stringify({ dependencies: { mandrel: '^2.17.0-rc.1' } })),
      ),
      { operator: '^', version: '2.17.0-rc.1' },
    );
  });
});

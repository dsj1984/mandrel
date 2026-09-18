/**
 * row-identity.test.js — the `rowIdentity` protocol member (Story #5215).
 *
 * `rowIdentity(row)` is the string a 3-way baseline merge keys a row on. It
 * is deliberately NOT `keyField`: `keyField` is the rollup/scope grouping
 * key, and CRAP groups by file while shipping one row per method. A merge
 * that reached for `keyField` would collapse every method in a file to one
 * row and silently drop the siblings — which is exactly the splice hazard
 * the driver exists to prevent, so the contract is pinned here:
 *
 *   1. every module in the kernel registry exports a callable `rowIdentity`;
 *   2. CRAP's identity is the composite, strictly finer than its `keyField`;
 *   3. identity is INJECTIVE over every shipped `baselines/<kind>.json` —
 *      two distinct rows never collide on one key.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  getKindModule,
  listKinds,
} from '../../../.agents/scripts/lib/baselines/kernel.js';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);

describe('rowIdentity — kind-module protocol', () => {
  for (const kind of listKinds()) {
    it(`${kind} exports a callable rowIdentity`, () => {
      const mod = getKindModule(kind);
      assert.equal(
        typeof mod.rowIdentity,
        'function',
        `${kind}.rowIdentity must be a function — the merge driver reads it off the kind module rather than rebuilding a key from keyField`,
      );
    });
  }

  it('every kind actually computes an identity from a row of its own shape', () => {
    // Asserting `typeof` alone leaves the implementations uninvoked — and the
    // kinds this repo ships no baseline for (mutation, bundle-size) would
    // then have an identity function nothing ever ran.
    const sampleRow = {
      path: 'a/b.js',
      bundle: 'main',
      method: 'fn',
      startLine: 7,
    };
    for (const kind of listKinds()) {
      const { rowIdentity, keyField } = getKindModule(kind);
      const id = rowIdentity(sampleRow);
      assert.equal(typeof id, 'string', `${kind} identity must be a string`);
      assert.ok(id.length > 0, `${kind} identity must be non-empty`);
      assert.ok(
        id.includes(String(sampleRow[keyField])),
        `${kind} identity must be derived from the row, not a constant`,
      );
    }
  });

  it('crap identity is the composite, strictly finer than its keyField', () => {
    const crap = getKindModule('crap');
    assert.equal(crap.keyField, 'path');

    const sibling = { path: 'a/b.js', method: 'two', startLine: 42, crap: 9 };
    const row = { path: 'a/b.js', method: 'one', startLine: 7, crap: 3 };

    assert.equal(crap.rowIdentity(row), 'a/b.js::one@7');
    assert.notEqual(
      crap.rowIdentity(row),
      crap.rowIdentity(sibling),
      'two methods in one file must not share an identity',
    );
    assert.equal(
      row[crap.keyField],
      sibling[crap.keyField],
      '…even though they DO share the keyField the rollup groups on',
    );
  });

  it('a single-field kind identifies by its keyField value', () => {
    const coverage = getKindModule('coverage');
    assert.equal(coverage.rowIdentity({ path: 'a/b.js', lines: 90 }), 'a/b.js');
  });
});

describe('rowIdentity — injective over the shipped baselines', () => {
  const shipped = listKinds()
    .map((kind) => ({
      kind,
      file: path.join(REPO_ROOT, 'baselines', `${kind}.json`),
    }))
    .filter(({ file }) => fs.existsSync(file));

  it('the repo ships at least one envelope baseline to check', () => {
    assert.ok(
      shipped.length > 0,
      'expected at least one baselines/<kind>.json for a known kind',
    );
  });

  for (const { kind, file } of shipped) {
    it(`${kind}.json has no two rows sharing an identity`, () => {
      const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
      const { rowIdentity } = getKindModule(kind);
      const seen = new Map();
      const collisions = [];
      for (const row of envelope.rows ?? []) {
        const id = rowIdentity(row);
        if (seen.has(id)) collisions.push(id);
        else seen.set(id, row);
      }
      assert.deepEqual(
        collisions.slice(0, 5),
        [],
        `${kind}: ${collisions.length} identity collision(s) — a merge keyed on this identity would drop rows`,
      );
      assert.equal(seen.size, (envelope.rows ?? []).length);
    });
  }
});

/**
 * hotspots.test.js — cross-gate clustering and ranking (Story #4902).
 *
 * The property under test is the reason the section exists: a file that is an
 * outlier in two gates is one cluster carrying both memberships, and it
 * outranks a single-gate outlier of *equal per-gate severity*. Rank the two
 * separately — as reading each baseline's own top-20 does — and the
 * convergence that makes the first file the real hotspot is invisible.
 *
 * Fixture-backed: the outliers are extracted from baseline files on disk, so
 * the test covers the on-disk read and the aggregation as well as the join.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { makeTempDir } from '../../test-temp.js';
import { buildHotspots } from '../hotspots.js';
import { extractOutliers } from '../outliers.js';
import { readJsonFile } from '../read.js';

const SHARED = 'src/shared.js';
const LONELY = 'src/lonely.js';
const CALM = 'src/calm.js';

/** Neutral weights, so ranking differences can only come from severity. */
const flatWeights = () => ({
  churnWeight: 1,
  centralityWeight: 1,
  frictionWeight: 1,
});

/**
 * Write a two-gate fixture where SHARED and LONELY are equally severe CRAP
 * outliers and only SHARED is also a maintainability outlier.
 *
 * @returns {string} fixture repo root
 */
function writeFixture() {
  const root = makeTempDir('audit-baselines-hotspots-');
  fs.mkdirSync(path.join(root, 'baselines'), { recursive: true });
  const write = (name, body) =>
    fs.writeFileSync(
      path.join(root, 'baselines', name),
      JSON.stringify(body, null, 2),
    );
  write('crap.json', {
    $schema: '../.agents/schemas/baselines/crap.schema.json',
    kernelVersion: '1.0.0',
    rows: [
      { path: SHARED, method: 'a', startLine: 1, crap: 30 },
      { path: LONELY, method: 'b', startLine: 1, crap: 30 },
      { path: CALM, method: 'c', startLine: 1, crap: 1 },
    ],
  });
  write('maintainability.json', {
    $schema: '../.agents/schemas/baselines/maintainability.schema.json',
    kernelVersion: '1.0.0',
    rows: [
      { path: SHARED, mi: 40 },
      { path: CALM, mi: 100 },
    ],
  });
  return root;
}

/**
 * Extract outliers for both fixture gates.
 *
 * @param {string} root
 * @returns {Array<object>}
 */
function outliersFrom(root) {
  return ['crap', 'maintainability'].flatMap((kind) =>
    extractOutliers({
      kind,
      baseline: readJsonFile(path.join(root, 'baselines', `${kind}.json`))
        .parsed,
      topN: 20,
    }),
  );
}

describe('cross-gate hotspot clustering', () => {
  const root = writeFixture();
  const outliers = outliersFrom(root);
  const hotspots = buildHotspots({ outliers, weightsFor: flatWeights });
  const byPath = new Map(hotspots.map((h) => [h.path, h]));

  it('emits a file outlying in two gates as ONE cluster with both memberships', () => {
    const shared = byPath.get(SHARED);
    assert.ok(shared, 'shared file missing from hotspots');
    assert.equal(shared.gateCount, 2);
    assert.deepEqual(shared.gateKinds, ['crap', 'maintainability']);
    assert.equal(hotspots.filter((h) => h.path === SHARED).length, 1);
  });

  it('gives the two gate memberships equal per-gate severity to the single-gate file', () => {
    const sharedCrap = byPath.get(SHARED).gates.find((g) => g.kind === 'crap');
    const lonelyCrap = byPath.get(LONELY).gates.find((g) => g.kind === 'crap');
    assert.equal(sharedCrap.severityWeight, lonelyCrap.severityWeight);
  });

  it('ranks the two-gate cluster above the single-gate outlier', () => {
    assert.equal(hotspots[0].path, SHARED);
    assert.ok(byPath.get(SHARED).rank > byPath.get(LONELY).rank);
    assert.equal(byPath.get(LONELY).gateCount, 1);
  });

  it('aggregates per-method rows to the file grain', () => {
    // CALM is a CRAP row and a maintainability row but the best value on
    // both axes — it clusters, it just ranks last.
    assert.ok(byPath.get(CALM).rank < byPath.get(LONELY).rank);
  });
});

describe('bounded extraction', () => {
  it('never emits more rows per gate than topN', () => {
    const root = makeTempDir('audit-baselines-topn-');
    fs.mkdirSync(path.join(root, 'baselines'), { recursive: true });
    const rows = Array.from({ length: 100 }, (_, i) => ({
      path: `src/f${i}.js`,
      method: 'm',
      startLine: 1,
      crap: i,
    }));
    fs.writeFileSync(
      path.join(root, 'baselines', 'crap.json'),
      JSON.stringify({
        kernelVersion: '1.0.0',
        rows,
      }),
    );
    const extracted = extractOutliers({
      kind: 'crap',
      baseline: readJsonFile(path.join(root, 'baselines', 'crap.json')).parsed,
      topN: 5,
    });
    assert.equal(extracted.length, 5);
    assert.equal(extracted[0].id, 'src/f99.js');
  });
});

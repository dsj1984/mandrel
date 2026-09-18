/**
 * gate-surface.test.js — instrument-health reporting across both halves of
 * the baseline surface (Story #4902).
 *
 * The load-bearing case is the **stub instrument**: a baseline committed with
 * no rows and an all-zero rollup passes its gate on every run without
 * measuring anything, and reads as green from the exit code. This suite pins
 * that four of Mandrel's own gates are exactly that today, and — the
 * asymmetry that makes the signal usable — that a ratchet baseline with
 * nothing to report (zero import cycles, the success state) is NOT flagged.
 *
 * Everything is driven through `buildGateSurface`, the module's only export:
 * the stub rule, the glob check, and the staleness clock are internals, and
 * pinning them through the composed surface is what a consumer of this
 * envelope actually depends on.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { getQuality, resolveConfig } from '../../config-resolver.js';
import { makeTempDir } from '../../test-temp.js';
import { buildGateSurface } from '../gate-surface.js';
import { GATE_KINDS } from '../kinds.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// __tests__ → audit-baselines → lib → scripts → .agents → repo root
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');

/** The out-of-band ratchets the engine walks alongside the gate kinds. */
const EXPECTED_RATCHETS = [
  'arch-cycles',
  'context-budget',
  // Story #4923 — the cyclomatic ceiling ratchet, the first consumer of
  // `codingGuardrails.cyclomaticMustFix`.
  'cyclomatic',
  'dead-exports',
  'dead-exports-production',
];

/**
 * Build a fixture repo root, writing each `[relPath, body]` pair.
 *
 * @param {Array<[string, object | string]>} files
 * @returns {string}
 */
function makeFixture(files) {
  const root = makeTempDir('audit-baselines-surface-');
  for (const [rel, body] of files) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(
      abs,
      typeof body === 'string' ? body : JSON.stringify(body, null, 2),
    );
  }
  return root;
}

/**
 * Index a fixture's surface entries by kind.
 *
 * @param {string} root
 * @param {object} quality
 * @returns {Map<string, object>}
 */
function surfaceOf(root, quality = { gates: {} }) {
  const { entries } = buildGateSurface({ cwd: root, quality });
  return new Map(entries.map((e) => [e.kind, e]));
}

describe('stub-instrument detection', () => {
  it('flags a baseline with no rows AND an all-zero rollup', () => {
    const byKind = surfaceOf(
      makeFixture([
        [
          'baselines/bundle-size.json',
          {
            kernelVersion: '1.0.0',
            generatedAt: '2026-01-01T00:00:00.000Z',
            rollup: { '*': { rawKb: 0, gzippedKb: 0 } },
            rows: [],
          },
        ],
      ]),
    );
    assert.equal(byKind.get('bundle-size').stub, true);
    assert.equal(byKind.get('bundle-size').rowCount, 0);
    assert.equal(byKind.get('bundle-size').baselineExists, true);
  });

  it('does not flag a measuring instrument that happens to report zero rows', () => {
    // arch-cycles ships `cycles: []` and no rollup at all. Zero cycles is the
    // ratchet passing, not the instrument being dead.
    const byKind = surfaceOf(
      makeFixture([
        [
          'baselines/arch-cycles.json',
          { generatedAt: '2026-01-01T00:00:00.000Z', cycles: [] },
        ],
      ]),
    );
    assert.equal(byKind.get('arch-cycles').baselineExists, true);
    assert.equal(byKind.get('arch-cycles').rowCount, 0);
    assert.equal(byKind.get('arch-cycles').stub, false);
  });

  it('does not flag a baseline whose rollup carries a non-zero value', () => {
    const byKind = surfaceOf(
      makeFixture([
        [
          'baselines/bundle-size.json',
          {
            kernelVersion: '1.0.0',
            generatedAt: '2026-01-01T00:00:00.000Z',
            rollup: { '*': { rawKb: 4, gzippedKb: 0 } },
            rows: [],
          },
        ],
      ]),
    );
    assert.equal(byKind.get('bundle-size').stub, false);
  });

  it('does not flag a missing baseline — there is no instrument to call dead', () => {
    const byKind = surfaceOf(makeFixture([]));
    assert.equal(byKind.get('bundle-size').baselineExists, false);
    assert.equal(byKind.get('bundle-size').stub, false);
    assert.equal(byKind.get('bundle-size').staleDays, null);
  });
});

describe('dead ignoreGlobs', () => {
  it('reports only the configured globs that match nothing on disk', () => {
    const root = makeFixture([
      ['src/a.js', 'export const a = 1;\n'],
      ['src/nested/b.js', 'export const b = 2;\n'],
    ]);
    const byKind = surfaceOf(root, {
      gates: {
        crap: {
          targetDirs: ['src'],
          ignoreGlobs: ['src/**/*.js', 'src/gone/**', 'src/a.js'],
        },
      },
    });
    assert.deepEqual(byKind.get('crap').deadIgnoreGlobs, ['src/gone/**']);
  });

  it('reports an empty list for a gate declaring no ignoreGlobs', () => {
    const root = makeFixture([['src/a.js', 'export const a = 1;\n']]);
    const byKind = surfaceOf(root, {
      gates: { crap: { targetDirs: ['src'] } },
    });
    assert.deepEqual(byKind.get('crap').deadIgnoreGlobs, []);
  });
});

describe('staleness', () => {
  it('reports whole days since generatedAt', () => {
    const root = makeFixture([
      [
        'baselines/coverage.json',
        {
          kernelVersion: '1.0.0',
          generatedAt: '2026-01-01T00:00:00.000Z',
          rollup: { '*': { lines: 90, branches: 80, functions: 85 } },
          rows: [{ path: 'src/a.js', lines: 90, branches: 80, functions: 85 }],
        },
      ],
    ]);
    const { entries } = buildGateSurface({
      cwd: root,
      quality: { gates: {} },
      now: new Date('2026-01-11T00:00:00.000Z'),
    });
    const coverage = entries.find((e) => e.kind === 'coverage');
    assert.equal(coverage.staleDays, 10);
    assert.equal(coverage.generatedAt, '2026-01-01T00:00:00.000Z');
  });
});

describe('buildGateSurface over the live repository', () => {
  const quality = getQuality(resolveConfig({ cwd: REPO_ROOT }));
  const { entries } = buildGateSurface({ cwd: REPO_ROOT, quality });
  const byKind = new Map(entries.map((e) => [e.kind, e]));

  it('walks both halves — the closed gate kinds and the out-of-band ratchets', () => {
    for (const kind of GATE_KINDS) {
      assert.equal(byKind.get(kind)?.surface, 'gate', `${kind} missing`);
    }
    for (const kind of EXPECTED_RATCHETS) {
      assert.equal(byKind.get(kind)?.surface, 'ratchet', `${kind} missing`);
    }
    assert.equal(entries.length, GATE_KINDS.length + EXPECTED_RATCHETS.length);
  });

  it('reports no stub instrument — Story #4923 removed the four it found', () => {
    // This suite used to assert that `lighthouse`, `mutation`, `lint`, and
    // `bundle-size` WERE stubs: zero rows, all-zero rollups, green since
    // 2026-05-15 over surfaces this package does not have. Story #4923 deleted
    // those four committed baselines, so the honest assertion flipped — the
    // repo now names no instrument it cannot produce. `stub` detection itself
    // stays exercised by the synthetic-fixture cases above.
    const stubs = entries
      .filter((e) => e.stub)
      .map((e) => e.kind)
      .sort();
    assert.deepEqual(stubs, []);
  });

  it('reports the deleted kinds as absent rather than empty', () => {
    // Story #5382 then removed the `lint` and `lighthouse` kinds outright, so
    // they no longer appear on the surface at all.
    assert.equal(byKind.has('lint'), false);
    assert.equal(byKind.has('lighthouse'), false);
    for (const kind of ['bundle-size', 'mutation']) {
      const entry = byKind.get(kind);
      assert.equal(entry.baselineExists, false, `${kind} should be absent`);
      assert.equal(entry.configured, false, `${kind} should have no gate`);
      assert.equal(entry.rowCount, 0, `${kind} rowCount`);
    }
  });

  it('never synthesises a gate block the consumer did not declare', () => {
    for (const entry of entries.filter((e) => e.configured)) {
      assert.ok(
        quality.gates[entry.kind],
        `${entry.kind} reported configured without a gate block`,
      );
    }
  });
});

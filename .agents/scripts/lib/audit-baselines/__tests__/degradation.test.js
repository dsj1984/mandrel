/**
 * degradation.test.js — the three optional inputs, all absent at once
 * (Story #4902).
 *
 * Git history, the friction ledger, and the import graph are all things a
 * consumer repository may simply not have — a shallow CI clone, a fresh
 * checkout, sources outside the scanned roots. The engine's contract is that
 * each collapses to a neutral 1.0 multiplier, `trend[]` goes empty, and the
 * run still exits 0 with a schema-valid envelope. A hard failure here would
 * make the lens unusable in exactly the repositories that most need it.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { before, describe, it } from 'node:test';
import { runCli } from '../../../audit-baselines.js';
import { makeTempDir } from '../../test-temp.js';
import { readChurn, readFriction } from '../weights.js';

/** The neutral multiplier every degraded weight must collapse to. */
const NEUTRAL_WEIGHT = 1;

/**
 * A repository-shaped fixture with baselines but nothing else: no `.git`, no
 * `temp/` ledger, and none of the roots the import graph scans.
 *
 * @returns {string} fixture root
 */
function writeBareFixture() {
  const root = makeTempDir('audit-baselines-degraded-');
  fs.mkdirSync(path.join(root, 'baselines'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'baselines', 'crap.json'),
    JSON.stringify({
      kernelVersion: '1.0.0',
      generatedAt: '2026-01-01T00:00:00.000Z',
      rollup: { '*': { p50: 2, p95: 20, max: 30, methodsAbove20: 2 } },
      rows: [
        { path: 'src/a.js', method: 'x', startLine: 1, crap: 30 },
        { path: 'src/b.js', method: 'y', startLine: 1, crap: 1 },
      ],
    }),
  );
  return root;
}

describe('engine over a repo with no git, no friction ledger, no import graph', () => {
  const root = writeBareFixture();
  const outPath = path.join(makeTempDir('audit-baselines-out-'), 'env.json');
  let exitCode;
  let envelope;

  before(async () => {
    exitCode = await runCli({
      argv: ['--out', outPath, '--cwd', root],
      stdout: { write: () => {} },
    });
    envelope = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  });

  it('exits 0', () => {
    assert.equal(exitCode, 0);
  });

  it('reports all three inputs as degraded', () => {
    assert.deepEqual(envelope.degradations, {
      gitHistory: true,
      importGraph: true,
      frictionLedger: true,
    });
  });

  it('emits an empty trend[]', () => {
    assert.deepEqual(envelope.trend, []);
  });

  it('gives every hotspot rank weights of exactly 1.0', () => {
    assert.ok(envelope.hotspots.length > 0, 'fixture produced no hotspots');
    for (const hotspot of envelope.hotspots) {
      assert.equal(hotspot.churnWeight, NEUTRAL_WEIGHT, hotspot.path);
      assert.equal(hotspot.centralityWeight, NEUTRAL_WEIGHT, hotspot.path);
      assert.equal(hotspot.frictionWeight, NEUTRAL_WEIGHT, hotspot.path);
      assert.equal(hotspot.rank, hotspot.severityWeight, hotspot.path);
    }
  });

  it('still reports the missing halves of the gate surface', () => {
    const missing = envelope.gateSurface
      .filter((entry) => !entry.baselineExists)
      .map((entry) => entry.kind);
    assert.ok(missing.includes('mutation'));
    assert.ok(missing.includes('arch-cycles'));
    // A missing baseline is not a stub — there is no instrument to call dead.
    for (const entry of envelope.gateSurface) {
      if (!entry.baselineExists) assert.equal(entry.stub, false);
    }
  });
});

describe('degradation probes in isolation', () => {
  it('readChurn degrades when git cannot answer', () => {
    const { counts, degraded } = readChurn({
      cwd: makeTempDir('audit-baselines-nogit-'),
    });
    assert.equal(degraded, true);
    assert.equal(counts.size, 0);
  });

  it('readFriction degrades when no signals stream exists', () => {
    const { degraded, streams } = readFriction({
      tempRootAbs: path.join(makeTempDir('audit-baselines-nosig-'), 'temp'),
    });
    assert.equal(degraded, true);
    assert.equal(streams, 0);
  });

  it('readFriction counts blamed files when a stream is present', () => {
    const tempRoot = makeTempDir('audit-baselines-sig-');
    const dir = path.join(tempRoot, 'standalone', 'stories', 'story-1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'signals.ndjson'),
      [
        JSON.stringify({
          kind: 'friction',
          ts: '2026-01-01T00:00:00.000Z',
          details: { errorPreview: 'failed in lib/target.js' },
        }),
        'not json at all',
        JSON.stringify({ kind: 'trace', ts: '2026-01-01T00:00:00.000Z' }),
        '',
      ].join('\n'),
    );
    const { counts, degraded, streams } = readFriction({
      tempRootAbs: tempRoot,
    });
    assert.equal(degraded, false);
    assert.equal(streams, 1);
    assert.equal(counts.get('lib/target.js'), 1);
  });
});

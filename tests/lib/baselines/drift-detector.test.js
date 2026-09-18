// tests/lib/baselines/drift-detector.test.js
/**
 * Story #4776 — full-scope baseline drift detection.
 *
 * The point of this module is the case the diff-scoped gates structurally
 * cannot see: a file nobody has touched since its baseline row was written.
 * The centrepiece test below therefore drifts ONLY an untouched row and
 * asserts it is still caught.
 *
 * Everything is driven through the module's public surface — the three
 * symbols the CLI uses. The internals are deliberately not exported (a
 * test-only export is an orphan by another name, which is the defect this
 * Story is about), so they are reached the way production reaches them:
 * through `detectBaselineDrift`'s injectable loader/scorer seams.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  parseArgs,
  runCheckBaselineDrift,
} from '../../../scripts/check-baseline-drift.js';
import {
  DRIFT_KINDS,
  detectBaselineDrift,
  formatDriftReport,
} from '../../../scripts/lib/baselines/drift-detector.js';

const MI_BASELINE = [
  { path: 'src/touched.js', mi: 80 },
  { path: 'src/untouched.js', mi: 75 },
];

/**
 * Drive one kind through the public entry point with injected seams.
 *
 * @returns {Promise<object>} that kind's result record
 */
async function detectOne({
  kind = 'maintainability',
  rows,
  baseline = MI_BASELINE,
  quality = {},
  tolerance = null,
}) {
  const run = await detectBaselineDrift({
    kinds: [kind],
    quality,
    tolerance,
    loadBaselineRows: () => baseline,
    scoreFullScope: async () => rows,
  });
  assert.equal(run.results.length, 1);
  assert.equal(run.ok, run.results[0].ok);
  return run.results[0];
}

describe('detectBaselineDrift — tolerance resolution', () => {
  it('prefers an explicit override over the gate config', async () => {
    const rows = [
      { path: 'src/touched.js', mi: 80 },
      { path: 'src/untouched.js', mi: 73 },
    ];
    const tight = await detectOne({ rows, tolerance: 0.5 });
    assert.equal(tight.ok, false);
    assert.equal(tight.tolerance, 0.5);

    const loose = await detectOne({ rows, tolerance: 5 });
    assert.equal(loose.ok, true);
    assert.equal(loose.tolerance, 5);
  });

  it("falls back to the gate's configured absolute tolerance", async () => {
    const result = await detectOne({
      rows: MI_BASELINE,
      quality: {
        maintainability: { tolerance: { kind: 'absolute', value: 1.25 } },
      },
    });
    assert.equal(result.tolerance, 1.25);
  });

  it('falls back to the per-kind default when nothing is configured', async () => {
    const mi = await detectOne({ rows: MI_BASELINE });
    assert.equal(mi.tolerance, 0.5);

    const crap = await detectOne({
      kind: 'crap',
      baseline: [{ path: 'src/a.js', method: 'go', startLine: 1, crap: 5 }],
      rows: [{ file: 'src/a.js', method: 'go', startLine: 1, crap: 5 }],
    });
    assert.equal(crap.tolerance, 0.001);
  });
});

describe('detectBaselineDrift — row projection', () => {
  it("reconciles the CRAP scorer's `file` key with the envelope's `path`", async () => {
    // The scorer emits `file`; the baseline keys on `path`. If the two were
    // not reconciled every row would look added AND removed at once.
    const result = await detectOne({
      kind: 'crap',
      baseline: [{ path: 'src/a.js', method: 'go', startLine: 3, crap: 9 }],
      rows: [{ file: 'src/a.js', method: 'go', startLine: 3, crap: 9 }],
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.added, []);
    assert.deepEqual(result.removed, []);
    assert.equal(result.scanned, 1);
  });

  it('drops rows the writer itself would refuse rather than throwing', async () => {
    const result = await detectOne({
      rows: [
        { path: 'src/touched.js', mi: 80 },
        { path: 'src/untouched.js', mi: 75 },
        { path: '/absolute/is/not/canonical.js', mi: 70 },
      ],
    });
    assert.equal(result.ok, true);
    assert.equal(result.scanned, 2);
  });
});

describe('detectBaselineDrift — classification (AC-6)', () => {
  it('catches drift on a file untouched by any recent diff', async () => {
    const result = await detectOne({
      rows: [
        // The file the branch changed is unchanged in score; only the
        // never-touched one moved. A diff-scoped gate sees nothing here.
        { path: 'src/touched.js', mi: 80 },
        { path: 'src/untouched.js', mi: 61 },
      ],
    });
    assert.equal(result.ok, false);
    assert.equal(result.drifted.length, 1);
    assert.equal(result.drifted[0].label, 'src/untouched.js');
    assert.equal(result.drifted[0].baseline, 75);
    assert.equal(result.drifted[0].current, 61);
    assert.equal(result.drifted[0].delta, -14);
  });

  it('reports improvement as drift too — a stale baseline either way', async () => {
    const result = await detectOne({
      rows: [
        { path: 'src/touched.js', mi: 80 },
        { path: 'src/untouched.js', mi: 91 },
      ],
    });
    assert.equal(result.ok, false);
    assert.equal(result.drifted[0].delta, 16);
  });

  it('separates added and removed rows from drift', async () => {
    const result = await detectOne({
      rows: [
        { path: 'src/touched.js', mi: 84 },
        { path: 'src/brand-new.js', mi: 90 },
      ],
    });
    assert.equal(result.drifted.length, 1);
    assert.deepEqual(
      result.added.map((a) => a.label),
      ['src/brand-new.js'],
    );
    assert.deepEqual(
      result.removed.map((r) => r.label),
      ['src/untouched.js'],
    );
  });

  it('holds rows within tolerance', async () => {
    const result = await detectOne({
      rows: [
        { path: 'src/touched.js', mi: 80.4 },
        { path: 'src/untouched.js', mi: 75 },
      ],
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.drifted, []);
  });

  it('keys CRAP rows per method, not per file', async () => {
    const result = await detectOne({
      kind: 'crap',
      baseline: [
        { path: 'src/a.js', method: 'one', startLine: 1, crap: 5 },
        { path: 'src/a.js', method: 'two', startLine: 9, crap: 5 },
      ],
      rows: [
        { file: 'src/a.js', method: 'one', startLine: 1, crap: 5 },
        { file: 'src/a.js', method: 'two', startLine: 9, crap: 22 },
      ],
    });
    assert.equal(result.drifted.length, 1);
    assert.equal(result.drifted[0].key, 'src/a.js::two@9');
  });

  it('is clean when every re-scored row matches its baseline', async () => {
    const result = await detectOne({ rows: MI_BASELINE });
    assert.equal(result.ok, true);
    assert.deepEqual(result.drifted, []);
    assert.equal(result.scanned, 2);
  });
});

describe('detectBaselineDrift — skips and fan-out', () => {
  it('skips a disabled gate, a missing baseline, and a missing scorer', async () => {
    const disabled = await detectOne({
      kind: 'crap',
      rows: [],
      quality: { crap: { enabled: false } },
    });
    assert.equal(disabled.ok, true);
    assert.equal(disabled.skipped, 'gate-disabled');

    const noBaseline = await detectOne({ rows: [], baseline: null });
    assert.equal(noBaseline.ok, true);
    assert.equal(noBaseline.skipped, 'no-baseline');

    const noScorer = await detectOne({ rows: null });
    assert.equal(noScorer.ok, true);
    assert.equal(noScorer.skipped, 'no-scorer');
  });

  it('rejects an unknown kind', async () => {
    await assert.rejects(
      () => detectBaselineDrift({ kinds: ['bogus'], quality: {} }),
      /unknown kind "bogus"/,
    );
  });

  it('is red when any single kind drifts', async () => {
    const run = await detectBaselineDrift({
      kinds: ['maintainability', 'crap'],
      quality: { crap: { enabled: false } },
      loadBaselineRows: () => MI_BASELINE,
      scoreFullScope: async () => [
        { path: 'src/touched.js', mi: 80 },
        { path: 'src/untouched.js', mi: 40 },
      ],
    });
    assert.equal(run.ok, false);
    assert.equal(run.results.length, 2);
    assert.equal(run.results[1].skipped, 'gate-disabled');
  });

  it('defaults to every drift kind', () => {
    assert.deepEqual([...DRIFT_KINDS], ['maintainability', 'crap']);
  });
});

describe('drift report rendering (AC-7)', () => {
  async function driftedRun() {
    return await detectBaselineDrift({
      kinds: ['maintainability'],
      quality: {},
      loadBaselineRows: () => MI_BASELINE,
      scoreFullScope: async () => [
        { path: 'src/touched.js', mi: 80 },
        { path: 'src/untouched.js', mi: 61 },
      ],
    });
  }

  it('prints a per-row before/after table', async () => {
    const text = formatDriftReport(await driftedRun());
    assert.match(text, /BASELINE/);
    assert.match(text, /CURRENT/);
    assert.match(text, /DELTA/);
    assert.match(text, /src\/untouched\.js\s+75\.00\s+61\.00\s+-14\.00/);
  });

  it('names the refresh remedy', async () => {
    const text = formatDriftReport(await driftedRun());
    assert.match(text, /npm run maintainability:update -- --full-scope/);
    assert.match(text, /baseline-refresh:/);
    assert.match(text, /Baseline drift detected/);
  });

  it('reports a clean or skipped kind on one line', async () => {
    const skipped = formatDriftReport(
      await detectBaselineDrift({
        kinds: ['crap'],
        quality: {},
        loadBaselineRows: () => null,
        scoreFullScope: async () => [],
      }),
    );
    assert.match(skipped, /⏭ crap: skipped \(no-baseline\)/);
    assert.match(skipped, /No baseline drift detected/);

    const clean = formatDriftReport(
      await detectBaselineDrift({
        kinds: ['maintainability'],
        quality: {},
        loadBaselineRows: () => MI_BASELINE,
        scoreFullScope: async () => MI_BASELINE,
      }),
    );
    assert.match(clean, /✓ maintainability: 2 row\(s\) re-scored full-scope/);
  });
});

describe('check-baseline-drift CLI (AC-7)', () => {
  it('parses gates, tolerance and --json', () => {
    assert.deepEqual(parseArgs([]), {
      kinds: ['maintainability', 'crap'],
      tolerance: null,
      json: false,
      requireScored: false,
    });
    assert.deepEqual(
      parseArgs(['--gate', 'crap', '--tolerance', '2', '--json']),
      { kinds: ['crap'], tolerance: 2, json: true, requireScored: false },
    );
    assert.deepEqual(parseArgs(['--require-scored']), {
      kinds: ['maintainability', 'crap'],
      tolerance: null,
      json: false,
      requireScored: true,
    });
  });

  it('rejects an unknown gate, a non-numeric tolerance, and stray argv', () => {
    assert.throws(() => parseArgs(['--gate', 'bogus']), /unknown --gate/);
    assert.throws(() => parseArgs(['--tolerance', 'x']), /must be a number/);
    assert.throws(() => parseArgs(['--wat']), /unrecognised argument/);
  });

  it('exits non-zero on drift and zero when clean', async () => {
    const red = await runCheckBaselineDrift({
      argv: ['--gate', 'crap'],
      detect: async (opts) =>
        await detectBaselineDrift({
          ...opts,
          quality: {},
          loadBaselineRows: () => [
            { path: 'src/a.js', method: 'go', startLine: 1, crap: 5 },
          ],
          scoreFullScope: async () => [
            { file: 'src/a.js', method: 'go', startLine: 1, crap: 40 },
          ],
        }),
    });
    assert.equal(red.exitCode, 1);
    assert.match(red.output, /src\/a\.js::go \(line 1\)/);
    assert.match(red.output, /\+35\.00/);
    assert.match(red.output, /npm run crap:update -- --full-scope/);

    const green = await runCheckBaselineDrift({
      argv: [],
      detect: async () => ({ ok: true, results: [] }),
    });
    assert.equal(green.exitCode, 0);
  });

  it('forwards the parsed kinds and tolerance to the detector', async () => {
    let seen = null;
    await runCheckBaselineDrift({
      argv: ['--gate', 'crap', '--tolerance', '3'],
      detect: async (opts) => {
        seen = opts;
        return { ok: true, results: [] };
      },
    });
    assert.deepEqual(seen.kinds, ['crap']);
    assert.equal(seen.tolerance, 3);
  });

  /**
   * Story #5023 — the skip-is-green contract is a fail-open trap for the
   * scheduled use this CLI exists for. Measured on the real repo: `--gate
   * crap` with no coverage artifact prints "✅ No baseline drift detected"
   * and exits 0. These pin the opt-in that closes it.
   */
  describe('--require-scored', () => {
    /** A run where `crap` skipped and `maintainability` came back clean. */
    const mixedRun = {
      ok: true,
      results: [
        {
          kind: 'maintainability',
          ok: true,
          drifted: [],
          added: [],
          removed: [],
        },
        { kind: 'crap', ok: true, skipped: 'no-scored-rows' },
      ],
    };

    it('turns a skipped kind into exit 2 naming the kind and the reason', async () => {
      const res = await runCheckBaselineDrift({
        argv: ['--require-scored'],
        detect: async () => mixedRun,
      });
      assert.equal(res.exitCode, 2);
      assert.match(res.output, /--require-scored/);
      assert.match(res.output, /crap \(no-scored-rows\)/);
      // The drift table for the kinds that DID score is still rendered.
      assert.match(res.output, /maintainability/);
    });

    it('leaves the same run at exit 0 without the flag', async () => {
      const res = await runCheckBaselineDrift({
        argv: [],
        detect: async () => mixedRun,
      });
      assert.equal(res.exitCode, 0);
      assert.doesNotMatch(res.output, /--require-scored/);
    });

    it('does not mask real drift: a drifted kind still exits 1', async () => {
      const res = await runCheckBaselineDrift({
        argv: ['--require-scored'],
        detect: async () => ({
          ok: false,
          results: [
            {
              kind: 'maintainability',
              refreshCommand: 'npm run maintainability:update -- --full-scope',
              ok: false,
              tolerance: 0.5,
              scanned: 1,
              baselineRows: 1,
              drifted: [
                {
                  key: 'src/a.js',
                  label: 'src/a.js',
                  baseline: 80,
                  current: 70,
                  delta: -10,
                },
              ],
              added: [],
              removed: [],
            },
          ],
        }),
      });
      assert.equal(res.exitCode, 1);
    });

    it('appends the note to the --json payload too', async () => {
      const res = await runCheckBaselineDrift({
        argv: ['--require-scored', '--json'],
        detect: async () => mixedRun,
      });
      assert.equal(res.exitCode, 2);
      const [payload, note] = res.output.split(/\n(?=\[drift\])/);
      assert.equal(JSON.parse(payload).ok, true);
      assert.match(note, /crap \(no-scored-rows\)/);
    });
  });

  it('emits a machine-readable report under --json', async () => {
    const res = await runCheckBaselineDrift({
      argv: ['--json'],
      detect: async () => ({ ok: true, results: [] }),
    });
    assert.deepEqual(JSON.parse(res.output), {
      schemaVersion: '1',
      ok: true,
      results: [],
    });
  });
});

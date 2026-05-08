import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  buildBaselineEnvelope,
  scanAndScore,
} from '../.agents/scripts/lib/crap-utils.js';
import { calculateForFile } from '../.agents/scripts/lib/maintainability-engine.js';
import { calculateAll } from '../.agents/scripts/lib/maintainability-utils.js';

/**
 * Acceptance criterion (Story #829, 5.29.0): existing JS-only consumer
 * baselines are byte-identical before vs. after the kernel bump. The
 * scoring data section (the file→score map for MI; the rows array for
 * CRAP) does not drift when only the kernel version label changes —
 * because the strip-then-analyze pipeline is a no-op for `.js`/`.mjs`/
 * `.cjs` paths.
 *
 * These snapshots pin literal numbers for a fixed JS fixture. If the
 * kernel ever moves the numbers for unchanged JS sources, this test
 * fails and the constants must be updated *together* with a
 * deliberately-bumped kernelVersion + a release note.
 */

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'baseline_snap_'));
}

function rmTmp(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* noop */
  }
}

const FIXTURE_A = `
export function classify(name) {
  if (!name) return 'empty';
  if (name.length > 10) return 'long';
  if (name.length > 5) return 'medium';
  return 'short';
}
`;

const FIXTURE_B = `
export function tally(items) {
  let count = 0;
  for (const item of items) {
    if (item && item.active) {
      count += 1;
    }
  }
  return count;
}
`;

test('maintainability — JS scoring is byte-identical to pinned snapshot (no kernel drift)', async () => {
  const dir = mkTmp();
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    fs.writeFileSync(path.join(dir, 'a.js'), FIXTURE_A);
    fs.writeFileSync(path.join(dir, 'b.mjs'), FIXTURE_B);

    const aScore = calculateForFile(path.join(dir, 'a.js'));
    const bScore = calculateForFile(path.join(dir, 'b.mjs'));

    // These constants pin the existing escomplex output. If they shift
    // without a deliberate kernel bump, the JS-only-byte-identical
    // contract is broken.
    assert.strictEqual(
      aScore,
      129.178,
      'classify() score must match pre-bump kernel output exactly',
    );
    assert.strictEqual(
      bScore,
      132.146,
      'tally() score must match pre-bump kernel output exactly',
    );

    const all = await calculateAll([
      path.join(dir, 'a.js'),
      path.join(dir, 'b.mjs'),
    ]);
    assert.deepStrictEqual(all, {
      'a.js': 129.178,
      'b.mjs': 132.146,
    });
  } finally {
    process.chdir(cwd);
    rmTmp(dir);
  }
});

test('CRAP — JS scan rows are byte-identical to pinned snapshot (no kernel drift)', async () => {
  const dir = mkTmp();
  try {
    fs.writeFileSync(path.join(dir, 'a.js'), FIXTURE_A);

    // Build a coverage entry so scanAndScore actually emits rows. The
    // exact coverage value is irrelevant for this test — we're asserting
    // the *cyclomatic*, *startLine*, and *method-name* outputs of the
    // escomplex kernel for the JS path are unchanged.
    const absPath = path.join(dir, 'a.js');
    const coverage = {
      [absPath]: {
        path: absPath,
        fnMap: {
          0: {
            name: 'classify',
            decl: { start: { line: 2, column: 0 } },
            loc: {
              start: { line: 2, column: 0 },
              end: { line: 7, column: 1 },
            },
            line: 2,
          },
        },
        f: { 0: 1 },
        statementMap: {
          0: { start: { line: 3, column: 0 }, end: { line: 3, column: 10 } },
          1: { start: { line: 4, column: 0 }, end: { line: 4, column: 10 } },
          2: { start: { line: 5, column: 0 }, end: { line: 5, column: 10 } },
          3: { start: { line: 6, column: 0 }, end: { line: 6, column: 10 } },
        },
        s: { 0: 1, 1: 1, 2: 1, 3: 1 },
        branchMap: {},
        b: {},
      },
    };

    const result = await scanAndScore({
      targetDirs: [dir],
      coverage,
      requireCoverage: true,
      cwd: dir,
    });

    assert.strictEqual(result.scannedFiles, 1);
    assert.strictEqual(result.rows.length, 1);
    const [row] = result.rows;
    assert.strictEqual(row.file, 'a.js');
    assert.strictEqual(row.method, 'classify');
    assert.strictEqual(row.startLine, 2);
    assert.strictEqual(row.cyclomatic, 4);
  } finally {
    rmTmp(dir);
  }
});

test('CRAP envelope — JS-only rows section is byte-identical across kernel-version bump', () => {
  // The kernelVersion *label* moves with each bump, but the rows array
  // is the byte-identical contract. We compare two envelopes built from
  // the same input rows under different kernel labels — only the label
  // bytes should differ.
  const rows = [
    { file: 'lib/a.js', method: 'doWork', startLine: 10, crap: 4.0 },
    { file: 'lib/b.js', method: 'helper', startLine: 5, crap: 2.5 },
  ];
  const e10 = buildBaselineEnvelope({
    rows,
    escomplexVersion: '0.1.0',
    kernelVersion: '1.0.0',
    tsTranspilerVersion: '0.0.0',
  });
  const e11 = buildBaselineEnvelope({
    rows,
    escomplexVersion: '0.1.0',
    kernelVersion: '1.1.0',
    tsTranspilerVersion: '5.9.3',
  });
  assert.deepStrictEqual(e10.rows, e11.rows);
});

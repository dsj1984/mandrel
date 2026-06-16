import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  scanAndScore,
  scanAndScoreCombined,
} from '../../.agents/scripts/lib/crap-utils.js';
import { calculateAll } from '../../.agents/scripts/lib/maintainability-utils.js';

/**
 * Story #4192 — byte-identical parity proof for the combined single-pass
 * MI + CRAP scan.
 *
 * The whole point of `scanAndScoreCombined` is that collapsing the two
 * escomplex passes (one for the MI module score, one for the CRAP method
 * rows) into a single `analyzeOnce` parse per file produces the EXACT same
 * numbers the two separate passes did. These tests run the real production
 * scorers — `calculateAll` (MI two-pass), `scanAndScore` (CRAP two-pass), and
 * `scanAndScoreCombined` (the new single-pass) — over the same real fixture
 * tree with the same coverage map, and assert deep equality of:
 *
 *   - the MI score map (`scanAndScoreCombined().miScores` === `calculateAll()`)
 *   - the CRAP scan result (`scanAndScoreCombined().crap` === `scanAndScore()`)
 *
 * No mocks of escomplex: the AST parse is real on both sides, so a parity
 * pass means the single-parse path yields identical scores.
 */

function mkFixtureFile(dir, rel, contents) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents, 'utf-8');
  return abs;
}

/**
 * Re-key a `{ relOrAbsPath: score }` map (as produced by `calculateAll`,
 * whose keys are relative to `process.cwd()`) to keys relative to `cwd`.
 * `calculateAll` ignores any explicit cwd and always relativises against
 * `process.cwd()`; `scanAndScoreCombined` relativises against the `cwd` it
 * is handed. In production both run with `cwd === process.cwd()` so the keys
 * coincide — this re-key makes the cross-cwd unit comparison faithful.
 */
function reKeyToCwd(scoreMap, cwd) {
  const out = {};
  for (const [key, score] of Object.entries(scoreMap)) {
    const abs = path.isAbsolute(key) ? key : path.resolve(process.cwd(), key);
    out[path.relative(cwd, abs).replace(/\\/g, '/')] = score;
  }
  return out;
}

/**
 * Build a synthetic istanbul-shaped coverage entry that marks every line in
 * `[1, lineCount]` as a function start AND a covered statement. This makes
 * `coverageForMethodInEntry` resolve a real (1.0) ratio for whatever method
 * lineStart escomplex reports, so the CRAP row-emission path is exercised on
 * both the two-pass and combined sides identically.
 */
function fullCoverageEntry(lineCount) {
  const fnMap = {};
  const statementMap = {};
  const s = {};
  for (let line = 1; line <= lineCount; line += 1) {
    fnMap[String(line)] = {
      name: `fn${line}`,
      decl: { start: { line }, end: { line } },
      loc: { start: { line }, end: { line: lineCount } },
    };
    statementMap[String(line)] = {
      start: { line },
      end: { line },
    };
    s[String(line)] = 1;
  }
  return { fnMap, statementMap, s };
}

describe('scanAndScoreCombined — byte-identical parity with the two-pass path', () => {
  let tmpDir;

  const FIXTURES = {
    'src/branchy.js': `export function branchy(n) {
  if (n > 10) {
    return 'big';
  }
  if (n > 5) {
    return 'mid';
  }
  for (let i = 0; i < n; i += 1) {
    if (i % 2 === 0) {
      continue;
    }
  }
  return 'small';
}

export function trivial() {
  return 42;
}
`,
    'src/nested/deep.js': `export function deep(items) {
  let total = 0;
  for (const item of items) {
    if (item.active) {
      total += item.value;
    } else if (item.pending) {
      total -= item.value;
    }
  }
  return total;
}
`,
    'src/plain.mjs': `export const add = (a, b) => a + b;

export function classify(x) {
  switch (x) {
    case 1:
      return 'one';
    case 2:
      return 'two';
    default:
      return 'many';
  }
}
`,
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crap-combined-parity-'));
    for (const [rel, contents] of Object.entries(FIXTURES)) {
      mkFixtureFile(tmpDir, rel, contents);
    }
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function buildCoverageMap() {
    const coverage = {};
    for (const rel of Object.keys(FIXTURES)) {
      const abs = path.join(tmpDir, rel);
      const lineCount = FIXTURES[rel].split('\n').length;
      // coverage-final.json keys on absolute paths.
      coverage[abs] = fullCoverageEntry(lineCount);
    }
    return coverage;
  }

  it('miScores deep-equals calculateAll over the same tree', async () => {
    const targetDirs = [path.join(tmpDir, 'src')];
    // calculateAll takes an explicit file list; build it the way the MI
    // regenerator does (scanDirectory walk), so the inputs are identical.
    const { scanDirectory } = await import(
      '../../.agents/scripts/lib/maintainability-utils.js'
    );
    const miFiles = [];
    for (const dir of targetDirs) scanDirectory(dir, miFiles, { cwd: tmpDir });

    // `calculateAll` keys its result by `path.relative(process.cwd(), abs)`
    // (it ignores any passed cwd). `scanAndScoreCombined` keys by the
    // explicit `cwd` it is given. Re-key the two-pass output to the same
    // cwd-relative shape so the comparison is apples-to-apples — in
    // production both collapse to the same key because the regenerator runs
    // with `cwd === process.cwd()` and re-derives `path.relative(cwd, key)`
    // before the writer canonicalises identically for either source.
    const twoPassRaw = await calculateAll(miFiles);
    const twoPassMi = reKeyToCwd(twoPassRaw, tmpDir);
    const { miScores } = await scanAndScoreCombined({
      targetDirs,
      coverage: buildCoverageMap(),
      requireCoverage: true,
      cwd: tmpDir,
    });

    assert.deepEqual(miScores, twoPassMi);
    // Sanity: the fixture actually produced scores (guards against an empty
    // both-sides match masking a broken walk).
    assert.ok(Object.keys(miScores).length >= 3);
  });

  it('crap result deep-equals scanAndScore over the same tree (requireCoverage)', async () => {
    const targetDirs = [path.join(tmpDir, 'src')];
    const coverage = buildCoverageMap();

    const twoPassCrap = await scanAndScore({
      targetDirs,
      coverage,
      requireCoverage: true,
      cwd: tmpDir,
    });
    const { crap } = await scanAndScoreCombined({
      targetDirs,
      coverage,
      requireCoverage: true,
      cwd: tmpDir,
    });

    assert.deepEqual(crap, twoPassCrap);
    // Sanity: real CRAP rows were produced.
    assert.ok(crap.rows.length >= 1);
    assert.ok(crap.scannedFiles >= 3);
  });

  it('crap result deep-equals scanAndScore when coverage is partial (files skipped)', async () => {
    const targetDirs = [path.join(tmpDir, 'src')];
    // Cover only ONE file so the other two trip the requireCoverage
    // file-level skip on both paths.
    const onlyOne = path.join(tmpDir, 'src/branchy.js');
    const coverage = {
      [onlyOne]: fullCoverageEntry(
        FIXTURES['src/branchy.js'].split('\n').length,
      ),
    };

    const twoPassCrap = await scanAndScore({
      targetDirs,
      coverage,
      requireCoverage: true,
      cwd: tmpDir,
    });
    const { crap, miScores } = await scanAndScoreCombined({
      targetDirs,
      coverage,
      requireCoverage: true,
      cwd: tmpDir,
    });

    // CRAP parity: same rows, same skip counters.
    assert.deepEqual(crap, twoPassCrap);
    assert.ok(crap.skippedFilesNoCoverage >= 2);
    // MI parity invariant: MI scores EVERY file regardless of coverage, so the
    // two coverage-skipped files still appear in miScores (the combined worker
    // computes MI before the coverage gate). Compare against the standalone MI
    // pass to prove it.
    const miFiles = [];
    const { scanDirectory } = await import(
      '../../.agents/scripts/lib/maintainability-utils.js'
    );
    for (const dir of targetDirs) scanDirectory(dir, miFiles, { cwd: tmpDir });
    const twoPassMi = reKeyToCwd(await calculateAll(miFiles), tmpDir);
    assert.deepEqual(miScores, twoPassMi);
    assert.equal(Object.keys(miScores).length, 3);
  });

  it('crap result deep-equals scanAndScore with requireCoverage:false', async () => {
    const targetDirs = [path.join(tmpDir, 'src')];
    // No coverage at all; requireCoverage false means methods resolve
    // coverage null → crap null → skipped methods, on both paths.
    const twoPassCrap = await scanAndScore({
      targetDirs,
      coverage: null,
      requireCoverage: false,
      cwd: tmpDir,
    });
    const { crap } = await scanAndScoreCombined({
      targetDirs,
      coverage: null,
      requireCoverage: false,
      cwd: tmpDir,
    });
    assert.deepEqual(crap, twoPassCrap);
  });

  it('honours preScannedFiles identically to scanAndScore', async () => {
    const targetDirs = [path.join(tmpDir, 'src')];
    const coverage = buildCoverageMap();
    const { scanDirectory } = await import(
      '../../.agents/scripts/lib/maintainability-utils.js'
    );
    const preScanned = [];
    for (const dir of targetDirs)
      scanDirectory(dir, preScanned, { cwd: tmpDir });

    const twoPassCrap = await scanAndScore({
      targetDirs,
      coverage,
      requireCoverage: true,
      cwd: tmpDir,
      preScannedFiles: preScanned,
    });
    const { crap } = await scanAndScoreCombined({
      targetDirs,
      coverage,
      requireCoverage: true,
      cwd: tmpDir,
      preScannedFiles: preScanned,
    });
    assert.deepEqual(crap, twoPassCrap);
  });

  it('rejects a non-array targetDirs (parity with scanAndScore guard)', async () => {
    await assert.rejects(
      () => scanAndScoreCombined({ targetDirs: 'nope', coverage: null }),
      /targetDirs must be an array/,
    );
  });
});

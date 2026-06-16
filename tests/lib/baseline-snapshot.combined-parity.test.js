import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { regenerateMainFromTree } from '../../.agents/scripts/lib/baseline-snapshot.js';
import {
  scanAndScore,
  scanAndScoreCombined,
} from '../../.agents/scripts/lib/crap-utils.js';
import { calculateAll } from '../../.agents/scripts/lib/maintainability-utils.js';

/**
 * Story #4192 — end-to-end envelope parity for the combined single-pass path.
 *
 * This is the load-bearing baseline-invariance proof: it runs the REAL
 * `regenerateMainFromTree` over a real fixture tree with real coverage TWICE —
 * once with the production-default scan seams (so the combined `analyzeOnce`
 * single-pass path is taken) and once with the two independent passes forced
 * on (real `calculateAll` + `scanAndScore`, wrapped so the seam-injection
 * guard routes to the two-pass branch) — and asserts the envelopes handed to
 * the writer are byte-for-byte identical (same `rows`, in the same order,
 * with the same scores). If the single-parse refactor shifted any MI or CRAP
 * number, this test fails.
 */

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
    statementMap[String(line)] = { start: { line }, end: { line } };
    s[String(line)] = 1;
  }
  return { fnMap, statementMap, s };
}

describe('regenerateMainFromTree — combined vs two-pass envelope parity (#4192)', () => {
  let tmpDir;

  beforeEach(() => {
    // Root the fixture under the repo's gitignored `tmp/` (NOT `temp/`, which
    // scanDirectory's IGNORED_DIRS skips) so the scan walks it AND so paths
    // relative to `process.cwd()` carry no `..` segments — `calculateAll`
    // keys by `process.cwd()`, and the baseline path-canon forbids `..`.
    // Running with `cwd === process.cwd()` makes both the combined and the
    // two-pass paths key files identically, which is exactly the production
    // invariant (the regenerator always runs at the repo root).
    const tmpRoot = path.join(process.cwd(), 'tmp');
    fs.mkdirSync(tmpRoot, { recursive: true });
    tmpDir = fs.mkdtempSync(path.join(tmpRoot, 'bsnap-combined-parity-'));
    for (const [rel, contents] of Object.entries(FIXTURES)) {
      const abs = path.join(tmpDir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, contents, 'utf-8');
    }
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function coverageMap() {
    const coverage = {};
    for (const rel of Object.keys(FIXTURES)) {
      coverage[path.join(tmpDir, rel)] = fullCoverageEntry(
        FIXTURES[rel].split('\n').length,
      );
    }
    return coverage;
  }

  // A minimal writer seam that records every `{ kind, rows }` it is asked to
  // assemble and echoes a deterministic envelope. We never touch disk
  // (writeFileFn is a no-op) — the assertion is purely on the captured rows.
  function recordingWriter() {
    const calls = [];
    return {
      calls,
      writeFn: ({ kind, rows }) => {
        calls.push({ kind, rows });
        return {
          $schema: `.agents/schemas/baselines/${kind}.schema.json`,
          kernelVersion: '0.1.0',
          generatedAt: 'fixed',
          rollup: { '*': {} },
          rows,
        };
      },
      writeFileFn: () => {},
    };
  }

  const baselinesResolved = () => ({
    maintainability: { path: 'baselines/maintainability.json' },
    crap: { path: 'baselines/crap.json' },
  });

  function qualityResolved(tmp) {
    return {
      maintainability: { targetDirs: [path.join(tmp, 'src')], ignoreGlobs: [] },
      crap: {
        targetDirs: [path.join(tmp, 'src')],
        ignoreGlobs: [],
        requireCoverage: true,
        coveragePath: 'coverage/coverage-final.json',
      },
    };
  }

  async function runRegen({ forceTwoPass }) {
    const writer = recordingWriter();
    const cov = coverageMap();
    // Forcing two-pass: inject WRAPPED real scorers so their reference differs
    // from the module defaults, which flips the seam-injection guard to the
    // independent-passes branch while still scoring with the real engines.
    const twoPassSeams = forceTwoPass
      ? {
          calculateAllFn: (paths) => calculateAll(paths),
          scanAndScoreFn: (opts) => scanAndScore(opts),
        }
      : {};
    await regenerateMainFromTree({
      // Run at the repo root (production invariant) so `calculateAll`'s
      // process.cwd()-relative keys and the combined scan's cwd-relative keys
      // coincide and canonicalise cleanly.
      cwd: process.cwd(),
      resolveConfig: () => ({ agentSettings: {} }),
      getBaselines: baselinesResolved,
      getQuality: () => qualityResolved(tmpDir),
      logger: { info: () => {}, warn: () => {} },
      // Coverage is loaded by both the combined eligibility check and the
      // CRAP pass; return the fixture map regardless of the resolved path.
      loadCoverageFn: () => cov,
      resolveEscomplexVersionFn: () => '0.1.0',
      resolveTsTranspilerVersionFn: () => '5.9.3',
      writeFn: writer.writeFn,
      writeFileFn: writer.writeFileFn,
      loadPriorFn: () => null,
      ...twoPassSeams,
    });
    return writer.calls;
  }

  it('combined and two-pass hand the writer identical MI and CRAP rows', async () => {
    const combinedCalls = await runRegen({ forceTwoPass: false });
    const twoPassCalls = await runRegen({ forceTwoPass: true });

    const pick = (calls, kind) =>
      calls.find((c) => c.kind === kind)?.rows ?? null;

    const combinedMi = pick(combinedCalls, 'maintainability');
    const twoPassMi = pick(twoPassCalls, 'maintainability');
    const combinedCrap = pick(combinedCalls, 'crap');
    const twoPassCrap = pick(twoPassCalls, 'crap');

    assert.ok(combinedMi, 'combined path must produce MI rows');
    assert.ok(twoPassMi, 'two-pass path must produce MI rows');
    assert.ok(combinedCrap, 'combined path must produce CRAP rows');
    assert.ok(twoPassCrap, 'two-pass path must produce CRAP rows');

    // The byte-identity contract: identical rows, identical order, identical
    // scores — exactly what the on-disk envelope serialises.
    assert.deepEqual(
      combinedMi,
      twoPassMi,
      'MI rows must be byte-identical between combined and two-pass paths',
    );
    assert.deepEqual(
      combinedCrap,
      twoPassCrap,
      'CRAP rows must be byte-identical between combined and two-pass paths',
    );

    // Sanity guards so an empty-vs-empty match cannot mask a broken scan.
    assert.equal(combinedMi.length, 3, 'three source files → three MI rows');
    assert.ok(combinedCrap.length >= 1, 'real CRAP rows were produced');
  });

  it('combined path is actually taken by default (guard wiring sanity)', async () => {
    // Prove the default run routes through the COMBINED scanner, not the
    // two-pass one, by spying on `scanAndScoreCombined` via a wrapped seam.
    // (We inject the combined fn explicitly; injecting it does NOT flip the
    // two-pass guard — only overriding calculateAllFn/scanAndScoreFn does.)
    let combinedCalled = 0;
    const cov = coverageMap();
    const writer = recordingWriter();
    await regenerateMainFromTree({
      cwd: process.cwd(),
      resolveConfig: () => ({ agentSettings: {} }),
      getBaselines: baselinesResolved,
      getQuality: () => qualityResolved(tmpDir),
      logger: { info: () => {}, warn: () => {} },
      loadCoverageFn: () => cov,
      scanAndScoreCombinedFn: async (opts) => {
        combinedCalled += 1;
        return scanAndScoreCombined(opts);
      },
      resolveEscomplexVersionFn: () => '0.1.0',
      resolveTsTranspilerVersionFn: () => '5.9.3',
      writeFn: writer.writeFn,
      writeFileFn: writer.writeFileFn,
      loadPriorFn: () => null,
    });
    assert.equal(
      combinedCalled,
      1,
      'the combined single-pass scanner must run exactly once on the default path',
    );
  });
});

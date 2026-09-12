import assert from 'node:assert';
import fs from 'node:fs';
import { describe, it, test } from 'node:test';
import escomplex from 'typhonjs-escomplex';
import {
  COORDINATE_ORIGINAL,
  COORDINATE_TRANSPILED,
  calculateCrapForSource,
  crapFormula,
  deriveFixGuidance,
  finalizeMethodRows,
  finalizeMethodRowsWithBaseline,
  UNSCORABLE,
} from '../../.agents/scripts/lib/crap-engine.js';
import {
  deriveMethodIdentities,
  isAnonymousMethodLabel,
} from '../../.agents/scripts/lib/crap-method-identity.js';

/**
 * Build a coverage-entry fixture that forces coverageForMethodInEntry to
 * return a specific ratio for a method starting at `methodStartLine`.
 */
function coverageEntryFor(methodStartLine, ratio) {
  const total = 10;
  const covered = Math.round(ratio * total);
  const statementMap = {};
  const s = {};
  for (let i = 0; i < total; i += 1) {
    statementMap[String(i)] = {
      start: { line: methodStartLine + 1 + i, column: 0 },
      end: { line: methodStartLine + 1 + i, column: 10 },
    };
    s[String(i)] = i < covered ? 1 : 0;
  }
  return {
    fnMap: {
      0: {
        name: 'fn',
        decl: { start: { line: methodStartLine, column: 0 } },
        loc: {
          start: { line: methodStartLine, column: 0 },
          end: { line: methodStartLine + total + 1, column: 1 },
        },
      },
    },
    f: { 0: covered > 0 ? 1 : 0 },
    statementMap,
    s,
    branchMap: {},
    b: {},
  };
}

test('crapFormula — cov=1 returns c (no penalty)', () => {
  assert.strictEqual(crapFormula(1, 1), 1);
  assert.strictEqual(crapFormula(10, 1), 10);
});

test('crapFormula — cov=0 returns c² + c (full penalty)', () => {
  assert.strictEqual(crapFormula(1, 0), 2);
  assert.strictEqual(crapFormula(5, 0), 30);
  assert.strictEqual(crapFormula(10, 0), 110);
});

test('crapFormula — clamps coverage inputs into [0, 1]', () => {
  assert.strictEqual(crapFormula(5, -1), crapFormula(5, 0));
  assert.strictEqual(crapFormula(5, 2), crapFormula(5, 1));
});

test('crapFormula — newMethodCeiling=30 matches canonical c=5, cov=0 threshold', () => {
  // The PRD canonical ceiling of 30 corresponds to c=5 at zero coverage.
  assert.strictEqual(crapFormula(5, 0), 30);
  assert.ok(crapFormula(6, 0) > 30);
  assert.ok(crapFormula(4, 0) < 30);
});

test('calculateCrapForSource — low complexity + full coverage → low CRAP', () => {
  const source = `export function simple(x) { return x + 1; }\n`;
  const cov = coverageEntryFor(1, 1.0);
  const rows = calculateCrapForSource(source, cov);
  assert.strictEqual(rows.length, 1);
  const [row] = rows;
  assert.strictEqual(row.method, 'simple');
  assert.strictEqual(row.startLine, 1);
  assert.strictEqual(row.cyclomatic, 1);
  assert.strictEqual(row.coverage, 1);
  assert.strictEqual(row.crap, 1);
});

test('calculateCrapForSource — low complexity + zero coverage stays under ceiling', () => {
  const source = `export function simple(x) { return x + 1; }\n`;
  const cov = coverageEntryFor(1, 0);
  const [row] = calculateCrapForSource(source, cov);
  assert.strictEqual(row.cyclomatic, 1);
  assert.strictEqual(row.coverage, 0);
  assert.strictEqual(row.crap, 2);
});

test('calculateCrapForSource — high complexity + full coverage → CRAP = c', () => {
  const source = `
export function branchy(x) {
  if (x === 1) return 1;
  if (x === 2) return 2;
  if (x === 3) return 3;
  if (x === 4) return 4;
  if (x === 5) return 5;
  if (x === 6) return 6;
  if (x === 7) return 7;
  if (x === 8) return 8;
  if (x === 9) return 9;
  return 0;
}
`;
  const cov = coverageEntryFor(2, 1.0);
  const [row] = calculateCrapForSource(source, cov);
  assert.ok(
    row.cyclomatic >= 10,
    `expected high cyclomatic, got ${row.cyclomatic}`,
  );
  assert.strictEqual(row.coverage, 1);
  assert.strictEqual(row.crap, row.cyclomatic);
});

test('calculateCrapForSource — high complexity + zero coverage explodes', () => {
  const source = `
export function branchy(x) {
  if (x === 1) return 1;
  if (x === 2) return 2;
  if (x === 3) return 3;
  if (x === 4) return 4;
  if (x === 5) return 5;
  if (x === 6) return 6;
  if (x === 7) return 7;
  if (x === 8) return 8;
  if (x === 9) return 9;
  return 0;
}
`;
  const cov = coverageEntryFor(2, 0);
  const [row] = calculateCrapForSource(source, cov);
  assert.ok(row.cyclomatic >= 10);
  assert.strictEqual(row.coverage, 0);
  // c=10 → CRAP = 100 + 10 = 110; allow for slightly higher cyclomatic.
  const c = row.cyclomatic;
  assert.strictEqual(row.crap, c * c + c);
  assert.ok(row.crap >= 110);
});

test('calculateCrapForSource — null coverageForFile yields coverage=null, crap=null per method', () => {
  const source = `
export function a(x) { if (x) return 1; return 0; }
export function b() { return 2; }
`;
  const rows = calculateCrapForSource(source, null);
  assert.strictEqual(rows.length, 2);
  for (const row of rows) {
    assert.strictEqual(row.coverage, null);
    assert.strictEqual(row.crap, null);
    assert.ok(typeof row.cyclomatic === 'number' && row.cyclomatic >= 1);
    assert.ok(typeof row.startLine === 'number' && row.startLine > 0);
  }
});

test('calculateCrapForSource — method without coverage record gets null, others scored', () => {
  // `unscored` sits far below the covered function's `loc` range so neither
  // containment nor the ±1 decl window can claim it (Story #4775) — it is
  // genuinely uninstrumented, not merely mis-keyed.
  const source = `
export function scored(x) { return x + 1; }
${'\n'.repeat(40)}
export function unscored(x) { return x * 2; }
`;
  // Only provide coverage for the first method (startLine=2).
  const cov = coverageEntryFor(2, 1.0);
  const rows = calculateCrapForSource(source, cov);
  assert.strictEqual(rows.length, 2);
  const scored = rows.find((r) => r.method === 'scored');
  const unscored = rows.find((r) => r.method === 'unscored');
  assert.strictEqual(scored.coverage, 1);
  assert.strictEqual(scored.crap, scored.cyclomatic);
  assert.strictEqual(unscored.coverage, null);
  assert.strictEqual(unscored.crap, null);
});

test('calculateCrapForSource — invalid syntax returns UNSCORABLE, not []', () => {
  // Story #5311: `[]` here is what made every caller's unscorable-drop path
  // unreachable — a parse failure arrived looking exactly like a method-free
  // file and landed in the baseline as a clean zero.
  const rows = calculateCrapForSource('function foo( {', null);
  assert.strictEqual(rows, UNSCORABLE);
  assert.strictEqual(rows, null);
});

test('calculateCrapForSource — source with no methods returns empty array', () => {
  const rows = calculateCrapForSource('const x = 1;\nconst y = 2;\n', null);
  assert.deepStrictEqual(rows, []);
});

test('calculateCrapForSource — unscorable and method-free are distinguishable', () => {
  const unscorable = calculateCrapForSource('function foo( {', null);
  const methodFree = calculateCrapForSource('const x = 1;\n', null);
  assert.notDeepStrictEqual(unscorable, methodFree);
  assert.strictEqual(unscorable, null);
  assert.ok(Array.isArray(methodFree) && methodFree.length === 0);
});

test('calculateCrapForSource — the AST shim is installed by importing the kernel', () => {
  // The shim used to reach the CRAP scorers only as a side effect of
  // `maintainability-engine.js` being in the serial path's import graph; the
  // worker's graph never included it, so this source scored zero rows there
  // and 1 row serially (Story #5311). `for (… of … /regex/ …)` is one of the
  // nine traits that re-serialise a sub-AST through the defective generator.
  const source =
    'export function f(s) {\n  for (const t of s.split(/[^a-z]+/)) void t;\n}\n';
  const rows = calculateCrapForSource(source, null);
  assert.ok(Array.isArray(rows), 'source must be scorable, not UNSCORABLE');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].method, 'f');
});

test('calculateCrapForSource — rows carry escomplex lineStart for baseline matching', () => {
  const source = `
// leading comments

export function first() { return 1; }

export function second() { return 2; }
`;
  const rows = calculateCrapForSource(source, null);
  const first = rows.find((r) => r.method === 'first');
  const second = rows.find((r) => r.method === 'second');
  assert.ok(first && second);
  assert.ok(second.startLine > first.startLine);
});

test('calculateCrapForSource — fixGuidance round-trip (single-axis fixes pass ceiling)', () => {
  // Simulate a regression: c=10, cov=0 → CRAP=110. Target ceiling 30.
  const c = 10;
  const target = 30;

  // minComplexityAt100Cov = floor(sqrt(target)) = 5 → CRAP at cov=1 is 5.
  const minComplexityAt100Cov = Math.floor(Math.sqrt(target));
  assert.ok(crapFormula(minComplexityAt100Cov, 1) <= target);

  // minCoverageAtCurrentComplexity = 1 − ((target − c)/c²)^(1/3)
  // For target=30, c=10 → 1 − (20/100)^(1/3) ≈ 0.415
  const minCov = 1 - ((target - c) / (c * c)) ** (1 / 3);
  assert.ok(crapFormula(c, minCov) <= target + 1e-9);
});

// ---------------------------------------------------------------------------
// Story #4866 — coordinate provenance. Before this Story, a method whose
// sourcemap lookup returned null silently kept its TRANSPILED line while its
// siblings carried remapped ORIGINAL ones: one scan, two coordinate systems,
// indistinguishable on disk. That mix is what mis-keys rows against the
// baseline and manufactures a regression no change can satisfy.
// ---------------------------------------------------------------------------

/** A source whose methods sit at known lines, for provenance assertions. */
const TWO_METHODS = `
export function first(x) { if (x) return 1; return 0; }

export function second(x) { if (x) return 2; return 0; }
`;

describe('methodRowsFromReport — coordinate provenance (AC-1, AC-2)', () => {
  it('records original coordinates for a JavaScript source (no mapper)', () => {
    // JS coordinates already ARE original-source coordinates — nothing was
    // remapped, and nothing needed to be.
    const rows = calculateCrapForSource(TWO_METHODS, null);
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.coordinateSystem, COORDINATE_ORIGINAL);
    }
  });

  it('records original coordinates when the sourcemap resolves', () => {
    const rows = calculateCrapForSource(TWO_METHODS, null, (line) => line + 10);
    for (const row of rows) {
      assert.equal(row.coordinateSystem, COORDINATE_ORIGINAL);
    }
    // And the row reports the remapped line, not the generated one.
    assert.ok(rows.every((r) => r.startLine > 10));
  });

  it('flags the row when the sourcemap has no entry for the generated line', () => {
    const rows = calculateCrapForSource(TWO_METHODS, null, () => null);
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.coordinateSystem, COORDINATE_TRANSPILED);
    }
  });

  it('emits exactly one coordinate system per row in a MIXED scan (AC-3)', () => {
    // The defect's exact shape: one method resolves, its sibling does not.
    // Both rows used to be emitted as if they shared a coordinate system.
    const rows = calculateCrapForSource(TWO_METHODS, null, (line) =>
      line < 3 ? line + 100 : null,
    );
    const byMethod = Object.fromEntries(rows.map((r) => [r.method, r]));
    assert.equal(byMethod.first.coordinateSystem, COORDINATE_ORIGINAL);
    assert.equal(byMethod.second.coordinateSystem, COORDINATE_TRANSPILED);
    assert.equal(
      new Set(rows.map((r) => r.coordinateSystem)).size,
      2,
      'the mix must be VISIBLE on the rows, not silently flattened',
    );
  });
});

describe('methodRowsFromReport — an un-remapped line joins no coverage (AC-2)', () => {
  it('refuses the coverage join rather than reading the wrong coordinate', () => {
    // The coverage entry is keyed at line 2 in ORIGINAL coordinates. Without
    // a resolved remap the row's line is a transpiled coordinate, and reading
    // istanbul's fnMap with it does not merely miss — it can land inside an
    // unrelated function's range and report an untested method as covered.
    const source = `export function simple(x) { return x + 1; }\n`;
    const cov = coverageEntryFor(1, 1.0);

    const resolved = calculateCrapForSource(source, cov, (line) => line);
    assert.equal(resolved[0].coverage, 1);
    assert.equal(resolved[0].crap, 1);

    const unresolved = calculateCrapForSource(source, cov, () => null);
    assert.equal(unresolved[0].coordinateSystem, COORDINATE_TRANSPILED);
    assert.equal(
      unresolved[0].coverage,
      null,
      'a transpiled coordinate must not be joined against an original-source fnMap',
    );
    assert.equal(unresolved[0].crap, null);
  });
});

describe('finalizeMethodRows — provenance gates the fill (#4866, #4901)', () => {
  const raw = [
    {
      method: 'mapped',
      startLine: 4,
      cyclomatic: 2,
      coverage: 1,
      crap: 2,
      coordinateSystem: COORDINATE_ORIGINAL,
    },
    {
      method: 'unmapped',
      startLine: 9,
      cyclomatic: 3,
      coverage: null,
      crap: null,
      coordinateSystem: COORDINATE_TRANSPILED,
    },
  ];

  it('drops the un-remapped row under requireCoverage: true', () => {
    // The default policy. An un-remapped row is unresolved, so it never
    // reaches a baseline at all — which is why a pure-JS baseline is
    // untouched by this change.
    const out = finalizeMethodRows(raw, { requireCoverage: true });
    assert.deepEqual(
      out.rows.map((r) => r.method),
      ['mapped'],
    );
    assert.equal(out.skippedMethodsNoCoverage, 1);
  });

  it('drops the un-remapped row under requireCoverage: false too (#4901)', () => {
    // Story #4901. This row used to be KEPT here and scored 0% — the flag
    // rode along, but the scoring branch never read it, so `crapFormula(3, 0)`
    // put a maximal 12 into the baseline for a method whose coverage was
    // merely unjoinable. Against a baseline row at the other coordinate that
    // reads as a drifted-regression no edit to the file can satisfy.
    const out = finalizeMethodRows(raw, { requireCoverage: false });
    assert.deepEqual(
      out.rows.map((r) => r.method),
      ['mapped'],
    );
    assert.equal(out.skippedMethodsNoCoverage, 1);
  });

  it('still scores a genuinely uninstrumented ORIGINAL row at 0%', () => {
    // The `requireCoverage: false` policy itself is untouched: an unresolved
    // row whose coordinate IS joinable is untested code, and 0% is a real
    // measurement of it. Only the unjoinable case changed.
    const out = finalizeMethodRows(
      [
        {
          method: 'untested',
          startLine: 7,
          cyclomatic: 3,
          coverage: null,
          crap: null,
          coordinateSystem: COORDINATE_ORIGINAL,
        },
      ],
      { requireCoverage: false, coverageAvailable: true },
    );
    assert.equal(out.rows.length, 1);
    assert.equal(out.rows[0].coverage, 0);
    assert.equal(out.rows[0].crap, 3 ** 2 + 3);
  });

  it('leaves the join counters untouched under either policy', () => {
    // The resolution-rate floor reads the JOIN, not the fill, so excluding a
    // transpiled row must not move these — otherwise the updater's
    // fail-closed floor would drift as a side effect of this Story.
    for (const requireCoverage of [true, false]) {
      const out = finalizeMethodRows(raw, { requireCoverage });
      assert.equal(out.totalMethods, 2, `totalMethods @ ${requireCoverage}`);
      assert.equal(
        out.resolvedMethods,
        1,
        `resolvedMethods @ ${requireCoverage}`,
      );
    }
  });

  it('defaults a row with no stamp to original coordinates', () => {
    // Back-compat: rows built before the stamp existed are original-source
    // coordinates by construction.
    const out = finalizeMethodRows(
      [{ method: 'legacy', startLine: 1, cyclomatic: 1, coverage: 1, crap: 1 }],
      { requireCoverage: true },
    );
    assert.equal(out.rows[0].coordinateSystem, COORDINATE_ORIGINAL);
  });
});

describe('finalizeMethodRowsWithBaseline — incremental join (Story #4981)', () => {
  const rawTouched = [
    {
      method: 'fresh',
      startLine: 4,
      cyclomatic: 2,
      coverage: 1,
      crap: 2,
      coordinateSystem: COORDINATE_ORIGINAL,
    },
  ];
  const rawUntouched = [
    {
      method: 'stable',
      startLine: 10,
      cyclomatic: 5,
      coverage: null,
      crap: null,
      coordinateSystem: COORDINATE_ORIGINAL,
    },
  ];

  it('AC-5: touched=true (the default) delegates byte-identically to finalizeMethodRows', () => {
    const baselineByKey = new Map([['stable@10', { crap: 3 }]]);
    const viaWrapper = finalizeMethodRowsWithBaseline(rawUntouched, {
      requireCoverage: true,
      touched: true,
      baselineByKey,
    });
    const viaPlain = finalizeMethodRows(rawUntouched, {
      requireCoverage: true,
    });
    assert.deepEqual(viaWrapper, viaPlain);
  });

  it('AC-5: a null/absent baselineByKey delegates byte-identically', () => {
    const viaWrapper = finalizeMethodRowsWithBaseline(rawTouched, {
      requireCoverage: true,
      touched: false,
      baselineByKey: null,
    });
    const viaPlain = finalizeMethodRows(rawTouched, { requireCoverage: true });
    assert.deepEqual(viaWrapper, viaPlain);
  });

  it('AC-2/AC-3: an untouched-file method with NO fresh coverage resolves from its baseline row', () => {
    const baselineByKey = new Map([['stable@10', { crap: 7.5 }]]);
    const out = finalizeMethodRowsWithBaseline(rawUntouched, {
      requireCoverage: true,
      touched: false,
      baselineByKey,
    });
    assert.equal(out.skippedMethodsNoCoverage, 0, 'no unresolved-method skip');
    assert.equal(out.resolvedMethods, 1);
    assert.equal(out.rows.length, 1);
    assert.equal(
      out.rows[0].crap,
      7.5,
      'verdict equals the committed baseline row',
    );
    assert.equal(out.rows[0].resolvedFromBaseline, true);
  });

  it('AC-3: fail-closed — an untouched-file method with NO baseline row falls back to skip-and-count', () => {
    const baselineByKey = new Map([['other-method@1', { crap: 1 }]]);
    const out = finalizeMethodRowsWithBaseline(rawUntouched, {
      requireCoverage: true,
      touched: false,
      baselineByKey,
    });
    // requireCoverage: true, unresolved (coverage: null) → skip-and-count,
    // exactly finalizeMethodRows' existing policy. Never silently passes.
    assert.equal(out.rows.length, 0);
    assert.equal(out.skippedMethodsNoCoverage, 1);
    assert.equal(out.resolvedMethods, 0);
  });

  it('AC-3: a diff-touched file with no fresh joinable coverage still fails the existing policy', () => {
    // Touched files are UNCHANGED by this Story: an unresolved method under
    // requireCoverage: true is still skipped-and-counted, never resolved
    // from the baseline even if one happens to exist.
    const touchedButUnresolved = [
      {
        method: 'stable',
        startLine: 10,
        cyclomatic: 5,
        coverage: null,
        crap: null,
        coordinateSystem: COORDINATE_ORIGINAL,
      },
    ];
    const baselineByKey = new Map([['stable@10', { crap: 7.5 }]]);
    const out = finalizeMethodRowsWithBaseline(touchedButUnresolved, {
      requireCoverage: true,
      touched: true,
      baselineByKey,
    });
    assert.equal(out.rows.length, 0);
    assert.equal(out.skippedMethodsNoCoverage, 1);
  });

  it('never resolves a transpiled (unjoinable) row from the baseline', () => {
    const raw = [
      {
        method: 'stable',
        startLine: 10,
        cyclomatic: 5,
        coverage: null,
        crap: null,
        coordinateSystem: COORDINATE_TRANSPILED,
      },
    ];
    const baselineByKey = new Map([['stable@10', { crap: 7.5 }]]);
    const out = finalizeMethodRowsWithBaseline(raw, {
      requireCoverage: true,
      touched: false,
      baselineByKey,
    });
    assert.equal(out.rows.length, 0);
    assert.equal(out.skippedMethodsNoCoverage, 1);
  });

  it('an empty baselineByKey Map delegates to the standard policy (falls back, not a crash)', () => {
    const out = finalizeMethodRowsWithBaseline(rawUntouched, {
      requireCoverage: true,
      touched: false,
      baselineByKey: new Map(),
    });
    assert.equal(out.rows.length, 0);
    assert.equal(out.skippedMethodsNoCoverage, 1);
  });
});

test('deriveFixGuidance — regression path (target=baseline, c=10 → both axes achievable)', () => {
  const guidance = deriveFixGuidance({ cyclomatic: 10, target: 30 });
  assert.ok(guidance);
  assert.strictEqual(guidance.crapCeiling, 30);
  assert.strictEqual(guidance.minComplexityAt100Cov, 5);
  // Formula: 1 - ((30-10)/100)^(1/3) ≈ 0.4152; expect a finite [0,1] value.
  assert.ok(guidance.minCoverageAtCurrentComplexity > 0);
  assert.ok(guidance.minCoverageAtCurrentComplexity < 1);
  // Round-trip — applying the coverage fix at the current complexity passes.
  assert.ok(
    crapFormula(10, guidance.minCoverageAtCurrentComplexity) <= 30 + 1e-9,
  );
  // Round-trip — applying the complexity fix at full coverage passes.
  assert.ok(crapFormula(guidance.minComplexityAt100Cov, 1) <= 30);
});

test('deriveFixGuidance — c > target renders coverage axis unachievable (null)', () => {
  // At c=40, CRAP@cov=1 = 40 which already exceeds a ceiling of 30. Coverage
  // alone cannot rescue the method — only complexity reduction can.
  const guidance = deriveFixGuidance({ cyclomatic: 40, target: 30 });
  assert.ok(guidance);
  assert.strictEqual(guidance.minCoverageAtCurrentComplexity, null);
  assert.strictEqual(guidance.minComplexityAt100Cov, 5);
});

test('deriveFixGuidance — c === target yields cov=1 exactly (boundary)', () => {
  // At c=t, the only passing coverage is 1.0 — the cube-root term is zero.
  const guidance = deriveFixGuidance({ cyclomatic: 10, target: 10 });
  assert.ok(guidance);
  assert.strictEqual(guidance.minCoverageAtCurrentComplexity, 1);
  assert.strictEqual(guidance.minComplexityAt100Cov, 3);
});

test('deriveFixGuidance — new-violation path (target=ceiling=30, c=6)', () => {
  const guidance = deriveFixGuidance({ cyclomatic: 6, target: 30 });
  assert.ok(guidance);
  assert.strictEqual(guidance.crapCeiling, 30);
  assert.strictEqual(guidance.minComplexityAt100Cov, 5);
  assert.ok(
    crapFormula(6, guidance.minCoverageAtCurrentComplexity) <= 30 + 1e-9,
  );
});

test('deriveFixGuidance — c=0 is degenerate: coverage is null, complexity fix is 0', () => {
  const guidance = deriveFixGuidance({ cyclomatic: 0, target: 30 });
  assert.ok(guidance);
  assert.strictEqual(guidance.minCoverageAtCurrentComplexity, null);
  assert.strictEqual(guidance.minComplexityAt100Cov, 5);
});

test('deriveFixGuidance — non-finite inputs return null', () => {
  assert.strictEqual(deriveFixGuidance({ cyclomatic: NaN, target: 30 }), null);
  assert.strictEqual(
    deriveFixGuidance({ cyclomatic: 10, target: Infinity }),
    null,
  );
  assert.strictEqual(deriveFixGuidance({ cyclomatic: 10, target: -1 }), null);
  assert.strictEqual(deriveFixGuidance(), null);
});

test('deriveFixGuidance — deterministic across repeated calls', () => {
  const a = deriveFixGuidance({ cyclomatic: 10, target: 30 });
  const b = deriveFixGuidance({ cyclomatic: 10, target: 30 });
  assert.deepStrictEqual(a, b);
});

// ---------------------------------------------------------------------------
// Story #4969 — order-independent identity for anonymous methods.
//
// escomplex names an unnamed function `<anon method-N>` from a per-module
// counter, so inserting one anonymous function renumbers every later one and
// re-keys 34.6% of the CRAP baseline. The comparator then pairs unrelated
// functions by nearest `startLine` and reports the pairing as a regression.
// ---------------------------------------------------------------------------

/** Identities for a source, in escomplex's emission order. */
function identitiesFor(source) {
  return deriveMethodIdentities(escomplex.analyzeModule(source).methods);
}

/** Just the derived anonymous identities, as a Set for order-free compare. */
function anonIdentities(source) {
  return new Set(
    identitiesFor(source)
      .filter((i) => i.anonymous)
      .map((i) => i.method),
  );
}

/**
 * A file with anonymous functions at module scope, inside a named function,
 * and nested inside another anonymous one — the three shapes the scope path
 * has to distinguish.
 */
const ANON_FIXTURE = `
const first = (p) => p + 1;
const second = (p) => p + 2;

export function outer(cfg) {
  const inner = (files, opts) => {
    return files.map((r) => r + opts);
  };
  return inner(cfg, 1);
}
`;

describe('deriveMethodIdentities — scope-path identity (Story #4969)', () => {
  it('names an anonymous method by its scope path, not by a global counter', () => {
    assert.deepEqual(
      [...anonIdentities(ANON_FIXTURE)].sort(),
      [
        '<anon (p)#0>',
        '<anon (p)#1>',
        // `/` sorts before `>`, so the nested one lands first.
        '<anon outer/(files,opts)#0/(r)#0>',
        '<anon outer/(files,opts)#0>',
      ],
      'the path must carry the enclosing chain, and nesting must be visible',
    );
  });

  it('leaves a named method exactly as escomplex reported it', () => {
    const outer = identitiesFor(ANON_FIXTURE).find((i) => i.method === 'outer');
    assert.ok(outer, 'the named function must keep its own name');
    assert.equal(outer.anonymous, false);
  });

  it('AC-1: an unrelated anonymous function added earlier re-keys nothing', () => {
    // The exact edit the old scheme could not survive: one extra arrow at the
    // TOP of the file. Under `<anon method-N>` every later anon shifted by one.
    const edited = ANON_FIXTURE.replace(
      'const first =',
      'const inserted = [1].map((z) => z * 2);\nconst first =',
    );

    const before = anonIdentities(ANON_FIXTURE);
    const after = anonIdentities(edited);
    for (const id of before) {
      assert.ok(
        after.has(id),
        `identity ${id} did not survive an unrelated insertion`,
      );
    }
    assert.equal(after.size, before.size + 1, 'only the new arrow is new');

    // The control, without which this test would also pass against a scheme
    // that never changed anything: under escomplex's own labels the SAME edit
    // renames the very functions it did not touch. Track one of them — the
    // `(p) => p + 2` arrow — by the label escomplex gives it before and after.
    const labelOfSecondArrow = (src) => {
      const m = escomplex
        .analyzeModule(src)
        .methods.find((x) =>
          src.split('\n')[x.lineStart - 1].includes('p + 2'),
        );
      return m.name;
    };
    assert.equal(labelOfSecondArrow(ANON_FIXTURE), '<anon method-2>');
    assert.equal(
      labelOfSecondArrow(edited),
      '<anon method-3>',
      'control: the ordinal label follows position, so an unrelated insertion ' +
        'renames an untouched function — the defect this Story removes',
    );
  });

  it('AC-2: two anonymous functions in one scope get different identities', () => {
    // Same enclosing scope, same arity, same body shape — nothing but their
    // order tells them apart, so the discriminator has to hold.
    const source = `
export function host() {
  const a = (x) => x + 1;
  const b = (x) => x + 2;
  return [a, b];
}
`;
    const ids = [...anonIdentities(source)];
    assert.equal(ids.length, 2, 'both must be present');
    assert.equal(
      new Set(ids).size,
      2,
      'the re-keying must not collapse two methods onto one row',
    );
    assert.deepEqual(ids.sort(), ['<anon host/(x)#0>', '<anon host/(x)#1>']);
  });

  it('AC-3: an anonymous method keeps its identity when it gains branches', () => {
    // The identity must NOT be a function of the body. If it were, a genuine
    // complexity increase would re-key the row, the comparator would file it
    // as a brand-new method, and the regression would be scored against the
    // new-method ceiling instead of the method's own baseline — silence
    // bought by dropping coverage.
    const before = `
export function host(v) {
  return [v].map((x) => x + 1);
}
`;
    const after = `
export function host(v) {
  return [v].map((x) => {
    if (x > 1) return x + 1;
    if (x > 2) return x + 2;
    if (x > 3) return x + 3;
    return x;
  });
}
`;
    assert.deepEqual([...anonIdentities(before)], ['<anon host/(x)#0>']);
    assert.deepEqual(
      [...anonIdentities(after)],
      ['<anon host/(x)#0>'],
      'a branchier body is the same method and must keep the same key',
    );

    // And the complexity really did move, so the assertion above is not
    // vacuous — the comparator has a genuine regression to find.
    const cyclomaticOf = (src) =>
      escomplex
        .analyzeModule(src)
        .methods.find((m) => /^<anon method-\d+>$/.test(m.name)).cyclomatic;
    assert.ok(
      cyclomaticOf(after) > cyclomaticOf(before),
      'fixture must actually get more complex',
    );
  });

  it('is injective over a real module — no two methods share a key', () => {
    const source = fs.readFileSync(
      '.agents/scripts/lib/baselines/kinds/crap.js',
      'utf-8',
    );
    const ids = identitiesFor(source).map((i) => i.method);
    assert.ok(ids.length > 30, 'fixture module should be substantial');
    assert.equal(
      new Set(ids).size,
      ids.length,
      'a collision would merge two methods into a single baseline row',
    );
  });

  it('tolerates a report with no methods and a method with no span', () => {
    assert.deepEqual(deriveMethodIdentities([]), []);
    assert.deepEqual(deriveMethodIdentities(undefined), []);
    const [only] = deriveMethodIdentities([{ name: '<anon method-1>' }]);
    assert.equal(only.method, '<anon ()#0>');
    assert.equal(only.anonymous, true);
  });
});

describe('methodRowsFromReport — rows carry the identity marker (#4969)', () => {
  it('flags a derived identity and leaves a named row unflagged', () => {
    const rows = calculateCrapForSource(ANON_FIXTURE, null);
    const named = rows.find((r) => r.method === 'outer');
    const anon = rows.find((r) => r.method === '<anon (p)#0>');
    assert.ok(named && anon);
    assert.equal(named.anonymous, false);
    assert.equal(anon.anonymous, true);
  });

  it('carries the marker through the requireCoverage policy step', () => {
    const out = finalizeMethodRows([
      {
        method: '<anon host/(x)#0>',
        anonymous: true,
        startLine: 2,
        cyclomatic: 2,
        coverage: 1,
        crap: 2,
        coordinateSystem: COORDINATE_ORIGINAL,
      },
    ]);
    assert.equal(out.rows[0].anonymous, true);
  });
});

describe('isAnonymousMethodLabel', () => {
  it('recognises both the derived identity and the superseded ordinal', () => {
    assert.equal(isAnonymousMethodLabel('<anon host/(x)#0>'), true);
    assert.equal(isAnonymousMethodLabel('<anon method-7>'), true);
    assert.equal(isAnonymousMethodLabel('doWork'), false);
    assert.equal(isAnonymousMethodLabel(undefined), false);
  });
});

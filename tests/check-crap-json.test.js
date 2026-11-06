import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, test } from 'node:test';
import Ajv from 'ajv';
import { runCheckBaselines } from '../.agents/scripts/check-baselines.js';
import { currentKernelVersion } from '../.agents/scripts/lib/baselines/kernel.js';
import {
  assertBaselineCompatible,
  buildCrapReport,
  compareCrap,
  envelopeExtras,
  printRemovedRows,
  printSummaryHeader,
  printViolation,
} from '../.agents/scripts/lib/baselines/kinds/crap.js';
import {
  calculateCrapForSource,
  crapFormula,
} from '../.agents/scripts/lib/crap-engine.js';
import { KERNEL_VERSION } from '../.agents/scripts/lib/crap-utils.js';
import { Logger } from '../.agents/scripts/lib/Logger.js';
import { makeTempDir } from '../.agents/scripts/lib/test-temp.js';
import {
  AHEAD_STAMP,
  RUNNING_STAMP,
  writeAheadCrapBaseline,
} from './fixtures/baselines/crap-ahead.js';

/**
 * Schema-conformance and round-trip coverage for the `--json` envelope
 * emitted by check-crap. Two contracts are enforced:
 *
 *   1. Envelope shape matches `crap-report.schema.json` (Ajv-validated).
 *   2. Applying either single-axis fix from `fixGuidance` to a violating
 *      method's inputs and re-running `crapFormula` yields a CRAP score at
 *      or below the target — the baseline for regressions, the ceiling for
 *      new-method violations.
 */

const SCHEMA_PATH = path.resolve('.agents/schemas/crap-report.schema.json');

function loadValidator() {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf-8'));
  return ajv.compile(schema);
}

function makeRegressionRow(overrides = {}) {
  return {
    file: 'lib/a.js',
    method: 'doWork',
    startLine: 42,
    cyclomatic: 8,
    coverage: 0.2,
    // CRAP = 64 * 0.512 + 8 = 40.768
    crap: crapFormula(8, 0.2),
    ...overrides,
  };
}

function makeBaselineRow(overrides = {}) {
  return {
    file: 'lib/a.js',
    method: 'doWork',
    startLine: 42,
    crap: 18,
    ...overrides,
  };
}

test('buildCrapReport — empty envelope validates against crap-report.schema.json', () => {
  const validate = loadValidator();
  const envelope = buildCrapReport({
    compareResult: compareCrap({
      currentRows: [],
      baselineRows: [],
      newMethodCeiling: 30,
      tolerance: 0.001,
    }),
    scanSummary: {},
    kernelVersion: KERNEL_VERSION,
    escomplexVersion: '7.3.2',
    newMethodCeiling: 30,
    scopeInfo: { scope: 'diff', diffRef: 'main' },
  });
  const ok = validate(envelope);
  assert.ok(
    ok,
    `empty envelope failed schema: ${JSON.stringify(validate.errors, null, 2)}`,
  );
  assert.strictEqual(envelope.violations.length, 0);
  assert.strictEqual(envelope.summary.total, 0);
  // Story #1394: envelope summary now carries scope + diffRef.
  assert.strictEqual(envelope.summary.scope, 'diff');
  assert.strictEqual(envelope.summary.diffRef, 'main');
});

test('buildCrapReport — full-scope nulls diffRef (Story #1394)', () => {
  const validate = loadValidator();
  const envelope = buildCrapReport({
    compareResult: compareCrap({
      currentRows: [],
      baselineRows: [],
      newMethodCeiling: 30,
      tolerance: 0.001,
    }),
    scanSummary: {},
    kernelVersion: KERNEL_VERSION,
    escomplexVersion: '7.3.2',
    newMethodCeiling: 30,
    scopeInfo: { scope: 'full', diffRef: 'main' },
  });
  assert.ok(validate(envelope), JSON.stringify(validate.errors));
  assert.strictEqual(envelope.summary.scope, 'full');
  assert.strictEqual(envelope.summary.diffRef, null);
});

test('buildCrapReport — defaults to scope=diff diffRef=null when scopeInfo omitted (Story #1394)', () => {
  const validate = loadValidator();
  const envelope = buildCrapReport({
    compareResult: compareCrap({
      currentRows: [],
      baselineRows: [],
      newMethodCeiling: 30,
      tolerance: 0.001,
    }),
    scanSummary: {},
    kernelVersion: KERNEL_VERSION,
    escomplexVersion: '7.3.2',
    newMethodCeiling: 30,
  });
  assert.ok(validate(envelope), JSON.stringify(validate.errors));
  assert.strictEqual(envelope.summary.scope, 'diff');
  assert.strictEqual(envelope.summary.diffRef, null);
});

test('buildCrapReport — regression envelope validates and carries fixGuidance', () => {
  const validate = loadValidator();
  const current = [makeRegressionRow()];
  const baseline = [makeBaselineRow()];
  const compareResult = compareCrap({
    currentRows: current,
    baselineRows: baseline,
    newMethodCeiling: 30,
    tolerance: 0.001,
  });
  const envelope = buildCrapReport({
    compareResult,
    scanSummary: { skippedFilesNoCoverage: 1, skippedMethodsNoCoverage: 2 },
    kernelVersion: KERNEL_VERSION,
    escomplexVersion: '7.3.2',
    newMethodCeiling: 30,
  });

  const ok = validate(envelope);
  assert.ok(
    ok,
    `envelope failed schema: ${JSON.stringify(validate.errors, null, 2)}`,
  );

  assert.strictEqual(envelope.summary.regressions, 1);
  assert.strictEqual(envelope.summary.newViolations, 0);
  assert.strictEqual(envelope.summary.skippedNoCoverage, 3);
  assert.strictEqual(envelope.violations.length, 1);

  const [v] = envelope.violations;
  assert.strictEqual(v.kind, 'regression');
  assert.strictEqual(v.baseline, 18);
  assert.strictEqual(v.ceiling, 30);
  assert.ok(v.fixGuidance, 'fixGuidance missing');
  assert.strictEqual(v.fixGuidance.crapCeiling, 18);
  assert.strictEqual(typeof v.fixGuidance.minComplexityAt100Cov, 'number');
});

test('buildCrapReport — round-trip: each single-axis fix reduces CRAP to ≤ target (regression)', () => {
  // c=8, baseline=18 → target 18. At c=8, CRAP@cov=1 = 8 ≤ 18 so coverage
  // fix is achievable. complexityAt100Cov = floor(sqrt(18)) = 4.
  const current = [makeRegressionRow()];
  const baseline = [makeBaselineRow()];
  const envelope = buildCrapReport({
    compareResult: compareCrap({
      currentRows: current,
      baselineRows: baseline,
      newMethodCeiling: 30,
      tolerance: 0.001,
    }),
    scanSummary: {},
    kernelVersion: KERNEL_VERSION,
    escomplexVersion: '7.3.2',
    newMethodCeiling: 30,
  });

  const [v] = envelope.violations;
  const target = v.baseline;

  // Coverage fix: hold complexity, lift coverage to `minCoverageAtCurrentComplexity`.
  const covFixScore = crapFormula(
    v.cyclomatic,
    v.fixGuidance.minCoverageAtCurrentComplexity,
  );
  assert.ok(
    covFixScore <= target + 1e-9,
    `coverage fix failed: crap=${covFixScore} > target=${target}`,
  );

  // Complexity fix: reduce to `minComplexityAt100Cov`, regardless of coverage
  // (the fix posits 100% coverage, but even at cov=0 CRAP ≤ target since the
  // formula collapses to c when cov=1; we assert the 100%-cov branch).
  const cplxFixScore = crapFormula(v.fixGuidance.minComplexityAt100Cov, 1);
  assert.ok(
    cplxFixScore <= target,
    `complexity fix failed: crap=${cplxFixScore} > target=${target}`,
  );
});

test('buildCrapReport — round-trip: each single-axis fix reduces CRAP to ≤ ceiling (new)', () => {
  // A brand-new method with c=10, cov=0.1 → CRAP ≈ 10^2 * 0.9^3 + 10 = 82.9.
  // Target = newMethodCeiling = 30. Coverage axis achievable since c=10 ≤ 30.
  const current = [
    {
      file: 'lib/b.js',
      method: 'freshlyAdded',
      startLine: 99,
      cyclomatic: 10,
      coverage: 0.1,
      crap: crapFormula(10, 0.1),
    },
  ];
  const envelope = buildCrapReport({
    compareResult: compareCrap({
      currentRows: current,
      baselineRows: [],
      newMethodCeiling: 30,
      tolerance: 0.001,
    }),
    scanSummary: {},
    kernelVersion: KERNEL_VERSION,
    escomplexVersion: '7.3.2',
    newMethodCeiling: 30,
  });

  assert.strictEqual(envelope.violations.length, 1);
  const [v] = envelope.violations;
  assert.strictEqual(v.kind, 'new');
  assert.strictEqual(v.baseline, null);
  assert.strictEqual(v.ceiling, 30);
  assert.strictEqual(v.fixGuidance.crapCeiling, 30);

  const covFixScore = crapFormula(
    v.cyclomatic,
    v.fixGuidance.minCoverageAtCurrentComplexity,
  );
  assert.ok(
    covFixScore <= 30 + 1e-9,
    `coverage fix failed: crap=${covFixScore} > 30`,
  );
  const cplxFixScore = crapFormula(v.fixGuidance.minComplexityAt100Cov, 1);
  assert.ok(
    cplxFixScore <= 30,
    `complexity fix failed: crap=${cplxFixScore} > 30`,
  );
});

test('buildCrapReport — drifted-regression kind surfaces through the envelope', () => {
  const baseline = [makeBaselineRow({ crap: 4 })];
  // A namesake re-key (`doWork` → `doWork#1`) re-pairs within the stem.
  const current = [
    makeRegressionRow({
      method: 'doWork#1',
      startLine: 25,
      cyclomatic: 10,
      coverage: 0,
      crap: 110,
    }),
  ];
  const envelope = buildCrapReport({
    compareResult: compareCrap({
      currentRows: current,
      baselineRows: baseline,
      newMethodCeiling: 30,
      tolerance: 0.001,
    }),
    scanSummary: {},
    kernelVersion: KERNEL_VERSION,
    escomplexVersion: '7.3.2',
    newMethodCeiling: 30,
  });
  const validate = loadValidator();
  assert.ok(validate(envelope), JSON.stringify(validate.errors));
  assert.strictEqual(envelope.violations[0].kind, 'drifted-regression');
  // Target = baseline (4), c=10 → coverage axis unachievable, complexity axis
  // still derivable (floor(sqrt(4)) = 2).
  assert.strictEqual(
    envelope.violations[0].fixGuidance.minCoverageAtCurrentComplexity,
    null,
  );
  assert.strictEqual(
    envelope.violations[0].fixGuidance.minComplexityAt100Cov,
    2,
  );
});

// ---------------------------------------------------------------------------
// Story #4969 — the re-keying, seen from the comparator and the artefact.
//
// `tests/lib/crap-engine.test.js` proves the identity itself is
// order-independent. These assert what the gate does with it: a real
// regression is still caught, the old baseline is refused wholesale rather
// than drift-paired, and the shipped baseline validates re-keyed.
// ---------------------------------------------------------------------------

const BASELINE_SCHEMA_PATH = path.resolve(
  '.agents/schemas/baselines/crap.schema.json',
);
const ENVELOPE_SCHEMA_PATH = path.resolve(
  '.agents/schemas/baselines/baseline-envelope.schema.json',
);

test('AC-3: a genuine regression on an anonymous method is still reported', () => {
  // The method kept its identity across the edit — that is the whole point —
  // so it matches its baseline row exactly and is scored against THAT row.
  // A body-derived identity would re-key the method on the very edit that made
  // it worse, landing it in the `new` bucket to be judged against the ceiling
  // instead of its own baseline: the wrong target, and a `regressions` count
  // of zero on a real regression.
  const identity = '<anon buildScorer/(files,opts)#0>';
  const result = compareCrap({
    currentRows: [makeRegressionRow({ method: identity, anonymous: true })],
    baselineRows: [makeBaselineRow({ method: identity, anonymous: true })],
    newMethodCeiling: 30,
    tolerance: 0.001,
  });
  assert.strictEqual(result.regressions, 1);
  assert.strictEqual(result.newViolations, 0);
  assert.strictEqual(result.violations[0].kind, 'regression');
  assert.strictEqual(result.violations[0].baseline, 18);
});

test('AC-1: an insertion above two methods leaves both paired by key alone', () => {
  // Two same-file anonymous methods whose lines shifted because something was
  // inserted above them. Their identities are unchanged and no line is
  // persisted, so each pairs with its OWN baseline row by key and neither
  // regresses, reads as new, or orphans its row.
  const cheap = '<anon host/(a)#0>';
  const costly = '<anon host/(b)#0>';
  const result = compareCrap({
    currentRows: [
      {
        file: 'lib/a.js',
        method: cheap,
        anonymous: true,
        startLine: 11,
        cyclomatic: 8,
        coverage: 1,
        crap: 8,
      },
      {
        file: 'lib/a.js',
        method: costly,
        anonymous: true,
        startLine: 21,
        cyclomatic: 8,
        coverage: 1,
        crap: 8,
      },
    ],
    baselineRows: [
      { file: 'lib/a.js', method: cheap, crap: 8 },
      { file: 'lib/a.js', method: costly, crap: 8 },
    ],
    newMethodCeiling: 30,
    tolerance: 0.001,
  });
  assert.strictEqual(result.regressions, 0, 'no phantom regression');
  assert.strictEqual(result.newViolations, 0, 'neither method reads as new');
  assert.strictEqual(result.removed, 0, 'neither baseline row is orphaned');
  assert.strictEqual(result.drifted, 0, 'both matched by exact key');
});

/**
 * Score a source at 100% coverage, so each row's CRAP is its cyclomatic and
 * closures with different branch counts are tellable apart.
 */
function scoredRows(source) {
  return calculateCrapForSource(source, null).map((r) => ({
    ...r,
    file: 'lib/a.js',
    coverage: 1,
    crap: r.cyclomatic,
  }));
}

/** Compare `after` against a baseline taken from `before`; every new method violates. */
function compareSources(before, after) {
  return compareCrap({
    currentRows: scoredRows(after),
    baselineRows: scoredRows(before).map(({ file, method, crap }) => ({
      file,
      method,
      crap,
    })),
    newMethodCeiling: 0,
    tolerance: 0.001,
  });
}

const EFFECT_A = '  useEffect(() => (p.a ? 1 : 2));';
const EFFECT_B =
  '  useEffect(() => { if (p.b) return 1; if (p.c) return 2; return 3; });';
const effects = (...lines) => `function host(p) {\n${lines.join('\n')}\n}\n`;

describe('compareCrap — anonymous rows re-pair by stem and order', () => {
  it('AC-1: an inserted same-anchor or other-anchor closure is one new method, nothing else', () => {
    for (const inserted of [
      '  useEffect(() => (p.z ? 1 : 2));',
      '  other(() => (p.z ? 1 : 2));',
    ]) {
      const r = compareSources(
        effects(EFFECT_A, EFFECT_B),
        effects(inserted, EFFECT_A, EFFECT_B),
      );
      assert.strictEqual(r.newViolations, 1, inserted);
      assert.strictEqual(r.regressions, 0, inserted);
      assert.strictEqual(r.removed, 0, inserted);
    }
  });

  it('AC-2: removing a sibling is one removed row and no regression', () => {
    const r = compareSources(
      effects(EFFECT_B, EFFECT_A, EFFECT_B),
      effects(EFFECT_A, EFFECT_B),
    );
    assert.strictEqual(r.removed, 1);
    assert.strictEqual(r.regressions, 0);
    assert.strictEqual(r.newViolations, 0);
  });

  it('AC-3: reordered JSX handlers are re-keyed, not regressions', () => {
    const A = '      <button onClick={() => (p.a ? 1 : 2)} />';
    const B = [
      '      <button onClick={() => {',
      '        if (p.b) return 1;',
      '        if (p.c) return 2;',
      '        return 3;',
      '      }} />',
    ].join('\n');
    const panel = (...kids) =>
      `function Panel(p) {\n  return (\n    <div>\n${kids.join('\n')}\n    </div>\n  );\n}\n`;
    const r = compareSources(panel(A, B), panel(B, A));
    assert.strictEqual(r.regressions, 0);
    assert.strictEqual(r.newViolations, 0);
    assert.strictEqual(r.removed, 0);
    assert.strictEqual(r.drifted, 2);
  });

  it('AC-6: a real increase regresses against its own row in place, moved, or reordered', () => {
    const B2 =
      '  useEffect(() => { if (p.b) return 1; if (p.c) return 2; if (p.d) return 4; return 3; });';
    const cases = [
      effects(EFFECT_A, B2),
      effects('  // moved', '', EFFECT_A, B2),
      effects(B2, EFFECT_A),
    ];
    for (const after of cases) {
      const r = compareSources(effects(EFFECT_A, EFFECT_B), after);
      assert.strictEqual(r.regressions, 1, after);
      assert.strictEqual(r.violations[0].baseline, 3, after);
      assert.strictEqual(r.violations[0].crap, 4, after);
      assert.strictEqual(r.newViolations, 0, after);
      assert.strictEqual(r.removed, 0, after);
    }
  });

  it('AC-6: a sibling removed alongside an increase still regresses against the own row', () => {
    const grown =
      '  useEffect(() => { if (p.a) return 1; if (p.z) return 2; return 3; });';
    const r = compareSources(effects(EFFECT_A, EFFECT_B), effects(grown));
    assert.strictEqual(r.regressions, 1);
    assert.strictEqual(r.violations[0].baseline, 2);
    assert.strictEqual(r.removed, 1);
  });

  it('AC-12: re-keyed pairs reach the result and the human summary, never the --json envelope', (t) => {
    const lines = [];
    t.mock.method(console, 'log', (m) => lines.push(String(m)));
    const result = compareCrap({
      currentRows: [
        {
          file: 'lib/a.js',
          method: '<anon f()#0>',
          startLine: 1,
          cyclomatic: 3,
          coverage: 1,
          crap: 3,
        },
        {
          file: 'lib/a.js',
          method: '<anon f()#1>',
          startLine: 2,
          cyclomatic: 2,
          coverage: 1,
          crap: 2,
        },
      ],
      baselineRows: [
        { file: 'lib/a.js', method: '<anon f()#0>', crap: 2 },
        { file: 'lib/a.js', method: '<anon f()#1>', crap: 3 },
      ],
      newMethodCeiling: 30,
      tolerance: 0.001,
    });
    assert.strictEqual(result.drifted, 2);
    assert.strictEqual(result.regressions, 0);
    printSummaryHeader(result, {});
    assert.ok(lines.some((l) => /Re-keyed \(matched\):\s+2/.test(l)));
    const envelope = buildCrapReport({
      compareResult: result,
      scanSummary: {},
      kernelVersion: KERNEL_VERSION,
      escomplexVersion: '0.0.0',
      newMethodCeiling: 30,
      scopeInfo: { scope: 'full' },
    });
    assert.ok(!('rekeyed' in envelope.summary));
    assert.ok(loadValidator()(envelope));
  });
});

describe('compareCrap — named rows re-pair by stem and order', () => {
  const cb = (body) => `[1].map(function cb(v) { ${body} });`;
  const SMALL = cb('return v ? 1 : 2;');
  const BIG = cb('if (v) return 1; if (v > 2) return 2; return 3;');

  it('AC-2: an inserted earlier namesake is one new method; the later one re-pairs', () => {
    const r = compareSources(`${BIG}\n`, `${SMALL}\n${BIG}\n`);
    assert.strictEqual(r.newViolations, 1);
    assert.strictEqual(r.regressions, 0);
    assert.strictEqual(r.removed, 0);
    assert.strictEqual(r.drifted, 1);
  });

  it('AC-4: an increase is not hidden by a later namesake re-keyed onto its row', () => {
    const r = compareCrap({
      currentRows: [
        {
          file: 'a.js',
          method: 'run',
          startLine: 1,
          cyclomatic: 3,
          coverage: 0,
          crap: 12,
        },
        {
          file: 'a.js',
          method: 'run#1',
          startLine: 10,
          cyclomatic: 1,
          coverage: 1,
          crap: 1,
        },
      ],
      baselineRows: [{ file: 'a.js', method: 'run', crap: 1 }],
      newMethodCeiling: 30,
      tolerance: 0.001,
    });
    assert.strictEqual(r.regressions, 1);
    assert.strictEqual(r.violations[0].method, 'run');
    assert.strictEqual(r.violations[0].kind, 'regression');
    assert.strictEqual(r.drifted, 0);
    assert.strictEqual(r.newViolations + r.removed, 0);
  });

  it('AC-4: a named increase regresses against its own row after lines above move', () => {
    const r = compareSources(
      'function run(p) { return p ? 1 : 2; }\n',
      '// header\n\nfunction run(p) { if (p) return 1; if (p > 1) return 2; return 3; }\n',
    );
    assert.strictEqual(r.regressions, 1);
    assert.strictEqual(r.violations[0].kind, 'regression');
    assert.strictEqual(r.violations[0].baseline, 2);
    assert.strictEqual(r.violations[0].crap, 3);
    assert.strictEqual(r.newViolations + r.removed, 0);
  });
});

describe('AC-4: the migration is refused, not drift-paired', () => {
  it('bumps SCORING_SEMANTICS off the value the old rows were scored under', () => {
    assert.notStrictEqual(
      envelopeExtras().scoringSemantics,
      'coverage-join-v2',
      'rows keyed by the ordinal scheme must not claim the current semantics',
    );
  });

  it('AC-9: stamps method-identity-v5 and refuses a v4 rows[] baseline with the re-seed command', () => {
    assert.strictEqual(envelopeExtras().scoringSemantics, 'method-identity-v5');
    assert.ok(!('provenanceStamped' in envelopeExtras()));
    const message = assertBaselineCompatible({
      scoringSemantics: 'method-identity-v4',
      provenanceStamped: true,
      rows: [
        {
          path: 'lib/a.js',
          method: '<anon host/(x)#0>',
          anonymous: true,
          startLine: 1,
          crap: 1,
        },
      ],
    });
    assert.match(message, /scoring semantics changed/);
    assert.match(message, /crap:update -- --full-scope/);
  });

  it('refuses a baseline stamped with the previous semantics', () => {
    const message = assertBaselineCompatible({
      scoringSemantics: 'coverage-join-v2',
      provenanceStamped: true,
      rows: [{ path: 'lib/a.js', method: 'run', startLine: 1, crap: 1 }],
    });
    assert.match(message, /scoring semantics changed/);
    assert.match(message, /crap:update -- --full-scope/);
  });

  it('passes a fully migrated baseline', () => {
    assert.strictEqual(
      assertBaselineCompatible({
        scoringSemantics: envelopeExtras().scoringSemantics,
        rows: [
          { path: 'lib/a.js', method: '<anon host/(x)#0>', crap: 1 },
          { path: 'lib/a.js', method: 'named', crap: 1 },
        ],
      }),
      null,
    );
  });
});

describe('AC-5: the shipped baseline is the grouped, startLine-free layout', () => {
  const raw = () =>
    fs.readFileSync(path.resolve('baselines/crap.json'), 'utf-8');
  const baseline = () => JSON.parse(raw());

  it('validates against crap.schema.json', () => {
    const ajv = new Ajv({ allErrors: true, strict: false });
    ajv.addSchema(
      JSON.parse(fs.readFileSync(ENVELOPE_SCHEMA_PATH, 'utf-8')),
      'baseline-envelope.schema.json',
    );
    const validate = ajv.compile(
      JSON.parse(fs.readFileSync(BASELINE_SCHEMA_PATH, 'utf-8')),
    );
    assert.ok(
      validate(baseline()),
      `baselines/crap.json failed its schema: ${JSON.stringify(validate.errors?.slice(0, 4), null, 2)}`,
    );
  });

  it('states each path once and each method as one number, sorted', () => {
    const b = baseline();
    assert.ok(!('rows' in b) && !('provenanceStamped' in b));
    const paths = Object.keys(b.files);
    assert.deepStrictEqual(
      paths,
      [...paths].sort((x, y) => x.localeCompare(y)),
    );
    for (const p of paths) {
      const keys = Object.keys(b.files[p]);
      assert.deepStrictEqual(
        keys,
        [...keys].sort((x, y) => x.localeCompare(y)),
      );
      for (const k of keys) assert.strictEqual(typeof b.files[p][k], 'number');
    }
    assert.ok(!/"(startLine|coordinateSystem|anonymous)"/.test(raw()));
  });

  it('carries no ordinal-keyed row', () => {
    const ordinal = Object.entries(baseline().files).flatMap(([p, methods]) =>
      Object.keys(methods)
        .filter((m) => /^<anon method-\d+>$/.test(m))
        .map((m) => `${p}::${m}`),
    );
    assert.deepStrictEqual(ordinal, []);
  });
});

describe('crap:check against a baseline stamped ahead (#5991 AC-4/AC-5)', () => {
  /** A repo whose CRAP baseline is ahead, beside a coverage baseline. */
  function aheadRepo(coverageLines) {
    const root = makeTempDir('crap-ahead-');
    fs.mkdirSync(path.join(root, 'baselines'));
    fs.writeFileSync(
      path.join(root, '.agentrc.json'),
      JSON.stringify({
        project: {
          baseBranch: 'main',
          paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
        },
        delivery: {
          quality: {
            gates: {
              crap: { enabled: true },
              coverage: {
                enabled: true,
                floors: { '*': { lines: 90, branches: 0, functions: 0 } },
              },
            },
          },
        },
      }),
    );
    writeAheadCrapBaseline(path.join(root, 'baselines', 'crap.json'));
    fs.writeFileSync(
      path.join(root, 'baselines', 'coverage.json'),
      JSON.stringify({
        $schema: 'coverage.schema.json',
        kernelVersion: currentKernelVersion('coverage'),
        rows: [
          {
            path: 'src/a.js',
            lines: coverageLines,
            branches: 100,
            functions: 100,
          },
        ],
      }),
    );
    return root;
  }

  it('skips the CRAP gate visibly, naming both stamps and CI, and exits 0', async () => {
    const root = aheadRepo(95);
    try {
      const res = await runCheckBaselines({
        argv: ['--no-friction', '--format', 'text'],
        cwd: root,
      });
      assert.strictEqual(res.exitCode, 0);
      assert.deepStrictEqual(res.report.schemaErrors, []);
      assert.deepStrictEqual(
        res.report.skipped.map((s) => s.kind),
        ['crap'],
      );
      assert.deepStrictEqual(
        res.report.gates.map((g) => g.kind),
        ['coverage'],
      );
      assert.match(res.output, /SKIPPED \(crap\)/);
      assert.match(res.output, new RegExp(AHEAD_STAMP));
      assert.match(res.output, new RegExp(RUNNING_STAMP));
      assert.match(res.output, /CI/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('still checks every other kind', async () => {
    const root = aheadRepo(50);
    try {
      const res = await runCheckBaselines({
        argv: ['--no-friction'],
        cwd: root,
      });
      assert.notStrictEqual(res.exitCode, 0);
      assert.ok(res.report.totalBreaches > 0);
      assert.strictEqual(res.report.skipped.length, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('violation and removed-row lines name the baseline key, not a line', () => {
  const base = { file: 'lib/a.js', method: 'run', startLine: 7, cyclomatic: 2 };

  it('prints regression, drifted-regression and new-method lines', (t) => {
    const lines = [];
    t.mock.method(Logger, 'error', (m) => lines.push(String(m)));
    printViolation({
      ...base,
      kind: 'regression',
      crap: 4,
      baseline: 3,
      coverage: 0.5,
    });
    printViolation({
      ...base,
      kind: 'drifted-regression',
      baselineMethod: 'run#1',
      crap: 4,
      baseline: 3,
      coverage: 0.5,
    });
    printViolation({
      ...base,
      kind: 'new',
      crap: 40,
      ceiling: 30,
      coverage: 0,
    });
    assert.match(lines[0], /REGRESSION: lib\/a\.js::run \(line 7\)/);
    assert.match(lines[2], /baseline key run#1/);
    assert.match(lines[4], /NEW-METHOD over ceiling: lib\/a\.js::run/);
  });

  it('lists removed rows by path::method and is silent when none', (t) => {
    const lines = [];
    t.mock.method(Logger, 'info', (m) => lines.push(String(m)));
    printRemovedRows({ removed: 0, removedRows: [] });
    assert.equal(lines.length, 0);
    printRemovedRows({
      removed: 1,
      removedRows: [{ file: 'lib/a.js', method: 'run' }],
    });
    assert.match(lines[1], /- lib\/a\.js::run$/);
  });
});

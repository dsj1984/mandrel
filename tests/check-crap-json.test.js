import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import Ajv from 'ajv';
import {
  buildCrapReport,
  compareCrap,
} from '../.agents/scripts/lib/baselines/kinds/crap.js';
import { crapFormula } from '../.agents/scripts/lib/crap-engine.js';
import { KERNEL_VERSION } from '../.agents/scripts/lib/crap-utils.js';

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
  const baseline = [makeBaselineRow({ startLine: 10, crap: 4 })];
  const current = [
    makeRegressionRow({
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

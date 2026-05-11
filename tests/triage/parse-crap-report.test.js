import assert from 'node:assert';
import { test } from 'node:test';
import {
  compareViolationsDesc,
  isCrapEnvelope,
  parseCrapEnvelope,
  parseCrapReport,
  topRegressions,
} from '../../.agents/scripts/lib/triage/parse-crap-report.js';

/**
 * parse-crap-report unit tests.
 *
 * Locks the contract:
 *   - Validate envelope shape just enough to render safely
 *   - Top-N selection by CRAP score descending with deterministic tie-break
 *   - Pure: same input → same output across runs (idempotency precondition)
 *   - Non-JSON, wrong shape, and non-string inputs throw with named errors
 */

function makeViolation(overrides = {}) {
  return {
    file: 'lib/x.js',
    method: 'fn',
    startLine: 10,
    cyclomatic: 8,
    coverage: 0.5,
    crap: 20,
    baseline: 15,
    ceiling: 30,
    kind: 'regression',
    fixGuidance: null,
    ...overrides,
  };
}

function makeEnvelope(violations = []) {
  return {
    kernelVersion: '1.2.3',
    escomplexVersion: '7.3.2',
    summary: {
      total: violations.length,
      regressions: violations.length,
      newViolations: 0,
      drifted: 0,
      removed: 0,
      skippedNoCoverage: 0,
    },
    violations,
  };
}

test('isCrapEnvelope — accepts a minimal valid envelope', () => {
  assert.strictEqual(isCrapEnvelope(makeEnvelope()), true);
});

test('isCrapEnvelope — rejects missing kernelVersion', () => {
  const env = makeEnvelope();
  delete env.kernelVersion;
  assert.strictEqual(isCrapEnvelope(env), false);
});

test('isCrapEnvelope — rejects unknown violation kind', () => {
  const env = makeEnvelope([makeViolation({ kind: 'invalid' })]);
  assert.strictEqual(isCrapEnvelope(env), false);
});

test('isCrapEnvelope — rejects non-object input', () => {
  assert.strictEqual(isCrapEnvelope(null), false);
  assert.strictEqual(isCrapEnvelope('string'), false);
  assert.strictEqual(isCrapEnvelope(42), false);
});

test('parseCrapEnvelope — throws on non-string input', () => {
  assert.throws(() => parseCrapEnvelope({}), TypeError);
});

test('parseCrapEnvelope — throws on invalid JSON, naming the source', () => {
  assert.throws(
    () => parseCrapEnvelope('{not json', { source: 'fixture.json' }),
    /fixture\.json is not valid JSON/,
  );
});

test('parseCrapEnvelope — throws on wrong shape, naming the source', () => {
  assert.throws(
    () => parseCrapEnvelope(JSON.stringify({}), { source: 'bad.json' }),
    /bad\.json does not match the CrapReport envelope shape/,
  );
});

test('compareViolationsDesc — higher CRAP sorts first', () => {
  const a = makeViolation({ crap: 30 });
  const b = makeViolation({ crap: 50 });
  assert.ok(compareViolationsDesc(a, b) > 0);
  assert.ok(compareViolationsDesc(b, a) < 0);
});

test('compareViolationsDesc — ties broken by file then method then line', () => {
  // Same CRAP score — must order deterministically.
  const a = makeViolation({
    crap: 25,
    file: 'a.js',
    method: 'foo',
    startLine: 5,
  });
  const b = makeViolation({
    crap: 25,
    file: 'a.js',
    method: 'foo',
    startLine: 10,
  });
  const c = makeViolation({
    crap: 25,
    file: 'a.js',
    method: 'bar',
    startLine: 1,
  });
  const d = makeViolation({
    crap: 25,
    file: 'b.js',
    method: 'aa',
    startLine: 1,
  });
  const sorted = [a, b, c, d].sort(compareViolationsDesc);
  assert.deepStrictEqual(
    sorted.map((v) => `${v.file}:${v.method}:${v.startLine}`),
    ['a.js:bar:1', 'a.js:foo:5', 'a.js:foo:10', 'b.js:aa:1'],
  );
});

test('topRegressions — returns up to N highest scores', () => {
  const env = makeEnvelope([
    makeViolation({ crap: 10, file: 'a.js' }),
    makeViolation({ crap: 50, file: 'b.js' }),
    makeViolation({ crap: 30, file: 'c.js' }),
    makeViolation({ crap: 20, file: 'd.js' }),
    makeViolation({ crap: 40, file: 'e.js' }),
    makeViolation({ crap: 5, file: 'f.js' }),
    makeViolation({ crap: 25, file: 'g.js' }),
  ]);
  const top = topRegressions(env, { top: 5 });
  assert.deepStrictEqual(
    top.map((v) => v.crap),
    [50, 40, 30, 25, 20],
  );
});

test('topRegressions — defaults to 5', () => {
  const env = makeEnvelope(
    Array.from({ length: 8 }, (_, i) => makeViolation({ crap: i + 1 })),
  );
  assert.strictEqual(topRegressions(env).length, 5);
});

test('topRegressions — top<=0 returns empty', () => {
  const env = makeEnvelope([makeViolation()]);
  assert.deepStrictEqual(topRegressions(env, { top: 0 }), []);
  assert.deepStrictEqual(topRegressions(env, { top: -1 }), []);
});

test('topRegressions — rejects invalid envelope', () => {
  assert.throws(() => topRegressions({}, { top: 5 }), TypeError);
});

test('topRegressions — tie-break determinism (idempotency contract)', () => {
  // Three violations with identical CRAP score; tie-break must be stable
  // across re-runs so the rendered comment body is byte-identical, which
  // is what makes PATCH (vs POST) idempotent for the workflow.
  const env = makeEnvelope([
    makeViolation({ crap: 42, file: 'lib/z.js', method: 'foo', startLine: 5 }),
    makeViolation({ crap: 42, file: 'lib/a.js', method: 'bar', startLine: 1 }),
    makeViolation({ crap: 42, file: 'lib/m.js', method: 'baz', startLine: 9 }),
  ]);

  const first = topRegressions(env, { top: 3 });
  const second = topRegressions(env, { top: 3 });
  // Same envelope, two calls → identical ordering.
  assert.deepStrictEqual(
    first.map((v) => `${v.file}:${v.method}:${v.startLine}`),
    second.map((v) => `${v.file}:${v.method}:${v.startLine}`),
  );
  assert.deepStrictEqual(
    first.map((v) => v.file),
    ['lib/a.js', 'lib/m.js', 'lib/z.js'],
  );
});

test('parseCrapReport — end-to-end happy path returns envelope + top', () => {
  const env = makeEnvelope([makeViolation({ crap: 99 })]);
  const result = parseCrapReport(JSON.stringify(env));
  assert.strictEqual(result.envelope.kernelVersion, '1.2.3');
  assert.strictEqual(result.top.length, 1);
  assert.strictEqual(result.top[0].crap, 99);
});

test('parseCrapReport — missing crap-report.json class: source string surfaces in error', () => {
  // The acceptance criterion "exits non-zero on missing artifacts" is
  // handled by the workflow-level wrapper (triage-ci-failure.js throws
  // when ARTIFACTS_DIR is absent); the parser-level contract is that an
  // unreadable artifact passed through still fails loudly with the source
  // path embedded in the message so the workflow log is debuggable.
  assert.throws(
    () =>
      parseCrapReport('null', {
        source: 'artifacts/crap-report-ubuntu/crap-report.json',
      }),
    /artifacts[\\/]+crap-report-ubuntu[\\/]+crap-report\.json/,
  );
});

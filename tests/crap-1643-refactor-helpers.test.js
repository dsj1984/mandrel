import assert from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  printRemovedRows,
  printSummaryHeader,
  printViolation,
} from '../.agents/scripts/check-crap.js';
import {
  classifyParsedReturn,
  countDoneStories,
  resolveConcurrencyCap,
  selectInputFlag,
  validateEpicWave,
  validateResultsReturnsXor,
  validateReturnsEntry,
} from '../.agents/scripts/epic-execute-record-wave.js';
import {
  hasDegraded,
  hasImproved,
  loadBaselineWithFallback,
} from '../.agents/scripts/lint-baseline.js';
import {
  classifyGithubError,
  extractErrorFields,
  isPermissionSignal,
  isTransientByCodeOrMessage,
  isTransientStatus,
} from '../.agents/scripts/providers/github.js';

/**
 * Unit tests for the helpers extracted in Story #1643 / Task #1647 to drive
 * every CRAP > 20 method back under the 20 ceiling. Each helper is pure
 * (or Logger-only) so the assertions stay shape-focused.
 */

// ---------------------------------------------------------------------------
// providers/github.js — classifyGithubError + extracted predicates
// ---------------------------------------------------------------------------
test('extractErrorFields normalizes Error / plain object / non-Error shapes', () => {
  assert.deepStrictEqual(extractErrorFields(new Error('Boom')), {
    lower: 'boom',
    status: undefined,
    code: undefined,
  });
  assert.deepStrictEqual(
    extractErrorFields({ message: 'Forbidden', status: 403, code: 'X' }),
    { lower: 'forbidden', status: 403, code: 'X' },
  );
  // String(err) routes through `err.toString()` for objects lacking `.message`.
  const stringy = extractErrorFields({ toString: () => 'fallback' });
  assert.strictEqual(stringy.lower, 'fallback');
});

test('isTransientStatus flags 429 and 5xx, nothing else', () => {
  assert.strictEqual(isTransientStatus(429), true);
  assert.strictEqual(isTransientStatus(500), true);
  assert.strictEqual(isTransientStatus(599), true);
  assert.strictEqual(isTransientStatus(404), false);
  assert.strictEqual(isTransientStatus(undefined), false);
});

test('isTransientByCodeOrMessage catches ECONNRESET and rate-limit text', () => {
  assert.strictEqual(isTransientByCodeOrMessage('ECONNRESET', ''), true);
  assert.strictEqual(
    isTransientByCodeOrMessage(undefined, 'secondary rate limit hit'),
    true,
  );
  assert.strictEqual(isTransientByCodeOrMessage(undefined, 'all good'), false);
});

test('isPermissionSignal flags 401/403 and permission-keyword messages', () => {
  assert.strictEqual(isPermissionSignal(401, ''), true);
  assert.strictEqual(isPermissionSignal(403, ''), true);
  assert.strictEqual(isPermissionSignal(undefined, 'unauthorized'), true);
  assert.strictEqual(isPermissionSignal(200, 'ok'), false);
});

test('classifyGithubError routes through each bucket deterministically', () => {
  assert.strictEqual(classifyGithubError(null), 'permanent');
  assert.strictEqual(
    classifyGithubError(new Error('feature not available')),
    'feature-disabled',
  );
  assert.strictEqual(
    classifyGithubError({ message: 'try again', status: 503 }),
    'transient',
  );
  assert.strictEqual(
    classifyGithubError({ message: 'no', code: 'ETIMEDOUT' }),
    'transient',
  );
  assert.strictEqual(
    classifyGithubError({ message: 'fetch failed' }),
    'transient',
  );
  assert.strictEqual(
    classifyGithubError({ message: 'Unauthorized', status: 401 }),
    'permission',
  );
  assert.strictEqual(
    classifyGithubError({ message: 'permission denied' }),
    'permission',
  );
  assert.strictEqual(
    classifyGithubError({ message: 'something else' }),
    'permanent',
  );
  // Rate-limit-via-403 must NOT be classified as permission — it's transient.
  assert.strictEqual(
    classifyGithubError({ message: 'secondary rate limit', status: 403 }),
    'transient',
  );
});

// ---------------------------------------------------------------------------
// check-crap.js — printSummary helpers (Logger-only side effects)
// ---------------------------------------------------------------------------
test('printSummaryHeader, printViolation, printRemovedRows run without throwing', () => {
  // Logger is best-effort here; we assert the helpers never throw on the
  // canonical shapes and accept absent-summary inputs.
  printSummaryHeader(
    { total: 1, regressions: 0, newViolations: 0, drifted: 0, removed: 0 },
    { skippedFilesNoCoverage: 1 },
  );
  printSummaryHeader(
    { total: 0, regressions: 0, newViolations: 0, drifted: 0, removed: 0 },
    {},
  );
  printViolation({
    kind: 'new',
    file: 'a.js',
    method: 'f',
    startLine: 1,
    crap: 30,
    ceiling: 20,
    cyclomatic: 5,
    coverage: 0,
  });
  printViolation({
    kind: 'regression',
    file: 'a.js',
    method: 'f',
    startLine: 1,
    crap: 30,
    baseline: 5,
    cyclomatic: 5,
    coverage: 0.1,
  });
  printViolation({
    kind: 'drifted-regression',
    file: 'a.js',
    method: 'f',
    startLine: 12,
    baselineStartLine: 10,
    crap: 30,
    baseline: 5,
    cyclomatic: 5,
    coverage: 0.1,
  });
  printRemovedRows({ removed: 0, removedRows: [] });
  printRemovedRows({
    removed: 1,
    removedRows: [{ file: 'a.js', method: 'g', startLine: 9 }],
  });
});

// ---------------------------------------------------------------------------
// lint-baseline.js — degraded/improved predicates + fallback loader
// ---------------------------------------------------------------------------
test('hasDegraded fires when either count exceeds baseline', () => {
  assert.strictEqual(
    hasDegraded(
      { errorCount: 1, warningCount: 0 },
      { errorCount: 0, warningCount: 0 },
    ),
    true,
  );
  assert.strictEqual(
    hasDegraded(
      { errorCount: 0, warningCount: 5 },
      { errorCount: 0, warningCount: 4 },
    ),
    true,
  );
  assert.strictEqual(
    hasDegraded(
      { errorCount: 0, warningCount: 0 },
      { errorCount: 0, warningCount: 0 },
    ),
    false,
  );
});

test('hasImproved fires when either count is strictly lower than baseline', () => {
  assert.strictEqual(
    hasImproved(
      { errorCount: 0, warningCount: 0 },
      { errorCount: 1, warningCount: 0 },
    ),
    true,
  );
  assert.strictEqual(
    hasImproved(
      { errorCount: 0, warningCount: 3 },
      { errorCount: 0, warningCount: 4 },
    ),
    true,
  );
  assert.strictEqual(
    hasImproved(
      { errorCount: 0, warningCount: 0 },
      { errorCount: 0, warningCount: 0 },
    ),
    false,
  );
});

// ---------------------------------------------------------------------------
// epic-execute-record-wave.js — extracted validators / classifiers / counters
// ---------------------------------------------------------------------------
test('validateEpicWave accepts positive epicId + non-negative wave', () => {
  validateEpicWave(1, 0);
  validateEpicWave(42, 7);
  assert.throws(() => validateEpicWave(0, 0), TypeError);
  assert.throws(() => validateEpicWave(1.5, 0), TypeError);
  assert.throws(() => validateEpicWave(1, -1), TypeError);
  assert.throws(() => validateEpicWave(1, 'x'), TypeError);
});

test('validateResultsReturnsXor enforces exactly-one', () => {
  validateResultsReturnsXor([], null);
  validateResultsReturnsXor(null, []);
  assert.throws(() => validateResultsReturnsXor(null, null), TypeError);
  assert.throws(() => validateResultsReturnsXor([], []), TypeError);
});

test('resolveConcurrencyCap respects override and rejects non-positive ints', () => {
  // Override beats every other source.
  assert.strictEqual(resolveConcurrencyCap(5, {}, { concurrencyCap: 3 }), 5);
  // Checkpoint value takes effect when override is omitted.
  assert.strictEqual(
    resolveConcurrencyCap(undefined, { concurrencyCap: 3 }, {}),
    3,
  );
  // Zero / negative / non-integer override → RangeError.
  assert.throws(() => resolveConcurrencyCap(0, {}, {}), RangeError);
  assert.throws(() => resolveConcurrencyCap(-1, {}, {}), RangeError);
  assert.throws(() => resolveConcurrencyCap(1.5, {}, {}), RangeError);
});

test('validateReturnsEntry normalizes returnText to a string', () => {
  assert.deepStrictEqual(
    validateReturnsEntry({ storyId: 5, returnText: 'hi' }, 0),
    { storyId: 5, returnText: 'hi' },
  );
  assert.deepStrictEqual(validateReturnsEntry({ id: 7, returnText: null }, 1), {
    storyId: 7,
    returnText: '',
  });
  assert.deepStrictEqual(
    validateReturnsEntry({ id: 9, returnText: { a: 1 } }, 2),
    { storyId: 9, returnText: '{"a":1}' },
  );
  assert.throws(() => validateReturnsEntry(null, 0), TypeError);
  assert.throws(() => validateReturnsEntry({ id: 0 }, 0), TypeError);
});

test('classifyParsedReturn flags storyId mismatch as a parse failure', () => {
  assert.deepStrictEqual(
    classifyParsedReturn({ ok: true, value: { storyId: 5 } }, 5),
    { ok: true, value: { storyId: 5 } },
  );
  const mismatch = classifyParsedReturn({ ok: true, value: { storyId: 6 } }, 5);
  assert.strictEqual(mismatch.ok, false);
  assert.match(mismatch.error, /disagrees with expected 5/);
  assert.deepStrictEqual(
    classifyParsedReturn({ ok: false, error: 'bad json' }, 5),
    { ok: false, error: 'bad json' },
  );
});

test('selectInputFlag enforces XOR contract between --results and --returns', () => {
  assert.strictEqual(selectInputFlag(true, false), 'results');
  assert.strictEqual(selectInputFlag(false, true), 'returns');
  assert.throws(() => selectInputFlag(true, true), TypeError);
  assert.throws(() => selectInputFlag(false, false), TypeError);
});

test('countDoneStories sums "done" rows across recorded waves only', () => {
  assert.strictEqual(countDoneStories([]), 0);
  assert.strictEqual(
    countDoneStories([
      { stories: [{ state: 'done' }, { state: 'blocked' }] },
      { stories: [{ state: 'done' }] },
    ]),
    2,
  );
  // Tolerate non-array `stories` fields without throwing.
  assert.strictEqual(
    countDoneStories([{ stories: 'oops' }, { stories: undefined }]),
    0,
  );
});

// ---------------------------------------------------------------------------
// lint-baseline.js — loadBaselineWithFallback uses an empty shape on
// BaselineNotFoundError, surfacing baselineHasByFile=false.
// ---------------------------------------------------------------------------
test('loadBaselineWithFallback returns empty baseline when path missing (with byFile)', () => {
  const result = loadBaselineWithFallback({
    baselinePath: '/definitely/not/here.json',
    baselinePathRel: 'definitely/not/here.json',
    includeByFile: true,
  });
  assert.deepStrictEqual(result.baseline, {
    errorCount: 0,
    warningCount: 0,
    byFile: {},
  });
  assert.strictEqual(result.baselineHasByFile, false);
});

test('loadBaselineWithFallback returns flat empty baseline when includeByFile=false', () => {
  const result = loadBaselineWithFallback({
    baselinePath: '/definitely/not/here.json',
    baselinePathRel: 'definitely/not/here.json',
    includeByFile: false,
  });
  assert.deepStrictEqual(result.baseline, { errorCount: 0, warningCount: 0 });
  assert.strictEqual(result.baselineHasByFile, false);
});

test('loadBaselineWithFallback surfaces byFile when present on a real baseline', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lint-baseline-1643-'));
  const baselinePath = path.join(dir, 'baseline.json');
  writeFileSync(
    baselinePath,
    JSON.stringify({
      errorCount: 2,
      warningCount: 1,
      byFile: { 'a.js': { errorCount: 2, warningCount: 1, rules: {} } },
    }),
  );
  const result = loadBaselineWithFallback({
    baselinePath,
    baselinePathRel: baselinePath,
    includeByFile: true,
  });
  assert.strictEqual(result.baseline.errorCount, 2);
  assert.strictEqual(result.baselineHasByFile, true);
});

test('loadBaselineWithFallback marks baselineHasByFile=false when includeByFile=false even on a populated baseline', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lint-baseline-1643-'));
  const baselinePath = path.join(dir, 'baseline.json');
  writeFileSync(
    baselinePath,
    JSON.stringify({ errorCount: 0, warningCount: 0, byFile: {} }),
  );
  const result = loadBaselineWithFallback({
    baselinePath,
    baselinePathRel: baselinePath,
    includeByFile: false,
  });
  assert.strictEqual(result.baselineHasByFile, false);
});

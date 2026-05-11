import assert from 'node:assert';
import { test } from 'node:test';
import {
  CLASS_PRIORITY,
  classifyBuffer,
  classifyLine,
  detectFailureClass,
  FIXABLE_CLASSES,
} from '../../.agents/scripts/lib/auto-fix/detect-failure-class.js';

/**
 * class-detection tests for the s4-auto-fix workflow.
 *
 * Locks the failure-class decision tree against real-shaped fixture
 * snippets — each fixture mimics a `test-output.txt` artifact the CI/CD
 * workflow uploads on failure. The detector must classify each into the
 * expected single class (the highest-priority signal observed across the
 * matrix legs).
 *
 * Coverage map (per Task #1257 acceptance):
 *
 *   - lint-only          → 'lint'    fixable
 *   - format-only        → 'format'  fixable
 *   - mixed lint+coverage→ 'coverage' NOT fixable (coverage wins)
 *   - coverage-only      → 'coverage' NOT fixable
 *   - CRAP-only          → 'crap'    NOT fixable
 *   - maintainability    → 'maintainability' NOT fixable
 *   - test-only          → 'test'    NOT fixable
 *
 * The detector also surfaces 'unknown' for empty/unrecognised buffers;
 * the once-per-pr.test.js covers that the workflow bails on it.
 */

/** Sample buffer: biome lint diagnostics only. */
const LINT_ONLY = [
  '> agent-protocols@5.40.0 test',
  '> node --test --experimental-test-coverage',
  '',
  './foo.js:10:1 lint/correctness/noUnusedVars FIXABLE  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  '  i Variable "x" is unused.',
  '',
  'Biome check found 3 errors',
].join('\n');

/** Sample buffer: biome formatter complaints only. */
const FORMAT_ONLY = [
  './bar.js  Formatter would have made changes.',
  '  - import   { foo } from "./foo.js";',
  '  + import { foo } from "./foo.js";',
  '',
  'Found 2 unformatted files.',
].join('\n');

/** Sample buffer: lint + coverage. Coverage is the non-fixable class so
 *  the verdict must be 'coverage', not 'lint'. */
const MIXED_LINT_AND_COVERAGE = [
  './foo.js:10:1 lint/correctness/noUnusedVars FIXABLE',
  'Biome check found 1 error',
  '',
  '# tests 12',
  '# pass 10',
  '# fail 0',
  '',
  'ERROR: Coverage threshold for lines (80%) not met: 76.3%',
].join('\n');

/** Sample buffer: coverage gate failure only. */
const COVERAGE_ONLY = [
  '# tests 100',
  '# pass 100',
  'ERROR: Coverage threshold for branches (75%) not met: 72.1%',
].join('\n');

/** Sample buffer: CRAP regression banner from check-crap.js. */
const CRAP_ONLY = [
  '[check-crap] Comparing crap-report.json against baseline...',
  '[check-crap] ✗ CRAP regression in lib/foo.js#doWork: 32.5 > ceiling 30',
  '[check-crap] FAIL — 1 regression(s), 0 new violations',
].join('\n');

/** Sample buffer: maintainability regression banner. */
const MAINTAINABILITY_ONLY = [
  '[check-maintainability] Comparing maintainability-report.json...',
  '[check-maintainability] ✗ Maintainability regression in lib/bar.js: 41 < baseline 65',
  '[check-maintainability] FAIL',
].join('\n');

/** Sample buffer: a single failed node:test assertion. */
const TEST_ONLY = [
  '▶ buildCommitSubject',
  '  ✔ accepts conventional types (1.234ms)',
  '  ✖ rejects empty title (2.345ms)',
  '    AssertionError: Expected error to be thrown',
  '',
  'not ok 7 - rejects empty title',
  '# fail 1',
].join('\n');

/** Sample buffer: artifact present but with no marker the detector
 *  recognises (e.g. a stray pre-test setup message). */
const UNKNOWN_BUFFER = [
  'Installing project dependencies...',
  'Bootstrap complete.',
  'Cleaning artifact cache.',
].join('\n');

test('classifyLine — recognises a lint diagnostic header', () => {
  assert.strictEqual(
    classifyLine('./foo.js:10:1 lint/correctness/noUnusedVars FIXABLE'),
    'lint',
  );
});

test('classifyLine — recognises a format diff header', () => {
  assert.strictEqual(
    classifyLine('Formatter would have made changes.'),
    'format',
  );
});

test('classifyLine — recognises a coverage gate failure', () => {
  assert.strictEqual(
    classifyLine('ERROR: Coverage threshold for lines (80%) not met: 76.3%'),
    'coverage',
  );
});

test('classifyLine — recognises a CRAP regression banner', () => {
  assert.strictEqual(
    classifyLine(
      '[check-crap] ✗ CRAP regression in lib/foo.js#doWork: 32.5 > ceiling 30',
    ),
    'crap',
  );
});

test('classifyLine — recognises a maintainability regression banner', () => {
  assert.strictEqual(
    classifyLine(
      '[check-maintainability] ✗ Maintainability regression in lib/bar.js: 41 < baseline 65',
    ),
    'maintainability',
  );
});

test('classifyLine — recognises a TAP not-ok line', () => {
  assert.strictEqual(classifyLine('not ok 7 - rejects empty title'), 'test');
});

test('classifyLine — empty / whitespace lines return null', () => {
  assert.strictEqual(classifyLine(''), null);
  assert.strictEqual(classifyLine('   '), null);
});

test('classifyLine — non-string input returns null', () => {
  assert.strictEqual(classifyLine(undefined), null);
  assert.strictEqual(classifyLine(null), null);
  assert.strictEqual(classifyLine(123), null);
});

test('classifyBuffer — lint-only fixture classifies as lint', () => {
  const { class: cls } = classifyBuffer(LINT_ONLY);
  assert.strictEqual(cls, 'lint');
});

test('classifyBuffer — format-only fixture classifies as format', () => {
  const { class: cls } = classifyBuffer(FORMAT_ONLY);
  assert.strictEqual(cls, 'format');
});

test('classifyBuffer — coverage-only fixture classifies as coverage', () => {
  const { class: cls } = classifyBuffer(COVERAGE_ONLY);
  assert.strictEqual(cls, 'coverage');
});

test('classifyBuffer — crap-only fixture classifies as crap', () => {
  const { class: cls } = classifyBuffer(CRAP_ONLY);
  assert.strictEqual(cls, 'crap');
});

test('classifyBuffer — maintainability-only fixture classifies as maintainability', () => {
  const { class: cls } = classifyBuffer(MAINTAINABILITY_ONLY);
  assert.strictEqual(cls, 'maintainability');
});

test('classifyBuffer — test-only fixture classifies as test', () => {
  const { class: cls } = classifyBuffer(TEST_ONLY);
  assert.strictEqual(cls, 'test');
});

test('classifyBuffer — mixed lint+coverage classifies as coverage (non-fixable wins)', () => {
  const { class: cls, lineCounts } = classifyBuffer(MIXED_LINT_AND_COVERAGE);
  // Coverage has higher priority than lint, so the verdict is coverage
  // even though a lint diagnostic is present.
  assert.strictEqual(cls, 'coverage');
  // Both classes still got counted in lineCounts so the breakdown is
  // accurate for downstream comment rendering.
  assert.ok(lineCounts.lint > 0);
  assert.ok(lineCounts.coverage > 0);
});

test('classifyBuffer — unrecognised buffer classifies as unknown', () => {
  const { class: cls } = classifyBuffer(UNKNOWN_BUFFER);
  assert.strictEqual(cls, 'unknown');
});

test('classifyBuffer — non-string input returns unknown', () => {
  assert.strictEqual(classifyBuffer(undefined).class, 'unknown');
  assert.strictEqual(classifyBuffer(null).class, 'unknown');
});

test('classifyBuffer — CRLF buffers are normalised', () => {
  const crlf = LINT_ONLY.replace(/\n/g, '\r\n');
  assert.strictEqual(classifyBuffer(crlf).class, 'lint');
});

test('detectFailureClass — single lint-only leg verdict is lint+fixable', () => {
  const v = detectFailureClass([{ os: 'ubuntu', raw: LINT_ONLY }]);
  assert.strictEqual(v.class, 'lint');
  assert.strictEqual(v.fixable, true);
  assert.deepStrictEqual(v.perLeg, [{ os: 'ubuntu', class: 'lint' }]);
});

test('detectFailureClass — single format-only leg verdict is format+fixable', () => {
  const v = detectFailureClass([{ os: 'ubuntu', raw: FORMAT_ONLY }]);
  assert.strictEqual(v.class, 'format');
  assert.strictEqual(v.fixable, true);
});

test('detectFailureClass — mixed lint+coverage in same leg verdict is coverage+not-fixable', () => {
  const v = detectFailureClass([
    { os: 'ubuntu', raw: MIXED_LINT_AND_COVERAGE },
  ]);
  assert.strictEqual(v.class, 'coverage');
  assert.strictEqual(v.fixable, false);
});

test('detectFailureClass — lint on ubuntu + coverage on windows verdict is coverage+not-fixable', () => {
  // Cross-leg priority: even though one leg is purely fixable, the
  // non-fixable leg's class wins, because we cannot ship a green build
  // without fixing the coverage gap on Windows too.
  const v = detectFailureClass([
    { os: 'ubuntu', raw: LINT_ONLY },
    { os: 'windows', raw: COVERAGE_ONLY },
  ]);
  assert.strictEqual(v.class, 'coverage');
  assert.strictEqual(v.fixable, false);
});

test('detectFailureClass — crap-only verdict is crap+not-fixable', () => {
  const v = detectFailureClass([{ os: 'ubuntu', raw: CRAP_ONLY }]);
  assert.strictEqual(v.class, 'crap');
  assert.strictEqual(v.fixable, false);
});

test('detectFailureClass — maintainability-only verdict is maintainability+not-fixable', () => {
  const v = detectFailureClass([{ os: 'ubuntu', raw: MAINTAINABILITY_ONLY }]);
  assert.strictEqual(v.class, 'maintainability');
  assert.strictEqual(v.fixable, false);
});

test('detectFailureClass — test-only verdict is test+not-fixable', () => {
  const v = detectFailureClass([{ os: 'ubuntu', raw: TEST_ONLY }]);
  assert.strictEqual(v.class, 'test');
  assert.strictEqual(v.fixable, false);
});

test('detectFailureClass — empty list verdict is unknown+not-fixable', () => {
  const v = detectFailureClass([]);
  assert.strictEqual(v.class, 'unknown');
  assert.strictEqual(v.fixable, false);
  assert.deepStrictEqual(v.perLeg, []);
});

test('detectFailureClass — non-array input verdict is unknown+not-fixable', () => {
  assert.strictEqual(detectFailureClass(null).class, 'unknown');
  assert.strictEqual(detectFailureClass(undefined).class, 'unknown');
});

test('detectFailureClass — any unknown leg forces verdict to unknown', () => {
  // Even if the other leg is cleanly lint-fixable, an unknown leg
  // signals config drift and the workflow must bail rather than push.
  const v = detectFailureClass([
    { os: 'ubuntu', raw: LINT_ONLY },
    { os: 'windows', raw: UNKNOWN_BUFFER },
  ]);
  assert.strictEqual(v.class, 'unknown');
  assert.strictEqual(v.fixable, false);
});

test('FIXABLE_CLASSES — only lint and format are auto-fixable', () => {
  assert.ok(FIXABLE_CLASSES.has('lint'));
  assert.ok(FIXABLE_CLASSES.has('format'));
  assert.strictEqual(FIXABLE_CLASSES.has('test'), false);
  assert.strictEqual(FIXABLE_CLASSES.has('coverage'), false);
  assert.strictEqual(FIXABLE_CLASSES.has('crap'), false);
  assert.strictEqual(FIXABLE_CLASSES.has('maintainability'), false);
  assert.strictEqual(FIXABLE_CLASSES.has('unknown'), false);
});

test('CLASS_PRIORITY — non-fixable classes outrank fixable ones', () => {
  // The order is load-bearing for the verdict logic. Keep this assertion
  // tight against the documented contract.
  assert.deepStrictEqual(CLASS_PRIORITY, [
    'format',
    'lint',
    'test',
    'coverage',
    'crap',
    'maintainability',
  ]);
});

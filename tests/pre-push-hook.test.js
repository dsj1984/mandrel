/**
 * tests/pre-push-hook.test.js — the `.husky/pre-push` contract.
 *
 * Story #2745 set the hook's shape (diff-scoped preview, no full lint).
 * Story #5356 pinned the one ordering the shape did not fix: coverage is
 * captured BEFORE the CRAP/MI preview scores it. Both halves live here —
 * the static reading of the hook, and the behavioural pair that shows what
 * the ordering buys and that the capture *skip* path stays sound.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { computeCrapPreviewScan } from '../.agents/scripts/lib/baselines/crap-preview-scan.js';
import { makeTempDir } from '../.agents/scripts/lib/test-temp.js';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

function readPrePush() {
  return fs.readFileSync(path.join(REPO_ROOT, '.husky', 'pre-push'), 'utf8');
}

/**
 * The hook's executable lines — every line that is neither blank nor a
 * comment, in source order. Comments and the shebang both start with `#`.
 *
 * @param {string} hook
 * @returns {string[]}
 */
function steps(hook) {
  return hook
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

test('pre-push — diff-scoped preview + coverage/CRAP ratchet, not full lint', () => {
  const hook = readPrePush();
  assert.doesNotMatch(hook, /npm run lint\b/);
  assert.doesNotMatch(hook, /maintainability:check/);
  assert.match(hook, /quality-preview\.js/);
  assert.match(hook, /--changed-since\s+origin\/main/);
  assert.match(hook, /coverage-capture\.js\s+--skip-when-no-crap-files/);
  assert.match(hook, /coverage-capture\.js[^\n]*--ref\s+origin\/main/);
  assert.match(hook, /npm run crap:check/);
  const captureIdx = hook.indexOf('coverage-capture.js');
  const crapIdx = hook.indexOf('npm run crap:check');
  assert.ok(
    captureIdx > -1 && crapIdx > captureIdx,
    'crap:check must run after coverage-capture',
  );
});

test('pre-push — documents npm run verify for the full local gate', () => {
  const hook = readPrePush();
  assert.match(hook, /npm run verify/);
  assert.match(hook, /CI/i);
});

test('pre-push — optional audit remains opt-in via PREPUSH_AUDIT', () => {
  const hook = readPrePush();
  assert.match(hook, /PREPUSH_AUDIT/);
  assert.match(hook, /npm audit --audit-level=high/);
});

// Story #4545 — the coverage + CRAP gate is unconditional. The Epic-era
// STORY_CLOSE_RECOVERY escape hatch required an `epic/<id>` ref to open, so
// it could never fire under the Story-only model; it and the per-push helper
// spawn that evaluated it are gone.
test('pre-push — coverage + CRAP gate runs unconditionally', () => {
  const hook = readPrePush();
  const captureIdx = hook.indexOf(
    'coverage-capture.js --skip-when-no-crap-files',
  );
  const crapIdx = hook.indexOf('npm run crap:check');
  assert.ok(
    captureIdx > -1 && crapIdx > captureIdx,
    'coverage-capture must run before crap:check (the CRAP gate reads the fresh coverage)',
  );
  assert.doesNotMatch(
    hook,
    /STORY_CLOSE_RECOVERY|check-prepush-recovery\.js/,
    'the retired Epic-scoped recovery escape hatch must not return',
  );
});

// ---------------------------------------------------------------------------
// Story #5356 — capture before preview.
// ---------------------------------------------------------------------------

test('pre-push — coverage is captured BEFORE the quality preview scores it', () => {
  const hook = readPrePush();
  const captureIdx = hook.indexOf('coverage-capture.js');
  const previewIdx = hook.indexOf('quality-preview.js');
  assert.ok(captureIdx > -1, 'coverage-capture.js must be invoked');
  assert.ok(previewIdx > -1, 'quality-preview.js must be invoked');
  assert.ok(
    captureIdx < previewIdx,
    'coverage-capture must run before quality-preview — the CRAP half of the ' +
      'preview scores `coverage/coverage-final.json`, so previewing first ' +
      'scores whatever artifact a prior, unrelated run left on disk ' +
      '(Story #5356)',
  );
});

test('pre-push — capture and preview are anchored on the same base ref', () => {
  const hook = readPrePush();
  const captureRef = hook.match(/coverage-capture\.js[^\n]*--ref\s+(\S+)/)?.[1];
  const previewRef = hook.match(
    /quality-preview\.js[^\n]*--changed-since\s+(\S+)/,
  )?.[1];
  assert.ok(captureRef, 'coverage-capture must pass --ref');
  assert.ok(previewRef, 'quality-preview must pass --changed-since');
  assert.equal(
    captureRef,
    previewRef,
    'the two refs are one invariant, not two settings: `--skip-when-no-crap-files` ' +
      'deposits no artifact when nothing under crap.targetDirs changed since its ' +
      'ref, and it is only because the preview derives its CRAP scope from the ' +
      'SAME ref that a skipped capture leaves the preview with nothing to score. ' +
      'Move one ref without the other and the skip becomes a stale read.',
  );
});

test('pre-push — only the capture step moved: same checks, same order, same exit semantics', () => {
  // The full executable body, pinned. A step added, removed or reordered
  // here is a deliberate act and must update this list. Husky runs the hook
  // through `sh -e` (`.husky/_/h`), so the first failing command aborts with
  // its own code — the assertions below keep the body from weakening that.
  assert.deepEqual(steps(readPrePush()), [
    'cat > /dev/null',
    'node .agents/scripts/coverage-capture.js --skip-when-no-crap-files --ref origin/main',
    'node .agents/scripts/quality-preview.js --changed-since origin/main',
    'if [ "${PREPUSH_AUDIT:-0}" = "1" ]; then',
    'npm audit --audit-level=high',
    'fi',
    'npm run crap:check',
    'node .agents/scripts/check-context-budget.js',
    'node .agents/scripts/check-workflow-citations.js',
  ]);

  const hook = readPrePush();
  assert.doesNotMatch(
    hook,
    /set \+e|\|\|\s*(true|:)|(^|\n)\s*exit\s/,
    'no step may swallow its failure or pin an exit code — the hook exits with ' +
      'the first failing check under the wrapper `sh -e`',
  );
});

// ---------------------------------------------------------------------------
// Story #5356 AC-3 — the capture skip must not become a stale read.
//
// `computeCrapPreviewScan` is the CRAP half of `quality-preview.js`: it loads
// `coverage/coverage-final.json` off disk and scores the files in the diff
// scope against it. Driving it directly over a temp fixture shows both halves
// of the ordering argument without spawning a push.
// ---------------------------------------------------------------------------

/** Two functions, one trivial and one branchy (cyclomatic 6). */
const FIXTURE_SRC = [
  'export function ping() {',
  "  return 'pong';",
  '}',
  '',
  'export function classify(n) {',
  "  if (n < 0) return 'neg';",
  "  if (n === 0) return 'zero';",
  "  if (n < 10) return 'small';",
  "  if (n < 100) return 'medium';",
  "  if (n < 1000) return 'large';",
  "  return 'huge';",
  '}',
  '',
].join('\n');

/** Line ranges of the two fixture functions, 1-based and inclusive. */
const FIXTURE_FNS = [
  { name: 'ping', start: 1, end: 3 },
  { name: 'classify', start: 5, end: 12 },
];

/**
 * Plant the fixture source under `<root>/src` and return its absolute path.
 *
 * @param {string} root
 * @returns {string}
 */
function plantFixture(root) {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const abs = path.join(root, 'src', 'scored.js');
  fs.writeFileSync(abs, FIXTURE_SRC);
  return abs;
}

/**
 * Write an istanbul-shaped `coverage-final.json` for the fixture in which
 * `ping` is covered and `classify` is covered or not, per `classifyHit`.
 *
 * `ping` is always hit on purpose: a file whose every method reads 0% is
 * exempted from the new-method ceiling by the Story #5002 relief, so an
 * all-zero fixture could never reproduce a phantom violation.
 *
 * @param {string} root
 * @param {string} abs absolute path of the scored source
 * @param {{ classifyHit: number }} opts
 */
function writeCoverageArtifact(root, abs, { classifyHit }) {
  const statementMap = {};
  const s = {};
  const fnMap = {};
  const f = {};
  let stmtId = 0;
  FIXTURE_FNS.forEach((fn, fnId) => {
    const hits = fn.name === 'classify' ? classifyHit : 4;
    fnMap[fnId] = {
      name: fn.name,
      decl: {
        start: { line: fn.start, column: 0 },
        end: { line: fn.start, column: 20 },
      },
      loc: {
        start: { line: fn.start, column: 0 },
        end: { line: fn.end, column: 1 },
      },
    };
    f[fnId] = hits;
    for (let line = fn.start; line <= fn.end; line += 1) {
      statementMap[stmtId] = {
        start: { line, column: 0 },
        end: { line, column: 20 },
      };
      s[stmtId] = hits;
      stmtId += 1;
    }
  });
  fs.mkdirSync(path.join(root, 'coverage'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'coverage', 'coverage-final.json'),
    JSON.stringify({
      [abs]: { path: abs, statementMap, s, fnMap, f, branchMap: {}, b: {} },
    }),
  );
}

const FIXTURE_CRAP = {
  targetDirs: ['src'],
  ignoreGlobs: [],
  requireCoverage: true,
  newMethodCeiling: 30,
  coveragePath: 'coverage/coverage-final.json',
};

/**
 * Run the preview's CRAP scan over the fixture at a given diff scope.
 *
 * @param {string} root
 * @param {string[]} changedFiles repo-relative paths in the diff scope
 */
function previewScan(root, changedFiles) {
  return computeCrapPreviewScan({
    crap: FIXTURE_CRAP,
    cwd: root,
    scopeSet: new Set(changedFiles),
    scope: 'diff',
    diffRef: 'origin/main',
    baseline: { rows: [] },
  });
}

test('quality-preview scores the artifact on disk — a stale one invents a violation', async () => {
  // The reason the ordering is load-bearing at all. Same tree, same diff
  // scope, two artifacts: the stale one reports `classify` at 0% coverage and
  // fails on crap=42, the fresh one measures the same method at c=6 and
  // passes. This is the #5343 `evaluateBudget` phantom in miniature — the
  // operator cannot tell it from a true reading at the point the hook fails,
  // which is why capture must precede the preview rather than follow it.
  const root = makeTempDir('prepush-stale-');
  const abs = plantFixture(root);

  writeCoverageArtifact(root, abs, { classifyHit: 0 });
  const stale = await previewScan(root, ['src/scored.js']);
  assert.equal(stale.exitCode, 1);
  assert.deepEqual(
    stale.envelope.violations.map((v) => v.method),
    ['classify'],
  );

  writeCoverageArtifact(root, abs, { classifyHit: 7 });
  const fresh = await previewScan(root, ['src/scored.js']);
  assert.equal(fresh.exitCode, 0);
  assert.deepEqual(fresh.envelope.violations, []);
});

test('a skipped capture and a fresh zero-scope capture reach the same verdict', async () => {
  // AC-3. `coverage-capture.js --skip-when-no-crap-files` deposits nothing
  // when the change set touches no file under `crap.targetDirs`. Off the same
  // ref the preview's CRAP scope is empty too, so it scores no file at all —
  // the stale artifact left by an earlier run is never read. All three
  // artifact states below must therefore agree: a stale one (capture skipped
  // over it), a fresh one (capture ran and found nothing in scope), and none
  // at all.
  const root = makeTempDir('prepush-skip-');
  const abs = plantFixture(root);
  const outOfScope = ['docs/notes.md'];

  writeCoverageArtifact(root, abs, { classifyHit: 0 });
  const skippedOverStale = await previewScan(root, outOfScope);

  writeCoverageArtifact(root, abs, { classifyHit: 7 });
  const freshZeroScope = await previewScan(root, outOfScope);

  fs.rmSync(path.join(root, 'coverage', 'coverage-final.json'));
  const noArtifact = await previewScan(root, outOfScope);

  const verdict = (result) => ({
    exitCode: result.exitCode,
    scannedMethods: result.envelope.summary.total,
    regressions: result.envelope.summary.regressions,
    newViolations: result.envelope.summary.newViolations,
    violations: result.envelope.violations,
  });
  const expected = {
    exitCode: 0,
    scannedMethods: 0,
    regressions: 0,
    newViolations: 0,
    violations: [],
  };

  assert.deepEqual(
    verdict(skippedOverStale),
    expected,
    'a skipped capture must leave the preview with no CRAP scope, not a stale artifact to score',
  );
  assert.deepEqual(verdict(freshZeroScope), expected);
  assert.deepEqual(verdict(noArtifact), expected);
});

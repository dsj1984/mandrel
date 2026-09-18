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
import { runCoverageCapture } from '../.agents/scripts/coverage-capture.js';
import { resolveCrapPreviewIncremental } from '../.agents/scripts/lib/baselines/crap-preview-incremental.js';
import { computeCrapPreviewScan } from '../.agents/scripts/lib/baselines/crap-preview-scan.js';
import { resolveChangedFilesRef } from '../.agents/scripts/lib/changed-files.js';
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

// ---------------------------------------------------------------------------
// Story #5365 — one resolved ref per invocation.
//
// The ref equality asserted above is a property of the hook TEXT. It is only
// the property that matters if `coverage-capture.js` actually computes its
// change set against the ref the hook hands it — and until #5365 a consumer
// that set `delivery.quality.gates.crap.incrementalCoverage.baseRef`
// outranked the flag, so capture and the preview scored different scopes with
// nothing saying so. This repo sets no `baseRef`, so only a test that
// configures one can see it.
// ---------------------------------------------------------------------------

/** A base ref no step of the hook mentions — the desynchronizing setting. */
const RIVAL_REF = 'refs/remotes/origin/some-other-base';

/**
 * The hook's own capture invocation, tokenized into a `process.argv`-shaped
 * array. Read from `.husky/pre-push` rather than retyped, so editing the hook
 * moves this test with it.
 *
 * @returns {string[]}
 */
function captureArgvFromHook() {
  const line = readPrePush()
    .split('\n')
    .find(
      (l) => l.includes('coverage-capture.js') && !l.trim().startsWith('#'),
    );
  assert.ok(line, 'the hook must invoke coverage-capture.js');
  return line.trim().split(/\s+/);
}

/** The ref the hook hands `quality-preview.js`. */
function previewRefFromHook() {
  const ref = readPrePush().match(
    /quality-preview\.js[^\n]*--changed-since\s+(\S+)/,
  )?.[1];
  assert.ok(ref, 'quality-preview must be given a --changed-since ref');
  return ref;
}

/**
 * Drive `runCoverageCapture` over injected seams with `baseRef` configured to
 * `RIVAL_REF`, and report every ref the changed-file lookup was asked for.
 * Coverage reports fresh, so no suite is ever spawned.
 *
 * @param {{ skipWhenUnchanged: boolean }} opts
 * @param {string[]} argv
 * @returns {Promise<string[]>}
 */
async function refsCaptureAsksFor({ skipWhenUnchanged }, argv) {
  const refs = [];
  await runCoverageCapture(argv, {
    resolveConfigImpl: () => ({
      delivery: { execution: { fullSuiteLock: false } },
    }),
    getQualityImpl: () => ({
      crap: {
        enabled: true,
        targetDirs: ['.agents/scripts'],
        coveragePath: 'coverage/coverage-final.json',
        incrementalCoverage: { skipWhenUnchanged, baseRef: RIVAL_REF },
      },
      coverage: {},
    }),
    readPackageScriptsImpl: () => ({ 'test:coverage': 'node --test' }),
    hasNpmScriptImpl: () => true,
    getChangedFilesImpl: ({ ref }) => {
      refs.push(ref);
      return ['.agents/scripts/a.js'];
    },
    filterFilesUnderTargetsImpl: (files) => files,
    isCoverageFreshImpl: () => ({ fresh: true, reason: 'fresh' }),
    runCaptureImpl: () => {
      throw new Error('no suite may be spawned by this test');
    },
    computeContentDigestImpl: () => 'digest',
    writeCaptureStampImpl: () => true,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  return refs;
}

test('pre-push — a configured baseRef cannot desynchronize capture from the preview', async () => {
  const argv = captureArgvFromHook();
  const previewRef = previewRefFromHook();
  assert.notEqual(
    previewRef,
    RIVAL_REF,
    "the fixture ref must differ from the hook's, or the test proves nothing",
  );

  // Both capture paths, because either can reach the changed-file lookup:
  // incremental mode owns it when `skipWhenUnchanged` is on, and the
  // full-scope path re-runs it for `--skip-when-no-crap-files` otherwise.
  for (const skipWhenUnchanged of [true, false]) {
    const refs = await refsCaptureAsksFor({ skipWhenUnchanged }, argv);
    assert.ok(refs.length > 0, 'the changed-file set must be computed');
    assert.deepEqual(
      [...new Set(refs)],
      [previewRef],
      `with skipWhenUnchanged=${skipWhenUnchanged}, capture must score the ref ` +
        'the hook named — the same one it hands quality-preview. Letting the ' +
        'configured baseRef win captures one scope and previews another, which ' +
        'is the stale artifact the capture-before-preview ordering exists to ' +
        'prevent (Story #5365).',
    );
  }
});

test("pre-push — the preview's CRAP baseline join scores the hook's ref too", () => {
  // The preview resolves a ref of its own whenever `baselineJoin` is on: the
  // touched-file set that decides which methods may be answered from the
  // committed baseline. It read `baseRef` first, the same inversion capture
  // had, so the same configuration desynchronized it from the scope the hook
  // handed the preview one line earlier.
  const asked = [];
  const result = resolveCrapPreviewIncremental({
    crap: {
      incrementalCoverage: { baselineJoin: true, baseRef: RIVAL_REF },
    },
    diffRef: previewRefFromHook(),
    cwd: '/repo',
    baselineRows: [],
    getChangedFilesImpl: ({ ref }) => {
      asked.push(ref);
      return ['.agents/scripts/a.js'];
    },
  });
  assert.ok(result, 'the join must resolve when baselineJoin is on');
  assert.deepEqual(
    asked,
    [previewRefFromHook()],
    'the ref the preview was handed wins over the configured baseRef',
  );
});

test('resolveChangedFilesRef states the rule once: a named ref wins, config is the default', () => {
  const crap = { incrementalCoverage: { baseRef: RIVAL_REF } };
  assert.equal(
    resolveChangedFilesRef({ crap, ref: 'origin/main' }),
    'origin/main',
  );
  assert.equal(
    resolveChangedFilesRef({ crap, ref: null }),
    RIVAL_REF,
    'a caller that names no ref — the close-validation gate — still gets the configured value',
  );
  assert.equal(
    resolveChangedFilesRef({ crap: {}, ref: null }),
    'main',
    'no config and no named ref falls back to the gate default',
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
    'node scripts/check-workflow-citations.js',
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

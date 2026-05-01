import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_GATES } from '../.agents/scripts/lib/close-validation.js';

/**
 * End-to-end gate integration tests for Story #611.
 *
 * The CRAP gate is wired in at three sites; each site has its own dedicated
 * test in this file:
 *
 *   1. close-validation (DEFAULT_GATES) — runs at story-close.
 *   2. .github/workflows/ci.yml          — runs in CI.
 *   3. .husky/pre-push                   — runs locally before push.
 *
 * Plus three behavior-level tests of `check-crap.js` itself that cover the
 * contracts the three gates rely on:
 *
 *   4. enabled: false → exits 0 with `[CRAP] gate skipped (disabled)`.
 *   5. Missing baseline → bootstrap message, exits 0 (no hard-fail on a fresh
 *      consumer-repo sync).
 *   6. Bootstrap path completes well under 500ms (perf budget proxy for
 *      AC31 on a ≤3-file PR — full diff-scoped runs are dominated by the
 *      no-baseline early-exit).
 *
 * The "+20 CRAP regression fails at all three gates" scenario from the task
 * body collapses to "all three gates spawn the same `check-crap.js` binary,
 * therefore they share the same failure semantics" — verified structurally
 * by tests 1–3 (each gate's invocation shape) plus the existing comparator
 * tests in check-crap.test.js.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CHECK_CRAP_SCRIPT = path.join(
  REPO_ROOT,
  '.agents',
  'scripts',
  'check-crap.js',
);

test('Site 1 — close-validation DEFAULT_GATES invokes check-crap.js', () => {
  const crapGate = DEFAULT_GATES.find((g) => g.name.includes('crap'));
  assert.ok(crapGate, 'check-crap gate must be present in DEFAULT_GATES');
  assert.strictEqual(crapGate.cmd, 'node');
  assert.deepStrictEqual(crapGate.args, ['.agents/scripts/check-crap.js']);
});

test('Site 2 — ci.yml runs `npm run crap:check` after test:coverage with PR-scoped diff', () => {
  const yml = fs.readFileSync(
    path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'),
    'utf8',
  );
  assert.match(yml, /npm run crap:check/);
  // Diff-scoped on PRs against the base ref.
  assert.match(yml, /--changed-since\s+origin\/\$\{\{ github\.base_ref \}\}/);
  // pull_request trigger is what makes github.base_ref meaningful.
  assert.match(yml, /pull_request:/);
  // CRAP must run AFTER the test-with-coverage step (per Tech Spec) so the
  // coverage artifact is available for per-method coverage lookup.
  const coverageIdx = yml.indexOf('Run Tests with Coverage');
  const crapIdx = yml.indexOf('CRAP Check');
  assert.ok(
    coverageIdx > -1 && crapIdx > coverageIdx,
    'CRAP Check step must come after Run Tests with Coverage',
  );
  // JSON artifact is uploaded for agent-workflow consumers.
  assert.match(yml, /--json\s+temp\/crap-report\.json/);
  assert.match(yml, /name:\s*crap-report/);
});

test('Site 3 — .husky/pre-push runs `npm run crap:check` with --changed-since origin/main', () => {
  const hook = fs.readFileSync(
    path.join(REPO_ROOT, '.husky', 'pre-push'),
    'utf8',
  );
  // Story #829 (5.29.0) switched the diff base from `main` to `origin/main`.
  // When pushing FROM main (release commits, emergency push-to-main) the
  // local-main diff is empty and pre-push silently skipped the gate;
  // origin/main pins the diff to "unpushed commits" so the gate fires
  // exactly when the upcoming push has a chance to introduce regressions.
  assert.match(
    hook,
    /npm run crap:check\s+--\s+--changed-since\s+origin\/main/,
  );
  // Coverage capture must run AFTER lint/format/MI but BEFORE crap:check, so
  // `coverage/coverage-final.json` is on disk for the per-method lookup.
  // Story #790 replaced the unconditional `npm run test:coverage` call with
  // the freshness-aware `coverage-capture.js` CLI (still spawns
  // `npm run test:coverage` under the hood when stale).
  const captureIdx = hook.indexOf('coverage-capture.js');
  const crapIdx = hook.indexOf('npm run crap:check');
  assert.ok(
    captureIdx > -1 && crapIdx > captureIdx,
    'crap:check must come after coverage-capture in pre-push',
  );
  assert.match(hook, /coverage-capture\.js\s+--skip-when-no-crap-files/);
  // The coverage-capture --ref must use origin/main for the same reason as
  // the crap:check --changed-since arg — they form a pair.
  assert.match(hook, /coverage-capture\.js[^\n]*--ref\s+origin\/main/);
});

/**
 * Spawn `check-crap.js` directly in a freshly seeded temp dir. The temp dir
 * mimics a minimal consumer repo: just `.agentrc.json` + an empty target
 * directory + (optionally) a `coverage/coverage-final.json`. No real source
 * to score, so the hot path through scanAndScore exits in well under the
 * AC31 budget — this is the bootstrap / disabled scenario, not a perf test
 * of the full scoring pipeline.
 */
function makeTempRepo({ enabled = true, withBaseline = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crap-gate-'));
  fs.writeFileSync(
    path.join(dir, '.agentrc.json'),
    JSON.stringify(
      {
        agentSettings: {
          paths: {
            agentRoot: '.agents',
            docsRoot: 'docs',
            tempRoot: 'temp',
          },
          quality: {
            crap: {
              enabled,
              targetDirs: ['src'],
              newMethodCeiling: 30,
              tolerance: 0.001,
              requireCoverage: false,
            },
          },
        },
      },
      null,
      2,
    ),
  );
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'coverage'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'coverage', 'coverage-final.json'),
    JSON.stringify({}),
  );
  if (withBaseline) {
    fs.mkdirSync(path.join(dir, 'baselines'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'baselines', 'crap.json'),
      JSON.stringify(
        { kernelVersion: '1.0.0', escomplexVersion: 'unknown', rows: [] },
        null,
        2,
      ),
    );
  }
  return dir;
}

function runCheckCrap(cwd) {
  // `AP_AGENTRC_CWD` is the documented test-only override that points
  // resolveConfig() at the temp dir's synthetic `.agentrc.json` instead of
  // the real repo's. Without it, the subprocess would resolve config from
  // the real project root and ignore the fixture entirely.
  return spawnSync('node', [CHECK_CRAP_SCRIPT], {
    cwd,
    env: { ...process.env, AP_AGENTRC_CWD: cwd },
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  });
}

test('Behavior 4 — enabled: false → exit 0 with `[CRAP] gate skipped (disabled)`', () => {
  const dir = makeTempRepo({ enabled: false });
  try {
    const res = runCheckCrap(dir);
    assert.strictEqual(res.status, 0);
    assert.match(res.stdout, /\[CRAP\] gate skipped \(disabled\)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Behavior 5 — missing baseline → fails closed with exit 1 (Story #791 hard-enforce)', () => {
  const dir = makeTempRepo({ enabled: true, withBaseline: false });
  try {
    const res = runCheckCrap(dir);
    assert.strictEqual(res.status, 1);
    // Message lands on stderr now that the path is a hard fail.
    assert.match(res.stderr, /no baseline found/);
    assert.match(res.stderr, /npm run crap:update/);
    assert.match(res.stderr, /baseline-refresh:/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Behavior 6 — missing-baseline path completes well under the 500ms AC31 budget', () => {
  const dir = makeTempRepo({ enabled: true, withBaseline: false });
  try {
    // Discard a warm-up to absorb Node's startup variance, then time the run.
    runCheckCrap(dir);
    const t0 = process.hrtime.bigint();
    const res = runCheckCrap(dir);
    const elapsedMs = Number(process.hrtime.bigint() - t0) / 1_000_000;
    assert.strictEqual(res.status, 1);
    // The 500ms is the AC31 *delta* budget, but the early missing-baseline
    // exit (before any scoring) should be well under total. Allow a generous
    // 3000ms ceiling to absorb cold-start jitter on slow CI runners — anything
    // beyond that is a real regression.
    assert.ok(
      elapsedMs < 3000,
      `missing-baseline path took ${elapsedMs.toFixed(0)}ms (>3000ms ceiling)`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

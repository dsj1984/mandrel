import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_GATES } from '../.agents/scripts/lib/close-validation.js';

/**
 * End-to-end gate integration tests for Story #611. Originally exercised
 * three call sites for the per-kind `check-crap.js` CLI; Story #1981
 * (Epic #1943) collapsed those gates into the unified
 * `check-baselines.js` runner. The remaining tests here pin the
 * close-validation registration shape (Site 1) and the CI workflow
 * wiring (Site 2 / Site 3); behavior-level CRAP tests now live next to
 * the per-kind comparator under `tests/check-crap-*.test.js` and
 * `tests/lib/baselines/kinds/`.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

test('Site 1 — close-validation DEFAULT_GATES invokes check-crap.js', () => {
  const crapGate = DEFAULT_GATES.find((g) => g.name.includes('crap'));
  assert.ok(crapGate, 'check-crap gate must be present in DEFAULT_GATES');
  assert.strictEqual(crapGate.cmd, 'node');
  assert.deepStrictEqual(crapGate.args, ['.agents/scripts/check-crap.js']);
});

test('Site 2 — ci.yml runs the unified baselines gate (Story #1981 collapse)', () => {
  const yml = fs.readFileSync(
    path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'),
    'utf8',
  );
  // Story #1981 (Epic #1943): the per-kind CRAP / coverage / MI / mutation
  // gates were folded into the unified `check-baselines.js` runner exposed
  // as the dedicated `baselines` job. The PR-scoped diff is enforced
  // inside `check-baselines.js` against `agentSettings`; the CI workflow
  // just invokes the runner.
  assert.match(yml, /node \.agents\/scripts\/check-baselines\.js/);
  // pull_request trigger is what makes github.base_ref meaningful.
  assert.match(yml, /pull_request:/);
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

// Story #1981 (Task #2006): the per-kind `check-crap.js` CLI was deleted
// once the unified `check-baselines.js` runner became authoritative.
// Behavior 4–6 (enabled-skip, missing-baseline hard-fail, perf budget)
// are now exercised end-to-end by `check-baselines.js` itself; the
// per-kind CLI shape they previously asserted no longer exists.

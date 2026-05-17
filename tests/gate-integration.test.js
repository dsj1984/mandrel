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

test('Site 1 — close-validation DEFAULT_GATES routes CRAP enforcement through the unified check-baselines gate (Story #2210)', () => {
  // Story #2210 retired the per-kind in-process CRAP gate. CRAP regression
  // enforcement is now performed by the unified `check-baselines` gate
  // (attribution-wired floor + tolerance + schema). The contract that
  // survives is: the unified gate is still registered in DEFAULT_GATES,
  // and the standalone `check-crap` gate is gone.
  const baselinesGate = DEFAULT_GATES.find((g) => g.name === 'check-baselines');
  assert.ok(
    baselinesGate,
    'unified `check-baselines` gate must be present in DEFAULT_GATES',
  );
  const crapGate = DEFAULT_GATES.find((g) => g.name === 'check-crap');
  assert.ok(
    !crapGate,
    'retired per-kind `check-crap` gate must not be registered in DEFAULT_GATES',
  );
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

test('Site 3 — .husky/pre-push invokes the unified crap:check (no legacy --changed-since)', () => {
  // Epic #1943: the unified `check-baselines.js` dispatcher resolves
  // scope via `delivery.quality.gateScoping` in `.agentrc.json`, so the
  // legacy `--changed-since origin/main` flag is gone from pre-push.
  // The contract that survives is: pre-push still runs crap:check, and
  // coverage-capture still seeds coverage data before it.
  const hook = fs.readFileSync(
    path.join(REPO_ROOT, '.husky', 'pre-push'),
    'utf8',
  );
  assert.match(hook, /npm run crap:check/);
  const captureIdx = hook.indexOf('coverage-capture.js');
  const crapIdx = hook.indexOf('npm run crap:check');
  assert.ok(
    captureIdx > -1 && crapIdx > captureIdx,
    'crap:check must come after coverage-capture in pre-push',
  );
  assert.match(hook, /coverage-capture\.js\s+--skip-when-no-crap-files/);
  assert.match(hook, /coverage-capture\.js[^\n]*--ref\s+origin\/main/);
});

// Story #1981 (Task #2006): the per-kind `check-crap.js` CLI was deleted
// once the unified `check-baselines.js` runner became authoritative.
// Behavior 4–6 (enabled-skip, missing-baseline hard-fail, perf budget)
// are now exercised end-to-end by `check-baselines.js` itself; the
// per-kind CLI shape they previously asserted no longer exists.

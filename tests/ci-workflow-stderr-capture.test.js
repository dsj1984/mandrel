import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CI_WORKFLOW = join(__dirname, '..', '.github', 'workflows', 'ci.yml');

function getTestCoverageStep(source) {
  const lines = source.split(/\r?\n/);
  const startIdx = lines.findIndex((l) =>
    /name:\s*Run Tests with Coverage/.test(l),
  );
  assert.notEqual(
    startIdx,
    -1,
    'Run Tests with Coverage step not found in .github/workflows/ci.yml',
  );
  const rest = lines.slice(startIdx);
  const nextStepIdx = rest
    .slice(1)
    .findIndex((l) => /^\s*- (name|uses):/.test(l));
  const endIdx = nextStepIdx === -1 ? rest.length : nextStepIdx + 1;
  return rest.slice(0, endIdx).join('\n');
}

test('CI workflow Run Tests with Coverage step preserves stderr-capture regression guards', () => {
  const source = readFileSync(CI_WORKFLOW, 'utf8');
  const step = getTestCoverageStep(source);

  assert.match(
    step,
    /2>&1|\|&/,
    'Coverage step must redirect stderr into the captured artifact (2>&1 or |&). Regression guard for Epic #441 Story 4.1 — stdout-only redirect hid test failures.',
  );

  assert.match(
    step,
    /set\s+-o\s+pipefail|set\s+-eo?\s+pipefail/,
    'Coverage step must set pipefail so a failing `npm run test:coverage` propagates through `tee`. Regression guard for Epic #441 Story 4.1.',
  );

  assert.match(
    step,
    /npm run test:coverage/,
    'Coverage step must still invoke `npm run test:coverage`.',
  );
});

// ---------------------------------------------------------------------------
// Story #4922 — the coverage instrument's CI wiring.
// ---------------------------------------------------------------------------

test('the coverage step leaves the preflight to the runner, not to a named script', () => {
  // Story #4922 had CI name `pretest:coverage` explicitly, because .npmrc's
  // `ignore-scripts=true` (CWE-1357 defence, which stays) suppresses every
  // pre*/post* lifecycle hook for `npm run` as well as for installs. Story
  // #4936 moved the invocation into run-coverage.js, so the preflight now
  // fires for every tier and every caller. If a `pretest*` script ever comes
  // back, this step must not be the only thing that runs it.
  const source = readFileSync(CI_WORKFLOW, 'utf8');
  const step = getTestCoverageStep(source);
  assert.ok(
    !/npm run pretest/.test(step),
    'the coverage step must not name a pretest* script — the runner owns ' +
      'the preflight (lib/test-runner-contract.js#runTierPreflight)',
  );
  assert.match(
    readFileSync(
      new URL('../scripts/run-coverage.js', import.meta.url),
      'utf8',
    ),
    /runTierPreflight/,
    'run-coverage.js must invoke the tier preflight itself',
  );
});

test('the worktree-manager real-git contract executes in a CI job', () => {
  const source = readFileSync(CI_WORKFLOW, 'utf8');
  assert.match(
    source,
    /tests\/lib\/worktree-manager\.integration\.test\.js/,
    'tests/lib/worktree-manager.integration.test.js must be invoked by a CI ' +
      'job. It is integration-tier (so `test:quick` on the Windows leg skips ' +
      'it) and its drive-letter-case guard is win32-gated, so without an ' +
      'explicit Windows invocation that assertion runs in no job at all.',
  );
});

test('the Windows leg is where the win32-gated guard runs', () => {
  const { jobs } = load(readFileSync(CI_WORKFLOW, 'utf8'));
  const shard = jobs['windows-smoke-shard'];
  assert.equal(shard['runs-on'], 'windows-latest');
  assert.ok(
    shard.steps.some((step) =>
      /tests\/lib\/worktree-manager\.integration\.test\.js/.test(step.run),
    ),
    'the worktree-manager contract must run on a windows-latest job — its ' +
      'drive-letter-case regression only reproduces there',
  );
});

// Story #5866 — the required `Windows Smoke` check is an ubuntu fan-in over
// two Windows shard jobs.
test('the Windows Smoke fan-in fails unless every shard succeeded', () => {
  const { jobs } = load(readFileSync(CI_WORKFLOW, 'utf8'));
  const fanIn = jobs['windows-smoke'];
  assert.equal(fanIn.name, 'Windows Smoke', 'the required check name');
  assert.equal(fanIn['runs-on'], 'ubuntu-latest');
  assert.deepEqual([fanIn.needs].flat(), ['windows-smoke-shard']);
  // Without always() a failed or cancelled shard SKIPS the fan-in, and a
  // skipped required check does not block the merge.
  assert.equal(fanIn.if, 'always()');
  const script = fanIn.steps.map((s) => `${s.run ?? ''}`).join('\n');
  const env = Object.assign({}, ...fanIn.steps.map((s) => s.env ?? {}));
  assert.equal(env.SHARD_RESULT, '${{ needs.windows-smoke-shard.result }}');
  assert.match(script, /test "\$SHARD_RESULT" = "success"/);
});

test('the shard job splits the quick tier across two Windows runners', () => {
  const { jobs } = load(readFileSync(CI_WORKFLOW, 'utf8'));
  const shard = jobs['windows-smoke-shard'];
  assert.deepEqual(shard.strategy.matrix.shard, [1, 2]);
  assert.equal(shard.strategy['fail-fast'], false);
  assert.ok(
    shard.steps.some(
      (s) => s.run === 'npm run test:quick -- --shard ${{ matrix.shard }}/2',
    ),
  );
});

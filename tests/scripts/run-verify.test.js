import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { runVerifySteps } from '../../scripts/run-verify.js';

const REPO_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

test('runVerifySteps stops on first failing step', () => {
  const calls = [];
  const outcome = runVerifySteps({
    spawn: (cmd, args) => {
      calls.push([cmd, args].flat().join(' '));
      if (calls.length === 3) {
        return { status: 3 };
      }
      return { status: 0 };
    },
    shell: false,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.failedStep, 'test');
  assert.equal(outcome.exitCode, 3);
  assert.equal(calls.length, 3);
});

test('runVerifySteps runs audit, lint, test, baselines, then the ratchets in order', () => {
  const calls = [];
  const outcome = runVerifySteps({
    spawn: (cmd, args) => {
      calls.push([cmd, ...args]);
      return { status: 0 };
    },
    shell: false,
  });
  assert.deepEqual(outcome, { ok: true });
  assert.deepEqual(calls, [
    ['npm', 'audit', '--audit-level=high'],
    ['npm', 'run', 'lint'],
    ['npm', 'test'],
    ['node', '.agents/scripts/check-baselines.js'],
    // Ahead of the dead-exports pair on purpose: when a new CLI is missing from
    // knip.json's entry list both gates fail, but only this one names the cause
    // (Story #5012 read the ratchet's diff first and nearly recorded live CLIs
    // as expected-dead).
    ['node', 'scripts/check-knip-entries.js'],
    ['node', '.agents/scripts/check-dead-exports.js'],
    ['node', '.agents/scripts/check-dead-exports.js', '--production'],
    ['node', '.agents/scripts/check-context-budget.js'],
    // A report since Story #5340, and mirrored here from the same Story: the
    // test that used to re-run its ratchet no longer does.
    ['node', 'scripts/check-workflow-citations.js'],
    ['node', '.agents/scripts/check-cyclomatic.js'],
    ['node', 'scripts/check-schema-references.js'],
  ]);
});

// Story #4549: verify advertises itself as a true CI mirror, so every gate CI's
// `baselines` job runs must be reachable from it. A clean verify that skipped
// the dead-export ratchet is exactly what let PR #4548 reach a red CI.
test('runVerifySteps runs the ratchets CI’s "Architecture Cycle Check" step covers', () => {
  const calls = [];
  runVerifySteps({
    spawn: (cmd, args) => {
      calls.push([cmd, ...args].join(' '));
      return { status: 0 };
    },
    shell: false,
  });
  for (const script of ['check-dead-exports.js', 'check-context-budget.js']) {
    assert.ok(
      calls.some((call) => call.includes(script)),
      `expected verify to run ${script}`,
    );
  }
});

// Story #5004: the guard above names two scripts by hand, so a ratchet ADDED to
// CI's standalone slot later is invisible to it — which is exactly how
// check-cyclomatic.js (#4923) and check-schema-references.js (#4938) each
// reached `main` uncovered by `npm run verify`. Read CI's own step instead and
// require every script it names to be accounted for: covered by verify,
// covered by lint, or listed here as a deliberate, reasoned exemption.
const CI_RATCHETS_NOT_MIRRORED_LOCALLY = new Map([
  // `check-workflow-citations.js` left this map in Story #5340. It was
  // exempted because `tests/check-workflow-citations.test.js` re-ran the same
  // ratchet through the `test` step, so a verify step would have double-paid
  // it. Demoting it to a report ended that: the test asserts the report, and
  // the verify step is now the only local surface that prints the count.
  [
    'check-baseline-scope.js',
    'Row-set honesty gate — meaningful only against a fully-scored tree; reachable as `npm run baselines:scope`.',
  ],
  // `prune-baseline-orphans.js` left this map in v2.32.0 along with the CI step
  // it exempted: `--check` has no merge-base attribution, so holding it in the
  // required job cancelled `check-baseline-scope.js`'s inherited-divergence
  // warning. It is an operator remedy now (`npm run baselines:prune`), and this
  // assertion is bidirectional — a stale exemption fails as loudly as a missing
  // one.
]);

test('every ratchet CI’s `baselines` job runs is mirrored locally or exempted', () => {
  const ci = readFileSync(
    path.join(REPO_ROOT, '.github/workflows/ci.yml'),
    'utf8',
  );
  const baselinesJob = ci.slice(
    ci.indexOf('\n  baselines:'),
    ci.indexOf('\n  windows-smoke:'),
  );
  assert.ok(baselinesJob.length > 0, 'could not slice the `baselines` job');

  const ciScripts = [
    ...new Set(
      // Contributor-only ratchets live under repo-root `scripts/` since Story
      // #5381; the rest still ship under `.agents/scripts/`.
      [
        ...baselinesJob.matchAll(
          /(?:^|[\s/])(?:\.agents\/)?scripts\/([\w-]+\.js)/gm,
        ),
      ].map((m) => m[1]),
    ),
  ];
  // A shape guard: if the regex ever stops matching, the assertions below pass
  // vacuously and the mirror rots again.
  assert.ok(
    ciScripts.length >= 8,
    `expected CI's baselines job to name at least 8 scripts, saw ${ciScripts.length}`,
  );

  const verifySource = readFileSync(
    path.join(REPO_ROOT, 'scripts/run-verify.js'),
    'utf8',
  );
  const lintSource = readFileSync(
    path.join(REPO_ROOT, 'scripts/run-lint.js'),
    'utf8',
  );
  const STEPS_ONLY = verifySource.slice(
    verifySource.indexOf('const STEPS = ['),
    verifySource.indexOf('export function runVerifySteps'),
  );

  const unmirrored = ciScripts.filter(
    (script) =>
      !STEPS_ONLY.includes(script) &&
      !lintSource.includes(script) &&
      // check-baselines.js is `npm run verify`'s own `baselines` step.
      script !== 'check-baselines.js' &&
      !CI_RATCHETS_NOT_MIRRORED_LOCALLY.has(script),
  );
  assert.deepEqual(
    unmirrored,
    [],
    `CI's \`baselines\` job runs ${unmirrored.join(', ')}, which no local ` +
      'aggregate covers. Add each to run-verify.js STEPS, or add it to ' +
      'CI_RATCHETS_NOT_MIRRORED_LOCALLY with the reason it cannot be.',
  );

  // The exemption list must not outlive its entries either.
  for (const script of CI_RATCHETS_NOT_MIRRORED_LOCALLY.keys()) {
    assert.ok(
      ciScripts.includes(script),
      `${script} is exempted from the local mirror but CI no longer runs it — drop the exemption.`,
    );
  }
});

// Story #5004: the duplicate `Maintainability Check` step in the `validate`
// job was a byte-for-byte subset of the required `baselines` job's
// check-baselines run on PRs. Pin its absence so it is not reinstated by a
// merge that "restores" a step nobody meant to keep.
test('the validate job does not re-run the maintainability gate the baselines job owns', () => {
  const ci = readFileSync(
    path.join(REPO_ROOT, '.github/workflows/ci.yml'),
    'utf8',
  );
  const validateJob = ci.slice(
    ci.indexOf('\n  validate:'),
    ci.indexOf('\n  baselines:'),
  );
  assert.ok(validateJob.length > 0, 'could not slice the `validate` job');
  assert.equal(
    /^\s+run:.*maintainability:check/m.test(validateJob),
    false,
    'the validate job runs `npm run maintainability:check` again — the ' +
      'required `baselines` job already runs it on the same scope.',
  );
});

// The third check in that CI step, check-arch-cycles.js, is already run by the
// `lint` step (run-lint.js). Adding it to STEPS as well would double-pay a gate
// verify already covers — this guards against that regression.
test('runVerifySteps does not re-run arch-cycles, which the lint step already covers', () => {
  const calls = [];
  runVerifySteps({
    spawn: (cmd, args) => {
      calls.push([cmd, ...args].join(' '));
      return { status: 0 };
    },
    shell: false,
  });
  assert.equal(
    calls.filter((call) => call.includes('check-arch-cycles.js')).length,
    0,
  );
  assert.ok(calls.includes('npm run lint'));
});

// The test above is only safe while `lint` really does carry arch-cycles. Pin
// that, or dropping it from run-lint.js would silently reopen the very gap
// this Story closed. Asserted against the source text rather than an import:
// run-lint.js is a top-level-await driver that would spawn biome on import.
test('run-lint.js still carries the arch-cycles ratchet verify relies on it for', () => {
  const source = readFileSync(
    path.join(REPO_ROOT, 'scripts/run-lint.js'),
    'utf8',
  );
  assert.ok(
    source.includes('check-arch-cycles.js'),
    'run-lint.js no longer runs check-arch-cycles.js — verify now has no ' +
      'arch-cycles coverage; add it to run-verify.js STEPS.',
  );
});

test('runVerifySteps reports a failing ratchet by its own step label', () => {
  const outcome = runVerifySteps({
    spawn: (_cmd, args) =>
      args.some((arg) => arg.includes('check-dead-exports.js'))
        ? { status: 1 }
        : { status: 0 },
    shell: false,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.failedStep, 'dead-exports');
  assert.equal(outcome.exitCode, 1);
});

test('runVerifySteps surfaces a failing high-severity audit first', () => {
  const calls = [];
  const outcome = runVerifySteps({
    spawn: (cmd, args) => {
      calls.push([cmd, ...args]);
      return { status: 1 };
    },
    shell: false,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.failedStep, 'audit');
  assert.equal(outcome.exitCode, 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['npm', 'audit', '--audit-level=high']);
});

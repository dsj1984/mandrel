import assert from 'node:assert/strict';
import test from 'node:test';
import { ValidationError } from '../../../.agents/scripts/lib/errors/index.js';
import {
  validateAcFreshness,
  validateAndNormalizeTickets,
} from '../../../.agents/scripts/lib/orchestration/ticket-validator.js';

/**
 * Build a fake gitRunner whose existence map is keyed by repo-relative
 * path. Every probe routes through the map; missing keys return false so
 * the test fails closed on typos.
 */
function fakeGitRunner(existing) {
  const set = new Set(existing);
  return ({ path }) => set.has(path);
}

function makeTask(slug, body, extras = {}) {
  return {
    slug,
    type: 'task',
    title: `Task ${slug}`,
    parent_slug: 'S1',
    body,
    ...extras,
  };
}

test('validateAcFreshness: passes when every referenced path exists at baseBranchRef', () => {
  const tickets = [
    makeTask('T1', {
      goal: 'Add freshness gate.',
      changes: [
        '.agents/scripts/lib/orchestration/ticket-validator.js: add validator',
      ],
      acceptance: ['validator throws on missing path'],
      verify: [
        'node --test tests/lib/orchestration/ticket-validator-freshness.test.js',
      ],
    }),
  ];
  assert.doesNotThrow(() =>
    validateAcFreshness({
      tickets,
      baseBranchRef: 'main',
      gitRunner: fakeGitRunner([
        '.agents/scripts/lib/orchestration/ticket-validator.js',
        'tests/lib/orchestration/ticket-validator-freshness.test.js',
      ]),
    }),
  );
});

test('validateAcFreshness: throws when a verify path is absent from main AND not declared in body.changes', () => {
  // The planner claims to verify against an aggregator script, but never
  // declared it in body.changes — so the path is a stale reference, not a
  // net-new file. The freshness gate must still fail.
  const tickets = [
    makeTask('T1', {
      goal: 'Aggregate phase timings.',
      changes: ['.agents/scripts/some-other-tool.js: edit unrelated'],
      acceptance: ['aggregator emits totals'],
      verify: ['node .agents/scripts/aggregate-phase-timings.js'],
    }),
  ];
  assert.throws(
    () =>
      validateAcFreshness({
        tickets,
        baseBranchRef: 'main',
        gitRunner: fakeGitRunner([
          // The path declared in `changes` exists; the verify-only path
          // does not — and is not in `changes`, so it must trip the gate.
          '.agents/scripts/some-other-tool.js',
        ]),
      }),
    (err) => {
      assert.ok(err instanceof ValidationError);
      assert.match(err.message, /T1/);
      assert.match(err.message, /aggregate-phase-timings\.js/);
      assert.match(err.message, /main/);
      return true;
    },
  );
});

test('validateAcFreshness: verify path that IS declared in body.changes and absent from main still passes', () => {
  // Net-new test file: declared in `changes`, referenced in `verify`, and
  // absent from the base branch tree. The freshness gate must accept it
  // — the planner is creating the file, not hallucinating it.
  const tickets = [
    makeTask('T1', {
      goal: 'Add freshness regression test.',
      changes: [
        'tests/unit/foo.test.js: cover regression',
        '.agents/scripts/lib/orchestration/ticket-validator.js: tweak gate',
      ],
      acceptance: ['regression test exercises the gate'],
      verify: ['node --test tests/unit/foo.test.js'],
    }),
  ];
  assert.doesNotThrow(() =>
    validateAcFreshness({
      tickets,
      baseBranchRef: 'main',
      // gitRunner returns true only for the existing validator path —
      // the brand-new test file is absent. The expected-new short-circuit
      // is what makes this scenario pass.
      gitRunner: fakeGitRunner([
        '.agents/scripts/lib/orchestration/ticket-validator.js',
      ]),
    }),
  );
});

test('validateAcFreshness: net-new path in body.changes skips the git probe entirely', () => {
  // Defensive variant: even when the runner would throw if invoked for
  // the net-new path, the freshness gate must short-circuit on the
  // expected-new set. Proves the skip is path-set membership, not a
  // probe-then-tolerate.
  const tickets = [
    makeTask('T1', {
      goal: 'Author a brand-new helper plus its test.',
      changes: [
        '.agents/scripts/lib/freshly-authored.js: new helper',
        'tests/lib/freshly-authored.test.js: new coverage',
      ],
      acceptance: ['helper exported', 'tests cover happy path'],
      verify: ['node --test tests/lib/freshly-authored.test.js'],
    }),
  ];
  assert.doesNotThrow(() =>
    validateAcFreshness({
      tickets,
      baseBranchRef: 'main',
      gitRunner: ({ path }) => {
        throw new Error(
          `gitRunner should not be called for expected-new path: ${path}`,
        );
      },
    }),
  );
});

test('validateAcFreshness: regex bounds — only the three roots are scanned', () => {
  // Paths that LOOK like code but live outside .agents/scripts, lib/, tests/
  // must NOT trigger the gate. (e.g. docs/, baselines/, image refs, prose.)
  const tickets = [
    makeTask('T1', {
      goal: 'Update docs only.',
      changes: [
        'docs/architecture.md: add section',
        'baselines/crap.json: regenerate',
      ],
      acceptance: [
        'See established convention in https://example.com/library/foo.js',
      ],
      verify: ['manual: visual review of docs'],
    }),
  ];
  // gitRunner returns false for everything — if the regex over-matches and
  // probes any of the above, this test will throw. The pass-through proves
  // the roots are bounded.
  assert.doesNotThrow(() =>
    validateAcFreshness({
      tickets,
      baseBranchRef: 'main',
      gitRunner: () => false,
    }),
  );
});

test('validateAcFreshness: Tasks with no file references pass unchanged', () => {
  const tickets = [
    makeTask('T1', {
      goal: 'Edit Story #1089 body to drop a stale reference.',
      changes: ['GitHub Story #1089 body: remove the deleted-file mention'],
      acceptance: [
        'Story body no longer cites the missing helper',
        'No code change in this Task',
      ],
      verify: ['manual: re-read Story #1089 body in GitHub UI'],
    }),
  ];
  assert.doesNotThrow(() =>
    validateAcFreshness({
      tickets,
      baseBranchRef: 'main',
      // Empty fixture: any probe call would throw because no key matches.
      // The pass-through proves no probe was triggered.
      gitRunner: () => {
        throw new Error(
          'gitRunner should not be called when no paths are referenced',
        );
      },
    }),
  );
});

test('validateAcFreshness: error names every offending Task slug + path', () => {
  // Paths must be referenced OUTSIDE `body.changes` to trip the gate —
  // anything declared in `changes` is treated as net-new and skipped.
  const tickets = [
    makeTask('T1', {
      goal: 'Edit .agents/scripts/missing-one.js to do thing.',
      changes: [],
      acceptance: [],
      verify: [],
    }),
    makeTask('T2', {
      goal: 'Touch lib/dropped.js to do other thing.',
      changes: [],
      acceptance: [],
      verify: [],
    }),
  ];
  let caught;
  try {
    validateAcFreshness({
      tickets,
      baseBranchRef: 'origin/main',
      gitRunner: () => false,
    });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof ValidationError);
  assert.match(caught.message, /T1/);
  assert.match(caught.message, /missing-one\.js/);
  assert.match(caught.message, /T2/);
  assert.match(caught.message, /dropped\.js/);
  assert.match(caught.message, /origin\/main/);
  assert.equal(caught.misses.length, 2);
});

test('validateAcFreshness: error message carries per-path remediation hint pointing at body.changes', () => {
  // Regression for Story #2279. A Task declares a brand-new test file in
  // `verify` but forgets to list it in `body.changes`; the gate trips
  // and the operator-visible error MUST hint at the actual fix
  // (declare the path in `body.changes`) rather than just calling the
  // reference stale.
  const tickets = [
    makeTask('T1', {
      goal: 'Add a regression test for the freshness gate.',
      changes: [],
      acceptance: ['regression test exercises the gate'],
      verify: ['node --test tests/lib/orchestration/new-fresh.test.js'],
    }),
    makeTask('T2', {
      goal: 'Touch .agents/scripts/missing-helper.js to do thing.',
      changes: [],
      acceptance: [],
      verify: [],
    }),
  ];
  let caught;
  try {
    validateAcFreshness({
      tickets,
      baseBranchRef: 'main',
      gitRunner: () => false,
    });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof ValidationError);
  // Per-path hint must name body.changes as the remediation target.
  assert.match(caught.message, /body\.changes/);
  // Tests/** paths get the explicit "add test file" verb shape.
  assert.match(
    caught.message,
    /tests\/lib\/orchestration\/new-fresh\.test\.js: add test file/,
  );
  // Non-test paths get the generic "create" verb shape.
  assert.match(
    caught.message,
    /\.agents\/scripts\/missing-helper\.js: create/,
  );
  // Trailing prose points at both branches (declare vs. correct).
  assert.match(caught.message, /Either declare the path in body\.changes/);
  assert.match(caught.message, /correct the reference/);
});

test('validateAcFreshness: requires baseBranchRef', () => {
  assert.throws(
    () => validateAcFreshness({ tickets: [], baseBranchRef: '' }),
    /baseBranchRef is required/,
  );
});

test('validateAndNormalizeTickets: freshness gate is opt-in via opts.baseBranchRef', () => {
  // The stale-path reference lives in `goal`, not `changes`, so the
  // expected-new short-circuit doesn't apply and the freshness clause
  // throws when the runner reports the path missing.
  const tickets = [
    { slug: 'F1', type: 'feature', title: 'F' },
    { slug: 'S1', type: 'story', title: 'S', parent_slug: 'F1' },
    makeTask('T1', {
      goal: 'Touch .agents/scripts/missing.js to do x.',
      changes: [],
      acceptance: ['a'],
      verify: ['v'],
    }),
  ];
  // Without baseBranchRef the validator's freshness clause is a no-op so
  // legacy callers (and existing tests) keep their semantics.
  assert.doesNotThrow(() => validateAndNormalizeTickets(tickets));
  // With baseBranchRef + a runner that returns false, the chain throws.
  assert.throws(
    () =>
      validateAndNormalizeTickets(tickets, {
        baseBranchRef: 'main',
        gitRunner: () => false,
      }),
    ValidationError,
  );
});

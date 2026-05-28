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

function makeStory(slug, body, extras = {}) {
  return {
    slug,
    type: 'story',
    title: `Story ${slug}`,
    parent_slug: 'F1',
    body,
    ...extras,
  };
}

test('validateAcFreshness: passes when every referenced path exists at baseBranchRef', () => {
  const tickets = [
    makeStory('T1', {
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
    makeStory('T1', {
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
    makeStory('T1', {
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
    makeStory('T1', {
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
    makeStory('T1', {
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
    makeStory('T1', {
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
    makeStory('T1', {
      goal: 'Edit .agents/scripts/missing-one.js to do thing.',
      changes: [],
      acceptance: [],
      verify: [],
    }),
    makeStory('T2', {
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
    makeStory('T1', {
      goal: 'Add a regression test for the freshness gate.',
      changes: [],
      acceptance: ['regression test exercises the gate'],
      verify: ['node --test tests/lib/orchestration/new-fresh.test.js'],
    }),
    makeStory('T2', {
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
  assert.match(caught.message, /\.agents\/scripts\/missing-helper\.js: create/);
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
    makeStory(
      'S1',
      {
        goal: 'Touch .agents/scripts/missing.js to do x.',
        changes: [],
        acceptance: ['a'],
        verify: ['v'],
      },
      { acceptance: ['a'], verify: ['v'] },
    ),
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

// --- Object-form body.changes (Story #2680 / framework-gap #1) -----------

test('validateAcFreshness: object-form `{path, assumption: "creates"}` entries short-circuit the probe', () => {
  // Story #2636 introduced the object form; the freshness gate's
  // `collectTaskChangesPaths` must recognise it the same way it recognises
  // legacy string bullets. The path is declared as net-new in `changes`
  // and cited verbatim by `verify` — the gate must accept it.
  const tickets = [
    makeStory('T1', {
      goal: 'Author the freshness regression test.',
      changes: [
        { path: 'tests/lib/freshly-authored.test.js', assumption: 'creates' },
        {
          path: '.agents/scripts/lib/orchestration/ticket-validator.js',
          assumption: 'refactors-existing',
        },
      ],
      acceptance: ['regression test exercises the gate'],
      verify: ['node --test tests/lib/freshly-authored.test.js'],
    }),
  ];
  assert.doesNotThrow(() =>
    validateAcFreshness({
      tickets,
      baseBranchRef: 'main',
      // Only the existing validator path is on `main`; the test file is
      // net-new. Without the object-form fix the gate would reject the
      // verify citation because String({path,...}) would never match the
      // freshness regex.
      gitRunner: fakeGitRunner([
        '.agents/scripts/lib/orchestration/ticket-validator.js',
      ]),
    }),
  );
});

test('validateAcFreshness: object-form changes still flag a verify path NOT in changes/references', () => {
  // Confirms the object-form acceptance is path-set membership, not a
  // blanket "trust everything". A task that only declares one object-form
  // path but cites a different one in verify must still fail closed.
  const tickets = [
    makeStory('T1', {
      goal: 'Edit a known file.',
      changes: [
        {
          path: '.agents/scripts/lib/orchestration/ticket-validator.js',
          assumption: 'refactors-existing',
        },
      ],
      acceptance: ['regression test exercises the gate'],
      verify: ['node .agents/scripts/missing-aggregator.js'],
    }),
  ];
  assert.throws(
    () =>
      validateAcFreshness({
        tickets,
        baseBranchRef: 'main',
        gitRunner: fakeGitRunner([
          '.agents/scripts/lib/orchestration/ticket-validator.js',
        ]),
      }),
    (err) => {
      assert.ok(err instanceof ValidationError);
      assert.match(err.message, /missing-aggregator\.js/);
      return true;
    },
  );
});

test('validateAcFreshness: object-form `{path, assumption: "exists"}` in body.references is unioned in', () => {
  // The new shape also covers read-only dependencies declared via
  // `body.references`. A path declared as a read-dependency by the
  // planner is intentional; citing it in `goal`/`verify` must not trip
  // the freshness gate.
  const tickets = [
    makeStory('T1', {
      goal: 'Wire generate-foo.js against .agents/schemas/foo.schema.json',
      changes: [
        { path: '.agents/scripts/generate-foo.js', assumption: 'creates' },
      ],
      // The schema is read-only, declared via references, and absent
      // from main from the fake-runner's perspective. The gate must
      // still accept the goal-line citation because references unions
      // into the expected-new set.
      references: [
        {
          path: '.agents/scripts/lib/freshly-authored.js',
          assumption: 'exists',
        },
      ],
      acceptance: ['generator emits a Markdown table'],
      verify: ['node .agents/scripts/generate-foo.js'],
    }),
  ];
  assert.doesNotThrow(() =>
    validateAcFreshness({
      tickets,
      baseBranchRef: 'main',
      // Empty fixture: every probe would return false. The pass-through
      // proves the references-declared path joined the expected-new set.
      gitRunner: () => false,
    }),
  );
});

test('validateAcFreshness: mixed string + object form in the same body.changes array', () => {
  // Backwards compat: planners (and tests) emitting a mix of the two
  // shapes during the migration window must work too.
  const tickets = [
    makeStory('T1', {
      goal: 'Half-migrated planner output.',
      changes: [
        'tests/lib/legacy-bullet.test.js: new coverage',
        {
          path: '.agents/scripts/generate-new-thing.js',
          assumption: 'creates',
        },
      ],
      acceptance: ['both paths covered'],
      verify: [
        'node --test tests/lib/legacy-bullet.test.js',
        'node .agents/scripts/generate-new-thing.js',
      ],
    }),
  ];
  assert.doesNotThrow(() =>
    validateAcFreshness({
      tickets,
      baseBranchRef: 'main',
      gitRunner: () => false,
    }),
  );
});

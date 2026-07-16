import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAndNormalizeTickets } from '../.agents/scripts/lib/orchestration/ticket-validator.js';
import { serialize } from '../.agents/scripts/lib/story-body/story-body.js';

/**
 * 2-tier ticket hierarchy (Story #4041): the backlog is a flat Story
 * array attached directly to the Epic, with every Story carrying its own
 * inline `acceptance[]` + `verify[]` contract. There is no Feature or
 * Task tier.
 */
function makeStory(slug, extras = {}) {
  return {
    slug,
    type: 'story',
    title: `Story ${slug}`,
    acceptance: ['Observable criterion is met.'],
    verify: ['node --test'],
    ...extras,
  };
}

test('ticket-validator: basic valid backlog', () => {
  const tickets = [
    makeStory('S1', { labels: ['complexity::fast'] }),
    makeStory('S2', { labels: ['complexity::fast'] }),
  ];

  const result = validateAndNormalizeTickets(tickets);
  assert.equal(result.length, 2);
});

test('ticket-validator: fails on a retired Feature ticket', () => {
  assert.throws(
    () =>
      validateAndNormalizeTickets([
        { slug: 'F1', type: 'feature', title: 'Feature 1' },
        makeStory('S1'),
        makeStory('S2'),
      ]),
    /are not Stories/,
  );
});

test('ticket-validator: fails on duplicate slug', () => {
  const tickets = [
    makeStory('S1', { labels: ['complexity::fast'] }),
    makeStory('S1', { title: 'Story 1 duplicate' }),
  ];
  assert.throws(
    () => validateAndNormalizeTickets(tickets),
    /Duplicate slug "S1"/,
  );
});

test('ticket-validator: fails when a Story lacks an inline acceptance + verify contract', () => {
  // A Story with no top-level acceptance/verify is the legacy shape that
  // expected child Tasks. With the Task tier removed, such a Story is
  // unimplementable and is rejected outright.
  const tickets = [
    {
      slug: 'S1',
      type: 'story',
      title: 'Story with no inline contract',
      labels: ['complexity::fast'],
    },
    makeStory('S2', { title: 'Well-formed story' }),
  ];
  assert.throws(
    () => validateAndNormalizeTickets(tickets),
    /lack an inline acceptance \+ verify contract/,
  );
});

test('ticket-validator: accepts a 2-tier Story (inline acceptance + verify)', () => {
  // The canonical 2-tier Story carries inline acceptance + verify and is
  // the implementation unit itself.
  const tickets = [
    makeStory('S1', {
      title: '2-tier story',
      labels: ['complexity::fast'],
      acceptance: ['Observable criterion is met.'],
      verify: ['node --test tests/foo.test.js'],
    }),
    // Second well-formed Story.
    makeStory('S2', {
      title: '2-tier story sibling',
      labels: ['complexity::fast'],
      acceptance: ['Another observable criterion is met.'],
      verify: ['node --test tests/bar.test.js'],
    }),
  ];
  const result = validateAndNormalizeTickets(tickets);
  assert.equal(result.length, 2);
});

test('ticket-validator: empty inline arrays do not satisfy the contract', () => {
  // Empty `acceptance` / `verify` arrays must not satisfy the inline
  // contract — both arrays must be non-empty.
  const tickets = [
    {
      slug: 'S1',
      type: 'story',
      title: 'Empty arrays',
      acceptance: [],
      verify: [],
    },
    // Valid sibling Story; the inline-contract gate is what fires.
    makeStory('S2', { title: 'Well-formed sibling' }),
  ];
  assert.throws(
    () => validateAndNormalizeTickets(tickets),
    /lack an inline acceptance \+ verify contract/,
  );
  // A Story with only `acceptance` (no `verify`) is incomplete and must
  // still fail — the contract requires both arrays.
  const onlyAcceptance = [
    {
      slug: 'S1',
      type: 'story',
      title: 'Incomplete',
      acceptance: ['Done.'],
    },
    makeStory('S2', { title: 'Well-formed sibling' }),
  ];
  assert.throws(
    () => validateAndNormalizeTickets(onlyAcceptance),
    /lack an inline acceptance \+ verify contract/,
  );
});

test('ticket-validator: reports all contract-less stories in one error', () => {
  const tickets = [
    {
      slug: 'S1',
      type: 'story',
      title: 'Empty A',
      labels: ['complexity::fast'],
    },
    {
      slug: 'S2',
      type: 'story',
      title: 'Empty B',
      labels: ['complexity::fast'],
    },
    makeStory('S3', { title: 'Well-formed' }),
  ];
  assert.throws(
    () => validateAndNormalizeTickets(tickets),
    /2 Story\/Stories.*Empty A.*Empty B/s,
  );
});

test('ticket-validator: honors explicit cross-story dependencies', () => {
  const tickets = [
    makeStory('S1', { labels: ['complexity::fast'] }),
    makeStory('S2', {
      labels: ['complexity::fast'],
      depends_on: ['S1'],
    }),
  ];

  const result = validateAndNormalizeTickets(tickets);
  const s2 = result.find((t) => t.slug === 'S2');

  assert.ok(s2.depends_on.includes('S1'), 'Story 2 should depend on Story 1');
});

test('ticket-validator: detects cycles', () => {
  const tickets = [
    makeStory('S1', {
      labels: ['complexity::fast'],
      depends_on: ['S2'],
    }),
    makeStory('S2', {
      labels: ['complexity::fast'],
      depends_on: ['S1'],
    }),
  ];

  assert.throws(
    () => validateAndNormalizeTickets(tickets),
    /Circular dependency detected/,
  );
});

test('ticket-validator: fails fast on unknown depends_on slug', () => {
  const tickets = [
    makeStory('S1', {
      labels: ['complexity::fast'],
      depends_on: ['MISSING'],
    }),
    // Valid sibling Story; the unknown-deps gate is what fires.
    makeStory('S2', { labels: ['complexity::fast'] }),
  ];
  assert.throws(() => validateAndNormalizeTickets(tickets), /unknown slugs/);
});

test('ticket-validator: shared probe cache — each path probed once across both gates', () => {
  // Arrange: two Stories where the same path appears in one Story's AC text
  // (scanned by validateAcFreshness) and another Story's body.changes
  // assumption (scanned by validateStoryFileAssumptions). The shared
  // memoized runner should invoke the underlying probe exactly once per
  // unique (baseBranchRef, path) pair, not once per validator.
  const probeCalls = [];
  const gitRunner = ({ baseBranchRef, path }) => {
    probeCalls.push(`${baseBranchRef}:${path}`);
    // Simulate the path existing so neither gate raises an error.
    return true;
  };

  const sharedPath = '.agents/scripts/lib/orchestration/ticket-validator.js';

  const tickets = [
    makeStory('S1', {
      // body.changes object-form triggers validateStoryFileAssumptions
      body: {
        goal: 'refactor the validator',
        changes: [{ path: sharedPath, assumption: 'refactors-existing' }],
        acceptance: ['Observable outcome is met.'],
        verify: ['node --test'],
      },
      acceptance: ['Observable outcome is met.'],
      verify: ['node --test'],
    }),
    makeStory('S2', {
      // AC text references the same path — triggers validateAcFreshness
      acceptance: [`The change is consistent with \`${sharedPath}\` exports.`],
      verify: ['node --test'],
    }),
  ];

  validateAndNormalizeTickets(tickets, {
    baseBranchRef: 'main',
    gitRunner,
  });

  // Each unique path should be probed at most once, even though two
  // validators both inspect the same path.
  const uniqueCalls = [...new Set(probeCalls)];
  assert.deepEqual(
    uniqueCalls,
    probeCalls,
    `Expected each path to be probed once; got ${probeCalls.length} calls for ${uniqueCalls.length} unique paths`,
  );
});

/**
 * Story #4541 — the canonical authoring shape is a **serialized string
 * body** with `acceptance[]` at the ticket's **top level**. Two gates read
 * the body only, so on every real plan they scanned nothing and passed
 * vacuously. These tests drive that exact shape rather than mirroring the
 * criteria into both places (which is what hid the defect).
 */

/** Build a Story in the canonical shape: string body, top-level contract. */
function canonicalStory(slug, { acceptance, body }) {
  return {
    slug,
    type: 'story',
    title: `Story ${slug}`,
    acceptance,
    verify: ['npm test (validate)'],
    body:
      body ??
      serialize({
        goal: `Deliver ${slug}.`,
        changes: [
          {
            path: '.agents/scripts/plan-persist.js',
            assumption: 'refactors-existing',
          },
        ],
      }),
  };
}

test('subject-prefix gate fires on the canonical shape (string body + top-level acceptance)', () => {
  const tickets = [
    canonicalStory('S1', {
      acceptance: [
        "Commit subject begins with 'baseline-refresh:' (forbidden)",
      ],
    }),
  ];
  let caught;
  try {
    validateAndNormalizeTickets(tickets);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, 'the gate must fire — it used to skip this shape entirely');
  assert.equal(caught.code, 'forbidden-subject-prefix');
  assert.equal(caught.violations[0].slug, 'S1');
});

test('subject-prefix gate passes a valid type on the canonical shape', () => {
  assert.doesNotThrow(() =>
    validateAndNormalizeTickets([
      canonicalStory('S1', {
        acceptance: [
          "Commit subject begins with 'chore(baselines):' for the refresh",
        ],
      }),
    ]),
  );
});

test('an unparseable body fails as a named body error, not a freshness miss', () => {
  // The defect: collectTaskChangesPaths swallowed the parse failure and
  // returned an empty whitelist, so the freshness gate then reported "files
  // do not exist at main" naming the very paths the Story *had* declared.
  const declaredPath = '.agents/scripts/lib/duplicate-search.js';
  const malformed = [
    '## Goal',
    '',
    'Fix the duplicate search.',
    '',
    '## Changes',
    '',
    `- just a prose bullet about ${declaredPath}`,
    '',
  ].join('\n');

  let caught;
  try {
    validateAndNormalizeTickets(
      [canonicalStory('S1', { acceptance: ['It works.'], body: malformed })],
      { baseBranchRef: 'main', gitRunner: () => false },
    );
  } catch (err) {
    caught = err;
  }

  assert.ok(caught);
  assert.equal(caught.code, 'story-body-unparseable');
  // Names the offending section and entry...
  assert.match(caught.message, /## changes/);
  assert.match(caught.message, /just a prose bullet/);
  // ...and is NOT the misleading stale-path diagnosis.
  assert.doesNotMatch(caught.message, /do not exist at main/);
  assert.equal(caught.violations[0].slug, 'S1');
  assert.equal(caught.violations[0].section, 'changes');
});

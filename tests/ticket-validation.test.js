import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAndNormalizeTickets } from '../.agents/scripts/lib/orchestration/ticket-validator.js';

/**
 * 3-tier ticket hierarchy (Epic #3238): the backlog is
 * Feature → Story, with every Story carrying its own inline
 * `acceptance[]` + `verify[]` contract. There is no Task tier.
 */
function makeStory(slug, parentSlug, extras = {}) {
  return {
    slug,
    type: 'story',
    title: `Story ${slug}`,
    parent_slug: parentSlug,
    acceptance: ['Observable criterion is met.'],
    verify: ['node --test'],
    ...extras,
  };
}

test('ticket-validator: basic valid hierarchy', () => {
  // Story #3777 — every Feature MUST carry >=2 Stories, so the canonical
  // valid hierarchy has two Stories under F1.
  const tickets = [
    { slug: 'F1', type: 'feature', title: 'Feature 1' },
    makeStory('S1', 'F1', { labels: ['complexity::fast'] }),
    makeStory('S2', 'F1', { labels: ['complexity::fast'] }),
  ];

  const result = validateAndNormalizeTickets(tickets);
  assert.equal(result.length, 3);
});

test('ticket-validator: fails on missing types', () => {
  assert.throws(
    () => validateAndNormalizeTickets([{ slug: 'F1', type: 'feature' }]),
    /must contain at least one Story/,
  );
});

test('ticket-validator: fails on missing parent', () => {
  const tickets = [
    { slug: 'F1', type: 'feature', title: 'Feature 1' },
    makeStory('S1', undefined, { labels: ['complexity::fast'] }),
  ];
  assert.throws(
    () => validateAndNormalizeTickets(tickets),
    /must have a parent_slug/,
  );
});

test('ticket-validator: fails on duplicate slug', () => {
  const tickets = [
    { slug: 'F1', type: 'feature', title: 'Feature 1' },
    makeStory('S1', 'F1', { labels: ['complexity::fast'] }),
    makeStory('S1', 'F1', { title: 'Story 1 duplicate' }),
  ];
  assert.throws(
    () => validateAndNormalizeTickets(tickets),
    /Duplicate slug "S1"/,
  );
});

test('ticket-validator: fails when a Story lacks an inline acceptance + verify contract', () => {
  // 3-tier (Epic #3238): a Story with no top-level acceptance/verify is
  // the legacy 4-tier shape that expected child Tasks. With the Task tier
  // removed, such a Story is unimplementable and is rejected outright.
  const tickets = [
    { slug: 'F1', type: 'feature', title: 'Feature 1' },
    {
      slug: 'S1',
      type: 'story',
      title: 'Story with no inline contract',
      parent_slug: 'F1',
      labels: ['complexity::fast'],
    },
    makeStory('S2', 'F1', { title: 'Well-formed story' }),
  ];
  assert.throws(
    () => validateAndNormalizeTickets(tickets),
    /lack an inline acceptance \+ verify contract/,
  );
});

test('ticket-validator: accepts a 3-tier Story (inline acceptance + verify)', () => {
  // The canonical 3-tier Story carries inline acceptance + verify and is
  // the implementation unit itself.
  const tickets = [
    { slug: 'F1', type: 'feature', title: 'Feature 1' },
    makeStory('S1', 'F1', {
      title: '3-tier story',
      labels: ['complexity::fast'],
      acceptance: ['Observable criterion is met.'],
      verify: ['node --test tests/foo.test.js'],
    }),
    // Story #3777 — second Story so F1 satisfies the >=2-Story invariant.
    makeStory('S2', 'F1', {
      title: '3-tier story sibling',
      labels: ['complexity::fast'],
      acceptance: ['Another observable criterion is met.'],
      verify: ['node --test tests/bar.test.js'],
    }),
  ];
  const result = validateAndNormalizeTickets(tickets);
  assert.equal(result.length, 3);
});

test('ticket-validator: empty inline arrays do not satisfy the contract', () => {
  // Empty `acceptance` / `verify` arrays must not satisfy the inline
  // contract — both arrays must be non-empty.
  const tickets = [
    { slug: 'F1', type: 'feature', title: 'Feature 1' },
    {
      slug: 'S1',
      type: 'story',
      title: 'Empty arrays',
      parent_slug: 'F1',
      acceptance: [],
      verify: [],
    },
    // Story #3777 — valid sibling so F1 has >=2 Stories; the inline-contract
    // gate (not the single-Story-Feature gate) is what fires.
    makeStory('S2', 'F1', { title: 'Well-formed sibling' }),
  ];
  assert.throws(
    () => validateAndNormalizeTickets(tickets),
    /lack an inline acceptance \+ verify contract/,
  );
  // A Story with only `acceptance` (no `verify`) is incomplete and must
  // still fail — the contract requires both arrays.
  const onlyAcceptance = [
    { slug: 'F1', type: 'feature', title: 'Feature' },
    {
      slug: 'S1',
      type: 'story',
      title: 'Incomplete',
      parent_slug: 'F1',
      acceptance: ['Done.'],
    },
    makeStory('S2', 'F1', { title: 'Well-formed sibling' }),
  ];
  assert.throws(
    () => validateAndNormalizeTickets(onlyAcceptance),
    /lack an inline acceptance \+ verify contract/,
  );
});

test('ticket-validator: reports all contract-less stories in one error', () => {
  const tickets = [
    { slug: 'F1', type: 'feature', title: 'Feature 1' },
    {
      slug: 'S1',
      type: 'story',
      title: 'Empty A',
      parent_slug: 'F1',
      labels: ['complexity::fast'],
    },
    {
      slug: 'S2',
      type: 'story',
      title: 'Empty B',
      parent_slug: 'F1',
      labels: ['complexity::fast'],
    },
    makeStory('S3', 'F1', { title: 'Well-formed' }),
  ];
  assert.throws(
    () => validateAndNormalizeTickets(tickets),
    /2 Story\/Stories.*Empty A.*Empty B/s,
  );
});

test('ticket-validator: honors explicit cross-story dependencies', () => {
  const tickets = [
    { slug: 'F1', type: 'feature', title: 'Feature' },
    makeStory('S1', 'F1', { labels: ['complexity::fast'] }),
    makeStory('S2', 'F1', {
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
    { slug: 'F1', type: 'feature', title: 'Feature' },
    makeStory('S1', 'F1', {
      labels: ['complexity::fast'],
      depends_on: ['S2'],
    }),
    makeStory('S2', 'F1', {
      labels: ['complexity::fast'],
      depends_on: ['S1'],
    }),
  ];

  assert.throws(
    () => validateAndNormalizeTickets(tickets),
    /Circular dependency detected/,
  );
});

test('ticket-validator: fails on missing Feature', () => {
  assert.throws(
    () => validateAndNormalizeTickets([{ slug: 'S1', type: 'story' }]),
    /must contain at least one Feature/,
  );
});

test('ticket-validator: fails if story parent is not a feature', () => {
  const tickets = [
    { slug: 'F1', type: 'feature' },
    makeStory('S0', 'F1'),
    makeStory('S1', 'S0', { labels: ['complexity::fast'] }),
  ];
  assert.throws(
    () => validateAndNormalizeTickets(tickets),
    /parent must be a Feature/,
  );
});

test('ticket-validator: fails fast on unknown depends_on slug', () => {
  const tickets = [
    { slug: 'F1', type: 'feature', title: 'Feature 1' },
    makeStory('S1', 'F1', {
      labels: ['complexity::fast'],
      depends_on: ['MISSING'],
    }),
    // Story #3777 — valid sibling so F1 has >=2 Stories; the unknown-deps
    // gate (not the single-Story-Feature gate) is what fires.
    makeStory('S2', 'F1', { labels: ['complexity::fast'] }),
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
    { slug: 'F1', type: 'feature', title: 'Feature 1' },
    makeStory('S1', 'F1', {
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
    makeStory('S2', 'F1', {
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

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
  const tickets = [
    { slug: 'F1', type: 'feature', title: 'Feature 1' },
    makeStory('S1', 'F1', { labels: ['complexity::fast'] }),
  ];

  const result = validateAndNormalizeTickets(tickets);
  assert.equal(result.length, 2);
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
  ];
  const result = validateAndNormalizeTickets(tickets);
  assert.equal(result.length, 2);
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
  ];
  assert.throws(() => validateAndNormalizeTickets(tickets), /unknown slugs/);
});

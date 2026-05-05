import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAndNormalizeTickets } from '../.agents/scripts/lib/orchestration/ticket-validator.js';

test('ticket-validator: basic valid hierarchy', () => {
  const tickets = [
    { slug: 'F1', type: 'feature', title: 'Feature 1' },
    {
      slug: 'S1',
      type: 'story',
      title: 'Story 1',
      parent_slug: 'F1',
      labels: ['complexity::fast'],
    },
    { slug: 'T1', type: 'task', title: 'Task 1', parent_slug: 'S1' },
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
    {
      slug: 'S1',
      type: 'story',
      title: 'Story 1',
      labels: ['complexity::fast'],
    }, // missing parent_slug
    { slug: 'T1', type: 'task', title: 'Task 1', parent_slug: 'S1' },
  ];
  assert.throws(
    () => validateAndNormalizeTickets(tickets),
    /must have a parent_slug/,
  );
});

test('ticket-validator: fails on duplicate slug', () => {
  const tickets = [
    { slug: 'F1', type: 'feature', title: 'Feature 1' },
    {
      slug: 'S1',
      type: 'story',
      title: 'Story 1',
      parent_slug: 'F1',
      labels: ['complexity::fast'],
    },
    { slug: 'T1', type: 'task', title: 'Task 1', parent_slug: 'S1' },
    { slug: 'T1', type: 'task', title: 'Task 1 duplicate', parent_slug: 'S1' },
  ];
  assert.throws(
    () => validateAndNormalizeTickets(tickets),
    /Duplicate slug "T1"/,
  );
});

test('ticket-validator: fails when a Story has no child Tasks', () => {
  const tickets = [
    { slug: 'F1', type: 'feature', title: 'Feature 1' },
    {
      slug: 'S1',
      type: 'story',
      title: 'Story with no tasks',
      parent_slug: 'F1',
      labels: ['complexity::fast'],
    },
    {
      slug: 'S2',
      type: 'story',
      title: 'Story with a task',
      parent_slug: 'F1',
      labels: ['complexity::fast'],
    },
    { slug: 'T1', type: 'task', title: 'Task 1', parent_slug: 'S2' },
  ];
  assert.throws(
    () => validateAndNormalizeTickets(tickets),
    /Story.*have no child Tasks/,
  );
});

test('ticket-validator: reports all empty stories in one error', () => {
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
    {
      slug: 'S3',
      type: 'story',
      title: 'Has task',
      parent_slug: 'F1',
      labels: ['complexity::fast'],
    },
    { slug: 'T1', type: 'task', title: 'Task 1', parent_slug: 'S3' },
  ];
  assert.throws(
    () => validateAndNormalizeTickets(tickets),
    /2 Story\/Stories.*Empty A.*Empty B/s,
  );
});

test('ticket-validator: lifts cross-story dependencies', () => {
  const tickets = [
    { slug: 'F1', type: 'feature', title: 'Feature' },
    {
      slug: 'S1',
      type: 'story',
      title: 'Story 1',
      parent_slug: 'F1',
      labels: ['complexity::fast'],
    },
    {
      slug: 'S2',
      type: 'story',
      title: 'Story 2',
      parent_slug: 'F1',
      labels: ['complexity::fast'],
    },
    { slug: 'T1', type: 'task', title: 'Task 1', parent_slug: 'S1' },
    {
      slug: 'T2',
      type: 'task',
      title: 'Task 2',
      parent_slug: 'S2',
      depends_on: ['T1'],
    },
  ];

  const result = validateAndNormalizeTickets(tickets);
  const s2 = result.find((t) => t.slug === 'S2');
  const t2 = result.find((t) => t.slug === 'T2');

  assert.ok(
    s2.depends_on.includes('S1'),
    'Story 2 should now depend on Story 1',
  );
  assert.strictEqual(
    t2.depends_on.length,
    0,
    'Task 2 cross-story dependency should be removed from task level',
  );
});

test('ticket-validator: detects cycles', () => {
  const tickets = [
    { slug: 'F1', type: 'feature', title: 'Feature' },
    {
      slug: 'S1',
      type: 'story',
      title: 'Story 1',
      parent_slug: 'F1',
      labels: ['complexity::fast'],
      depends_on: ['S2'],
    },
    {
      slug: 'S2',
      type: 'story',
      title: 'Story 2',
      parent_slug: 'F1',
      labels: ['complexity::fast'],
      depends_on: ['S1'],
    },
    { slug: 'T1', type: 'task', title: 'Task 1', parent_slug: 'S1' },
    { slug: 'T2', type: 'task', title: 'Task 2', parent_slug: 'S2' },
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

test('ticket-validator: fails on missing Task', () => {
  assert.throws(
    () =>
      validateAndNormalizeTickets([
        { slug: 'F1', type: 'feature' },
        {
          slug: 'S1',
          type: 'story',
          parent_slug: 'F1',
          labels: ['complexity::fast'],
        },
      ]),
    /must contain at least one Task/,
  );
});

test('ticket-validator: fails if story parent is not a feature', () => {
  const tickets = [
    { slug: 'F1', type: 'feature' },
    { slug: 'T0', type: 'task' },
    {
      slug: 'S1',
      type: 'story',
      parent_slug: 'T0',
      labels: ['complexity::fast'],
    },
    { slug: 'T1', type: 'task', parent_slug: 'S1' },
  ];
  assert.throws(
    () => validateAndNormalizeTickets(tickets),
    /parent must be a Feature/,
  );
});

test('ticket-validator: fails if task parent is not a story', () => {
  const tickets = [
    { slug: 'F1', type: 'feature' },
    {
      slug: 'S1',
      type: 'story',
      parent_slug: 'F1',
      labels: ['complexity::fast'],
    },
    { slug: 'T1', type: 'task', parent_slug: 'F1' },
  ];
  assert.throws(
    () => validateAndNormalizeTickets(tickets),
    /parent must be a Story/,
  );
});

test('ticket-validator: fails fast on unknown depends_on slug (previously deferred to decomposer)', () => {
  const tickets = [
    { slug: 'F1', type: 'feature', title: 'Feature 1' },
    {
      slug: 'S1',
      type: 'story',
      title: 'Story 1',
      parent_slug: 'F1',
      labels: ['complexity::fast'],
    },
    {
      slug: 'T1',
      type: 'task',
      title: 'Task 1',
      parent_slug: 'S1',
      depends_on: ['MISSING'],
    },
  ];
  assert.throws(() => validateAndNormalizeTickets(tickets), /unknown slugs/);
});

test('ticket-validator: keeps cross-story deps on non-task tickets', () => {
  const tickets = [
    { slug: 'F1', type: 'feature' },
    {
      slug: 'S1',
      type: 'story',
      parent_slug: 'F1',
      labels: ['complexity::fast'],
    },
    {
      slug: 'S2',
      type: 'story',
      parent_slug: 'F1',
      labels: ['complexity::fast'],
    },
    { slug: 'T1', type: 'task', parent_slug: 'S1', depends_on: ['S2'] },
    { slug: 'T2', type: 'task', parent_slug: 'S2' },
  ];
  const result = validateAndNormalizeTickets(tickets);
  assert.ok(result.find((t) => t.slug === 'T1').depends_on.includes('S2'));
});

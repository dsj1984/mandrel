import assert from 'node:assert';
import { test } from 'node:test';
import {
  buildTaskGraph,
  hasInlineAcceptance,
  sortTasksByDependencies,
} from '../../../.agents/scripts/lib/story-init/task-graph-builder.js';

function mkTask(
  id,
  { body = '', title = `t${id}`, labels = ['type::task'] } = {},
) {
  return { id, title, labels, body };
}

test('sortTasksByDependencies returns input unchanged for 0/1 tasks', () => {
  assert.deepStrictEqual(sortTasksByDependencies([]), []);
  const one = [mkTask(1)];
  assert.deepStrictEqual(sortTasksByDependencies(one), one);
});

test('sortTasksByDependencies honours blocked-by references between siblings', () => {
  const tasks = [
    mkTask(1, { body: 'blocked by #2' }),
    mkTask(2),
    mkTask(3, { body: 'blocked by #1' }),
  ];
  const sorted = sortTasksByDependencies(tasks);
  const order = sorted.map((t) => t.id);
  assert.ok(order.indexOf(2) < order.indexOf(1));
  assert.ok(order.indexOf(1) < order.indexOf(3));
});

test('sortTasksByDependencies throws on cycles', () => {
  const tasks = [
    mkTask(1, { body: 'blocked by #2' }),
    mkTask(2, { body: 'blocked by #1' }),
  ];
  assert.throws(
    () => sortTasksByDependencies(tasks),
    /Dependency cycle detected/,
  );
});

test('buildTaskGraph warns on empty child task list', async () => {
  const warnings = [];
  const provider = {
    async getSubTickets() {
      return [];
    },
  };
  const out = await buildTaskGraph({
    provider,
    logger: { warn: (m) => warnings.push(m), progress: () => {} },
    input: { storyId: 123 },
  });
  assert.deepStrictEqual(out.sortedTasks, []);
  assert.ok(warnings.some((w) => w.includes('no child Tasks')));
});

test('buildTaskGraph returns topologically-sorted tasks from the provider', async () => {
  const provider = {
    async getSubTickets(_storyId) {
      return [mkTask(1, { body: 'blocked by #2' }), mkTask(2)];
    },
  };
  const out = await buildTaskGraph({
    provider,
    input: { storyId: 1 },
  });
  assert.deepStrictEqual(
    out.sortedTasks.map((t) => t.id),
    [2, 1],
  );
  assert.strictEqual(out.mode, '4-tier');
});

// ---------------------------------------------------------------------------
// 3-tier (inline-acceptance) behaviour — Story #3121.
// ---------------------------------------------------------------------------

test('hasInlineAcceptance detects `## Acceptance` heading with bullets', () => {
  assert.strictEqual(
    hasInlineAcceptance('## Acceptance\n- item one\n- item two\n'),
    true,
  );
  assert.strictEqual(
    hasInlineAcceptance('## Acceptance Criteria\n* a\n* b\n'),
    true,
  );
});

test('hasInlineAcceptance returns false without an Acceptance section', () => {
  assert.strictEqual(hasInlineAcceptance(''), false);
  assert.strictEqual(hasInlineAcceptance('## Goal\n- a\n'), false);
});

test('hasInlineAcceptance returns false when section has no bullets', () => {
  assert.strictEqual(
    hasInlineAcceptance('## Acceptance\n\n## Verify\n- v\n'),
    false,
  );
});

test('buildTaskGraph treats empty Task list as expected when Story has inline acceptance', async () => {
  const warnings = [];
  const progress = [];
  const provider = {
    async getSubTickets() {
      return [];
    },
  };
  const out = await buildTaskGraph({
    provider,
    logger: {
      warn: (m) => warnings.push(m),
      progress: (phase, msg) => progress.push([phase, msg]),
    },
    input: {
      storyId: 3121,
      storyBody: '## Acceptance\n- foo works\n- bar works\n',
    },
  });
  assert.deepStrictEqual(out.sortedTasks, []);
  assert.strictEqual(out.mode, '3-tier');
  // Must NOT emit the scary "no child Tasks" warning when the Story
  // is authored in the 3-tier shape.
  assert.deepStrictEqual(warnings, []);
  // Must instead emit a TASKS progress message that names inline acceptance.
  assert.ok(
    progress.some(
      ([phase, msg]) => phase === 'TASKS' && /inline acceptance/i.test(msg),
    ),
    `expected an inline-acceptance progress message, got: ${JSON.stringify(progress)}`,
  );
});

test('buildTaskGraph still warns on empty Task list for a Story without inline acceptance', async () => {
  const warnings = [];
  const provider = {
    async getSubTickets() {
      return [];
    },
  };
  const out = await buildTaskGraph({
    provider,
    logger: { warn: (m) => warnings.push(m), progress: () => {} },
    input: { storyId: 3121, storyBody: '## Goal\nDo a thing.\n' },
  });
  assert.deepStrictEqual(out.sortedTasks, []);
  assert.strictEqual(out.mode, '4-tier');
  assert.ok(warnings.some((w) => w.includes('no child Tasks')));
});

test('buildTaskGraph enumerates child Tasks normally when Story has both inline acceptance AND child Tasks', async () => {
  // Defensive: if a Story body somehow has an Acceptance section but the
  // ticket also has child Tasks (mixed shape during migration), the Tasks
  // MUST still be returned. No regression on AC2.
  const provider = {
    async getSubTickets() {
      return [mkTask(1), mkTask(2, { body: 'blocked by #1' })];
    },
  };
  const out = await buildTaskGraph({
    provider,
    input: {
      storyId: 3121,
      storyBody: '## Acceptance\n- foo\n',
    },
  });
  assert.deepStrictEqual(
    out.sortedTasks.map((t) => t.id),
    [1, 2],
  );
  assert.strictEqual(out.mode, '4-tier');
});

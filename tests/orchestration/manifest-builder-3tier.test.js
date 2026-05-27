/**
 * Contract tests for the orchestration `manifest-builder.js` Story-only
 * path (Epic #3078 / Story #3118 / Task #3133).
 *
 * Locks the two-shape branching in `buildManifest`:
 *
 *   1. **3-tier** inputs (no `type::task` tickets, at least one
 *      `type::story`) emit `waves[].stories[]` and a Story-only
 *      `storyManifest`. `groupTasksByStory` from `story-grouper.js`
 *      MUST NOT be invoked.
 *
 *   2. **4-tier** inputs (the current default) continue to emit the
 *      Task-grouped `waves[].tasks[]` shape — and the output is
 *      byte-equivalent to the pre-3-tier behaviour for a frozen fixture.
 *
 * These tests are pure-input contract tests: they pass fixture-shaped
 * tickets directly to `buildManifest` so the projection is locked
 * independent of dispatch-pipeline wiring (Story 3.2+ handles that).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildManifest } from '../../.agents/scripts/lib/orchestration/manifest-builder.js';

const EPIC_ID = 9000;

function makeEpic() {
  return { id: EPIC_ID, title: 'Test Epic', body: '', labels: ['type::epic'] };
}

function makeStory(id, overrides = {}) {
  return {
    id,
    title: `Story ${id}`,
    body: [
      '## Acceptance',
      `- [ ] Story ${id} ships`,
      '',
      '## Verify',
      `- node --test tests/story-${id}.test.js`,
      '',
      `parent: #100`,
      `Epic: #${EPIC_ID}`,
    ].join('\n'),
    labels: ['type::story', 'persona::engineer', 'agent::ready'],
    ...overrides,
  };
}

function makeTask(id, parentStoryId, dependsOn = []) {
  return {
    id,
    title: `Task ${id}`,
    body: `parent: #${parentStoryId}`,
    status: 'agent::ready',
    labels: ['type::task', 'agent::ready'],
    persona: 'engineer',
    mode: 'fast',
    skills: [],
    focusAreas: [],
    dependsOn,
  };
}

test('3-tier: buildManifest emits waves[].stories[] when input has only Stories', () => {
  const epic = makeEpic();
  const storyA = makeStory(3098);
  const storyB = makeStory(3099, {
    body: [
      '## Acceptance',
      '- [ ] B ships',
      '',
      '## Verify',
      '- node --test',
      '',
      'blocked by #3098',
    ].join('\n'),
  });

  const allTickets = [epic, storyA, storyB];
  const waves = [[storyA], [storyB]];

  const manifest = buildManifest({
    epicId: EPIC_ID,
    epic,
    tasks: [],
    allTickets,
    waves,
    dispatched: [],
    dryRun: false,
  });

  // Story-only waves: no tasks key, stories key present.
  assert.equal(manifest.waves.length, 2);
  for (const wave of manifest.waves) {
    assert.equal(wave.tasks, undefined, 'no waves[].tasks[] in 3-tier');
    assert.ok(Array.isArray(wave.stories), 'waves[].stories[] present');
  }

  // Inline acceptance/verify carried verbatim from the Story body.
  const w0Story = manifest.waves[0].stories[0];
  assert.equal(w0Story.storyId, 3098);
  assert.equal(w0Story.title, 'Story 3098');
  assert.equal(w0Story.persona, 'engineer');
  assert.deepEqual(w0Story.acceptance, ['Story 3098 ships']);
  assert.deepEqual(w0Story.verify, ['node --test tests/story-3098.test.js']);
  assert.deepEqual(w0Story.dependsOn, []);
  assert.equal(w0Story.branch, 'story-3098');

  // Story B picks up the body-level dependency from `blocked by #3098`.
  const w1Story = manifest.waves[1].stories[0];
  assert.equal(w1Story.storyId, 3099);
  assert.deepEqual(w1Story.dependsOn, [3098]);

  // Summary axis flips to story counts.
  assert.equal(manifest.summary.totalStories, 2);
  assert.equal(manifest.summary.doneStories, 0);
  assert.equal(manifest.summary.totalWaves, 2);
  assert.equal(manifest.hierarchy, '3-tier');

  // storyManifest is Story-only (no Task children).
  assert.equal(manifest.storyManifest.length, 2);
  for (const s of manifest.storyManifest) {
    assert.deepEqual(s.tasks, []);
    assert.equal(s.type, 'story');
  }
});

test('3-tier: story-grouper is bypassed (Stories with no `parent: #N` Feature ref still appear)', () => {
  // In 4-tier mode, `groupTasksByStory` walks each Task's `parent: #N`
  // line to find its Story container; Stories without a Task child
  // wouldn't appear in the storyManifest at all. In 3-tier we read
  // Stories directly from `allTickets`, so a Story with NO `parent: #N`
  // body marker (and no children of any kind) MUST still surface in
  // both `storyManifest` and `waves[].stories[]`.
  const epic = makeEpic();
  const orphanStory = {
    id: 3200,
    title: 'Orphan Story',
    // Deliberately omit `parent: #N` — groupTasksByStory would route
    // this Story to the `__ungrouped__` bucket with `tasks: []`.
    body: '## Acceptance\n- [ ] ships\n\n## Verify\n- node --test',
    labels: ['type::story', 'persona::engineer', 'agent::ready'],
  };

  const manifest = buildManifest({
    epicId: EPIC_ID,
    epic,
    tasks: [],
    allTickets: [epic, orphanStory],
    waves: [[orphanStory]],
    dispatched: [],
    dryRun: false,
  });

  // Story appears directly in storyManifest (proves groupTasksByStory
  // was bypassed — the grouper would never emit a Story-only entry from
  // an empty tasks[] input).
  assert.equal(manifest.storyManifest.length, 1);
  assert.equal(manifest.storyManifest[0].storyId, 3200);
  assert.equal(manifest.storyManifest[0].type, 'story');

  // And it appears in waves[].stories[].
  assert.equal(manifest.waves[0].stories[0].storyId, 3200);

  // No `__ungrouped__` artifact (the grouper's fallback bucket).
  assert.equal(
    manifest.storyManifest.find((s) => s.storyId === '__ungrouped__'),
    undefined,
    'no __ungrouped__ bucket — proves groupTasksByStory was not invoked',
  );
});

test('3-tier: explicit hierarchy:"3-tier" flag forces the Story-only path', () => {
  const epic = makeEpic();
  const story = makeStory(3098);

  const manifest = buildManifest({
    epicId: EPIC_ID,
    epic,
    tasks: [],
    allTickets: [epic, story],
    waves: [[story]],
    dispatched: [],
    dryRun: false,
    hierarchy: '3-tier',
  });

  assert.equal(manifest.hierarchy, '3-tier');
  assert.ok(Array.isArray(manifest.waves[0].stories));
});

test('4-tier: byte-equivalent manifest for a frozen Task-grouped fixture', () => {
  const epic = makeEpic();
  const story = makeStory(100, { id: 100, title: 'Parent Story' });
  const t1 = makeTask(101, 100);
  const t2 = makeTask(102, 100, [101]);

  const allTickets = [epic, story, t1, t2];
  const waves = [[t1], [t2]];

  // Pin generatedAt so the JSON serialisation is fully deterministic for the
  // byte-equivalence assertion.
  const fixedNow = '2026-05-27T00:00:00.000Z';
  const origNow = Date.now;
  const origToISO = Date.prototype.toISOString;
  Date.prototype.toISOString = function patched() {
    return this.getTime() === Date.now() ? fixedNow : origToISO.call(this);
  };
  Date.now = () => new Date(fixedNow).getTime();

  let manifest;
  try {
    manifest = buildManifest({
      epicId: EPIC_ID,
      epic,
      tasks: [t1, t2],
      allTickets,
      waves,
      dispatched: [],
      dryRun: false,
    });
  } finally {
    Date.now = origNow;
    Date.prototype.toISOString = origToISO;
  }

  // The 4-tier shape MUST keep emitting waves[].tasks[] with the established
  // field set (taskId, title, status, branch, persona, mode, skills,
  // focusAreas, dependsOn).
  assert.equal(manifest.waves.length, 2);
  for (const wave of manifest.waves) {
    assert.equal(wave.stories, undefined, 'no waves[].stories[] in 4-tier');
    assert.ok(Array.isArray(wave.tasks));
    for (const tk of wave.tasks) {
      assert.equal(typeof tk.taskId, 'number');
      assert.equal(typeof tk.title, 'string');
      assert.equal(typeof tk.branch, 'string');
      assert.equal(typeof tk.persona, 'string');
      assert.ok(Array.isArray(tk.skills));
    }
  }

  // 4-tier hierarchy is omitted (default branch path).
  assert.equal(manifest.hierarchy, undefined);
  assert.equal(manifest.summary.totalTasks, 2);
  assert.equal(manifest.summary.doneTasks, 0);
  assert.equal(manifest.summary.totalStories, undefined);

  // storyManifest reflects the Task-grouped projection.
  assert.equal(manifest.storyManifest.length, 1);
  assert.equal(manifest.storyManifest[0].storyId, 100);
  assert.equal(manifest.storyManifest[0].tasks.length, 2);
});

test('4-tier: explicit hierarchy:"4-tier" flag forces the Task-grouped path even if tasks: []', () => {
  const epic = makeEpic();
  const story = makeStory(3098);

  const manifest = buildManifest({
    epicId: EPIC_ID,
    epic,
    tasks: [],
    allTickets: [epic, story],
    waves: [],
    dispatched: [],
    dryRun: false,
    hierarchy: '4-tier',
  });

  // 4-tier explicit: even with stories present, no waves[].stories[] emit.
  assert.equal(manifest.hierarchy, undefined);
  assert.equal(manifest.summary.totalTasks, 0);
  assert.equal(manifest.summary.totalStories, undefined);
});

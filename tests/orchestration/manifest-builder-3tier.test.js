/**
 * Contract tests for the orchestration `manifest-builder.js` Story-only
 * producer.
 *
 * Epic #3163, Category 2 (Story #3187) deleted the legacy 4-tier branch
 * and the `groupTasksByStory` import from `story-grouper.js`. The
 * producer now reads Story tickets directly from `allTickets` and
 * always emits the `waves[].stories[]` + Story-only `storyManifest`
 * shape.
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
  // The legacy 4-tier `groupTasksByStory` walked each Task's `parent: #N`
  // line to find its Story container; a Story with no Task child would
  // not appear in `storyManifest` at all. The 3-tier producer reads
  // Stories directly from `allTickets`, so a Story with NO `parent: #N`
  // body marker (and no children of any kind) MUST still surface in
  // both `storyManifest` and `waves[].stories[]`.
  const epic = makeEpic();
  const orphanStory = {
    id: 3200,
    title: 'Orphan Story',
    // Deliberately omit `parent: #N`.
    body: '## Acceptance\n- [ ] ships\n\n## Verify\n- node --test',
    labels: ['type::story', 'persona::engineer', 'agent::ready'],
  };

  const manifest = buildManifest({
    epicId: EPIC_ID,
    epic,
    allTickets: [epic, orphanStory],
    waves: [[orphanStory]],
    dispatched: [],
    dryRun: false,
  });

  // Story appears directly in storyManifest.
  assert.equal(manifest.storyManifest.length, 1);
  assert.equal(manifest.storyManifest[0].storyId, 3200);
  assert.equal(manifest.storyManifest[0].type, 'story');

  // And it appears in waves[].stories[].
  assert.equal(manifest.waves[0].stories[0].storyId, 3200);

  // No `__ungrouped__` artifact (the legacy grouper's fallback bucket).
  assert.equal(
    manifest.storyManifest.find((s) => s.storyId === '__ungrouped__'),
    undefined,
    'no __ungrouped__ bucket — proves story-grouper is no longer wired in',
  );
});

test('Story-only graph emits the 3-tier manifest shape unconditionally', () => {
  const epic = makeEpic();
  const story = makeStory(3098);

  const manifest = buildManifest({
    epicId: EPIC_ID,
    epic,
    allTickets: [epic, story],
    waves: [[story]],
    dispatched: [],
    dryRun: false,
  });

  assert.equal(manifest.hierarchy, '3-tier');
  assert.ok(Array.isArray(manifest.waves[0].stories));
  assert.equal(manifest.summary.totalStories, 1);
  assert.equal(manifest.summary.totalTasks, undefined);
});

test('Task-bearing inputs are ignored — producer is Story-only', () => {
  // Epic #3163 deleted the 4-tier branch. Even if a caller still passes
  // Task tickets in `allTickets`, the producer filters to `type::story`
  // and emits the 3-tier shape. No `waves[].tasks[]` is ever produced.
  const epic = makeEpic();
  const story = makeStory(100, { id: 100, title: 'Parent Story' });
  const taskTicket = {
    id: 101,
    title: 'Stale Task',
    body: 'parent: #100',
    status: 'agent::ready',
    labels: ['type::task', 'agent::ready'],
  };

  const manifest = buildManifest({
    epicId: EPIC_ID,
    epic,
    allTickets: [epic, story, taskTicket],
    waves: [[story]],
    dispatched: [],
    dryRun: false,
  });

  assert.equal(manifest.hierarchy, '3-tier');
  assert.equal(manifest.summary.totalStories, 1);
  assert.equal(manifest.summary.totalTasks, undefined);
  assert.ok(Array.isArray(manifest.waves[0].stories));
  assert.equal(manifest.waves[0].tasks, undefined);
  // Task ticket is filtered out of the Story-only storyManifest.
  assert.equal(manifest.storyManifest.length, 1);
  assert.equal(manifest.storyManifest[0].storyId, 100);
});

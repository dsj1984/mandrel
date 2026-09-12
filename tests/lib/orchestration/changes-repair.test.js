/**
 * tests/lib/orchestration/changes-repair.test.js — the `changes[]` repair
 * pass persist runs before judging (Story #5312, AC-5).
 *
 * A plain-string bullet or a trailing parenthetical is rewritten into
 * `{ path, assumption }` by probing the base branch, on both authoring
 * surfaces, and every repair is reported. A string nothing path-shaped can
 * be salvaged from is left alone for the body-shape validator to refuse.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  renderChangeRepair,
  repairChangeEntries,
} from '../../../.agents/scripts/lib/orchestration/plan-persist/changes-repair.js';
import { parse as parseStoryBody } from '../../../.agents/scripts/lib/story-body/story-body.js';

/** Base branch fixture: exactly these paths exist. */
const AT_BASE = new Set(['src/existing.js', 'lib/old.js']);
const existsAtBase = (path) => AT_BASE.has(path);

function objectStory(changes) {
  return {
    slug: 'obj',
    type: 'story',
    title: 'Object body',
    body: {
      goal: 'Goal.',
      changes,
      acceptance: ['done'],
      verify: ['npm test'],
    },
  };
}

function stringStory(changesLines) {
  return {
    slug: 'str',
    type: 'story',
    title: 'String body',
    body: [
      '## Goal',
      'Goal.',
      '',
      '## Changes',
      ...changesLines,
      '',
      '## Acceptance',
      '- done',
      '',
      '## Verify',
      '- npm test',
    ].join('\n'),
  };
}

describe('repairChangeEntries — structured object bodies', () => {
  it('rewrites a plain-string bullet into { path, assumption } by probing base', () => {
    const story = objectStory(['src/existing.js', 'src/brand-new.js']);
    const repairs = repairChangeEntries([story], { existsAtBase });
    assert.deepEqual(story.body.changes, [
      { path: 'src/existing.js', assumption: 'refactors-existing' },
      { path: 'src/brand-new.js', assumption: 'creates' },
    ]);
    assert.deepEqual(
      repairs.map((r) => [r.slug, r.reason, r.assumption]),
      [
        ['obj', 'plain-string', 'refactors-existing'],
        ['obj', 'plain-string', 'creates'],
      ],
    );
  });

  it('salvages a backticked or bullet-marked string and a humanized tail', () => {
    const story = objectStory([
      '`src/existing.js`',
      '- lib/old.js — adds the route',
    ]);
    repairChangeEntries([story], { existsAtBase });
    assert.deepEqual(story.body.changes, [
      { path: 'src/existing.js', assumption: 'refactors-existing' },
      { path: 'lib/old.js', assumption: 'refactors-existing' },
    ]);
  });

  it('strips a trailing parenthetical from an object entry and keeps its authored assumption', () => {
    const story = objectStory([
      { path: 'src/existing.js (in place)', assumption: 'refactors-existing' },
      { path: 'src/new.js (new file)' },
    ]);
    const repairs = repairChangeEntries([story], { existsAtBase });
    assert.deepEqual(story.body.changes, [
      { path: 'src/existing.js', assumption: 'refactors-existing' },
      { path: 'src/new.js', assumption: 'creates' },
    ]);
    assert.deepEqual(
      repairs.map((r) => r.reason),
      ['trailing-parenthetical', 'trailing-parenthetical'],
    );
  });

  it('fills a missing assumption on an otherwise clean object entry', () => {
    const story = objectStory([{ path: 'lib/old.js' }]);
    const [repair] = repairChangeEntries([story], { existsAtBase });
    assert.deepEqual(story.body.changes, [
      { path: 'lib/old.js', assumption: 'refactors-existing' },
    ]);
    assert.equal(repair.reason, 'missing-assumption');
  });

  it('leaves canonical entries and unsalvageable strings untouched', () => {
    const changes = [
      { path: 'src/existing.js', assumption: 'deletes' },
      'tidy up the persist tests',
      42,
      null,
    ];
    const story = objectStory([...changes]);
    const repairs = repairChangeEntries([story], { existsAtBase });
    assert.deepEqual(story.body.changes, changes);
    assert.deepEqual(repairs, []);
  });

  it('reads top-level changes[] when the ticket carries no body', () => {
    const ticket = {
      slug: 'flat',
      type: 'story',
      title: 'Flat',
      changes: ['src/existing.js'],
    };
    repairChangeEntries([ticket], { existsAtBase });
    assert.deepEqual(ticket.changes, [
      { path: 'src/existing.js', assumption: 'refactors-existing' },
    ]);
  });
});

describe('repairChangeEntries — serialized string bodies', () => {
  it('rewrites plain bullets under ## Changes into the humanized canonical line', () => {
    const story = stringStory([
      '- src/existing.js',
      '- `src/brand-new.js`',
      '- {"path": "lib/old.js", "assumption": "refactors-existing"}',
    ]);
    const before = story.body;
    const repairs = repairChangeEntries([story], { existsAtBase });
    assert.equal(repairs.length, 2, 'the canonical JSON line needs no repair');
    assert.notEqual(story.body, before);
    const { body } = parseStoryBody(story.body);
    assert.deepEqual(body.changes, [
      { path: 'src/existing.js', assumption: 'refactors-existing' },
      { path: 'src/brand-new.js', assumption: 'creates' },
      { path: 'lib/old.js', assumption: 'refactors-existing' },
    ]);
    // Only the section was touched; the rest of the body is byte-identical.
    assert.ok(story.body.startsWith('## Goal\nGoal.\n\n## Changes\n'));
    assert.ok(story.body.endsWith('## Verify\n- npm test'));
  });

  it('strips a trailing parenthetical inside a humanized or JSON line', () => {
    const story = stringStory([
      '- `src/existing.js (edited)` — refactors-existing',
      '- `src/new.js (new)` — nope',
      '- {"path": "lib/old.js (kept)", "assumption": "deletes"}',
    ]);
    repairChangeEntries([story], { existsAtBase });
    const { body } = parseStoryBody(story.body);
    assert.deepEqual(body.changes, [
      { path: 'src/existing.js', assumption: 'refactors-existing' },
      { path: 'src/new.js', assumption: 'creates' },
      { path: 'lib/old.js', assumption: 'deletes' },
    ]);
  });

  it('leaves a canonical section and an unsalvageable bullet byte-identical', () => {
    const story = stringStory([
      '- `src/existing.js` — refactors-existing',
      '- tidy things up',
      '- {not json',
    ]);
    const before = story.body;
    assert.deepEqual(repairChangeEntries([story], { existsAtBase }), []);
    assert.equal(story.body, before);
  });

  it('stops at the next heading — a path-shaped Acceptance line is not a changes entry', () => {
    const story = stringStory(['- src/existing.js']);
    story.body = story.body.replace('- done', '- src/other.js passes');
    repairChangeEntries([story], { existsAtBase });
    assert.match(story.body, /## Acceptance\n- src\/other\.js passes/);
  });
});

describe('repairChangeEntries — totality and reporting', () => {
  it('ignores non-Story tickets, null entries and a non-array argument', () => {
    const feature = { slug: 'f', type: 'feature', body: { changes: ['x.js'] } };
    assert.deepEqual(
      repairChangeEntries([feature, null, undefined], { existsAtBase }),
      [],
    );
    assert.deepEqual(feature.body.changes, ['x.js']);
    assert.deepEqual(repairChangeEntries(undefined, { existsAtBase }), []);
  });

  it('renders each repair as the dry-run line the operator reads', () => {
    const line = renderChangeRepair({
      slug: 's',
      from: 'src/x.js (new)',
      path: 'src/x.js',
      assumption: 'creates',
      reason: 'trailing-parenthetical',
    });
    assert.match(line, /Story "s"/);
    assert.match(line, /trailing parenthetical/);
    assert.match(line, /\{"path":"src\/x\.js","assumption":"creates"\}/);
    assert.match(line, /by probing base/);
    assert.match(
      renderChangeRepair({
        slug: 's',
        from: 'a/b.js',
        path: 'a/b.js',
        assumption: 'creates',
        reason: 'plain-string',
      }),
      /plain-string bullet/,
    );
    assert.match(
      renderChangeRepair({
        slug: 's',
        from: 'a/b.js',
        path: 'a/b.js',
        assumption: 'creates',
        reason: 'missing-assumption',
      }),
      /missing assumption/,
    );
  });
});

/**
 * Exhaustive tests for `lib/orchestration/epic-spec-reconciler-diff.js`
 * (Story #1492 / Task #1514). Walks every operation kind plus the
 * empty-diff idempotency path against fixture triples under
 * `tests/fixtures/reconciler/`.
 *
 * Contract under test:
 *   - `diff()` is a pure function — same inputs yield byte-identical
 *     Plans across repeated calls.
 *   - Spec slug present + state mapping absent → Create.
 *   - Spec slug present + state mapping present + structural drift
 *     (title/body/labels/wave) → Update with only the changed fields.
 *   - Spec slug absent + state mapping present → Close.
 *   - Spec slug present + state mapping present + edge change
 *     (parent or dependsOn) → Relink.
 *   - Empty-diff path: identical (spec, state, ghState) yields a Plan
 *     where every bucket is length 0, and a second call returns the
 *     same object shape (idempotent).
 *
 * The fixtures are JSON (not YAML) so the diff tests don't need the
 * loader — they hand parsed objects directly into `diff()`. This keeps
 * the unit boundary clean: the loader has its own integration suite.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { diff } from '../../.agents/scripts/lib/orchestration/epic-spec-reconciler-diff.js';
import {
  ENTITY_KINDS,
  isPlan,
  OP_KINDS,
} from '../../.agents/scripts/lib/orchestration/epic-spec-reconciler-ops.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(__dirname, '..', 'fixtures', 'reconciler');

function loadFixture(name) {
  const raw = readFileSync(path.join(FIXTURE_DIR, `${name}.json`), 'utf8');
  return JSON.parse(raw);
}

describe('reconciler diff — Plan shape invariants', () => {
  it('returns a Plan with all four buckets even when empty', () => {
    const { spec, state, ghState } = loadFixture('empty-diff');
    const plan = diff({ spec, state, ghState });
    assert.equal(isPlan(plan), true);
    assert.deepEqual(plan, {
      creates: [],
      updates: [],
      closes: [],
      relinks: [],
    });
  });

  it('throws when state is omitted (TypeError, pure contract)', () => {
    const { spec, ghState } = loadFixture('empty-diff');
    assert.throws(() => diff({ spec, ghState }), /state argument is required/);
  });

  it('returns the empty plan when spec is missing (graceful degrade)', () => {
    const plan = diff({ spec: undefined, state: { epicId: 1, mapping: {} } });
    assert.equal(isPlan(plan), true);
    assert.equal(plan.creates.length, 0);
  });
});

describe('reconciler diff — create-only fixture', () => {
  it('creates one operation per spec entity when mapping is empty', () => {
    const { spec, state, ghState } = loadFixture('create-only');
    const plan = diff({ spec, state, ghState });
    assert.equal(plan.updates.length, 0);
    assert.equal(plan.closes.length, 0);
    assert.equal(plan.relinks.length, 0);
    // epic + feat-alpha + story-one + task-one-a = 4 creates
    assert.equal(plan.creates.length, 4);
    const slugs = plan.creates.map((op) => op.slug);
    assert.deepEqual([...slugs].sort(), [
      'epic',
      'feat-alpha',
      'story-one',
      'task-one-a',
    ]);
    // Every op carries kind=create
    for (const op of plan.creates) {
      assert.equal(op.kind, OP_KINDS.CREATE);
    }
  });

  it('attaches parentSlug for non-epic creates', () => {
    const { spec, state, ghState } = loadFixture('create-only');
    const plan = diff({ spec, state, ghState });
    const byslug = Object.fromEntries(plan.creates.map((op) => [op.slug, op]));
    assert.equal(byslug.epic.parentSlug, undefined);
    assert.equal(byslug['feat-alpha'].parentSlug, 'epic');
    assert.equal(byslug['story-one'].parentSlug, 'feat-alpha');
    assert.equal(byslug['task-one-a'].parentSlug, 'story-one');
  });

  it('records wave and dependsOn on story creates', () => {
    const { spec, state, ghState } = loadFixture('create-only');
    const plan = diff({ spec, state, ghState });
    const story = plan.creates.find((op) => op.slug === 'story-one');
    assert.equal(story.entity, ENTITY_KINDS.STORY);
    assert.equal(story.wave, 0);
    assert.deepEqual(story.dependsOn, []);
  });
});

describe('reconciler diff — update-only fixture', () => {
  it('emits Update ops only for slugs whose ghState drifted', () => {
    const { spec, state, ghState } = loadFixture('update-only');
    const plan = diff({ spec, state, ghState });
    assert.equal(plan.creates.length, 0);
    assert.equal(plan.closes.length, 0);
    assert.equal(plan.relinks.length, 0);
    // feat-alpha (labels drift) + story-one (title drift) = 2 updates
    assert.equal(plan.updates.length, 2);
    const bySlug = Object.fromEntries(plan.updates.map((op) => [op.slug, op]));
    assert.ok(bySlug['feat-alpha']);
    assert.ok(bySlug['story-one']);

    assert.deepEqual(Object.keys(bySlug['feat-alpha'].changes).sort(), [
      'labels',
    ]);
    assert.deepEqual(Object.keys(bySlug['story-one'].changes).sort(), [
      'title',
    ]);
    assert.deepEqual(bySlug['story-one'].changes.title, {
      before: 'Original Story Title',
      after: 'Renamed Story',
    });
    assert.deepEqual(bySlug['feat-alpha'].changes.labels, {
      before: ['type::feature'],
      after: ['area::core', 'type::feature'],
    });
  });

  it('includes the mapped issueNumber on every Update', () => {
    const { spec, state, ghState } = loadFixture('update-only');
    const plan = diff({ spec, state, ghState });
    for (const op of plan.updates) {
      assert.equal(typeof op.issueNumber, 'number');
      assert.ok(Number.isFinite(op.issueNumber));
    }
  });
});

describe('reconciler diff — close-only fixture', () => {
  it('emits one Close per mapping slug missing from the spec', () => {
    const { spec, state, ghState } = loadFixture('close-only');
    const plan = diff({ spec, state, ghState });
    assert.equal(plan.creates.length, 0);
    assert.equal(plan.updates.length, 0);
    assert.equal(plan.relinks.length, 0);
    assert.equal(plan.closes.length, 1);
    assert.equal(plan.closes[0].slug, 'task-one-b');
    assert.equal(plan.closes[0].kind, OP_KINDS.CLOSE);
    assert.equal(plan.closes[0].issueNumber, 203);
    assert.equal(plan.closes[0].entity, ENTITY_KINDS.TASK);
  });
});

describe('reconciler diff — relink-only fixture', () => {
  it('emits Relink ops for changed parent and dependsOn edges', () => {
    const { spec, state, ghState } = loadFixture('relink-only');
    const plan = diff({ spec, state, ghState });
    assert.equal(plan.creates.length, 0);
    assert.equal(plan.updates.length, 0);
    assert.equal(plan.closes.length, 0);
    assert.equal(plan.relinks.length, 2);
    const bySlug = Object.fromEntries(plan.relinks.map((op) => [op.slug, op]));

    // story-one: dependsOn [] → [story-two]
    assert.ok(bySlug['story-one'].dependsOn);
    assert.deepEqual(bySlug['story-one'].dependsOn, {
      before: [],
      after: ['story-two'],
    });
    assert.equal(bySlug['story-one'].parent, undefined);

    // task-shared: parent story-two → story-one
    assert.ok(bySlug['task-shared'].parent);
    assert.deepEqual(bySlug['task-shared'].parent, {
      before: 'story-two',
      after: 'story-one',
    });
  });
});

describe('reconciler diff — mixed fixture (all four kinds)', () => {
  it('emits at least one op in every bucket', () => {
    const { spec, state, ghState } = loadFixture('mixed');
    const plan = diff({ spec, state, ghState });
    assert.ok(plan.creates.length >= 1, 'expected ≥1 create');
    assert.ok(plan.updates.length >= 1, 'expected ≥1 update');
    assert.ok(plan.closes.length >= 1, 'expected ≥1 close');
    assert.ok(plan.relinks.length >= 1, 'expected ≥1 relink');
  });

  it('names the newly-added Story as a Create', () => {
    const { spec, state, ghState } = loadFixture('mixed');
    const plan = diff({ spec, state, ghState });
    const created = plan.creates.find((op) => op.slug === 'story-two');
    assert.ok(created, 'story-two should be created');
    assert.equal(created.entity, ENTITY_KINDS.STORY);
  });

  it('names the drifted Feature as an Update with title change', () => {
    const { spec, state, ghState } = loadFixture('mixed');
    const plan = diff({ spec, state, ghState });
    const updated = plan.updates.find((op) => op.slug === 'feat-alpha');
    assert.ok(updated);
    assert.deepEqual(updated.changes.title, {
      before: 'Alpha Old Title',
      after: 'Alpha Renamed',
    });
  });

  it('names the orphan Task as a Close', () => {
    const { spec, state, ghState } = loadFixture('mixed');
    const plan = diff({ spec, state, ghState });
    const closed = plan.closes.find((op) => op.slug === 'task-dropped');
    assert.ok(closed);
    assert.equal(closed.issueNumber, 503);
  });

  it('names the rewired Story as a Relink (dependsOn changed)', () => {
    const { spec, state, ghState } = loadFixture('mixed');
    const plan = diff({ spec, state, ghState });
    const relinked = plan.relinks.find((op) => op.slug === 'story-one');
    assert.ok(relinked);
    assert.deepEqual(relinked.dependsOn, {
      before: [],
      after: ['story-two'],
    });
  });
});

describe('reconciler diff — empty-diff idempotency', () => {
  it('returns a plan with every bucket length 0 for matching inputs', () => {
    const { spec, state, ghState } = loadFixture('empty-diff');
    const plan = diff({ spec, state, ghState });
    assert.equal(plan.creates.length, 0);
    assert.equal(plan.updates.length, 0);
    assert.equal(plan.closes.length, 0);
    assert.equal(plan.relinks.length, 0);
  });

  it('is byte-identical across two consecutive calls', () => {
    const { spec, state, ghState } = loadFixture('empty-diff');
    const first = diff({ spec, state, ghState });
    const second = diff({ spec, state, ghState });
    assert.deepEqual(first, second);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
  });

  it('is byte-identical for non-empty plans too (deterministic ordering)', () => {
    const { spec, state, ghState } = loadFixture('mixed');
    const first = diff({ spec, state, ghState });
    const second = diff({ spec, state, ghState });
    assert.equal(JSON.stringify(first), JSON.stringify(second));
  });

  it('sorts each bucket by slug', () => {
    const { spec, state, ghState } = loadFixture('mixed');
    const plan = diff({ spec, state, ghState });
    for (const bucket of ['creates', 'updates', 'closes', 'relinks']) {
      const slugs = plan[bucket].map((op) => op.slug);
      const sorted = [...slugs].sort((a, b) => a.localeCompare(b));
      assert.deepEqual(slugs, sorted, `${bucket} not sorted by slug`);
    }
  });
});

describe('reconciler diff — purity', () => {
  it('does not mutate the input spec', () => {
    const fixture = loadFixture('mixed');
    const before = JSON.stringify(fixture.spec);
    diff({
      spec: fixture.spec,
      state: fixture.state,
      ghState: fixture.ghState,
    });
    assert.equal(JSON.stringify(fixture.spec), before);
  });

  it('does not mutate the input state mapping', () => {
    const fixture = loadFixture('mixed');
    const before = JSON.stringify(fixture.state);
    diff({
      spec: fixture.spec,
      state: fixture.state,
      ghState: fixture.ghState,
    });
    assert.equal(JSON.stringify(fixture.state), before);
  });

  it('does not mutate the input ghState', () => {
    const fixture = loadFixture('mixed');
    const before = JSON.stringify(fixture.ghState);
    diff({
      spec: fixture.spec,
      state: fixture.state,
      ghState: fixture.ghState,
    });
    assert.equal(JSON.stringify(fixture.ghState), before);
  });
});

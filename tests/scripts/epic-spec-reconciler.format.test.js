/**
 * Tests for `lib/orchestration/epic-spec-reconciler-format.js`
 * (Story #1492 / Task #1511 + #1514). Verifies:
 *
 *   - Output is deterministic for a given plan (sorted by slug).
 *   - Each operation line names slug, issue number, and changed fields.
 *   - Empty plans yield the canonical "no operations" marker.
 *   - `formatPlan` rejects non-Plan inputs with a TypeError.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { diff } from '../../.agents/scripts/lib/orchestration/epic-spec-reconciler-diff.js';
import { formatPlan } from '../../.agents/scripts/lib/orchestration/epic-spec-reconciler-format.js';
import {
  closeOp,
  createOp,
  ENTITY_KINDS,
  emptyPlan,
  relinkOp,
  updateOp,
} from '../../.agents/scripts/lib/orchestration/epic-spec-reconciler-ops.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(__dirname, '..', 'fixtures', 'reconciler');

function loadFixture(name) {
  return JSON.parse(
    readFileSync(path.join(FIXTURE_DIR, `${name}.json`), 'utf8'),
  );
}

describe('formatPlan — empty plan', () => {
  it('renders the canonical "no operations" header', () => {
    const md = formatPlan(emptyPlan());
    assert.match(md, /^# Reconciler plan — no operations \(idempotent\)/);
  });

  it('still emits all four section headings even when empty', () => {
    const md = formatPlan(emptyPlan());
    assert.match(md, /## Creates/);
    assert.match(md, /## Updates/);
    assert.match(md, /## Closes/);
    assert.match(md, /## Relinks/);
    // Each section has the empty marker.
    assert.match(md, /_no operations_/);
  });

  it('is byte-identical for two consecutive calls', () => {
    const md1 = formatPlan(emptyPlan());
    const md2 = formatPlan(emptyPlan());
    assert.equal(md1, md2);
  });
});

describe('formatPlan — input validation', () => {
  it('throws TypeError on a non-Plan input', () => {
    assert.throws(() => formatPlan(null), /not a Plan/);
    assert.throws(() => formatPlan({}), /not a Plan/);
    assert.throws(() => formatPlan({ creates: [] }), /not a Plan/);
  });
});

describe('formatPlan — per-section rendering', () => {
  it('renders CreateOp with slug, entity, title, and parent', () => {
    const plan = emptyPlan();
    plan.creates.push(
      createOp({
        slug: 'feat-alpha',
        entity: ENTITY_KINDS.FEATURE,
        title: 'Alpha Feature',
        parentSlug: 'epic',
        labels: ['type::feature'],
      }),
    );
    const md = formatPlan(plan);
    assert.match(md, /## Creates/);
    assert.match(md, /`feat-alpha` \[feature\]: Alpha Feature/);
    assert.match(md, /labels=\[type::feature\]/);
    assert.match(md, /parent=epic/);
  });

  it('renders UpdateOp with issue number + sorted change fields', () => {
    const plan = emptyPlan();
    plan.updates.push(
      updateOp({
        slug: 'story-one',
        entity: ENTITY_KINDS.STORY,
        issueNumber: 42,
        changes: {
          title: { before: 'Old', after: 'New' },
          labels: { before: ['x'], after: ['y'] },
        },
      }),
    );
    const md = formatPlan(plan);
    assert.match(md, /`story-one` \[story\] \(#42\):/);
    // labels comes before title (alphabetical sort)
    const labelsIdx = md.indexOf('labels:');
    const titleIdx = md.indexOf('title:');
    assert.ok(labelsIdx > -1 && titleIdx > -1);
    assert.ok(
      labelsIdx < titleIdx,
      'change fields must be alphabetically sorted',
    );
  });

  it('renders CloseOp with slug + issue number + title', () => {
    const plan = emptyPlan();
    plan.closes.push(
      closeOp({
        slug: 'task-dropped',
        entity: ENTITY_KINDS.TASK,
        issueNumber: 503,
        title: 'Dropped Task',
      }),
    );
    const md = formatPlan(plan);
    assert.match(md, /`task-dropped` \[task\] \(#503\): Dropped Task/);
  });

  it('renders RelinkOp with parent and dependsOn deltas', () => {
    const plan = emptyPlan();
    plan.relinks.push(
      relinkOp({
        slug: 'story-one',
        entity: ENTITY_KINDS.STORY,
        issueNumber: 99,
        parent: { before: 'feat-old', after: 'feat-new' },
        dependsOn: { before: ['a'], after: ['b', 'c'] },
      }),
    );
    const md = formatPlan(plan);
    assert.match(md, /`story-one` \[story\] \(#99\):/);
    assert.match(md, /parent: feat-old → feat-new/);
    assert.match(md, /dependsOn: \[a\] → \[b, c\]/);
  });
});

describe('formatPlan — determinism (sort by slug)', () => {
  it('sorts each section by slug even if input is unsorted', () => {
    const plan = emptyPlan();
    plan.creates.push(
      createOp({ slug: 'zebra', entity: ENTITY_KINDS.TASK, title: 'Z' }),
      createOp({ slug: 'apple', entity: ENTITY_KINDS.TASK, title: 'A' }),
      createOp({ slug: 'mango', entity: ENTITY_KINDS.TASK, title: 'M' }),
    );
    const md = formatPlan(plan);
    const idxApple = md.indexOf('`apple`');
    const idxMango = md.indexOf('`mango`');
    const idxZebra = md.indexOf('`zebra`');
    assert.ok(idxApple < idxMango);
    assert.ok(idxMango < idxZebra);
  });

  it('produces identical output for two equivalent plans', () => {
    const a = emptyPlan();
    const b = emptyPlan();
    a.creates.push(
      createOp({ slug: 'beta', entity: ENTITY_KINDS.TASK, title: 'B' }),
      createOp({ slug: 'alpha', entity: ENTITY_KINDS.TASK, title: 'A' }),
    );
    b.creates.push(
      createOp({ slug: 'alpha', entity: ENTITY_KINDS.TASK, title: 'A' }),
      createOp({ slug: 'beta', entity: ENTITY_KINDS.TASK, title: 'B' }),
    );
    assert.equal(formatPlan(a), formatPlan(b));
  });
});

describe('formatPlan — round-trip with diff fixtures', () => {
  it('renders the mixed-fixture plan with one bullet per op', () => {
    const { spec, state, ghState } = loadFixture('mixed');
    const plan = diff({ spec, state, ghState });
    const md = formatPlan(plan);
    const totalOps =
      plan.creates.length +
      plan.updates.length +
      plan.closes.length +
      plan.relinks.length;
    const bulletCount = md
      .split('\n')
      .filter((line) => line.startsWith('- ')).length;
    assert.equal(bulletCount, totalOps);
  });

  it('renders the empty-diff plan as the canonical no-op block', () => {
    const { spec, state, ghState } = loadFixture('empty-diff');
    const plan = diff({ spec, state, ghState });
    const md = formatPlan(plan);
    assert.match(md, /no operations \(idempotent\)/);
    // No bullet lines at all.
    const bulletCount = md
      .split('\n')
      .filter((line) => line.startsWith('- ')).length;
    assert.equal(bulletCount, 0);
  });
});

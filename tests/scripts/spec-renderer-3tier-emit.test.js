/**
 * tests/scripts/spec-renderer-3tier-emit.test.js — hotfix for the
 * 3-tier (Epic #3078) decompose bootstrap blocker.
 *
 * Bug: `lib/orchestration/spec-renderer.js` unconditionally emitted
 * `tasks: []` on every Story, which `.agents/schemas/epic-spec.schema.json`
 * (v3.0.0, `additionalProperties: false` on Story) rejects with
 * `SpecRenderValidationError` at `/features/0/stories/0`. That broke
 * `/epic-plan` Phase 8 for every 3-tier decompose.
 *
 * This test pins the surgical fix:
 *   1. A 3-tier ticket array (Stories with inline acceptance[] / verify[]
 *      and no Task children) renders to a spec that validates against the
 *      live schema — the `tasks` field is omitted entirely.
 *   2. The Story's inline `acceptance` and `verify` arrays are projected
 *      onto the rendered Story output (so the 3-tier execution loop has
 *      the Goal/Changes/Acceptance/Verify surface it expects).
 *   3. A 4-tier ticket array (Stories with `type::task` children) now
 *      raises a 3-tier-guard error in `indexTickets`. Epic #3163 / Story
 *      #3192 rewrote the renderer to drop Task-tier emission entirely;
 *      Task tickets in the input are a hard contract violation.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { renderSpec } from '../../.agents/scripts/lib/orchestration/spec-renderer.js';

const SCHEMA_PATH = path.resolve(
  process.cwd(),
  '.agents',
  'schemas',
  'epic-spec.schema.json',
);

function buildAjv() {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')));
}

const EPIC = {
  id: 3163,
  title: 'Hotfix bootstrap — 3-tier spec rendering',
  body: 'Bootstrap fixture.',
  labels: ['type::epic'],
};

function build3TierTickets() {
  return [
    {
      slug: 'feat-a',
      type: 'feature',
      title: 'Feature A',
      body: 'Feature body.',
      labels: ['type::feature'],
      parent_slug: '',
      depends_on: [],
    },
    {
      slug: 'story-1',
      type: 'story',
      title: 'Story 1 — top-level acceptance/verify',
      body: 'Inline body for Story 1.',
      acceptance: [
        'Spec-renderer omits tasks for 3-tier Stories',
        'Spec validates against epic-spec.schema.json v3.0.0',
      ],
      verify: ['node --test tests/scripts/spec-renderer-3tier-emit.test.js'],
      labels: ['type::story', 'persona::engineer'],
      parent_slug: 'feat-a',
      depends_on: [],
    },
    {
      slug: 'story-2',
      type: 'story',
      title: 'Story 2 — no acceptance, depends on story-1',
      body: 'Plain string body.',
      labels: ['type::story'],
      parent_slug: 'feat-a',
      depends_on: ['story-1'],
    },
  ];
}

function build4TierTickets() {
  return [
    {
      slug: 'feat-b',
      type: 'feature',
      title: 'Feature B',
      labels: ['type::feature'],
      parent_slug: '',
      depends_on: [],
    },
    {
      slug: 'story-x',
      type: 'story',
      title: 'Story X with Task children',
      body: 'Has Task children.',
      labels: ['type::story'],
      parent_slug: 'feat-b',
      depends_on: [],
    },
    {
      slug: 'task-x1',
      type: 'task',
      title: 'Task X1',
      body: {
        goal: 'Do thing 1.',
        changes: ['file.js: change'],
        acceptance: ['done'],
        verify: ['npm test'],
      },
      labels: ['type::task'],
      parent_slug: 'story-x',
      depends_on: [],
    },
    {
      slug: 'task-x2',
      type: 'task',
      title: 'Task X2',
      body: 'Plain string body.',
      labels: ['type::task'],
      parent_slug: 'story-x',
      depends_on: ['task-x1'],
    },
  ];
}

describe('spec-renderer — 3-tier emission (hotfix for Epic #3163 blocker)', () => {
  it('omits the tasks field on Stories with no Task children', () => {
    const spec = renderSpec(build3TierTickets(), { epic: EPIC });

    const story1 = spec.features[0].stories[0];
    const story2 = spec.features[0].stories[1];

    assert.equal(
      Object.hasOwn(story1, 'tasks'),
      false,
      'story-1 should not carry a tasks field under 3-tier',
    );
    assert.equal(
      Object.hasOwn(story2, 'tasks'),
      false,
      'story-2 should not carry a tasks field under 3-tier',
    );
  });

  it('renders a 3-tier spec that validates against epic-spec.schema.json', () => {
    const spec = renderSpec(build3TierTickets(), { epic: EPIC });
    const validate = buildAjv();
    const ok = validate(spec);
    assert.equal(
      ok,
      true,
      `spec failed schema validation: ${JSON.stringify(validate.errors, null, 2)}`,
    );
  });

  it('projects top-level Story acceptance[] and verify[] onto the rendered Story', () => {
    const spec = renderSpec(build3TierTickets(), { epic: EPIC });
    const story1 = spec.features[0].stories[0];

    assert.deepEqual(story1.acceptance, [
      'Spec-renderer omits tasks for 3-tier Stories',
      'Spec validates against epic-spec.schema.json v3.0.0',
    ]);
    assert.deepEqual(story1.verify, [
      'node --test tests/scripts/spec-renderer-3tier-emit.test.js',
    ]);
  });

  it('omits acceptance/verify when the Story did not declare them', () => {
    const spec = renderSpec(build3TierTickets(), { epic: EPIC });
    const story2 = spec.features[0].stories[1];

    assert.equal(
      Object.hasOwn(story2, 'acceptance'),
      false,
      'story-2 has no acceptance — field must be omitted, not emitted empty',
    );
    assert.equal(
      Object.hasOwn(story2, 'verify'),
      false,
      'story-2 has no verify — field must be omitted, not emitted empty',
    );
  });

  it('preserves the inter-Story dependsOn projection', () => {
    const spec = renderSpec(build3TierTickets(), { epic: EPIC });
    const story2 = spec.features[0].stories[1];
    assert.deepEqual(story2.dependsOn, ['story-1']);
  });
});

describe('spec-renderer — Task tickets rejected (Epic #3163 rewrite)', () => {
  it('throws a 3-tier-guard error when the input carries any type:"task" ticket', () => {
    // Epic #3163 rewrote the renderer to drop Task-tier emission
    // entirely. The 4-tier back-compat path that previously emitted
    // a populated `Story.tasks` array is gone; a Task ticket in the
    // input is now a hard contract violation that raises in
    // `indexTickets` before any spec is built.
    assert.throws(
      () => renderSpec(build4TierTickets(), { epic: EPIC, validate: false }),
      /3-tier hierarchy/,
    );
  });
});

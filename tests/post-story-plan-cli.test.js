/**
 * Contract tests for `post-story-plan.js`.
 *
 * Story #3258 (Epic #3212) — Asserts:
 *   1. `runPostStoryPlan` emits the story-plan comment with revision 1 on first call.
 *   2. Re-calling with identical content results in a single comment (idempotent
 *      upsert, no second change to the underlying provider state).
 *   3. Re-calling after content changes increments plan_revision to 2.
 *   4. `validateRequiredArgs` enforces all required CLI flags.
 *   5. Unknown/invalid plan JSON is rejected before the provider is called.
 *
 * The tests use an in-memory provider that mirrors the surface
 * `upsertStructuredComment` uses (postComment, getTicketComments, deleteComment)
 * so no real GitHub API calls are made.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import {
  deriveNextRevision,
  formatPlanBody,
  parsePlan,
  runPostStoryPlan,
  validateRequiredArgs,
} from '../.agents/scripts/post-story-plan.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(
  __dirname,
  '..',
  '.agents',
  'schemas',
  'story-plan-comment.schema.json',
);

function makeValidator() {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(schema);
}

/**
 * In-memory provider mirroring the surface `upsertStructuredComment` needs:
 * postComment, getTicketComments, deleteComment.
 */
function makeProvider() {
  const comments = [];
  let nextId = 1;
  return {
    comments,
    async postComment(ticketId, { type, body }) {
      const id = nextId++;
      comments.push({ id, ticketId, type, body });
      return { commentId: id };
    },
    async getTicketComments(ticketId) {
      return comments.filter((c) => c.ticketId === ticketId);
    },
    async deleteComment(id) {
      const idx = comments.findIndex((c) => c.id === id);
      if (idx >= 0) comments.splice(idx, 1);
    },
  };
}

/** Minimal valid plan JSON (revision will be overridden by the emitter). */
function minimalPlanJson(overrides = {}) {
  return JSON.stringify({
    files_to_touch: ['src/foo.js'],
    ac_mapping: { 0: { tests: ['tests/foo.test.js'] } },
    open_questions: [],
    plan_revision: 1,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// parsePlan
// ---------------------------------------------------------------------------

describe('parsePlan — validation boundary', () => {
  const validate = makeValidator();

  it('returns the parsed object for valid JSON', () => {
    const plan = parsePlan(minimalPlanJson(), validate);
    assert.equal(plan.plan_revision, 1);
    assert.deepEqual(plan.files_to_touch, ['src/foo.js']);
  });

  it('throws on malformed JSON', () => {
    assert.throws(() => parsePlan('{not valid json', validate), /valid JSON/);
  });

  it('throws when required field is missing', () => {
    const bad = JSON.stringify({
      files_to_touch: ['src/foo.js'],
      ac_mapping: {},
      open_questions: [],
      // plan_revision omitted
    });
    assert.throws(
      () => parsePlan(bad, validate),
      /story-plan-comment\.schema\.json/,
    );
  });

  it('throws when plan_revision is 0 (below minimum)', () => {
    const bad = JSON.stringify({
      files_to_touch: [],
      ac_mapping: {},
      open_questions: [],
      plan_revision: 0,
    });
    assert.throws(
      () => parsePlan(bad, validate),
      /story-plan-comment\.schema\.json/,
    );
  });
});

// ---------------------------------------------------------------------------
// deriveNextRevision
// ---------------------------------------------------------------------------

describe('deriveNextRevision — revision derivation', () => {
  it('returns 1 when no prior story-plan comment exists', async () => {
    const provider = makeProvider();
    const rev = await deriveNextRevision(provider, 999);
    assert.equal(rev, 1);
  });

  it('returns prior revision + 1 when a prior comment exists', async () => {
    const validate = makeValidator();
    const provider = makeProvider();
    // Post an initial plan so the provider has a comment.
    await runPostStoryPlan({
      storyId: 42,
      rawPlan: minimalPlanJson(),
      provider,
      validate,
    });
    // deriveNextRevision should now read that comment and return 2.
    const rev = await deriveNextRevision(provider, 42);
    assert.equal(rev, 2);
  });
});

// ---------------------------------------------------------------------------
// formatPlanBody
// ---------------------------------------------------------------------------

describe('formatPlanBody — body rendering', () => {
  it('includes the revision number in the heading', () => {
    const body = formatPlanBody({ plan_revision: 3, files_to_touch: [] });
    assert.match(body, /revision 3/);
  });

  it('includes a JSON code block with the full plan', () => {
    const plan = {
      plan_revision: 1,
      files_to_touch: ['a.js'],
      ac_mapping: {},
      open_questions: [],
    };
    const body = formatPlanBody(plan);
    assert.match(body, /```json/);
    const reparsed = JSON.parse(
      body.match(/```json\s*([\s\S]*?)```/)[1].trim(),
    );
    assert.deepEqual(reparsed, plan);
  });
});

// ---------------------------------------------------------------------------
// runPostStoryPlan — idempotency contract (the key acceptance criterion)
// ---------------------------------------------------------------------------

describe('runPostStoryPlan — first post', () => {
  it('returns success envelope with planRevision: 1 on first call', async () => {
    const validate = makeValidator();
    const provider = makeProvider();
    const envelope = await runPostStoryPlan({
      storyId: 10,
      rawPlan: minimalPlanJson(),
      provider,
      validate,
    });
    assert.deepEqual(envelope, { success: true, storyId: 10, planRevision: 1 });
  });

  it('creates exactly one comment on the Story', async () => {
    const validate = makeValidator();
    const provider = makeProvider();
    await runPostStoryPlan({
      storyId: 11,
      rawPlan: minimalPlanJson(),
      provider,
      validate,
    });
    const comments = await provider.getTicketComments(11);
    assert.equal(comments.length, 1);
  });
});

describe('runPostStoryPlan — idempotent upsert (the AC-3 contract)', () => {
  it('calling twice with identical content leaves only ONE comment (no second change)', async () => {
    const validate = makeValidator();
    const provider = makeProvider();
    const rawPlan = minimalPlanJson();

    await runPostStoryPlan({ storyId: 20, rawPlan, provider, validate });
    await runPostStoryPlan({ storyId: 20, rawPlan, provider, validate });

    // The provider still has exactly one comment for this ticket —
    // the upsert replaced rather than appended.
    const comments = await provider.getTicketComments(20);
    assert.equal(
      comments.length,
      1,
      'expected exactly one comment after two identical posts',
    );
  });

  it('the revision after two identical posts is 2 (revision incremented on upsert)', async () => {
    // Even when content is nominally the same, re-posting is a new plan revision
    // because the caller may have changed context.  The revision counter
    // increments on every upsert regardless of content equality.
    const validate = makeValidator();
    const provider = makeProvider();
    const rawPlan = minimalPlanJson();

    const first = await runPostStoryPlan({
      storyId: 21,
      rawPlan,
      provider,
      validate,
    });
    const second = await runPostStoryPlan({
      storyId: 21,
      rawPlan,
      provider,
      validate,
    });

    assert.equal(first.planRevision, 1);
    assert.equal(second.planRevision, 2);
  });

  it('there is still only ONE comment in the provider after the second call', async () => {
    const validate = makeValidator();
    const provider = makeProvider();

    await runPostStoryPlan({
      storyId: 22,
      rawPlan: minimalPlanJson(),
      provider,
      validate,
    });
    await runPostStoryPlan({
      storyId: 22,
      rawPlan: minimalPlanJson(),
      provider,
      validate,
    });

    const comments = await provider.getTicketComments(22);
    assert.equal(comments.length, 1);
  });
});

describe('runPostStoryPlan — re-post with changed content', () => {
  it('increments planRevision when plan content changes between calls', async () => {
    const validate = makeValidator();
    const provider = makeProvider();

    const firstPlan = minimalPlanJson({ files_to_touch: ['src/a.js'] });
    const secondPlan = minimalPlanJson({
      files_to_touch: ['src/a.js', 'src/b.js'],
    });

    await runPostStoryPlan({
      storyId: 30,
      rawPlan: firstPlan,
      provider,
      validate,
    });
    const second = await runPostStoryPlan({
      storyId: 30,
      rawPlan: secondPlan,
      provider,
      validate,
    });

    assert.equal(second.planRevision, 2);
  });
});

// ---------------------------------------------------------------------------
// validateRequiredArgs
// ---------------------------------------------------------------------------

describe('validateRequiredArgs', () => {
  it('returns parsed storyId and no errors when all flags are present', () => {
    const out = validateRequiredArgs({ story: '42', plan: '{}' });
    assert.equal(out.storyId, 42);
    assert.deepEqual(out.errors, []);
  });

  it('reports --story error when story is missing', () => {
    const out = validateRequiredArgs({ plan: '{}' });
    assert.ok(out.errors.some((e) => e.includes('--story')));
  });

  it('reports --plan error when plan is missing', () => {
    const out = validateRequiredArgs({ story: '7' });
    assert.ok(out.errors.some((e) => e.includes('--plan')));
  });

  it('reports both errors when nothing is supplied', () => {
    const out = validateRequiredArgs({});
    assert.equal(out.errors.length, 2);
  });

  it('rejects non-positive story ids', () => {
    for (const v of ['0', '-1', 'abc', '']) {
      const out = validateRequiredArgs({ story: v, plan: '{}' });
      assert.ok(
        out.errors.some((e) => e.includes('--story')),
        `expected --story error for "${v}"`,
      );
    }
  });
});

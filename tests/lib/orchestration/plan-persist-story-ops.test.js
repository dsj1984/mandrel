/**
 * Unit tests for v2 Stage 3 flat Story ops (plan-persist/story-ops.js).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AGENT_LABELS,
  TYPE_LABELS,
} from '../../../.agents/scripts/lib/label-constants.js';
import {
  assemblePlanStories,
  createStoryIssues,
  foldSpecIntoStoryBody,
  normalizeStoryTicket,
} from '../../../.agents/scripts/lib/orchestration/plan-persist/story-ops.js';
import { DEFAULT_SPEC_BODY_TOKEN_BUDGET } from '../../../.agents/scripts/lib/orchestration/spec-spill.js';
import {
  parse,
  serialize,
} from '../../../.agents/scripts/lib/story-body/story-body.js';

function storyTicket(slug, overrides = {}) {
  return {
    slug,
    type: 'story',
    title: `Story ${slug}`,
    body: serialize({
      goal: `Goal of ${slug}.`,
      changes: [{ path: `src/${slug}.js`, assumption: 'creates' }],
      acceptance: [`${slug} works`],
      verify: ['npm test (unit)'],
      reason_to_exist: `Deliver ${slug}`,
      ...overrides.bodyFields,
    }),
    ...overrides,
  };
}

// Story #4540 removed planRunLabel / PLAN_RUN_LABEL_PREFIX / normalizePlanRunId
// from this module along with the label itself. Their tests went with them;
// the createStoryIssues test below now asserts the label's ABSENCE, which is
// the contract that replaced them.

describe('normalizeStoryTicket — supersedes (Story #4535)', () => {
  it('normalizes a top-level supersedes[] onto the Story', () => {
    const n = normalizeStoryTicket(
      storyTicket('alpha', {
        supersedes: [4525, { id: 4529, note: 'Correction.' }],
      }),
    );
    assert.deepEqual(n.supersedes, [
      { id: 4525, note: null },
      { id: 4529, note: 'Correction.' },
    ]);
  });

  it('defaults to [] when absent', () => {
    assert.deepEqual(normalizeStoryTicket(storyTicket('alpha')).supersedes, []);
  });

  it('keeps supersedes out of the serialized body (bookkeeping, not contract)', () => {
    const { stories } = assemblePlanStories(
      [storyTicket('alpha', { supersedes: [4525] })],
      { sourceTicketIds: [4525] },
    );
    assert.deepEqual(stories[0].supersedes, [{ id: 4525, note: null }]);
    assert.doesNotMatch(stories[0].body, /supersede/i);
    assert.equal(parse(stories[0].body).body.supersedes, undefined);
  });

  it('assemblePlanStories fails closed on a partial supersede map', () => {
    assert.throws(
      () =>
        assemblePlanStories([storyTicket('alpha', { supersedes: [4525] })], {
          sourceTicketIds: [4525, 4526],
        }),
      /supersede partition failed/,
    );
  });
});

describe('normalizeStoryTicket', () => {
  it('parses a serialized body', () => {
    const n = normalizeStoryTicket(storyTicket('alpha'));
    assert.equal(n.slug, 'alpha');
    assert.equal(n.bodyObject.goal, 'Goal of alpha.');
    assert.deepEqual(n.bodyObject.acceptance, ['alpha works']);
  });

  it('rejects disagreement between top-level and body contracts', () => {
    assert.throws(
      () =>
        normalizeStoryTicket(
          storyTicket('alpha', { acceptance: ['different contract'] }),
        ),
      /mismatched top-level and body acceptance/,
    );
  });

  it('fills empty body acceptance/verify from top-level (no dual-author)', () => {
    const n = normalizeStoryTicket({
      slug: 'solo',
      title: 'Solo',
      body: serialize({
        goal: 'Goal.',
        changes: [{ path: 'src/a.js', assumption: 'creates' }],
        acceptance: [],
        verify: [],
        reason_to_exist: 'One reason',
      }),
      acceptance: ['observable works'],
      verify: ['npm test (unit)'],
    });
    assert.deepEqual(n.bodyObject.acceptance, ['observable works']);
    assert.deepEqual(n.bodyObject.verify, ['npm test (unit)']);
  });
});

describe('foldSpecIntoStoryBody', () => {
  it('keeps a small shared spec inline', () => {
    const { bodyObject } = foldSpecIntoStoryBody(
      { goal: 'g', changes: [], acceptance: [], verify: [], references: [] },
      's1',
      { sharedSpec: 'short tech spec' },
    );
    assert.equal(bodyObject.spec, 'short tech spec');
  });

  it('rejects an over-budget spec instead of spilling to docs/', () => {
    const big = 'x'.repeat((DEFAULT_SPEC_BODY_TOKEN_BUDGET + 50) * 4);
    assert.throws(
      () =>
        foldSpecIntoStoryBody(
          {
            goal: 'g',
            changes: [],
            acceptance: [],
            verify: [],
            references: [],
          },
          's1',
          { sharedSpec: big },
        ),
      /never written to docs/,
    );
  });
});

describe('assemblePlanStories', () => {
  it('assembles a default-single plan', () => {
    const { stories } = assemblePlanStories([storyTicket('solo')]);
    assert.equal(stories.length, 1);
    assert.match(stories[0].body, /## Goal/);
  });

  it('refuses cross-Story duplicate acceptance', () => {
    assert.throws(
      () =>
        assemblePlanStories([
          storyTicket('a', {
            bodyFields: { acceptance: ['shared criterion'] },
          }),
          storyTicket('b', {
            bodyFields: { acceptance: ['shared criterion'] },
          }),
        ]),
      /split-policy/,
    );
  });

  it('refuses folding one shared techspec into N>1 Stories', () => {
    assert.throws(
      () =>
        assemblePlanStories([storyTicket('a'), storyTicket('b')], {
          sharedSpec: 'one shared approach for everyone',
        }),
      /shared techspec\.md cannot be folded into N>1/,
    );
  });

  it('allows N>1 when sharedSpec is absent or blank', () => {
    const { stories } = assemblePlanStories(
      [storyTicket('a'), storyTicket('b')],
      { sharedSpec: '   ' },
    );
    assert.equal(stories.length, 2);
  });
});

describe('createStoryIssues', () => {
  it('creates issues with type::story + agent::ready and NO plan-run label, even when N>1', async () => {
    // Story #4540: N>1 used to mint an opaque `plan-run::<hex>` label that
    // nothing ever deleted, to express a grouping that ordering already
    // encodes via the blocked-by footers asserted in the next test.
    const calls = [];
    const provider = {
      createIssue: async (payload) => {
        calls.push(payload);
        return {
          id: 100 + calls.length,
          url: `https://example/${calls.length}`,
        };
      },
    };
    const { stories } = assemblePlanStories([
      storyTicket('a'),
      storyTicket('b'),
    ]);
    const result = await createStoryIssues({ provider, stories });
    assert.equal(result.created.length, 2);
    assert.equal(result.planRunLabel, undefined);
    for (const call of calls) {
      assert.ok(call.labels.includes(TYPE_LABELS.STORY));
      assert.ok(call.labels.includes(AGENT_LABELS.READY));
      assert.deepEqual(
        call.labels.filter((l) => l.startsWith('plan-run::')),
        [],
        'no batch label is applied',
      );
    }
  });

  it('creates dependencies first and persists numeric blocked-by edges', async () => {
    const calls = [];
    const provider = {
      createIssue: async (payload) => {
        calls.push(payload);
        return { id: 200 + calls.length };
      },
    };
    const { stories } = assemblePlanStories([
      storyTicket('consumer', { depends_on: ['migration'] }),
      storyTicket('migration'),
    ]);
    const { created } = await createStoryIssues({
      provider,
      stories,
      opts: { planRunId: 'ordered' },
    });
    assert.deepEqual(
      created.map((story) => story.slug),
      ['migration', 'consumer'],
    );
    assert.deepEqual(parse(calls[1].body).body.depends_on, ['#201']);
  });

  it('rejects unknown dependencies before any issue write', async () => {
    let writes = 0;
    const provider = {
      createIssue: async () => {
        writes += 1;
        return { id: 1 };
      },
    };
    const { stories } = assemblePlanStories([
      storyTicket('consumer', { depends_on: ['missing'] }),
    ]);
    await assert.rejects(
      () => createStoryIssues({ provider, stories }),
      /unknown sibling/,
    );
    assert.equal(writes, 0);
  });
});

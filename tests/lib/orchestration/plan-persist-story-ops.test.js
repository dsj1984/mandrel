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
  PLAN_RUN_LABEL_PREFIX,
  planRunLabel,
} from '../../../.agents/scripts/lib/orchestration/plan-persist/story-ops.js';
import { DEFAULT_SPEC_BODY_TOKEN_BUDGET } from '../../../.agents/scripts/lib/orchestration/spec-spill.js';
import { serialize } from '../../../.agents/scripts/lib/story-body/story-body.js';

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

describe('planRunLabel', () => {
  it('prefixes plan-run:: and sanitizes ids', () => {
    assert.equal(planRunLabel('My Run'), `${PLAN_RUN_LABEL_PREFIX}my-run`);
    assert.match(
      planRunLabel(),
      new RegExp(`^${PLAN_RUN_LABEL_PREFIX}[a-f0-9]{8}$`),
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
});

describe('foldSpecIntoStoryBody', () => {
  it('keeps a small shared spec inline', () => {
    const { bodyObject, spill } = foldSpecIntoStoryBody(
      { goal: 'g', changes: [], acceptance: [], verify: [], references: [] },
      's1',
      { sharedSpec: 'short tech spec', write: false },
    );
    assert.equal(bodyObject.spec, 'short tech spec');
    assert.equal(spill.spilled, false);
  });

  it('spills an over-budget spec to a reference', () => {
    const writes = new Map();
    const big = 'x'.repeat((DEFAULT_SPEC_BODY_TOKEN_BUDGET + 50) * 4);
    const { bodyObject, spill } = foldSpecIntoStoryBody(
      { goal: 'g', changes: [], acceptance: [], verify: [], references: [] },
      's1',
      {
        sharedSpec: big,
        write: true,
        repoRoot: '/repo',
        fs: {
          writeFileSync: (p, c) => writes.set(p, c),
          mkdirSync: () => {},
        },
      },
    );
    assert.equal(bodyObject.spec, '');
    assert.equal(spill.spilled, true);
    assert.deepEqual(bodyObject.references[0], {
      path: 'docs/specs/s1.md',
      assumption: 'creates',
    });
    assert.equal(writes.has('/repo/docs/specs/s1.md'), true);
  });
});

describe('assemblePlanStories', () => {
  it('assembles a default-single plan', () => {
    const { stories } = assemblePlanStories([storyTicket('solo')], {
      write: false,
    });
    assert.equal(stories.length, 1);
    assert.match(stories[0].body, /## Goal/);
  });

  it('refuses cross-Story duplicate acceptance', () => {
    assert.throws(
      () =>
        assemblePlanStories(
          [
            storyTicket('a', {
              bodyFields: { acceptance: ['shared criterion'] },
            }),
            storyTicket('b', {
              bodyFields: { acceptance: ['shared criterion'] },
            }),
          ],
          { write: false },
        ),
      /split-policy/,
    );
  });
});

describe('createStoryIssues', () => {
  it('creates issues with type::story + agent::ready and plan-run label when N>1', async () => {
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
    const { stories } = assemblePlanStories(
      [storyTicket('a'), storyTicket('b')],
      { write: false },
    );
    const { created, planRunLabel: label } = await createStoryIssues({
      provider,
      stories,
      opts: { planRunId: 'abc12345' },
    });
    assert.equal(created.length, 2);
    assert.equal(label, `${PLAN_RUN_LABEL_PREFIX}abc12345`);
    assert.ok(calls[0].labels.includes(TYPE_LABELS.STORY));
    assert.ok(calls[0].labels.includes(AGENT_LABELS.READY));
    assert.ok(calls[0].labels.includes(label));
  });
});

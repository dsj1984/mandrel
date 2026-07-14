/**
 * v2 Stage 3 — flat Story persist (no Epic, no deliveryShape).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AGENT_LABELS,
  TYPE_LABELS,
} from '../../.agents/scripts/lib/label-constants.js';
import { runPlanPersist } from '../../.agents/scripts/lib/orchestration/plan-persist/run-plan-persist.js';
import { PLAN_SUMMARY_COMMENT_TYPE } from '../../.agents/scripts/lib/orchestration/plan-persist/summary.js';
import { serialize } from '../../.agents/scripts/lib/story-body/story-body.js';

const VERDICT = {
  axes: [
    {
      axis: 'internal-refactor',
      level: 'low',
      rationale: 'Test fixture — internal tooling only.',
    },
  ],
  summary: 'Low-risk internal refactor (test fixture).',
};

function ticket(slug) {
  const acceptance = [`${slug} done`];
  const verify = ['npm test (validate)'];
  return {
    slug,
    type: 'story',
    title: `Story ${slug}`,
    acceptance,
    verify,
    body: serialize({
      goal: `Goal of ${slug}.`,
      changes: [
        {
          path: 'tests/scripts/plan-persist.flat-stories.test.js',
          assumption: 'refactors-existing',
        },
      ],
      acceptance,
      verify,
      reason_to_exist: `Ship ${slug}`,
    }),
  };
}

function fakeProvider() {
  const issues = new Map();
  const comments = [];
  let nextId = 5000;
  return {
    issues,
    comments,
    async createIssue({ title, body, labels }) {
      const id = nextId++;
      issues.set(id, { id, title, body, labels });
      return { id, url: `https://example.test/${id}` };
    },
    async getTicketComments(issueNumber) {
      return comments.filter((c) => c.issueNumber === issueNumber);
    },
    async postComment(issueNumber, payload) {
      const body = typeof payload === 'string' ? payload : payload.body;
      const id = comments.length + 1;
      comments.push({ id, issueNumber, body });
      return { commentId: id, id };
    },
    async deleteComment(id) {
      const idx = comments.findIndex((c) => c.id === id);
      if (idx >= 0) comments.splice(idx, 1);
    },
  };
}

describe('runPlanPersist — flat Story ops', () => {
  it('creates one Story by default with agent::ready and plan-summary', async () => {
    const provider = fakeProvider();
    const result = await runPlanPersist({
      provider,
      artifacts: {
        stories: [ticket('solo')],
        riskVerdict: VERDICT,
        techSpecContent: '## Overview\n\nSmall folded spec.',
      },
      config: {},
      opts: { skipCleanup: true, writeSpill: false },
    });

    assert.equal(result.stories.length, 1);
    assert.equal(result.primaryStoryId, result.stories[0].id);
    assert.equal(result.planRunLabel, null);

    const issue = provider.issues.get(result.primaryStoryId);
    assert.ok(issue.labels.includes(TYPE_LABELS.STORY));
    assert.ok(issue.labels.includes(AGENT_LABELS.READY));
    assert.match(issue.body, /## Spec/);

    const bodies = provider.comments.map((c) => c.body).join('\n');
    assert.match(bodies, /Plan Summary/);
    assert.match(bodies, /internal-refactor|risk-verdict/);
    void PLAN_SUMMARY_COMMENT_TYPE;
  });

  it('refuses deliveryShape in the risk verdict', async () => {
    const provider = fakeProvider();
    await assert.rejects(
      () =>
        runPlanPersist({
          provider,
          artifacts: {
            stories: [ticket('solo')],
            riskVerdict: {
              ...VERDICT,
              deliveryShape: 'single',
              deliveryShapeRationale: 'nope',
            },
          },
          opts: { skipCleanup: true, writeSpill: false },
        }),
      /deliveryShape/,
    );
  });

  it('rejects hard model-capacity findings before issue creation', async () => {
    const provider = fakeProvider();
    const oversized = ticket('oversized');
    oversized.acceptance = Array.from(
      { length: 20 },
      (_, index) => `criterion ${index}`,
    );
    oversized.body = serialize({
      goal: 'A cohesive but oversized session.',
      changes: [
        {
          path: 'tests/scripts/plan-persist.flat-stories.test.js',
          assumption: 'refactors-existing',
        },
      ],
      acceptance: oversized.acceptance,
      verify: oversized.verify,
      reason_to_exist: 'Prove hard capacity is enforced',
    });

    await assert.rejects(
      () =>
        runPlanPersist({
          provider,
          artifacts: {
            stories: [oversized],
            riskVerdict: VERDICT,
          },
          config: {
            delivery: { maxTokenBudget: 1000 },
            planning: {
              modelCapacity: {
                hardSessionFraction: 0.1,
                softSessionFraction: 0.05,
              },
            },
          },
          opts: { skipCleanup: true, writeSpill: false },
        }),
      /ticket validation failed.*oversized/s,
    );
    assert.equal(provider.issues.size, 0);
  });

  it('labels N>1 Stories with a shared plan-run:: label', async () => {
    const provider = fakeProvider();
    const result = await runPlanPersist({
      provider,
      artifacts: {
        stories: [ticket('one'), ticket('two')],
        riskVerdict: VERDICT,
      },
      opts: {
        skipCleanup: true,
        writeSpill: false,
        planRunId: 'stage3',
      },
    });
    assert.equal(result.stories.length, 2);
    assert.equal(result.planRunLabel, 'plan-run::stage3');
    for (const s of result.stories) {
      const issue = provider.issues.get(s.id);
      assert.ok(issue.labels.includes('plan-run::stage3'));
      const storyComments = provider.comments
        .filter((comment) => comment.issueNumber === s.id)
        .map((comment) => comment.body)
        .join('\n');
      assert.match(storyComments, /risk-verdict/);
      assert.match(storyComments, /story-plan-state/);
    }
  });
});

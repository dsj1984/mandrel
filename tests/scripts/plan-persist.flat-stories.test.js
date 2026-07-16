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
import { resolveSourceTicketIds } from '../../.agents/scripts/lib/orchestration/plan-persist/supersede-ops.js';
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

function fakeProvider({ sources = [] } = {}) {
  const issues = new Map();
  const comments = [];
  const updates = [];
  let nextId = 5000;
  for (const source of sources) {
    issues.set(source.id, {
      id: source.id,
      title: source.title ?? `Source ${source.id}`,
      body: source.body ?? '',
      labels: [],
      state: source.state ?? 'open',
    });
  }
  return {
    issues,
    comments,
    updates,
    async createIssue({ title, body, labels }) {
      const id = nextId++;
      issues.set(id, { id, title, body, labels });
      return { id, url: `https://example.test/${id}` };
    },
    async getTicket(id) {
      const issue = issues.get(id);
      if (!issue) throw new Error(`ticket #${id} not found`);
      return { ...issue, state: issue.state ?? 'open' };
    },
    async updateTicket(id, mutations) {
      updates.push({ id, mutations });
      const issue = issues.get(id);
      if (!issue) throw new Error(`ticket #${id} not found`);
      Object.assign(issue, mutations);
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
      opts: { skipCleanup: true },
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
          opts: { skipCleanup: true },
        }),
      /deliveryShape/,
    );
  });

  it('rejects hard model-capacity findings before issue creation', async () => {
    const provider = fakeProvider();
    // Authored-tokens-only mass: pad Spec above hardSessionTokens: 100.
    const oversized = ticket('oversized');
    const verboseSpec = 'x'.repeat(1200);
    oversized.body = serialize({
      goal: 'A cohesive but oversized session.',
      spec: verboseSpec,
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
          opts: {
            modelCapacity: { hardSessionTokens: 100, softSessionTokens: 50 },
            skipCleanup: true,
          },
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

describe('runPlanPersist — superseded source tickets (Story #4535)', () => {
  function supersedingTicket(slug, supersedes) {
    return { ...ticket(slug), supersedes };
  }

  function sourceComments(provider, id) {
    return provider.comments
      .filter((comment) => comment.issueNumber === id)
      .map((comment) => comment.body)
      .join('\n');
  }

  it('comments naming the claiming Story and closes as not_planned', async () => {
    const provider = fakeProvider({
      sources: [{ id: 900, title: 'Old idea' }],
    });
    const result = await runPlanPersist({
      provider,
      artifacts: {
        stories: [supersedingTicket('solo', [900])],
        riskVerdict: VERDICT,
      },
      opts: { skipCleanup: true, sourceTicketIds: [900] },
    });

    const storyId = result.primaryStoryId;
    assert.deepEqual(result.supersede.closed, [900]);
    assert.deepEqual(result.supersede.failed, []);

    const body = sourceComments(provider, 900);
    assert.match(body, new RegExp(`Superseded by #${storyId}`));
    assert.match(body, /Story solo/);
    assert.match(body, /superseded-by/);
    // Names the specific Story, not a blanket plan-run reference.
    assert.doesNotMatch(body, /superseded by this plan-run/i);

    assert.deepEqual(provider.updates, [
      { id: 900, mutations: { state: 'closed', state_reason: 'not_planned' } },
    ]);
    assert.equal(provider.issues.get(900).state, 'closed');
  });

  it('renders the per-supersede note authored on the Story', async () => {
    const provider = fakeProvider({ sources: [{ id: 901 }] });
    await runPlanPersist({
      provider,
      artifacts: {
        stories: [
          supersedingTicket('solo', [
            {
              id: 901,
              note: 'The filed fix is provably inert — recorded here.',
            },
          ]),
        ],
        riskVerdict: VERDICT,
      },
      opts: { skipCleanup: true, sourceTicketIds: [901] },
    });

    assert.match(
      sourceComments(provider, 901),
      /The filed fix is provably inert — recorded here\./,
    );
  });

  it('maps each source to exactly one Story when N>1', async () => {
    const provider = fakeProvider({ sources: [{ id: 910 }, { id: 911 }] });
    const result = await runPlanPersist({
      provider,
      artifacts: {
        stories: [
          supersedingTicket('one', [910]),
          supersedingTicket('two', [911]),
        ],
        riskVerdict: VERDICT,
      },
      opts: { skipCleanup: true, sourceTicketIds: [910, 911], planRunId: 'r1' },
    });

    const byslug = new Map(result.stories.map((s) => [s.slug, s.id]));
    assert.match(
      sourceComments(provider, 910),
      new RegExp(`Superseded by #${byslug.get('one')}`),
    );
    assert.match(
      sourceComments(provider, 911),
      new RegExp(`Superseded by #${byslug.get('two')}`),
    );
    assert.match(sourceComments(provider, 910), /plan-run::r1/);
  });

  it('fails closed on a partial supersede map before creating any Story', async () => {
    const provider = fakeProvider({ sources: [{ id: 920 }, { id: 921 }] });
    await assert.rejects(
      () =>
        runPlanPersist({
          provider,
          artifacts: {
            stories: [supersedingTicket('solo', [920])],
            riskVerdict: VERDICT,
          },
          opts: { skipCleanup: true, sourceTicketIds: [920, 921] },
        }),
      /supersede partition failed[\s\S]*#921 is not claimed/,
    );
    // Nothing was created: only the two pre-seeded sources remain.
    assert.equal(provider.issues.size, 2);
    assert.deepEqual(provider.updates, []);
  });

  it('rejects a Story claiming a ticket that was not a source', async () => {
    const provider = fakeProvider({ sources: [{ id: 930 }] });
    await assert.rejects(
      () =>
        runPlanPersist({
          provider,
          artifacts: {
            stories: [supersedingTicket('solo', [930, 999])],
            riskVerdict: VERDICT,
          },
          opts: { skipCleanup: true, sourceTicketIds: [930] },
        }),
      /#999, which was not passed to --tickets/,
    );
    assert.equal(provider.issues.size, 1);
  });

  it('--no-close-superseded leaves sources open but still creates Stories', async () => {
    const provider = fakeProvider({ sources: [{ id: 940 }] });
    const result = await runPlanPersist({
      provider,
      artifacts: {
        stories: [supersedingTicket('solo', [940])],
        riskVerdict: VERDICT,
      },
      opts: {
        skipCleanup: true,
        sourceTicketIds: [940],
        closeSuperseded: false,
      },
    });

    assert.equal(result.stories.length, 1);
    assert.equal(result.supersede.enabled, false);
    assert.equal(result.supersede.reason, 'disabled-by-flag');
    assert.equal(sourceComments(provider, 940), '');
    assert.deepEqual(provider.updates, []);
    assert.equal(provider.issues.get(940).state, 'open');
  });

  it('--dry-run writes nothing and reports what it would have done', async () => {
    const provider = fakeProvider({ sources: [{ id: 950 }] });
    const result = await runPlanPersist({
      provider,
      artifacts: {
        stories: [supersedingTicket('solo', [950])],
        riskVerdict: VERDICT,
      },
      opts: { skipCleanup: true, sourceTicketIds: [950], dryRun: true },
    });

    assert.equal(result.supersede.dryRun, true);
    // Reported by slug: dry-run creates no issue, so the only Story
    // identifier that means anything here is the slug.
    assert.deepEqual(result.supersede.planned, [
      { ticket: 950, storySlug: 'solo' },
    ]);
    assert.deepEqual(result.supersede.closed, []);
    assert.equal(sourceComments(provider, 950), '');
    assert.deepEqual(provider.updates, []);
    assert.equal(provider.issues.get(950).state, 'open');
  });

  it('skips an already-closed source rather than re-commenting', async () => {
    const provider = fakeProvider({
      sources: [{ id: 960, state: 'closed' }],
    });
    const result = await runPlanPersist({
      provider,
      artifacts: {
        stories: [supersedingTicket('solo', [960])],
        riskVerdict: VERDICT,
      },
      opts: { skipCleanup: true, sourceTicketIds: [960] },
    });

    assert.deepEqual(result.supersede.closed, []);
    assert.deepEqual(result.supersede.skipped, [
      { ticket: 960, reason: 'already-closed' },
    ]);
    assert.equal(sourceComments(provider, 960), '');
    assert.deepEqual(provider.updates, []);
  });

  it('skips an inaccessible source without failing the run', async () => {
    const provider = fakeProvider();
    const result = await runPlanPersist({
      provider,
      artifacts: {
        stories: [supersedingTicket('solo', [970])],
        riskVerdict: VERDICT,
      },
      opts: { skipCleanup: true, sourceTicketIds: [970] },
    });

    assert.equal(result.stories.length, 1);
    assert.deepEqual(result.supersede.closed, []);
    assert.equal(result.supersede.skipped[0].ticket, 970);
    assert.match(result.supersede.skipped[0].reason, /inaccessible/);
  });

  it('reports a close failure without failing the run or orphaning Stories', async () => {
    const provider = fakeProvider({ sources: [{ id: 980 }, { id: 981 }] });
    provider.updateTicket = async (id) => {
      if (id === 980) throw new Error('403 forbidden');
      provider.issues.get(id).state = 'closed';
    };

    const result = await runPlanPersist({
      provider,
      artifacts: {
        stories: [supersedingTicket('solo', [980, 981])],
        riskVerdict: VERDICT,
      },
      opts: { skipCleanup: true, sourceTicketIds: [980, 981] },
    });

    // The Story survives — bookkeeping never fails the run.
    assert.equal(result.stories.length, 1);
    assert.ok(provider.issues.get(result.primaryStoryId));
    assert.deepEqual(result.supersede.closed, [981]);
    assert.deepEqual(result.supersede.failed, [
      { ticket: 980, reason: '403 forbidden' },
    ]);
  });

  it('runs no close phase in seed mode (no source tickets)', async () => {
    const provider = fakeProvider();
    const result = await runPlanPersist({
      provider,
      artifacts: { stories: [ticket('solo')], riskVerdict: VERDICT },
      opts: { skipCleanup: true },
    });

    assert.equal(result.stories.length, 1);
    assert.equal(result.supersede.enabled, false);
    assert.equal(result.supersede.reason, 'no-source-tickets');
    assert.equal(result.supersede.sourceTicketOrigin, 'none');
    assert.deepEqual(provider.updates, []);
  });

  // Story #4554 — the flagless path. `--source-tickets` is never passed; the
  // ids come off the plan-context envelope the run already emitted.
  it('closes the source ticket when the ids were derived from the envelope, with no --source-tickets flag', async () => {
    const provider = fakeProvider({ sources: [{ id: 4525, title: 'Old' }] });
    const { ids, origin } = resolveSourceTicketIds({
      envelope: {
        mode: 'tickets',
        sourceTickets: [{ id: 4525, title: 'Old', body: '' }],
      },
    });

    const result = await runPlanPersist({
      provider,
      artifacts: {
        stories: [supersedingTicket('solo', [4525])],
        riskVerdict: VERDICT,
      },
      opts: {
        skipCleanup: true,
        sourceTicketIds: ids,
        sourceTicketOrigin: origin,
      },
    });

    assert.equal(result.supersede.sourceTicketOrigin, 'envelope');
    assert.deepEqual(result.supersede.closed, [4525]);
    assert.equal(provider.issues.get(4525).state, 'closed');
  });

  // The vacuous-pass hole itself: an envelope-derived source set turns a
  // forgotten `supersedes[]` into the loud partition error it always should
  // have been, instead of an empty-set pass that reported success.
  it('fail-closes rather than partitioning an empty set when the envelope has sources the Stories do not claim', async () => {
    const provider = fakeProvider({ sources: [{ id: 4525 }] });
    const { ids } = resolveSourceTicketIds({
      envelope: { mode: 'tickets', sourceTickets: [{ id: 4525 }] },
    });

    await assert.rejects(
      runPlanPersist({
        provider,
        artifacts: { stories: [ticket('solo')], riskVerdict: VERDICT },
        opts: { skipCleanup: true, sourceTicketIds: ids },
      }),
      /#4525 is not claimed by any Story/,
    );
    // Fail-closed means fail *before* any GitHub write.
    assert.deepEqual(provider.updates, []);
  });
});

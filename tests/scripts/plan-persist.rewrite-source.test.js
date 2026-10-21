/**
 * One-for-one `/mandrel-plan --tickets` plans rewrite their source ticket in
 * place instead of filing a new Story and closing the source (Story #5604).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Logger } from '../../.agents/scripts/lib/Logger.js';
import {
  AGENT_LABELS,
  TYPE_LABELS,
} from '../../.agents/scripts/lib/label-constants.js';
import { runPlanPersist } from '../../.agents/scripts/lib/orchestration/plan-persist/run-plan-persist.js';
import { resolveRewriteTarget } from '../../.agents/scripts/lib/orchestration/plan-persist/source-rewrite.js';
import { serialize } from '../../.agents/scripts/lib/story-body/story-body.js';

const SOURCE_ID = 990;

function draft(goal = 'Rewrite the source in place.') {
  const acceptance = ['the source carries the Story'];
  const verify = ['npm test (validate)'];
  return {
    slug: 'solo',
    type: 'story',
    title: 'Story solo',
    acceptance,
    verify,
    supersedes: [SOURCE_ID],
    body: serialize({
      goal,
      changes: [
        {
          path: '.agents/scripts/plan-persist.js',
          assumption: 'refactors-existing',
        },
      ],
      acceptance,
      verify,
    }),
  };
}

/**
 * In-memory provider that records every write in `events`, so the tests can
 * assert ordering (comment before ready flip) as well as end state.
 */
function recordingProvider({
  labels = [],
  state = 'open',
  body = 'The original analysis.',
} = {}) {
  const issues = new Map([
    [
      SOURCE_ID,
      {
        id: SOURCE_ID,
        title: 'Old idea',
        body,
        labels: [...labels],
        state,
      },
    ],
  ]);
  const comments = [];
  const events = [];
  let nextId = 7000;
  return {
    issues,
    comments,
    events,
    async createIssue({ title, body, labels: created }) {
      const id = nextId++;
      issues.set(id, { id, title, body, labels: [...created], state: 'open' });
      events.push({ kind: 'create', id });
      return { id, url: `https://example.test/${id}` };
    },
    async getTicket(id) {
      const issue = issues.get(id);
      if (!issue) throw new Error(`ticket #${id} not found`);
      return { ...issue, labels: [...issue.labels] };
    },
    async listIssuesByLabel({ state: wanted, labels: label }) {
      return [...issues.values()].filter(
        (issue) => issue.state === wanted && issue.labels.includes(label),
      );
    },
    async updateTicket(id, mutations) {
      events.push({ kind: 'update', id, mutations });
      const issue = issues.get(id);
      const { labels: labelMutations, _ticketSnapshot, ...rest } = mutations;
      Object.assign(issue, rest);
      if (labelMutations) {
        const next = new Set(issue.labels);
        for (const l of labelMutations.remove ?? []) next.delete(l);
        for (const l of labelMutations.add ?? []) next.add(l);
        issue.labels = [...next];
      }
    },
    async getTicketComments(issueNumber) {
      return comments.filter((c) => c.issueNumber === issueNumber);
    },
    async postComment(issueNumber, payload) {
      const body = typeof payload === 'string' ? payload : payload.body;
      const id = comments.length + 1;
      comments.push({ id, issueNumber, body });
      events.push({ kind: 'comment', id: issueNumber, body });
      return { commentId: id, id };
    },
    async deleteComment(id) {
      const idx = comments.findIndex((c) => c.id === id);
      if (idx >= 0) comments.splice(idx, 1);
    },
  };
}

function persist(provider, opts = {}, stories = [draft()]) {
  return runPlanPersist({
    provider,
    artifacts: { stories },
    opts: { skipCleanup: true, sourceTicketIds: [SOURCE_ID], ...opts },
  });
}

function commentsOfType(provider, type) {
  return provider.comments.filter((c) => c.body.includes(`type="${type}"`));
}

describe('runPlanPersist — one-for-one rewrite in place (Story #5604)', () => {
  it('rewrites the source and files no new issue', async () => {
    const provider = recordingProvider({ labels: ['bug'] });
    const result = await persist(provider);

    assert.equal(provider.issues.size, 1, 'no new issue is created');
    const source = provider.issues.get(SOURCE_ID);
    assert.equal(source.title, 'Story solo');
    assert.match(source.body, /Rewrite the source in place\./);
    assert.equal(source.state, 'open');
    assert.ok(source.labels.includes(TYPE_LABELS.STORY));
    assert.ok(source.labels.includes('bug'), 'operator labels survive');
    assert.ok(source.labels.includes(AGENT_LABELS.READY));
    assert.ok(source.labels.some((l) => l.startsWith('plan-run::')));

    assert.equal(result.primaryStoryId, SOURCE_ID);
    assert.equal(result.stories[0].rewritten, true);
    assert.deepEqual(result.rewrite, { ticket: SOURCE_ID, reason: null });
    assert.deepEqual(result.supersede.rewritten, [SOURCE_ID]);
    assert.deepEqual(result.supersede.closed, []);
    assert.equal(commentsOfType(provider, 'superseded-by').length, 0);
  });

  it('preserves the original title and body once, first write wins', async () => {
    const provider = recordingProvider();
    await persist(provider);
    await persist(provider, {}, [draft('A second, different plan.')]);

    const preserved = commentsOfType(provider, 'plan-rewrite');
    assert.equal(preserved.length, 1);
    assert.match(preserved[0].body, /Original: Old idea/);
    assert.match(preserved[0].body, /The original analysis\./);
    assert.match(
      provider.issues.get(SOURCE_ID).body,
      /A second, different plan\./,
    );
  });

  it('strips agent::* in the rewriting PATCH and flips ready only after the plan comment', async () => {
    const provider = recordingProvider({
      labels: [AGENT_LABELS.READY, 'plan-run::0ldc0h0r'],
    });
    await persist(provider);

    const rewriteIdx = provider.events.findIndex(
      (e) => e.kind === 'update' && e.mutations.title === 'Story solo',
    );
    const remove = provider.events[rewriteIdx].mutations.labels.remove;
    assert.ok(remove.includes(AGENT_LABELS.READY));
    assert.ok(remove.includes('plan-run::0ldc0h0r'));

    const planCommentIdx = provider.events.findIndex(
      (e) => e.kind === 'comment' && e.body.includes('story-plan-state'),
    );
    const readyIdx = provider.events.findIndex(
      (e) =>
        e.kind === 'update' &&
        e.mutations.labels?.add?.includes(AGENT_LABELS.READY) &&
        e.mutations.title === undefined,
    );
    assert.ok(rewriteIdx < planCommentIdx, 'rewrite precedes the plan comment');
    assert.ok(planCommentIdx < readyIdx, 'ready is the terminal flip');
  });

  for (const [label, opts] of [
    ['--no-rewrite-source', { rewriteSource: false }],
    ['--no-close-superseded', { closeSuperseded: false }],
  ]) {
    it(`${label} keeps the create-and-close path`, async () => {
      const provider = recordingProvider();
      const result = await persist(provider, opts);
      assert.equal(provider.issues.size, 2, 'a new Story is filed');
      assert.notEqual(result.primaryStoryId, SOURCE_ID);
      assert.equal(provider.issues.get(SOURCE_ID).title, 'Old idea');
      assert.equal(result.stories[0].rewritten, undefined);
    });
  }

  for (const [why, setup] of [
    ['epic-container', { labels: [TYPE_LABELS.EPIC] }],
    ['mid-delivery', { labels: [AGENT_LABELS.EXECUTING] }],
    ['mid-delivery', { labels: [AGENT_LABELS.CLOSING] }],
    ['mid-delivery', { labels: [AGENT_LABELS.BLOCKED] }],
    ['closed', { state: 'closed' }],
  ]) {
    it(`falls back to create-and-close with a warning when the source is ${why} (${JSON.stringify(setup)})`, async () => {
      const provider = recordingProvider(setup);
      const result = await persist(provider);
      assert.equal(provider.issues.size, 2);
      assert.equal(provider.issues.get(SOURCE_ID).title, 'Old idea');
      assert.equal(result.rewrite.reason, why);
      assert.ok(
        result.warnings.some((w) =>
          w.includes(`#${SOURCE_ID} cannot be rewritten in place (${why})`),
        ),
        result.warnings.join('\n'),
      );
    });
  }

  it('a dry run writes nothing and reports the planned rewrite', async () => {
    const provider = recordingProvider();
    const result = await persist(provider, { dryRun: true });

    assert.deepEqual(provider.events, []);
    assert.equal(result.stories[0].id, SOURCE_ID);
    assert.equal(result.stories[0].rewritten, true);
    assert.deepEqual(result.supersede.rewritten, [SOURCE_ID]);
    assert.deepEqual(result.supersede.planned, []);
  });

  it('a dry run logs only what it would do, never a rewrite or ready flip', async (t) => {
    const info = [];
    t.mock.method(Logger, 'info', (m) => info.push(String(m)));
    await persist(recordingProvider(), { dryRun: true });

    assert.ok(
      info.includes(
        `[plan-persist] dry-run: would rewrite #${SOURCE_ID} in place as its Story.`,
      ),
    );
    assert.ok(info.some((m) => m.includes('nothing was written to GitHub')));
    for (const claim of ['Rewrote #', 'agent::ready', 'Deliver with']) {
      assert.ok(
        !info.some((m) => m.includes(claim)),
        `dry-run log must not claim "${claim}"`,
      );
    }
  });

  it('a re-run after a failed ready flip adopts the rewritten issue by fingerprint', async () => {
    const provider = recordingProvider();
    const update = provider.updateTicket.bind(provider);
    provider.updateTicket = async (id, mutations) => {
      if (
        mutations.title === undefined &&
        mutations.labels?.add?.includes(AGENT_LABELS.READY)
      ) {
        throw new Error('502 bad gateway');
      }
      return update(id, mutations);
    };
    await assert.rejects(() => persist(provider), /agent::ready/);
    provider.updateTicket = update;

    const result = await persist(provider);
    assert.equal(provider.issues.size, 1, 'no duplicate is created');
    assert.equal(result.stories[0].id, SOURCE_ID);
    assert.equal(result.stories[0].adopted, true);
    assert.equal(result.stories[0].rewritten, true);
    assert.deepEqual(
      result.supersede.closed,
      [],
      'the Story never closes itself',
    );
    assert.equal(provider.issues.get(SOURCE_ID).state, 'open');
    assert.ok(
      provider.issues.get(SOURCE_ID).labels.includes(AGENT_LABELS.READY),
    );
  });
});

describe('resolveRewriteTarget (Story #5604)', () => {
  const provider = recordingProvider();

  it('is not one-for-one with two sources or two Stories', async () => {
    for (const [storyCount, sourceTicketIds] of [
      [1, [SOURCE_ID, 991]],
      [2, [SOURCE_ID]],
      [1, []],
    ]) {
      const result = await resolveRewriteTarget({
        provider,
        storyCount,
        sourceTicketIds,
      });
      assert.equal(result.target, null);
      assert.equal(result.reason, 'not-one-for-one');
      assert.deepEqual(result.warnings, []);
    }
  });

  it('refuses an inaccessible source with a warning', async () => {
    const result = await resolveRewriteTarget({
      provider,
      storyCount: 1,
      sourceTicketIds: [404],
    });
    assert.equal(result.target, null);
    assert.match(result.reason, /^inaccessible:/);
    assert.match(result.warnings[0], /#404 cannot be rewritten in place/);
  });
});

describe('the plan-rewrite comment (Story #5604)', () => {
  it('marks an empty original body explicitly', async () => {
    const provider = recordingProvider({ body: '  ' });
    await persist(provider);
    const [preserved] = commentsOfType(provider, 'plan-rewrite');
    assert.match(preserved.body, /_\(empty body\)_/);
  });
});

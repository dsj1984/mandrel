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
  derivePlanRunId,
  foldSpecIntoStoryBody,
  normalizePlanRunId,
  normalizeStoryTicket,
  PLAN_RUN_LABEL_PREFIX,
  planRunLabel,
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

// Story #4692 reintroduced planRunLabel / PLAN_RUN_LABEL_PREFIX /
// normalizePlanRunId (retired by Story #4540) as a metadata-only grouping
// axis, with the id now DETERMINISTIC over the authored artifacts
// (derivePlanRunId hashes the sorted per-Story plan fingerprints) instead of
// random, so a resumed persist reuses the identical label. The
// createStoryIssues tests below assert the label's presence and stability.

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
  it('creates issues with type::story plus exactly one plan-run cohort label and NO agent::ready, even when N>1', async () => {
    // Story #4692: every Story a persist run creates carries the cohort's
    // `plan-run::<id>` grouping label — metadata only, never a delivery
    // input. Ordering still lives in the blocked-by footers asserted in the
    // next test.
    //
    // Story #4541: agent::ready is no longer part of the creating POST.
    // `markStoriesReady` applies it as the terminal step of persist, once
    // every checkpoint is on the ticket — so a Story labelled ready always
    // has its risk envelope.
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
    const expectedLabel = planRunLabel(
      derivePlanRunId(stories.map((s) => s.fingerprint)),
    );
    assert.equal(result.planRunLabel, expectedLabel);
    for (const call of calls) {
      assert.ok(call.labels.includes(TYPE_LABELS.STORY));
      assert.ok(
        !call.labels.includes(AGENT_LABELS.READY),
        'ready is the terminal flip, not part of the creating POST',
      );
      assert.deepEqual(
        call.labels.filter((l) => l.startsWith(PLAN_RUN_LABEL_PREFIX)),
        [expectedLabel],
        'exactly one cohort grouping label is applied',
      );
    }
  });

  it('derives the same plan-run label across a re-run and different labels for different plans', async () => {
    // The id is a pure function of the authored artifacts (sorted per-Story
    // fingerprints), so a persist re-run of the same stories.json derives
    // the identical cohort label — the resumable-create contract — while a
    // different plan derives a different one.
    const makeProvider = () => ({
      createIssue: async () => ({ id: Math.floor(Math.random() * 1e6) }),
    });
    const { stories: first } = assemblePlanStories([
      storyTicket('a'),
      storyTicket('b'),
    ]);
    const { stories: second } = assemblePlanStories([
      storyTicket('a'),
      storyTicket('b'),
    ]);
    const runA = await createStoryIssues({
      provider: makeProvider(),
      stories: first,
    });
    const runB = await createStoryIssues({
      provider: makeProvider(),
      stories: second,
    });
    assert.equal(runA.planRunLabel, runB.planRunLabel);
    assert.match(
      runA.planRunLabel,
      new RegExp(`^${PLAN_RUN_LABEL_PREFIX}[0-9a-f]{8}$`),
    );

    const { stories: other } = assemblePlanStories([storyTicket('c')]);
    const runC = await createStoryIssues({
      provider: makeProvider(),
      stories: other,
    });
    assert.notEqual(runC.planRunLabel, runA.planRunLabel);
  });

  it('is independent of fingerprint order', () => {
    assert.equal(
      derivePlanRunId(['bbb', 'aaa']),
      derivePlanRunId(['aaa', 'bbb']),
    );
  });

  it('normalizePlanRunId canonicalizes tokens and rejects empty ids', () => {
    assert.equal(normalizePlanRunId('  Plan-Run::My Cohort!  '), 'my-cohort-');
    assert.equal(normalizePlanRunId('plan-run::abc123'), 'abc123');
    assert.equal(planRunLabel('ABC 123'), `${PLAN_RUN_LABEL_PREFIX}abc-123`);
    assert.throws(() => normalizePlanRunId('   '), /non-empty planRunId/);
  });

  it('ensures the cohort label before the first create and degrades non-fatally on ensure failure', async () => {
    // AC-4: the label must exist before it is applied, and a label-ensure
    // failure degrades to a warning — the Stories are still created, just
    // without the cosmetic grouping label.
    const events = [];
    const okProvider = {
      ensureLabels: async (defs) => {
        events.push(`ensure:${defs[0].name}`);
        return { created: [defs[0].name], skipped: [], missing: [] };
      },
      createIssue: async (payload) => {
        events.push('create');
        events.push(payload.labels.filter((l) => l.startsWith('plan-run::')));
        return { id: 300 + events.length };
      },
    };
    const { stories } = assemblePlanStories([storyTicket('a')]);
    const ok = await createStoryIssues({ provider: okProvider, stories });
    assert.equal(events[0], `ensure:${ok.planRunLabel}`);
    assert.deepEqual(events[2], [ok.planRunLabel]);

    const failCalls = [];
    const failProvider = {
      ensureLabels: async () => {
        throw new Error('boom');
      },
      createIssue: async (payload) => {
        failCalls.push(payload);
        return { id: 400 + failCalls.length };
      },
    };
    const { stories: stories2 } = assemblePlanStories([storyTicket('a')]);
    const degraded = await createStoryIssues({
      provider: failProvider,
      stories: stories2,
    });
    assert.equal(degraded.created.length, 1, 'Stories are still created');
    assert.deepEqual(
      failCalls[0].labels.filter((l) => l.startsWith('plan-run::')),
      [],
      'the unensured label is not applied',
    );
    assert.equal(
      degraded.planRunLabel,
      ok.planRunLabel,
      'the derived label is still reported',
    );
  });

  it('reports the derived plan-run label under dryRun without any write', async () => {
    let writes = 0;
    const provider = {
      ensureLabels: async () => {
        writes += 1;
        return { created: [], skipped: [], missing: [] };
      },
      createIssue: async () => {
        writes += 1;
        return { id: 1 };
      },
    };
    const { stories } = assemblePlanStories([storyTicket('a')]);
    const result = await createStoryIssues({
      provider,
      stories,
      opts: { dryRun: true },
    });
    assert.equal(writes, 0);
    assert.match(
      result.planRunLabel,
      new RegExp(`^${PLAN_RUN_LABEL_PREFIX}[0-9a-f]{8}$`),
    );
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

/**
 * Build a provider fake that speaks the `getDependencyWriteContext` interface
 * (Story #4544) and records both the created-issue payloads and the raw
 * dependencies-API traffic.
 *
 * `createIssue` hands back ids from 201 upward in call order, and `getTicket`
 * maps an issue number to a distinct REST database id (`90000 + number`) —
 * distinct because the dependencies API takes the database id, not the issue
 * number, and a fake that conflated them would let that bug through.
 *
 * @param {{ existingBlockedBy?: Array<{ id: number }>, postShouldFail?: boolean }} [opts]
 */
function makeMirrorProvider({
  existingBlockedBy = [],
  postShouldFail = false,
} = {}) {
  const createPayloads = [];
  const ghCalls = [];
  return {
    createPayloads,
    ghCalls,
    createIssue: async (payload) => {
      createPayloads.push(payload);
      return { id: 200 + createPayloads.length };
    },
    getTicket: async (issueNumber) => ({ internalId: 90000 + issueNumber }),
    getDependencyWriteContext: () => ({
      owner: 'org',
      repo: 'repo',
      gh: {
        api: async ({ method, endpoint, body }) => {
          ghCalls.push({ method, endpoint, body });
          if (method === 'GET') {
            return {
              stdout: JSON.stringify(existingBlockedBy),
              stderr: '',
              code: 0,
            };
          }
          if (postShouldFail) {
            throw new Error('dependencies API rejected the edge');
          }
          return { stdout: JSON.stringify({ id: 1 }), stderr: '', code: 0 };
        },
      },
    }),
  };
}

/** A two-Story plan carrying exactly one edge: consumer depends on migration. */
function orderedPair() {
  return assemblePlanStories([
    storyTicket('consumer', { depends_on: ['migration'] }),
    storyTicket('migration'),
  ]).stories;
}

describe('createStoryIssues — native blocked_by mirroring (Story #4544)', () => {
  it('mirrors each authored depends_on edge into exactly one native blocked_by POST', async () => {
    // The count is asserted exactly, not as ">= 0" or mere completion,
    // precisely because the mirroring contract is non-fatal: a wiring mistake
    // (e.g. handing the writer the create loop's `Map` where it does property
    // access) skips every edge, adds zero, and still reports success.
    const provider = makeMirrorProvider();
    const { created, dependencyEdges } = await createStoryIssues({
      provider,
      stories: orderedPair(),
    });

    assert.deepEqual(
      created.map((s) => s.slug),
      ['migration', 'consumer'],
    );
    assert.deepEqual(dependencyEdges, {
      edgesAdded: 1,
      edgesSkipped: 0,
      edgesFailed: 0,
      storiesProcessed: 1,
    });

    const posts = provider.ghCalls.filter((c) => c.method === 'POST');
    assert.equal(posts.length, 1);
    assert.equal(
      posts[0].endpoint,
      '/repos/org/repo/issues/202/dependencies/blocked_by',
      'the edge is written on the dependent Story (consumer, #202)',
    );
    assert.deepEqual(
      posts[0].body,
      { issue_id: 90201 },
      "the payload carries the blocker's REST database id, not its issue number",
    );
  });

  it('is idempotent: an edge that already exists is skipped, not duplicated', async () => {
    const provider = makeMirrorProvider({
      existingBlockedBy: [{ id: 90201 }],
    });
    const { dependencyEdges } = await createStoryIssues({
      provider,
      stories: orderedPair(),
    });

    assert.deepEqual(dependencyEdges, {
      edgesAdded: 0,
      edgesSkipped: 1,
      edgesFailed: 0,
      storiesProcessed: 1,
    });
    assert.deepEqual(
      provider.ghCalls.filter((c) => c.method === 'POST'),
      [],
      're-applying an existing edge writes nothing',
    );
  });

  it('completes the persist when the dependencies API rejects, and reports the failure', async () => {
    // Non-fatal is the right call here — and only because the ordering has a
    // second home. A dropped edge is cosmetic: the `blocked by #N` footer is
    // already in the created body, and that is what /deliver's resolver reads.
    const provider = makeMirrorProvider({ postShouldFail: true });
    const { created, dependencyEdges } = await createStoryIssues({
      provider,
      stories: orderedPair(),
    });

    assert.equal(created.length, 2, 'persist completes rather than throwing');
    assert.equal(dependencyEdges.edgesAdded, 0);
    assert.equal(
      dependencyEdges.edgesFailed,
      1,
      'the failure is counted and returned, not swallowed',
    );
    assert.deepEqual(
      parse(provider.createPayloads[1].body).body.depends_on,
      ['#201'],
      'ordering survives in the body footer',
    );
  });

  it('never reaches into provider internals when no interface is offered', async () => {
    // A provider exposing only the private `_gh` field must yield no edges —
    // if this ever starts writing, something has gone back to reaching through
    // the provider's internals from the orchestration layer.
    const ghCalls = [];
    let n = 0;
    const provider = {
      createIssue: async () => ({ id: 200 + ++n }),
      getTicket: async () => ({ internalId: 1 }),
      _gh: {
        api: async (call) => {
          ghCalls.push(call);
          return { stdout: '[]', stderr: '', code: 0 };
        },
      },
    };

    const { created, dependencyEdges } = await createStoryIssues({
      provider,
      stories: orderedPair(),
    });

    assert.equal(created.length, 2);
    assert.equal(dependencyEdges, null);
    assert.deepEqual(ghCalls, []);
  });

  it('does not touch the dependencies API for a plan with no edges', async () => {
    const provider = makeMirrorProvider();
    const { dependencyEdges } = await createStoryIssues({
      provider,
      stories: assemblePlanStories([storyTicket('solo')]).stories,
    });
    assert.equal(dependencyEdges, null);
    assert.deepEqual(provider.ghCalls, []);
  });

  it('mirrors edges on a resumed run whose Stories were already created', async () => {
    // The adopted branch skips the POST but still records the id, so a re-run
    // after a mid-creation failure completes the cohort's edges too.
    const provider = makeMirrorProvider();
    provider.listIssuesByLabel = async () =>
      orderedPair().map((story, i) => ({
        number: 201 + (story.slug === 'migration' ? 0 : 1),
        title: story.title,
        body: `<!-- plan-story: ${story.fingerprint} -->`,
        html_url: `https://example/${i}`,
      }));

    const { created, dependencyEdges } = await createStoryIssues({
      provider,
      stories: orderedPair(),
    });

    assert.deepEqual(
      created.map((s) => s.adopted),
      [true, true],
      'both Stories are adopted, not re-created',
    );
    assert.deepEqual(provider.createPayloads, []);
    assert.equal(dependencyEdges.edgesAdded, 1);
  });
});

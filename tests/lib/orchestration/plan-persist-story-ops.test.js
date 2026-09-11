/**
 * Unit tests for v2 Stage 3 flat Story ops (plan-persist/story-ops.js).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseBlockedBy } from '../../../.agents/scripts/lib/dependency-parser.js';
import {
  AGENT_LABELS,
  TYPE_LABELS,
} from '../../../.agents/scripts/lib/label-constants.js';
import { LITE_ROUTE_LABEL } from '../../../.agents/scripts/lib/orchestration/complexity-gate.js';
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
  computeAssembledConflictFindings,
  computeConflictFindings,
} from '../../../.agents/scripts/lib/orchestration/ticket-validator-conflicts.js';
import {
  parse,
  serialize,
} from '../../../.agents/scripts/lib/story-body/story-body.js';

// GitHub's published cap on a label description — an external API
// constraint, pinned as a literal so the assertion is independent of ours.
const LABEL_DESCRIPTION_MAX_LENGTH = 100;

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

  it("sends both persist label descriptions within GitHub's length cap", async () => {
    // Story #5201: the cohort description was 108 characters and the
    // route::lite one 138, so `gh label create` answered HTTP 422
    // `description is too long` and the cohort label was never once created.
    // Asserted through the defs the gateway actually receives, so a future
    // edit to either literal is caught here rather than at persist time.
    const defs = [];
    const provider = {
      ensureLabels: async (given) => {
        defs.push(...given);
        return { created: given.map((d) => d.name), skipped: [], missing: [] };
      },
      createIssue: async () => ({ id: 700 + defs.length }),
    };
    const { stories } = assemblePlanStories([storyTicket('a')]);
    await createStoryIssues({
      provider,
      stories,
      opts: { routeLabel: LITE_ROUTE_LABEL },
    });

    assert.equal(
      defs.length,
      2,
      'both the cohort and route labels are ensured',
    );
    for (const def of defs) {
      assert.ok(
        def.description.length > 0,
        `${def.name} still says what the label is for`,
      );
      assert.ok(
        def.description.length <= LABEL_DESCRIPTION_MAX_LENGTH,
        `${def.name} description is ${def.description.length} characters, ` +
          `over the ${LABEL_DESCRIPTION_MAX_LENGTH} cap`,
      );
    }
  });

  it('separates the derived cohort id from whether it was applied', async () => {
    // The epilogue reads `planRunLabelApplied` to decide whether to advertise
    // a `label:` filter; `planRunLabel` keeps reporting the derived id on
    // every path, including the ones where nothing carries it.
    const applied = await createStoryIssues({
      provider: {
        ensureLabels: async (defs) => ({
          created: defs.map((d) => d.name),
          skipped: [],
          missing: [],
        }),
        createIssue: async () => ({ id: 801 }),
      },
      stories: assemblePlanStories([storyTicket('a')]).stories,
    });
    assert.equal(applied.planRunLabelApplied, true);

    const refused = await createStoryIssues({
      provider: {
        ensureLabels: async () => {
          throw new Error('HTTP 422');
        },
        createIssue: async () => ({ id: 802 }),
      },
      stories: assemblePlanStories([storyTicket('a')]).stories,
    });
    assert.equal(refused.planRunLabelApplied, false);
    assert.equal(refused.planRunLabel, applied.planRunLabel);

    // A dry run writes nothing, so it claims nothing was applied while still
    // reporting the id it derived.
    const dry = await createStoryIssues({
      provider: {
        ensureLabels: async () => ({ created: [], skipped: [], missing: [] }),
        createIssue: async () => ({ id: 803 }),
      },
      stories: assemblePlanStories([storyTicket('a')]).stories,
      opts: { dryRun: true },
    });
    assert.equal(dry.planRunLabelApplied, false);
    assert.equal(dry.planRunLabel, applied.planRunLabel);
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
    // already in the created body, and that is what /mandrel-deliver's resolver reads.
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

describe('audit dedup provenance carry (Story #4877, AC-5)', () => {
  const SHA = 'd'.repeat(40);
  const KEY = 'architecture␟lib/seam.js';

  /** The seed shape `/audit-to-stories --emit-plan-seed` writes. */
  const auditSeed = [
    '# Idea Seed: Audit Remediation',
    '',
    '## MVP Scope',
    '',
    '1. **Remediate the unwired seam** — architecture (`lib/seam.js`)',
    `   <!-- audit-fingerprints: ${SHA} -->`,
    `   <!-- audit-semantic-keys: ${KEY} -->`,
    '',
  ].join('\n');

  const ticket = {
    slug: 'wire-the-reader',
    title: 'Wire the reader',
    goal: 'Build the reader for the stamped field.',
    changes: [{ path: 'lib/seam.js', assumption: 'refactors-existing' }],
    acceptance: ['The reader is wired and a test fails without it.'],
    verify: ['npm test (unit)'],
  };

  it('assembly carries the seed footers into the persisted body', () => {
    // This is the wiring assertion, not a unit test of the helper: it proves the
    // carry is REACHED on the real assembly path. `carryProvenanceFooters` was
    // exactly the shape of seam this Story teaches the lenses to hunt — built,
    // unit-tested, and dead if nothing called it.
    const { stories } = assemblePlanStories([ticket], {
      provenanceSource: auditSeed,
    });
    assert.equal(stories.length, 1);
    assert.match(stories[0].body, new RegExp(`audit-fingerprints:\\s*${SHA}`));
    assert.ok(
      stories[0].body.includes(`audit-semantic-keys: ${KEY}`),
      'the semantic-key footer must ride along with the fingerprint footer',
    );
  });

  it('the carried body still round-trips through the story-body parser', () => {
    // The footers are HTML comments appended after the canonical sections, so
    // they must not disturb the structured contract.
    const { stories } = assemblePlanStories([ticket], {
      provenanceSource: auditSeed,
    });
    const { body } = parse(stories[0].body);
    assert.equal(body.goal, ticket.goal);
    assert.deepEqual(body.acceptance, ticket.acceptance);
    assert.deepEqual(
      body.changes.map((c) => c.path),
      ['lib/seam.js'],
    );
  });

  it('every Story in an N>1 plan carries the provenance', () => {
    // Scope note (Story #5056): this asserts on ASSEMBLY output for tickets
    // with no edges at all. It is not the persist-side guard, however much it
    // reads like one — a dependent Story's posted body is rebuilt by
    // `renderStoryBodyForCreate` and can lose the footers with this still
    // green. The guard that reads the POSTed body is the
    // `Story #4935/#5056` suite at the bottom of this file.
    //
    // Distinct acceptance per Story — a verbatim-shared criterion is refused as
    // a coupled split before assembly ever reaches the carry.
    const second = {
      ...ticket,
      slug: 'drop-the-field',
      title: 'Drop the field',
      acceptance: ['The unread field is gone and no writer stamps it.'],
    };
    const { stories } = assemblePlanStories([ticket, second], {
      provenanceSource: auditSeed,
    });
    assert.equal(stories.length, 2);
    for (const story of stories) {
      assert.match(story.body, new RegExp(`audit-fingerprints:\\s*${SHA}`));
    }
  });

  it('a plan with no provenance source is byte-identical to before the carry', () => {
    // A `--tickets` run and a plain `--seed` run must be untouched.
    const withoutOpt = assemblePlanStories([ticket], {}).stories[0];
    for (const provenanceSource of [
      '',
      null,
      undefined,
      '# Seed\n\nNo footers.\n',
    ]) {
      const { stories } = assemblePlanStories([ticket], { provenanceSource });
      assert.equal(
        stories[0].body,
        withoutOpt.body,
        'a non-audit plan body must not change',
      );
      assert.equal(
        stories[0].fingerprint,
        withoutOpt.fingerprint,
        'and neither must its plan fingerprint',
      );
      assert.ok(!stories[0].body.includes('audit-fingerprints'));
    }
  });

  it('re-assembling an already-carried body does not stack footers', () => {
    // Resumability: persist is idempotent by plan fingerprint, so assembly may
    // run twice over the same inputs.
    const first = assemblePlanStories([ticket], {
      provenanceSource: auditSeed,
    }).stories[0];
    const again = assemblePlanStories([ticket], {
      provenanceSource: auditSeed,
    }).stories[0];
    assert.equal(again.body, first.body);
    assert.equal(
      (first.body.match(/audit-fingerprints:/g) ?? []).length,
      1,
      'exactly one fingerprint footer',
    );
  });
});

describe('per-Story provenance attribution (Story #5045, AC-1)', () => {
  const SHA_OWNED = 'a'.repeat(40);
  const SHA_SIBLING = 'b'.repeat(40);
  const KEY_OWNED = 'architecture␟lib/owned.js';
  const KEY_SIBLING = 'quality␟lib/sibling.js';

  /** A two-group audit seed: the union both groups' footers add up to. */
  const auditSeed = [
    '# Idea Seed: Audit Remediation',
    '',
    '## MVP Scope',
    '',
    '1. **Own the seam** — architecture (`lib/owned.js`)',
    `   <!-- audit-fingerprints: ${SHA_OWNED} -->`,
    `   <!-- audit-semantic-keys: ${KEY_OWNED} -->`,
    '2. **Cover the gap** — quality (`lib/sibling.js`)',
    `   <!-- audit-fingerprints: ${SHA_SIBLING} -->`,
    `   <!-- audit-semantic-keys: ${KEY_SIBLING} -->`,
    '',
  ].join('\n');

  const attributed = {
    slug: 'own-the-seam',
    type: 'story',
    title: 'Own the seam',
    goal: 'Wire the unread seam.',
    changes: [{ path: 'lib/owned.js', assumption: 'refactors-existing' }],
    acceptance: ['The seam is wired and a test fails without it.'],
    verify: ['npm test (unit)'],
    provenance: {
      fingerprints: [SHA_OWNED],
      semanticKeys: [KEY_OWNED],
    },
  };

  const unattributed = {
    slug: 'cover-the-gap',
    type: 'story',
    title: 'Cover the gap',
    goal: 'Cover the untested branch.',
    changes: [{ path: 'lib/sibling.js', assumption: 'refactors-existing' }],
    acceptance: ['The untested branch has a failing-first test.'],
    verify: ['npm test (unit)'],
  };

  it('stamps exactly the keys the attributed Story owns', () => {
    const { stories } = assemblePlanStories([attributed], {
      provenanceSource: auditSeed,
    });
    const { body } = stories[0];
    assert.match(body, new RegExp(`audit-fingerprints:\\s*${SHA_OWNED}`));
    assert.ok(body.includes(`audit-semantic-keys: ${KEY_OWNED}`));
    // The whole point: the sibling group's identities are in the seed and
    // must NOT reach this Story. Under the union every sibling carried every
    // key, which is what made the next sweep's attribution arbitrary.
    assert.ok(
      !body.includes(SHA_SIBLING),
      "an attributed Story must not carry a sibling group's fingerprint",
    );
    assert.ok(
      !body.includes(KEY_SIBLING),
      "an attributed Story must not carry a sibling group's semantic key",
    );
  });

  it('a sibling without the field still receives the whole-seed union', () => {
    // Recall safety: deleting the union fallback re-opens the measured
    // #4626 / #4877 hand-carry failure. Attribution is additive, not a swap.
    const { stories } = assemblePlanStories([attributed, unattributed], {
      provenanceSource: auditSeed,
    });
    const bySlug = new Map(stories.map((s) => [s.slug, s.body]));

    const owned = bySlug.get('own-the-seam');
    assert.ok(!owned.includes(SHA_SIBLING));

    const inherited = bySlug.get('cover-the-gap');
    assert.ok(
      inherited.includes(SHA_OWNED) && inherited.includes(SHA_SIBLING),
      'an un-attributed sibling keeps the recall-safe union fallback',
    );
    assert.ok(
      inherited.includes(KEY_OWNED) && inherited.includes(KEY_SIBLING),
      'and the union covers semantic keys too',
    );
  });

  it('an empty provenance object stamps nothing at all', () => {
    // "Owns no findings" is a real answer and must not silently inherit.
    const { stories } = assemblePlanStories(
      [{ ...attributed, provenance: {} }],
      { provenanceSource: auditSeed },
    );
    assert.ok(!stories[0].body.includes('audit-fingerprints'));
    assert.ok(!stories[0].body.includes('audit-semantic-keys'));
  });

  it('a Story may own fingerprints without semantic keys', () => {
    const { stories } = assemblePlanStories(
      [{ ...attributed, provenance: { fingerprints: [SHA_OWNED] } }],
      { provenanceSource: auditSeed },
    );
    assert.match(
      stories[0].body,
      new RegExp(`audit-fingerprints:\\s*${SHA_OWNED}`),
    );
    assert.ok(!stories[0].body.includes('audit-semantic-keys'));
  });

  it('normalizeStoryTicket surfaces the owned identities, deduplicated', () => {
    const { provenance } = normalizeStoryTicket({
      ...attributed,
      provenance: {
        fingerprints: [SHA_OWNED, SHA_OWNED],
        semanticKeys: [KEY_OWNED],
      },
    });
    assert.deepEqual(provenance, {
      fingerprints: [SHA_OWNED],
      semanticKeys: [KEY_OWNED],
    });
  });

  it('an absent provenance field normalizes to null, not an empty set', () => {
    // `null` is what selects the union fallback — an empty object would
    // silently mean "owns nothing" and strip every Story of its provenance.
    assert.equal(normalizeStoryTicket(unattributed).provenance, null);
  });

  it('rejects a malformed provenance field rather than dropping identities', () => {
    for (const bad of [
      { fingerprints: 'not-an-array' },
      { fingerprints: ['too-short'] },
      { semanticKeys: ['has,a,comma'] },
      { unknownField: [] },
      ['an', 'array'],
    ]) {
      assert.throws(
        () => normalizeStoryTicket({ ...attributed, provenance: bad }),
        /provenance on "own-the-seam"/,
        `expected a throw for ${JSON.stringify(bad)}`,
      );
    }
  });
});

describe('conflict analysis sees the persisted artifact (Story #5045, AC-3)', () => {
  // The canonical authoring shape carries `acceptance[]` / `verify[]` at the
  // ticket's TOP LEVEL; assembly folds them into the body. `indexConsumers`
  // scans `body.acceptance` / `body.verify`, so on the raw payload it scanned
  // two empty arrays and the implicit-cross-story-dep pass was inert — the
  // exact defect running the passes post-assembly closes.
  const producer = {
    slug: 'produce-the-fixture',
    type: 'story',
    title: 'Produce the fixture',
    goal: 'Create the shared fixture module.',
    changes: [{ path: 'lib/fixture.js', assumption: 'creates' }],
    acceptance: ['The fixture module exists and exports the builder.'],
    verify: ['npm test (unit)'],
  };
  const consumer = {
    slug: 'consume-the-fixture',
    type: 'story',
    title: 'Consume the fixture',
    goal: 'Verify the reader against the shared fixture.',
    changes: [{ path: 'lib/reader.js', assumption: 'refactors-existing' }],
    acceptance: ['The reader resolves every entry.'],
    // No depends_on edge — this is the implicit dependency the pass exists
    // to name, and it is only visible once the body carries `verify[]`.
    verify: ['node --test lib/fixture.js (unit)'],
  };

  it('the raw payload hides the implicit dependency the assembled body reveals', () => {
    const rawFindings = computeConflictFindings({
      stories: [producer, consumer],
    });
    assert.deepEqual(
      rawFindings.filter((f) => f.kind === 'implicit-cross-story-dep'),
      [],
      'pre-assembly the consumer scan has no body.verify to read',
    );

    const { stories } = assemblePlanStories([producer, consumer]);
    const assembled = computeAssembledConflictFindings({ stories });
    const implicit = assembled.filter(
      (f) => f.kind === 'implicit-cross-story-dep',
    );
    assert.equal(
      implicit.length,
      1,
      `expected the assembled pass to find the edge, got ${JSON.stringify(assembled)}`,
    );
    assert.equal(implicit[0].path, 'lib/fixture.js');
    assert.equal(implicit[0].producer.storySlug, 'produce-the-fixture');
    assert.equal(implicit[0].consumer.storySlug, 'consume-the-fixture');
  });

  it('scans the footer-stamped bodies, not a re-serialization of the tickets', () => {
    // The bodies handed to the pass are the same strings persist posts —
    // provenance footers and all — so what validation judged is what landed.
    const seed = `1. **Fix it**\n   <!-- audit-fingerprints: ${'c'.repeat(40)} -->`;
    const { stories } = assemblePlanStories([producer, consumer], {
      provenanceSource: seed,
    });
    for (const story of stories) {
      assert.ok(
        story.body.includes('audit-fingerprints:'),
        'the assembled body carries its provenance footer',
      );
    }
    const assembled = computeAssembledConflictFindings({ stories });
    assert.equal(
      assembled.filter((f) => f.kind === 'implicit-cross-story-dep').length,
      1,
      'the footers must not disturb the conflict passes',
    );
  });

  it('an explicit depends_on edge clears the finding', () => {
    const { stories } = assemblePlanStories([
      producer,
      { ...consumer, depends_on: ['produce-the-fixture'] },
    ]);
    assert.deepEqual(
      computeAssembledConflictFindings({ stories }).filter(
        (f) => f.kind === 'implicit-cross-story-dep',
      ),
      [],
    );
  });

  it('a policy upgrade bites on the assembled artifact too', () => {
    const shared = [
      {
        ...producer,
        changes: [{ path: 'lib/shared.js', assumption: 'refactors-existing' }],
      },
      {
        ...consumer,
        changes: [{ path: 'lib/shared.js', assumption: 'refactors-existing' }],
      },
    ];
    const { stories } = assemblePlanStories(shared);
    const findings = computeAssembledConflictFindings({
      stories,
      config: { planning: { failOnSharedEditors: true } },
    });
    const sharedEditor = findings.filter((f) => f.kind === 'shared-editor');
    assert.equal(sharedEditor.length, 1);
    assert.equal(sharedEditor[0].severity, 'hard');
  });
});

/**
 * The persist-side guard for the provenance carry (Story #4935, restored by
 * Story #5056).
 *
 * Every assertion here reads `provider.createPayloads[N].body` — the body
 * `createIssue` is actually called with — and never `stories[N].body`. That
 * distinction is the whole point of the suite. `assembleOnePlanStory` appends
 * the footers to the body *string*; `story.bodyObject` never holds them. So a
 * Story with a non-empty `depends_on`, whose posted body
 * `renderStoryBodyForCreate` re-serializes from that object, can lose the
 * provenance while every assembly-level assertion in the two suites above
 * stays green. That is exactly how the #4939 fix was reverted by #4956 hours
 * later and stayed reverted for three weeks: the persist path had no witness.
 */
describe('the dependent path re-carries the provenance (Story #4935/#5056)', () => {
  const SHA_ROOT = '1'.repeat(40);
  const SHA_DEP = '2'.repeat(40);
  const KEY_ROOT = 'architecture␟lib/foundation.js';
  const KEY_DEP = 'quality␟lib/consumer.js';

  /** A two-group audit seed — one group per Story in the pair below. */
  const auditSeed = [
    '# Idea Seed: Audit Remediation',
    '',
    '## MVP Scope',
    '',
    '1. **Lay the foundation** — architecture (`lib/foundation.js`)',
    `   <!-- audit-fingerprints: ${SHA_ROOT} -->`,
    `   <!-- audit-semantic-keys: ${KEY_ROOT} -->`,
    '2. **Build on it** — quality (`lib/consumer.js`)',
    `   <!-- audit-fingerprints: ${SHA_DEP} -->`,
    `   <!-- audit-semantic-keys: ${KEY_DEP} -->`,
    '',
  ].join('\n');

  const rootTicket = {
    slug: 'lay-the-foundation',
    type: 'story',
    title: 'Lay the foundation',
    goal: 'Introduce the seam the consumer will read.',
    changes: [{ path: 'lib/foundation.js', assumption: 'creates' }],
    acceptance: ['The seam exists and is exported.'],
    verify: ['npm test (unit)'],
  };

  const dependentTicket = {
    slug: 'build-on-the-foundation',
    type: 'story',
    title: 'Build on the foundation',
    goal: 'Read the seam from the consumer.',
    changes: [{ path: 'lib/consumer.js', assumption: 'refactors-existing' }],
    acceptance: ['The consumer reads the seam and fails without it.'],
    verify: ['npm test (unit)'],
    depends_on: ['lay-the-foundation'],
  };

  /**
   * Persist a plan through a recording provider and index the bodies actually
   * POSTed by Story title. Indexing by the payload's own title rather than by
   * call position keeps the assertions readable regardless of the
   * dependency-first create order.
   *
   * @param {object[]} tickets
   * @returns {Promise<{ posted: Map<string, string>, stories: object[] }>}
   */
  async function persist(tickets) {
    const { stories } = assemblePlanStories(tickets, {
      provenanceSource: auditSeed,
    });
    const provider = makeMirrorProvider();
    // Story #5307 — these tickets attribute provenance, so the create loop now
    // records the audit ledger. Point it at a temp file: the default is the
    // repo's committed `baselines/audit-ledger.json`, which a unit test must
    // never write.
    await createStoryIssues({
      provider,
      stories,
      opts: { planRunId: 'provenance-carry' },
    });
    return {
      posted: new Map(
        provider.createPayloads.map((payload) => [payload.title, payload.body]),
      ),
      stories,
    };
  }

  it('AC-1: the body POSTed for a dependent Story carries both footers', async () => {
    // Fails against the pre-#5056 implementation: the dependency branch
    // rebuilds the body from `story.bodyObject`, which never held the footers.
    const { posted } = await persist([dependentTicket, rootTicket]);
    const body = posted.get('Build on the foundation');

    assert.match(
      body,
      /<!--\s*audit-fingerprints:/,
      'a dependent Story must POST its fingerprint footer, not just assemble it',
    );
    assert.ok(
      body.includes(SHA_ROOT) && body.includes(SHA_DEP),
      'the un-attributed union fallback must survive the re-serialization',
    );
    assert.ok(
      body.includes(KEY_ROOT) && body.includes(KEY_DEP),
      'and the semantic keys must survive it too',
    );
  });

  it('AC-2: the re-carried footers coexist with the blocked-by footer', async () => {
    // The two live in the same trailing region of the body, so a carry that
    // clobbered the ordering footer would trade one silent loss for another.
    const { posted } = await persist([dependentTicket, rootTicket]);
    const body = posted.get('Build on the foundation');

    assert.deepEqual(
      parse(body).body.depends_on,
      ['#201'],
      'the resolved blocked-by edge still round-trips out of the posted body',
    );
    assert.match(body, /blocked by #201/);
    assert.ok(body.includes(SHA_DEP), 'and the provenance rides alongside it');
  });

  it('AC-4: an attributed dependent Story POSTs exactly its owned identities', async () => {
    // Sourcing the re-carry `from: story.body` rather than from the seed is
    // what keeps Story #5045 attribution intact. Re-carrying from the seed
    // would look identical on AC-1 and silently reintroduce the union here.
    const { posted } = await persist([
      {
        ...dependentTicket,
        provenance: { fingerprints: [SHA_DEP], semanticKeys: [KEY_DEP] },
      },
      rootTicket,
    ]);
    const body = posted.get('Build on the foundation');

    assert.ok(body.includes(SHA_DEP), 'the owned fingerprint is posted');
    assert.ok(body.includes(KEY_DEP), 'the owned semantic key is posted');
    assert.ok(
      !body.includes(SHA_ROOT),
      "the seed's union must not be reintroduced through the dependent path",
    );
    assert.ok(!body.includes(KEY_ROOT), "nor the sibling group's semantic key");
  });

  it('AC-5: the re-carry adds no duplicate sha to the posted body', async () => {
    // `carryProvenanceFooters` is additive and idempotent; the dependent path
    // applies it a second time over an already-carried body, so a regression
    // in those properties would surface as stacked footers here.
    const { posted } = await persist([dependentTicket, rootTicket]);
    const body = posted.get('Build on the foundation');

    assert.equal(
      (body.match(new RegExp(SHA_DEP, 'g')) ?? []).length,
      1,
      'each sha appears exactly once in the posted body',
    );
    assert.equal(
      (body.match(/<!--\s*audit-fingerprints:/g) ?? []).length,
      1,
      'exactly one fingerprint footer, not a stacked pair',
    );
  });

  it('AC-6: a Story with no depends_on is unaffected', async () => {
    const { posted, stories } = await persist([dependentTicket, rootTicket]);
    const root = stories.find((s) => s.slug === 'lay-the-foundation');
    const body = posted.get('Lay the foundation');

    assert.ok(
      body.startsWith(`${root.body}\n\n<!--`),
      'the edge-free branch still posts the assembled body verbatim',
    );
    assert.ok(
      body.includes(root.fingerprint),
      'and stamps the same plan fingerprint it was assembled with',
    );
    assert.ok(body.includes(SHA_ROOT) && body.includes(SHA_DEP));
  });

  it('AC-7: every Story in an N>1 cohort with edges POSTs the provenance', async () => {
    // The durable guard. A future refactor of `renderStoryBodyForCreate` that
    // drops the carry cannot leave this green, however it rebuilds the body —
    // this reads the persisted artifact for every Story in the chain.
    const mid = {
      ...dependentTicket,
      acceptance: ['The middle layer reads the seam.'],
    };
    const leaf = {
      slug: 'cap-the-stack',
      type: 'story',
      title: 'Cap the stack',
      goal: 'Expose the stack to callers.',
      changes: [{ path: 'lib/cap.js', assumption: 'creates' }],
      acceptance: ['The cap exposes the stack and fails without the middle.'],
      verify: ['npm test (unit)'],
      depends_on: ['build-on-the-foundation'],
    };
    const { posted } = await persist([leaf, mid, rootTicket]);

    assert.equal(posted.size, 3);
    for (const [title, body] of posted) {
      assert.match(
        body,
        /<!--\s*audit-fingerprints:/,
        `Story "${title}" POSTed a body with no fingerprint footer`,
      );
      assert.match(
        body,
        /<!--\s*audit-semantic-keys:/,
        `Story "${title}" POSTed a body with no semantic-key footer`,
      );
    }
  });
});

describe('createStoryIssues — the createIssue retry probe (Story #5112)', () => {
  // The probe handed to `provider.createIssue` as `findExisting` is the
  // content-keyed lookup that lets a retry after a lost response adopt the
  // issue attempt 1 already filed, instead of creating a twin. It was shipped
  // with no coverage at all, which is what put it at the top of the CRAP
  // rollup; these cases exercise every arm the caller can reach.

  /** Run one create and hand back the probe plus the body that was POSTed. */
  async function captureProbe(provider) {
    let probe = null;
    let postedBody = null;
    const spy = {
      ...provider,
      createIssue: async (payload) => {
        probe = payload.findExisting;
        postedBody = payload.body;
        return { id: 700, url: 'https://example/700' };
      },
    };
    const { stories } = assemblePlanStories([storyTicket('probe')]);
    await createStoryIssues({ provider: spy, stories });
    return { probe, postedBody };
  }

  it('adopts an open Story whose body carries the same plan fingerprint', async () => {
    // Round 1 gives us a body the fingerprint marker is really embedded in —
    // asserting against a hand-built body would test the fixture, not the probe.
    const { postedBody } = await captureProbe({});
    const twin = { id: 701, body: postedBody };
    // The twin must stay hidden from the resume index that runs BEFORE the
    // create — otherwise the run adopts there and never reaches the probe.
    let listed = 0;
    const { probe } = await captureProbe({
      listIssuesByLabel: async () =>
        listed++ === 0 ? [] : [{ id: 699, body: 'unrelated' }, twin],
    });
    assert.deepEqual(await probe(), twin);
  });

  it('returns null when no open Story carries the fingerprint', async () => {
    const { probe } = await captureProbe({
      listIssuesByLabel: async () => [{ id: 699, body: 'unrelated' }],
    });
    assert.equal(await probe(), null);
  });

  it('returns null when the provider has no listing surface', async () => {
    const { probe } = await captureProbe({});
    assert.equal(await probe(), null);
  });

  it('returns null when the listing throws — best-effort, never fatal', async () => {
    const { probe } = await captureProbe({
      listIssuesByLabel: async () => {
        throw new Error('rate limited');
      },
    });
    assert.equal(await probe(), null);
  });

  it('returns null when the listing yields a non-array', async () => {
    const { probe } = await captureProbe({
      listIssuesByLabel: async () => null,
    });
    assert.equal(await probe(), null);
  });

  it('scopes the listing to open type::story issues', async () => {
    let args = null;
    const { probe } = await captureProbe({
      listIssuesByLabel: async (a) => {
        args = a;
        return [];
      },
    });
    await probe();
    assert.deepEqual(args, { state: 'open', labels: TYPE_LABELS.STORY });
  });
});

describe('external `#<id>` depends_on refs (Story #5155)', () => {
  it('renders the canonical footer line and mirrors ONE native edge to that issue', async () => {
    const provider = makeMirrorProvider();
    const { created, dependencyEdges } = await createStoryIssues({
      provider,
      stories: assemblePlanStories([
        storyTicket('follow-up', { depends_on: ['#4712'] }),
      ]).stories,
    });

    assert.equal(created.length, 1);
    assert.deepEqual(dependencyEdges, {
      edgesAdded: 1,
      edgesSkipped: 0,
      edgesFailed: 0,
      storiesProcessed: 1,
    });

    // The footer is the durable half — it is what `parseBlockedBy` reads when
    // the dependencies API is unavailable, so the rendered form must be the
    // canonical one and not the slug-substituted `#undefined` a sibling-only
    // resolver would produce.
    const body = provider.createPayloads[0].body;
    assert.match(body, /^blocked by #4712$/m);
    assert.deepEqual(parseBlockedBy(body), [4712]);

    const posts = provider.ghCalls.filter((c) => c.method === 'POST');
    assert.equal(posts.length, 1);
    assert.equal(
      posts[0].body.issue_id,
      94712,
      'the blocker resolves to the EXISTING issue, not a sibling slot',
    );
  });

  it('does not order creation around an external ref — it gates delivery only', async () => {
    const provider = makeMirrorProvider();
    // `#4712` is already live, so it can never become "scheduled" in this run.
    // Treated as a sibling it would wedge the topological sort into a cycle.
    const { created } = await createStoryIssues({
      provider,
      stories: assemblePlanStories([
        storyTicket('second', { depends_on: ['first', '#4712'] }),
        storyTicket('first'),
      ]).stories,
    });

    assert.deepEqual(
      created.map((s) => s.slug),
      ['first', 'second'],
      'sibling ordering still applies; the external ref is simply not a node',
    );
  });
});

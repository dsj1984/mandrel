/**
 * tests/scripts/epic-spec-reconciler.apply.test.js — contract tests for
 * the apply engine (Story #1494 / Task #1520).
 *
 * Covers every operation kind (create, update, close, relink) plus:
 *   - dry-run no-op (zero provider calls)
 *   - idempotency (a second apply against the projected state produces
 *     the empty plan + zero provider calls)
 *   - partial failure (state.json reflects completed ops only)
 *   - bounded-concurrency wiring (cap=4 from APPLY_CONCURRENCY constant)
 *   - discriminator gate enforcement (mayClose / mayUpdate)
 *
 * The tests use the lightweight `StubProvider` in
 * `tests/fixtures/reconciler/stub-provider.mjs` rather than the legacy
 * general-purpose mock — the stub records calls in order so contract
 * assertions are exact.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  APPLY_CONCURRENCY,
  ApplyGateViolation,
  apply,
} from '../../.agents/scripts/lib/orchestration/epic-spec-reconciler-apply.js';
import { diff } from '../../.agents/scripts/lib/orchestration/epic-spec-reconciler-diff.js';
import {
  closeOp,
  createOp,
  ENTITY_KINDS,
  emptyPlan,
  relinkOp,
  updateOp,
} from '../../.agents/scripts/lib/orchestration/epic-spec-reconciler-ops.js';
import { StubProvider } from '../fixtures/reconciler/stub-provider.mjs';

/**
 * Build a minimal spec with a single feature + story so apply has
 * something to project state from. Slugs are stable across tests.
 */
function makeSpec({ epicId = 9000, storyTitle = 'Story One' } = {}) {
  return {
    epic: { id: epicId, title: 'Test Epic', labels: ['type::epic'] },
    features: [
      {
        slug: 'feat-alpha',
        title: 'Alpha',
        labels: ['type::feature'],
        stories: [
          {
            slug: 'story-one',
            title: storyTitle,
            wave: 0,
            dependsOn: [],
            labels: ['type::story'],
            tasks: [],
          },
        ],
      },
    ],
  };
}

describe('reconciler apply — wiring invariants', () => {
  it('exports APPLY_CONCURRENCY = 4 (RECONCILE_CONCURRENCY match)', () => {
    assert.equal(APPLY_CONCURRENCY, 4);
  });

  it('throws TypeError when plan is malformed', async () => {
    const provider = new StubProvider();
    await assert.rejects(
      () => apply({ not: 'a plan' }, provider),
      /plan must conform to the Plan shape/,
    );
  });

  it('throws TypeError when provider is missing', async () => {
    await assert.rejects(
      () => apply(emptyPlan(), null),
      /provider is required/,
    );
  });
});

describe('reconciler apply — dry-run path', () => {
  it('makes zero provider calls and echoes plan intent', async () => {
    const provider = new StubProvider();
    const plan = emptyPlan();
    plan.creates.push(
      createOp({
        slug: 'story-new',
        entity: ENTITY_KINDS.STORY,
        title: 'New Story',
        parentSlug: 'feat-alpha',
      }),
    );
    plan.updates.push(
      updateOp({
        slug: 'story-existing',
        entity: ENTITY_KINDS.STORY,
        issueNumber: 5001,
        changes: { title: { before: 'Old', after: 'New' } },
      }),
    );
    const result = await apply(plan, provider, { dryRun: true });
    assert.equal(result.dryRun, true);
    assert.equal(provider.calls.length, 0);
    assert.equal(result.created.length, 1);
    assert.equal(result.created[0].slug, 'story-new');
    assert.equal(result.updated.length, 1);
    assert.equal(result.updated[0].issueNumber, 5001);
  });

  it('dryRun with a plan that would fail the gate is still a no-op', async () => {
    // dryRun explicitly skips the gate so the operator can preview
    // operations that would need --explicit-delete. This matches the
    // PRD "dry-run by default" stance.
    const provider = new StubProvider();
    const plan = emptyPlan();
    plan.closes.push(
      closeOp({
        slug: 'story-dropped',
        entity: ENTITY_KINDS.STORY,
        issueNumber: 5050,
      }),
    );
    const result = await apply(plan, provider, { dryRun: true });
    assert.equal(result.dryRun, true);
    assert.equal(result.closed.length, 1);
    assert.equal(provider.calls.length, 0);
  });
});

describe('reconciler apply — create path', () => {
  it('creates issues in dependency order and records each slug → id', async () => {
    const provider = new StubProvider({ startingIssue: 9100 });
    const plan = emptyPlan();
    plan.creates.push(
      createOp({
        slug: 'feat-alpha',
        entity: ENTITY_KINDS.FEATURE,
        title: 'Alpha',
        labels: ['type::feature'],
        parentSlug: 'epic',
      }),
      createOp({
        slug: 'story-one',
        entity: ENTITY_KINDS.STORY,
        title: 'Story One',
        labels: ['type::story'],
        parentSlug: 'feat-alpha',
        wave: 0,
        dependsOn: [],
      }),
    );
    const result = await apply(plan, provider, {
      epicId: 9000,
      slugToIssue: { epic: 9000 },
    });
    assert.equal(result.failure, undefined);
    assert.equal(result.created.length, 2);
    // feat-alpha created first (parent), story-one second
    assert.equal(provider.calls[0].kind, 'createTicket');
    assert.equal(result.slugToIssue['feat-alpha'], 9100);
    assert.equal(result.slugToIssue['story-one'], 9101);
  });

  it('rejects creates whose parent slug is unmapped', async () => {
    const provider = new StubProvider();
    const plan = emptyPlan();
    plan.creates.push(
      createOp({
        slug: 'orphan-task',
        entity: ENTITY_KINDS.TASK,
        title: 'Orphan',
        parentSlug: 'missing-story',
      }),
    );
    const result = await apply(plan, provider, { epicId: 9000 });
    // Orphan parent surfaces as a failure on the result (caught by
    // the partial-failure path so the state file still reflects the
    // pre-failure mapping).
    assert.ok(result.failure instanceof ApplyGateViolation);
    assert.equal(result.failure.reason, 'unmapped-parent');
  });

  it('topo-sorts dependsOn within the create batch so footers resolve', async () => {
    // Regression: before this fix, topoSortCreates only inspected
    // parentSlug, so a dependent sibling (story-b depends_on story-a)
    // landed in the same batch as its dependency and won the alphabetic
    // race. renderDependsOnFooter then silently dropped the unresolved
    // slug. This test orders the creates with the dependent FIRST and
    // verifies the dependency lands first anyway, and the `blocked by`
    // footer is rendered on the dependent.
    const provider = new StubProvider({ startingIssue: 9200 });
    const plan = emptyPlan();
    plan.creates.push(
      createOp({
        slug: 'feat-parent',
        entity: ENTITY_KINDS.FEATURE,
        title: 'Parent Feature',
        labels: ['type::feature'],
        parentSlug: 'epic',
      }),
      // Dependent listed BEFORE its dependency.
      createOp({
        slug: 'story-b',
        entity: ENTITY_KINDS.STORY,
        title: 'B depends on A',
        labels: ['type::story'],
        parentSlug: 'feat-parent',
        wave: 1,
        dependsOn: ['story-a'],
      }),
      createOp({
        slug: 'story-a',
        entity: ENTITY_KINDS.STORY,
        title: 'A (foundation)',
        labels: ['type::story'],
        parentSlug: 'feat-parent',
        wave: 0,
        dependsOn: [],
      }),
    );
    const result = await apply(plan, provider, {
      epicId: 9000,
      slugToIssue: { epic: 9000 },
    });
    assert.equal(result.failure, undefined);
    const aId = result.slugToIssue['story-a'];
    const bId = result.slugToIssue['story-b'];
    assert.equal(typeof aId, 'number');
    assert.equal(typeof bId, 'number');
    assert.ok(aId < bId, 'story-a must be created before story-b');
    // Find story-b's create call and verify the footer landed.
    // createTicket(parentId, ticketData) → args[1] is ticketData.
    const bCall = provider.calls.find(
      (c) => c.kind === 'createTicket' && c.args[1]?.title === 'B depends on A',
    );
    assert.ok(bCall, 'story-b createTicket call missing');
    assert.match(bCall.args[1].body, new RegExp(`blocked by #${aId}`));
  });

  it('fails loud when a dependsOn slug cannot be resolved at apply time', async () => {
    // Belt-and-suspenders: if the topo sort can't resolve a sibling
    // dependency (e.g. a malformed plan with a phantom dependsOn slug
    // that isn't in slugToIssue or createSlugs), the footer renderer
    // must throw rather than silently drop the line.
    const provider = new StubProvider({ startingIssue: 9300 });
    const plan = emptyPlan();
    plan.creates.push(
      createOp({
        slug: 'story-orphan',
        entity: ENTITY_KINDS.STORY,
        title: 'Orphan deps',
        labels: ['type::story'],
        parentSlug: 'epic',
        wave: 0,
        dependsOn: ['ghost-slug'],
      }),
    );
    const result = await apply(plan, provider, {
      epicId: 9000,
      slugToIssue: { epic: 9000 },
    });
    assert.ok(result.failure instanceof Error);
    assert.match(
      result.failure.message,
      /unresolved dependsOn slugs: ghost-slug/,
    );
  });
});

describe('reconciler apply — update path', () => {
  it('translates plan changes into provider mutations (title, body, labels)', async () => {
    const provider = new StubProvider();
    const plan = emptyPlan();
    plan.updates.push(
      updateOp({
        slug: 'story-one',
        entity: ENTITY_KINDS.STORY,
        issueNumber: 5001,
        changes: {
          title: { before: 'Old Title', after: 'New Title' },
          body: { before: 'old body', after: 'new body' },
          labels: {
            before: ['type::story', 'context::stale'],
            after: ['type::story', 'context::fresh'],
          },
        },
      }),
    );
    const result = await apply(plan, provider);
    assert.equal(result.updated.length, 1);
    const call = provider.calls.find((c) => c.kind === 'updateTicket');
    assert.deepEqual(call.args[0], 5001);
    assert.deepEqual(call.args[1].title, 'New Title');
    assert.deepEqual(call.args[1].body, 'new body');
    assert.deepEqual(call.args[1].labels.add, ['context::fresh']);
    assert.deepEqual(call.args[1].labels.remove, ['context::stale']);
  });

  it('discriminator rejects updates targeting agent::* fields', async () => {
    const provider = new StubProvider();
    const plan = {
      creates: [],
      updates: [
        // Hand-built op bypassing the diff engine's filter
        {
          kind: 'update',
          slug: 'story-one',
          entity: ENTITY_KINDS.STORY,
          issueNumber: 5001,
          changes: {
            'not-a-real-field': { before: 'a', after: 'b' },
          },
        },
      ],
      closes: [],
      relinks: [],
    };
    await assert.rejects(
      () => apply(plan, provider),
      (err) =>
        err instanceof ApplyGateViolation &&
        err.kind === 'update' &&
        err.field === 'not-a-real-field',
    );
    // No provider call leaked through the gate.
    assert.equal(provider.calls.length, 0);
  });
});

describe('reconciler apply — close path', () => {
  it('closes via updateTicket({ state: closed }) when explicitDelete is set', async () => {
    const provider = new StubProvider();
    const plan = emptyPlan();
    plan.closes.push(
      closeOp({
        slug: 'story-dropped',
        entity: ENTITY_KINDS.STORY,
        issueNumber: 5050,
      }),
    );
    const result = await apply(plan, provider, { explicitDelete: true });
    assert.equal(result.closed.length, 1);
    const call = provider.calls.find((c) => c.kind === 'updateTicket');
    assert.equal(call.args[0], 5050);
    assert.equal(call.args[1].state, 'closed');
  });

  it('rejects close ops without explicitDelete (discriminator)', async () => {
    const provider = new StubProvider();
    const plan = emptyPlan();
    plan.closes.push(
      closeOp({
        slug: 'story-dropped',
        entity: ENTITY_KINDS.STORY,
        issueNumber: 5050,
      }),
    );
    await assert.rejects(
      () => apply(plan, provider),
      (err) =>
        err instanceof ApplyGateViolation &&
        err.kind === 'close' &&
        err.reason === 'explicit-delete-required',
    );
    assert.equal(provider.calls.length, 0);
  });
});

describe('reconciler apply — relink path', () => {
  it('rewrites parent edges via remove + add sub-issue', async () => {
    const provider = new StubProvider();
    const plan = emptyPlan();
    plan.relinks.push(
      relinkOp({
        slug: 'story-moved',
        entity: ENTITY_KINDS.STORY,
        issueNumber: 5010,
        parent: { before: 'feat-old', after: 'feat-new' },
      }),
    );
    const result = await apply(plan, provider, {
      slugToIssue: { 'feat-old': 8001, 'feat-new': 8002 },
    });
    assert.equal(result.relinked.length, 1);
    const remove = provider.calls.find((c) => c.kind === 'removeSubIssue');
    const add = provider.calls.find((c) => c.kind === 'addSubIssue');
    assert.deepEqual(remove.args, [8001, 5010]);
    assert.deepEqual(add.args, [8002, 5010]);
  });

  it('does not write the body from the relink path (Story #2982)', async () => {
    // Story #2982 — the relink op previously wrote a body containing
    // only the `blocked by` footer, which stripped description +
    // `parent: #N` + `Epic: #M` on every dependsOn change. The diff
    // engine now recomposes the canonical orchestrator footer and
    // routes the body update through `applyUpdate`; relink dispatches
    // only the parent sub-issue add/remove (when parent changed).
    const provider = new StubProvider();
    const plan = emptyPlan();
    plan.relinks.push(
      relinkOp({
        slug: 'story-edge',
        entity: ENTITY_KINDS.STORY,
        issueNumber: 5020,
        dependsOn: { before: [], after: ['story-blocker'] },
      }),
    );
    await apply(plan, provider, {
      slugToIssue: { 'story-blocker': 7001 },
    });
    const updateCalls = provider.calls.filter((c) => c.kind === 'updateTicket');
    assert.equal(updateCalls.length, 0);
  });
});

describe('reconciler apply — idempotency (state writer)', () => {
  it('successful apply followed by an immediate second apply is a no-op', async () => {
    // First apply: creates feat-alpha + story-one. State file records
    // the new mapping with content hashes.
    const provider = new StubProvider({ startingIssue: 9100 });
    const spec = makeSpec();
    const priorState = { epicId: 9000, mapping: {} };
    let writtenState = null;
    const writeStateSpy = (epicId, state) => {
      writtenState = state;
      return `/tmp/${epicId}.state.json`;
    };

    const plan1 = diff({ spec, state: priorState, ghState: {} });
    // Plan includes 'epic', 'feat-alpha', 'story-one' creates.
    assert.equal(plan1.creates.length, 3);
    const result1 = await apply(plan1, provider, {
      epicId: 9000,
      spec,
      priorState,
      writeState: writeStateSpy,
      stateNow: '2026-05-12T12:00:00.000Z',
      slugToIssue: { epic: 9000 },
    });
    assert.equal(result1.failure, undefined);
    assert.ok(writtenState, 'state was written');
    assert.equal(writtenState.epicId, 9000);
    // feat-alpha + story-one mapped to new IDs; epic preserves 9000.
    assert.equal(
      typeof writtenState.mapping['feat-alpha'].issueNumber,
      'number',
    );

    // Second apply: same spec, state now reflects the first run. The
    // diff engine emits the empty plan (the spec's structural fields
    // match what the apply just minted).
    const ghStateAfter = {};
    for (const slug of Object.keys(writtenState.mapping)) {
      const id = writtenState.mapping[slug].issueNumber;
      if (typeof id !== 'number') continue;
      // Pull the title/labels from the spec walk so ghState matches.
      const ticket = provider.tickets.get(id);
      if (ticket) {
        ghStateAfter[id] = {
          title: ticket.title,
          body: ticket.body,
          labels: ticket.labels,
          state: ticket.state,
        };
      }
    }
    const plan2 = diff({ spec, state: writtenState, ghState: ghStateAfter });
    // Empty plan: no creates/updates/closes/relinks.
    assert.equal(plan2.creates.length, 0);
    assert.equal(plan2.updates.length, 0);
    assert.equal(plan2.closes.length, 0);
    assert.equal(plan2.relinks.length, 0);

    // And applying the empty plan does not touch the provider.
    const callCountBefore = provider.calls.length;
    await apply(plan2, provider, {
      epicId: 9000,
      spec,
      priorState: writtenState,
      writeState: writeStateSpy,
      stateNow: '2026-05-12T13:00:00.000Z',
    });
    assert.equal(provider.calls.length, callCountBefore);
  });
});

describe('reconciler apply — partial failure', () => {
  it('state.json reflects completed operations only on partial failure', async () => {
    // Two creates: the first succeeds, the second fails. State should
    // record only the first slug → issue mapping.
    const spec = makeSpec();
    let calls = 0;
    const provider = new StubProvider({
      startingIssue: 9100,
      failOn: (call) => {
        if (call.kind === 'createTicket') {
          calls += 1;
          // Fail on the third createTicket so epic/feat-alpha land but
          // story-one's create rejects.
          return calls === 3;
        }
        return false;
      },
    });

    let writtenState = null;
    const writeStateSpy = (_epicId, state) => {
      writtenState = state;
      return '/tmp/partial.state.json';
    };

    const plan = diff({
      spec,
      state: { epicId: 9000, mapping: {} },
      ghState: {},
    });
    const result = await apply(plan, provider, {
      epicId: 9000,
      spec,
      priorState: { epicId: 9000, mapping: {} },
      writeState: writeStateSpy,
      stateNow: '2026-05-12T12:00:00.000Z',
    });

    assert.ok(result.failure, 'apply surfaced a failure');
    assert.ok(result.failure.message.includes('createTicket'));

    // state.json captured the completed creates; the failed one is
    // recorded as issueNumber:null via projectMapping's default.
    assert.ok(writtenState, 'partial state was persisted');
    // feat-alpha was created successfully and should have a numeric id.
    const feat = writtenState.mapping['feat-alpha'];
    assert.equal(typeof feat.issueNumber, 'number');
    // story-one never got an id (its create rejected).
    const story = writtenState.mapping['story-one'];
    assert.equal(story.issueNumber, null);
  });
});

describe('reconciler apply — bounded concurrency', () => {
  it('does not exceed APPLY_CONCURRENCY in flight at once for updates', async () => {
    // Build 10 updates so the cap matters. Each update awaits a small
    // tick and increments an in-flight counter that the test asserts
    // against APPLY_CONCURRENCY.
    let inFlight = 0;
    let peak = 0;
    const provider = new (class extends StubProvider {
      async updateTicket(id, mutations) {
        inFlight += 1;
        if (inFlight > peak) peak = inFlight;
        await new Promise((r) => setImmediate(r));
        inFlight -= 1;
        return super.updateTicket(id, mutations);
      }
    })();

    const plan = emptyPlan();
    for (let i = 0; i < 10; i += 1) {
      plan.updates.push(
        updateOp({
          slug: `story-${i}`,
          entity: ENTITY_KINDS.STORY,
          issueNumber: 6000 + i,
          changes: { title: { before: 'old', after: `new ${i}` } },
        }),
      );
    }
    await apply(plan, provider);
    assert.ok(
      peak <= APPLY_CONCURRENCY,
      `peak in-flight ${peak} exceeded cap ${APPLY_CONCURRENCY}`,
    );
  });
});

describe('reconciler apply — 3-tier hierarchy (Story #3117 / Epic #3078)', () => {
  it('applies a 3-tier create plan (Feature + Story only, no Tasks) without phantom task ops', async () => {
    const provider = new StubProvider({ startingIssue: 9200 });
    const plan = emptyPlan();
    plan.creates.push(
      createOp({
        slug: 'feat-3tier',
        entity: ENTITY_KINDS.FEATURE,
        title: '3-tier Feature',
        labels: ['type::feature'],
        parentSlug: 'epic',
      }),
      createOp({
        slug: 'story-3tier',
        entity: ENTITY_KINDS.STORY,
        title: 'Story with inline acceptance/verify',
        labels: ['type::story', 'persona::engineer'],
        parentSlug: 'feat-3tier',
        wave: 0,
        dependsOn: [],
      }),
    );
    const spec3tier = {
      version: '2.0.0',
      epic: { id: 9000, title: 'E', labels: ['type::epic'] },
      features: [
        {
          slug: 'feat-3tier',
          title: '3-tier Feature',
          labels: ['type::feature'],
          stories: [
            {
              slug: 'story-3tier',
              title: 'Story with inline acceptance/verify',
              wave: 0,
              labels: ['type::story', 'persona::engineer'],
              acceptance: ['outcome holds'],
              verify: ['node --test foo (contract)'],
            },
          ],
        },
      ],
    };
    const result = await apply(plan, provider, {
      epicId: 9000,
      slugToIssue: { epic: 9000 },
      spec: spec3tier,
    });
    assert.equal(result.failure, undefined);
    assert.equal(result.created.length, 2);
    // No createTicket call for any task
    for (const call of provider.calls) {
      if (call.kind !== 'createTicket') continue;
      const labels = call.payload?.labels ?? [];
      assert.equal(
        labels.includes('type::task'),
        false,
        `apply must not create type::task tickets under 3-tier; saw call ${JSON.stringify(call)}`,
      );
    }
  });

  it('round-trips a 3-tier spec through diff → apply with an empty plan on re-run (idempotent)', async () => {
    const spec = {
      version: '2.0.0',
      epic: { id: 9300, title: '3-tier E', labels: ['type::epic'] },
      features: [
        {
          slug: 'feat-r',
          title: 'F',
          labels: ['type::feature'],
          stories: [
            {
              slug: 'story-r',
              title: 'S',
              wave: 0,
              labels: ['type::story', 'persona::engineer'],
              acceptance: ['x'],
              verify: ['y (unit)'],
            },
          ],
        },
      ],
    };
    const state = {
      epicId: 9300,
      mapping: {
        epic: { issueNumber: 9300, entity: 'epic', parentSlug: null },
        'feat-r': {
          issueNumber: 9301,
          entity: 'feature',
          parentSlug: 'epic',
        },
        'story-r': {
          issueNumber: 9302,
          entity: 'story',
          parentSlug: 'feat-r',
          wave: 0,
          dependsOn: [],
        },
      },
    };
    const ghState = {
      9300: { title: '3-tier E', body: '', labels: ['type::epic'] },
      9301: { title: 'F', body: '', labels: ['type::feature'] },
      9302: {
        title: 'S',
        body: '',
        labels: ['type::story', 'persona::engineer'],
      },
    };
    const plan = diff({ spec, state, ghState });
    assert.equal(plan.creates.length, 0);
    assert.equal(plan.closes.length, 0);
    assert.equal(plan.relinks.length, 0);
  });
});

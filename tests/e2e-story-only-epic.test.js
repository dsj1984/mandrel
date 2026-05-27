/**
 * tests/e2e-story-only-epic.test.js
 *
 * E2E (Story #3144, Feature #3093, Epic #3078): exercises the 3-tier
 * Story-only Epic execution model end-to-end against a synthetic ticket
 * graph and asserts that no Task-keyed code path is engaged.
 *
 * The test synthesizes a 3-tier Epic (one Epic, one Feature, two
 * Stories — Story B depends on Story A) and walks the canonical
 * pipeline:
 *
 *   plan        → dispatch() returns a Story-centric manifest
 *                 (`waves[].stories[]`, `hierarchy: '3-tier'`,
 *                 totalStories/doneStories in the summary).
 *   dispatch    → second dispatch after Story A completes; only
 *                 Story B remains.
 *   deliver     → Story-implementation phase represented by a
 *                 `story-run-progress` snapshot whose payload carries
 *                 `phases[]` (not `tasks[]`).
 *   merge       → transitionTicketState('agent::done') + cascadeCompletion
 *                 propagates Story → Feature → Epic without any
 *                 Task-keyed mutation.
 *
 * The test asserts the three acceptance criteria from Task #3150:
 *   1. The synthetic graph never contains a `type::task` ticket and
 *      no mutation under test ever creates one.
 *   2. The `story-run-progress` payload uses the `phases[]` shape
 *      (not `tasks[]`).
 *   3. The full plan → dispatch → deliver → merge walk completes:
 *      every Story closes via `agent::done`, the Feature cascades to
 *      `agent::done`, and the Epic remains open (Epic auto-close is
 *      explicitly suppressed; Epics close via the operator's PR merge).
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ITicketingProvider } from '../.agents/scripts/lib/ITicketingProvider.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SCRIPTS = path.join(ROOT, '.agents', 'scripts');

const { dispatch } = await import(
  pathToFileURL(path.join(SCRIPTS, 'dispatcher.js')).href
);
const { cascadeCompletion, transitionTicketState } = await import(
  pathToFileURL(path.join(SCRIPTS, 'lib', 'orchestration', 'ticketing.js')).href
);
const { renderStoryRunProgressBody, defaultStoryPhases } = await import(
  pathToFileURL(
    path.join(
      SCRIPTS,
      'lib',
      'orchestration',
      'epic-runner',
      'story-run-progress-writer.js',
    ),
  ).href
);

// ---------------------------------------------------------------------------
// Mock Provider — minimal contract surface needed by dispatch() + cascade().
// Modelled after tests/e2e-story-lifecycle.test.js but with no Task tickets
// in the fixture, so we exercise the 3-tier branch end-to-end.
// ---------------------------------------------------------------------------

class StoryOnlyMockProvider extends ITicketingProvider {
  constructor({ epic, tickets }) {
    super();
    this._epic = epic;
    this._tickets = tickets;
    this.updateCalls = [];
    this.commentCalls = [];
  }

  async getEpic() {
    return this._epic;
  }

  async getTickets(_epicId, filters = {}) {
    let result = this._tickets;
    if (filters.label) {
      result = result.filter((t) => (t.labels ?? []).includes(filters.label));
    }
    return result;
  }

  async getTicket(ticketId) {
    const t = this._tickets.find((t) => t.id === ticketId);
    if (!t) throw new Error(`Ticket ${ticketId} not found`);
    return t;
  }

  async updateTicket(ticketId, mutations) {
    this.updateCalls.push({ ticketId, mutations });
    const ticket = this._tickets.find((t) => t.id === ticketId);
    if (!ticket) return;
    if (mutations.labels) {
      const rm = mutations.labels.remove || [];
      const add = mutations.labels.add || [];
      let current = (ticket.labels || []).filter((l) => !rm.includes(l));
      current = [...new Set([...current, ...add])];
      ticket.labels = current;
    }
    if (mutations.body !== undefined) ticket.body = mutations.body;
    if (mutations.state !== undefined) ticket.state = mutations.state;
  }

  async postComment(ticketId, payload) {
    this.commentCalls.push({ ticketId, payload });
    return { commentId: Date.now() };
  }

  async getTicketDependencies(ticketId) {
    const ticket = await this.getTicket(ticketId);
    const blocksMatch = ticket.body.matchAll(/blocked by #(\d+)/gi);
    const blockedBy = [...blocksMatch].map((m) => Number.parseInt(m[1], 10));
    const blocks = [];
    const parentMatch = ticket.body.match(/parent:\s*#(\d+)/i);
    if (parentMatch) blocks.push(Number.parseInt(parentMatch[1], 10));
    return { blocks, blockedBy };
  }

  async getSubTickets(parentId) {
    return this._tickets.filter((t) => {
      const pMatch = t.body.match(/parent:\s*#(\d+)/i);
      return pMatch && Number.parseInt(pMatch[1], 10) === parentId;
    });
  }

  // No-op cache primer for the dispatch pipeline.
  primeTicketCache() {}
}

const EPIC_ID = 9000;
const FEATURE_ID = 9001;
const STORY_A_ID = 9010;
const STORY_B_ID = 9011;

function buildStoryOnlyEpicFixture() {
  const epic = {
    id: EPIC_ID,
    title: 'Story-only Epic 9000',
    body: 'Synthetic 3-tier Epic for end-to-end E2E coverage (Story #3144).',
    labels: ['type::epic'],
    linkedIssues: { prd: null, techSpec: null },
    state: 'open',
  };
  const feature = {
    id: FEATURE_ID,
    title: 'Feature 9001',
    body: 'parent: #9000',
    labels: ['type::feature'],
    state: 'open',
  };
  const storyA = {
    id: STORY_A_ID,
    title: 'Story A — implement plan/dispatch shape',
    body: [
      'parent: #9001',
      `Epic: #${EPIC_ID}`,
      '',
      '## Acceptance',
      '- [ ] Story A is dispatchable in wave 0',
      '',
      '## Verify',
      '- node --test',
    ].join('\n'),
    labels: ['type::story', 'persona::engineer'],
    state: 'open',
  };
  const storyB = {
    id: STORY_B_ID,
    title: 'Story B — implement deliver/merge shape',
    body: [
      'parent: #9001',
      `Epic: #${EPIC_ID}`,
      'blocked by #9010',
      '',
      '## Acceptance',
      '- [ ] Story B runs after Story A',
      '',
      '## Verify',
      '- node --test',
    ].join('\n'),
    labels: ['type::story', 'persona::engineer'],
    state: 'open',
  };
  return { epic, feature, storyA, storyB };
}

test('e2e-story-only-epic — 3-tier Epic walks plan → dispatch → deliver → merge without Task-keyed paths', async () => {
  // -------------------------------------------------------------------------
  // ARRANGE: synthetic 3-tier ticket graph (no Tasks).
  // -------------------------------------------------------------------------
  const { epic, feature, storyA, storyB } = buildStoryOnlyEpicFixture();
  const tickets = [epic, feature, storyA, storyB];
  const provider = new StoryOnlyMockProvider({ epic, tickets });

  // Assertion #1 setup: no `type::task` ticket anywhere in the fixture.
  for (const t of tickets) {
    assert.ok(
      !(t.labels ?? []).includes('type::task'),
      `Fixture violation: ticket #${t.id} carries type::task — the 3-tier ` +
        'E2E must never include a Task issue.',
    );
  }

  // -------------------------------------------------------------------------
  // PHASE 1 — PLAN: dispatch() against the 3-tier graph returns a
  // Story-centric manifest. Acceptance #1 (no type::task issue created at
  // any stage) is validated below by re-inspecting the ticket store and
  // every updateTicket() call.
  // -------------------------------------------------------------------------
  const planManifest = await dispatch({
    epicId: EPIC_ID,
    dryRun: true,
    provider,
  });

  assert.equal(planManifest.hierarchy, '3-tier');
  assert.equal(planManifest.summary.totalStories, 2);
  assert.equal(planManifest.summary.doneStories, 0);
  assert.equal(
    planManifest.summary.totalTasks,
    undefined,
    'totalTasks must be absent from a 3-tier summary',
  );
  assert.equal(planManifest.waves.length, 2);
  assert.ok(Array.isArray(planManifest.waves[0].stories));
  assert.equal(planManifest.waves[0].stories[0].storyId, STORY_A_ID);
  assert.equal(planManifest.waves[1].stories[0].storyId, STORY_B_ID);
  assert.deepEqual(planManifest.waves[1].stories[0].dependsOn, [STORY_A_ID]);

  // -------------------------------------------------------------------------
  // PHASE 2 — DELIVER (Story A): emit a story-run-progress snapshot whose
  // payload carries phases[] (3-tier shape), not tasks[] (4-tier shape).
  // -------------------------------------------------------------------------
  const initialPhases = defaultStoryPhases();
  const initSnapshot = renderStoryRunProgressBody({
    storyId: STORY_A_ID,
    branch: `story-${STORY_A_ID}`,
    phase: 'init',
    phases: initialPhases,
    updatedAt: '2026-05-27T00:00:00.000Z',
  });

  // Acceptance #3: payload uses phases[], not tasks[].
  assert.ok(
    Array.isArray(initSnapshot.payload.phases),
    'story-run-progress payload must carry phases[]',
  );
  assert.equal(
    initSnapshot.payload.tasks,
    undefined,
    'story-run-progress payload must NOT carry tasks[] in 3-tier mode',
  );
  assert.deepEqual(
    initSnapshot.payload.phases.map((p) => p.name),
    ['init', 'implement', 'validate', 'close'],
  );

  // Story-implementation phase: flip implement → in-progress.
  const implPhases = defaultStoryPhases().map((p) =>
    p.name === 'implement'
      ? { ...p, status: 'in-progress', startedAt: '2026-05-27T00:00:01.000Z' }
      : p,
  );
  const implSnapshot = renderStoryRunProgressBody({
    storyId: STORY_A_ID,
    branch: `story-${STORY_A_ID}`,
    phase: 'implementing',
    phases: implPhases,
    updatedAt: '2026-05-27T00:00:01.000Z',
  });
  assert.ok(Array.isArray(implSnapshot.payload.phases));
  assert.equal(implSnapshot.payload.tasks, undefined);

  // -------------------------------------------------------------------------
  // PHASE 3 — MERGE (Story A): transition + cascade. Story A is the only
  // child Story for wave 0; Feature/Epic should NOT close yet because
  // Story B is still open.
  // -------------------------------------------------------------------------
  await transitionTicketState(provider, STORY_A_ID, 'agent::done');
  await cascadeCompletion(provider, STORY_A_ID);

  const aAfter = await provider.getTicket(STORY_A_ID);
  assert.ok(aAfter.labels.includes('agent::done'));
  assert.equal(aAfter.state, 'closed');

  const epicAfterA = await provider.getTicket(EPIC_ID);
  assert.ok(
    !epicAfterA.labels.includes('agent::done'),
    'Epic must remain open while Story B is unresolved',
  );

  // -------------------------------------------------------------------------
  // PHASE 4 — DISPATCH again: Story B is unblocked and should occupy the
  // first wave (Story A is done and pruned).
  // -------------------------------------------------------------------------
  const dispatch2 = await dispatch({
    epicId: EPIC_ID,
    dryRun: true,
    provider,
  });
  assert.equal(dispatch2.hierarchy, '3-tier');
  // After Story A closes, the manifest reflects the done count and Story
  // B remains scheduled (waves[1].stories[]). The dispatch graph keeps
  // closed Stories visible in the manifest for full-graph rendering, so
  // we assert the summary count rather than wave-0 occupancy here.
  assert.equal(dispatch2.summary.doneStories, 1);
  assert.equal(dispatch2.summary.totalStories, 2);
  const allDispatch2StoryIds = dispatch2.waves.flatMap((w) =>
    (w.stories ?? []).map((s) => s.storyId),
  );
  assert.ok(
    allDispatch2StoryIds.includes(STORY_B_ID),
    'Story B must still appear in the manifest after Story A closes',
  );

  // -------------------------------------------------------------------------
  // PHASE 5 — DELIVER + MERGE (Story B): final transitions cascade up.
  // -------------------------------------------------------------------------
  const closePhases = defaultStoryPhases().map((p) => ({
    ...p,
    status: 'done',
    startedAt: '2026-05-27T00:00:02.000Z',
    endedAt: '2026-05-27T00:00:03.000Z',
  }));
  const closeSnapshot = renderStoryRunProgressBody({
    storyId: STORY_B_ID,
    branch: `story-${STORY_B_ID}`,
    phase: 'done',
    phases: closePhases,
    updatedAt: '2026-05-27T00:00:03.000Z',
  });
  assert.ok(Array.isArray(closeSnapshot.payload.phases));
  assert.equal(closeSnapshot.payload.tasks, undefined);

  await transitionTicketState(provider, STORY_B_ID, 'agent::done');
  await cascadeCompletion(provider, STORY_B_ID);

  // Story B done.
  const bFinal = await provider.getTicket(STORY_B_ID);
  assert.ok(bFinal.labels.includes('agent::done'));
  assert.equal(bFinal.state, 'closed');

  // Feature done.
  const featureFinal = await provider.getTicket(FEATURE_ID);
  assert.ok(
    featureFinal.labels.includes('agent::done'),
    'Feature must close after every child Story closes',
  );

  // Epic remains open by design: cascade explicitly skips Epic auto-close
  // (Epics close via the operator's PR merge or /epic-close recovery).
  // The 3-tier cascade reaching the Epic is the all-children-done signal.
  const epicFinal = await provider.getTicket(EPIC_ID);
  assert.equal(
    epicFinal.state,
    'open',
    'Epic stays open until the operator merges the integration PR — the ' +
      'cascade explicitly skips Epic auto-close even when every Feature is done.',
  );

  // -------------------------------------------------------------------------
  // ACCEPTANCE #1 (final check): walk every ticket and every updateTicket
  // call and confirm no type::task issue was created or mutated at any
  // stage of the pipeline.
  // -------------------------------------------------------------------------
  for (const t of provider._tickets) {
    assert.ok(
      !(t.labels ?? []).includes('type::task'),
      `Post-run: ticket #${t.id} acquired type::task — 3-tier path must never ` +
        'create or label a Task issue.',
    );
  }
  for (const { ticketId, mutations } of provider.updateCalls) {
    const adds = mutations?.labels?.add ?? [];
    assert.ok(
      !adds.includes('type::task'),
      `Mutation on #${ticketId} attempted to add type::task — forbidden in ` +
        '3-tier execution.',
    );
  }
});

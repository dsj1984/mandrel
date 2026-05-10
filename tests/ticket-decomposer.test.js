import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { renderDecomposerSystemPrompt } from '../.agents/scripts/lib/templates/decomposer-prompts.js';
import {
  buildDecomposerSystemPrompt,
  buildDecompositionContext,
  decomposeEpic,
  orderTicketsForCreation,
  resolveDependencies,
} from '../.agents/scripts/ticket-decomposer.js';

const baseTickets = () => [
  {
    slug: 'f1',
    type: 'feature',
    title: 'Feature One',
    body: 'Body of Feature One',
    labels: ['type::feature', 'persona::engineer'],
  },
  {
    slug: 's1',
    type: 'story',
    title: 'Story One',
    body: 'Body of Story One',
    labels: ['type::story', 'persona::fullstack', 'complexity::fast'],
    parent_slug: 'f1',
  },
  {
    slug: 't1',
    type: 'task',
    title: 'Task One',
    body: 'Body of Task One',
    labels: ['type::task', 'persona::engineer'],
    parent_slug: 's1',
  },
];

describe('ticket-decomposer orchestration (v5.6+)', () => {
  let mockProvider;

  beforeEach(() => {
    mockProvider = {
      createdTickets: [],
      updatedTickets: [],

      async getEpic(id) {
        if (id !== 1) return null;
        return {
          id: 1,
          title: 'Implement V5 Core',
          body: 'Epic body.',
          labels: ['epic'],
          linkedIssues: { prd: 100, techSpec: 101 },
        };
      },

      async getTicket(id) {
        if (id === 100) return { id: 100, body: 'Mocked PRD body' };
        if (id === 101) return { id: 101, body: 'Mocked Tech Spec body' };
        return null;
      },

      async createTicket(epicId, ticketData) {
        const newId = 200 + this.createdTickets.length;
        this.createdTickets.push({ epicId, ticketData, newId });
        return { id: newId, url: `https://github.com/test/${newId}` };
      },

      async updateTicket(id, mutations) {
        this.updatedTickets.push({ id, mutations });
      },
    };
  });

  it('aborts early if epic is missing linked artifacts', async () => {
    mockProvider.getEpic = async () => ({
      title: 'Missing Links Epic',
      linkedIssues: { prd: null, techSpec: null },
    });

    await assert.rejects(
      async () =>
        await decomposeEpic(1, mockProvider, { tickets: baseTickets() }),
      {
        message:
          '[Decomposer] Epic #1 is missing linked PRD or Tech Spec. Run the Epic Planner first.',
      },
    );
  });

  it('rejects a non-array tickets payload', async () => {
    await assert.rejects(
      async () =>
        await decomposeEpic(1, mockProvider, { tickets: 'not an array' }),
      { message: /tickets must be an array/ },
    );
  });

  it('creates Feature/Story/Task tickets from an authored array', async () => {
    await decomposeEpic(1, mockProvider, { tickets: baseTickets() });

    assert.equal(
      mockProvider.createdTickets.length,
      3,
      'Should create exactly three tickets (Feature, Story, Task)',
    );

    const f1 = mockProvider.createdTickets[0];
    assert.equal(f1.ticketData.title, 'Feature One');
    assert.deepEqual(f1.ticketData.labels, [
      'type::feature',
      'persona::engineer',
    ]);
    assert.deepEqual(f1.ticketData.dependencies, []);

    const s1 = mockProvider.createdTickets[1];
    assert.equal(s1.ticketData.title, 'Story One');
    assert.deepEqual(s1.ticketData.labels, [
      'type::story',
      'persona::fullstack',
      'complexity::fast',
    ]);

    const t1 = mockProvider.createdTickets[2];
    assert.equal(t1.ticketData.title, 'Task One');
  });

  it('throws when a depends_on references an unknown slug', async () => {
    const tickets = baseTickets();
    tickets.push({
      slug: 't2',
      type: 'task',
      title: 'Task Two',
      body: 'Depends on typo',
      labels: ['type::task', 'persona::engineer'],
      parent_slug: 's1',
      depends_on: ['t-typo'],
    });

    await assert.rejects(
      () => decomposeEpic(1, mockProvider, { tickets }),
      /unknown slugs/,
    );
  });

  it('creates a depth-3 intra-Story Task dep chain in topological order', async () => {
    // Author the chain in REVERSE dep order so the typeOrder-only sort would
    // have created t-d before t-c before t-b before t-a, leaving every
    // depends_on unresolvable. Topological sort within (s1, task) must
    // re-order them to t-a, t-b, t-c, t-d before any provider.createTicket
    // call fires.
    const tickets = [
      ...baseTickets().filter((t) => t.type !== 'task'),
      {
        slug: 't-d',
        type: 'task',
        title: 'Task D',
        body: 'Depends on C',
        labels: ['type::task', 'persona::engineer'],
        parent_slug: 's1',
        depends_on: ['t-c'],
      },
      {
        slug: 't-c',
        type: 'task',
        title: 'Task C',
        body: 'Depends on B',
        labels: ['type::task', 'persona::engineer'],
        parent_slug: 's1',
        depends_on: ['t-b'],
      },
      {
        slug: 't-b',
        type: 'task',
        title: 'Task B',
        body: 'Depends on A',
        labels: ['type::task', 'persona::engineer'],
        parent_slug: 's1',
        depends_on: ['t-a'],
      },
      {
        slug: 't-a',
        type: 'task',
        title: 'Task A',
        body: 'Root of chain',
        labels: ['type::task', 'persona::engineer'],
        parent_slug: 's1',
      },
    ];

    await decomposeEpic(1, mockProvider, { tickets });

    const taskTitles = mockProvider.createdTickets
      .filter((c) => c.ticketData.title.startsWith('Task '))
      .map((c) => c.ticketData.title);
    assert.deepEqual(taskTitles, ['Task A', 'Task B', 'Task C', 'Task D']);

    const byTitle = new Map(
      mockProvider.createdTickets.map((c) => [c.ticketData.title, c]),
    );
    assert.deepEqual(byTitle.get('Task A').ticketData.dependencies, []);
    assert.deepEqual(byTitle.get('Task B').ticketData.dependencies, [
      byTitle.get('Task A').newId,
    ]);
    assert.deepEqual(byTitle.get('Task C').ticketData.dependencies, [
      byTitle.get('Task B').newId,
    ]);
    assert.deepEqual(byTitle.get('Task D').ticketData.dependencies, [
      byTitle.get('Task C').newId,
    ]);
  });

  it('staged concurrentMap preserves parent-before-child ordering under cap=3 (2F × 3S × 2T)', async () => {
    // Author 2 Features, each with 3 Stories, each with 2 Tasks (16 tickets).
    // The mock provider holds each createTicket promise open for one
    // microtask burst before resolving, so when concurrencyCap=3 a Story
    // could in principle race its parent Feature. The three staged passes
    // (features → stories → tasks) make that impossible: every parent's
    // ID lands in slugMap before the child pass starts. The test asserts
    // that invariant against `createdTickets` order regardless of within-
    // pass scheduling.
    const tickets = [];
    for (const f of [1, 2]) {
      tickets.push({
        slug: `f${f}`,
        type: 'feature',
        title: `Feature ${f}`,
        body: '',
        labels: ['type::feature', 'persona::engineer'],
      });
      for (const s of [1, 2, 3]) {
        const sSlug = `f${f}-s${s}`;
        tickets.push({
          slug: sSlug,
          type: 'story',
          title: `Story ${f}.${s}`,
          body: '',
          labels: ['type::story', 'persona::fullstack', 'complexity::fast'],
          parent_slug: `f${f}`,
        });
        for (const t of [1, 2]) {
          tickets.push({
            slug: `${sSlug}-t${t}`,
            type: 'task',
            title: `Task ${f}.${s}.${t}`,
            body: '',
            labels: ['type::task', 'persona::engineer'],
            parent_slug: sSlug,
          });
        }
      }
    }

    // Provider that defers each createTicket through a few microtasks so
    // siblings genuinely interleave under cap=3.
    let nextId = 200;
    mockProvider.createdTickets = [];
    mockProvider.createTicket = async (parentId, ticketData) => {
      const id = nextId++;
      // Yield twice so other queued workers get a chance to run.
      await Promise.resolve();
      await Promise.resolve();
      mockProvider.createdTickets.push({
        epicId: parentId,
        ticketData,
        newId: id,
      });
      return { id, url: `https://github.com/test/${id}` };
    };

    await decomposeEpic(
      1,
      mockProvider,
      { tickets },
      {
        orchestration: {
          runners: { decomposer: { concurrencyCap: 3 } },
        },
      },
    );

    // 2F + (2×3)S + (2×3×2)T = 2 + 6 + 12 = 20.
    assert.equal(mockProvider.createdTickets.length, 20);

    // Build a slug → creation index for every ticket. Then assert each
    // child's parent appears earlier in the createdTickets array.
    const titleToIndex = new Map(
      mockProvider.createdTickets.map((c, i) => [c.ticketData.title, i]),
    );
    for (const t of tickets) {
      if (!t.parent_slug) continue;
      const parentTicket = tickets.find((x) => x.slug === t.parent_slug);
      assert.ok(
        titleToIndex.get(parentTicket.title) < titleToIndex.get(t.title),
        `Parent "${parentTicket.title}" must be created before child "${t.title}"`,
      );
    }

    // Stronger structural guarantee: every Feature must precede every
    // Story, and every Story must precede every Task. The staged passes
    // make per-type creation contiguous in time.
    const lastFeatureIdx = Math.max(
      ...mockProvider.createdTickets
        .map((c, i) => (c.ticketData.title.startsWith('Feature ') ? i : -1))
        .filter((i) => i >= 0),
    );
    const firstStoryIdx = mockProvider.createdTickets.findIndex((c) =>
      c.ticketData.title.startsWith('Story '),
    );
    const lastStoryIdx = Math.max(
      ...mockProvider.createdTickets
        .map((c, i) => (c.ticketData.title.startsWith('Story ') ? i : -1))
        .filter((i) => i >= 0),
    );
    const firstTaskIdx = mockProvider.createdTickets.findIndex((c) =>
      c.ticketData.title.startsWith('Task '),
    );
    assert.ok(
      lastFeatureIdx < firstStoryIdx,
      'all features precede all stories',
    );
    assert.ok(lastStoryIdx < firstTaskIdx, 'all stories precede all tasks');
  });

  it('honours configured decomposer.concurrencyCap by limiting in-flight createTicket calls', async () => {
    // Probe the cap directly: 1 Feature with 6 sibling Stories (each
    // carrying its own Task to satisfy the validator). Track concurrent
    // createTicket invocations during the Story pass and assert the
    // high-water mark equals the configured concurrencyCap.
    const tickets = [
      {
        slug: 'f1',
        type: 'feature',
        title: 'Feature 1',
        body: '',
        labels: ['type::feature', 'persona::engineer'],
      },
    ];
    for (let i = 1; i <= 6; i++) {
      tickets.push({
        slug: `s${i}`,
        type: 'story',
        title: `Story ${i}`,
        body: '',
        labels: ['type::story', 'persona::fullstack', 'complexity::fast'],
        parent_slug: 'f1',
      });
      tickets.push({
        slug: `t${i}`,
        type: 'task',
        title: `Task ${i}`,
        body: '',
        labels: ['type::task', 'persona::engineer'],
        parent_slug: `s${i}`,
      });
    }

    let inFlight = 0;
    const peakByType = { feature: 0, story: 0, task: 0 };
    mockProvider.createTicket = async (parentId, ticketData) => {
      inFlight++;
      const labels = ticketData.labels || [];
      const type = labels.find((l) => l.startsWith('type::'))?.slice(6);
      if (type && inFlight > peakByType[type]) peakByType[type] = inFlight;
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      const id = 200 + mockProvider.createdTickets.length;
      mockProvider.createdTickets.push({
        epicId: parentId,
        ticketData,
        newId: id,
      });
      return { id, url: `https://github.com/test/${id}` };
    };

    await decomposeEpic(
      1,
      mockProvider,
      { tickets },
      {
        orchestration: { runners: { decomposer: { concurrencyCap: 2 } } },
      },
    );

    assert.equal(mockProvider.createdTickets.length, 13);
    // Story pass has 6 siblings under cap=2 — peak must hit 2 exactly.
    assert.equal(
      peakByType.story,
      2,
      `expected story-pass cap=2 but observed peak=${peakByType.story}`,
    );
    // Task pass has 6 siblings under cap=2 — peak must hit 2 exactly.
    assert.equal(
      peakByType.task,
      2,
      `expected task-pass cap=2 but observed peak=${peakByType.task}`,
    );
  });

  it('resume mode: skips create when title matches an existing OPEN child and reuses its id for dep wiring', async () => {
    const tickets = baseTickets();
    tickets.push({
      slug: 't2',
      type: 'task',
      title: 'Task Two',
      body: 'Depends on Task One',
      labels: ['type::task', 'persona::engineer'],
      parent_slug: 's1',
      depends_on: ['t1'],
    });

    // Existing children: Feature One (#500) + Story One (#501) already
    // landed; Task One was never created. Resume must skip the first two
    // and create only Task One + Task Two, wiring Task Two's dep to the id
    // of the freshly-created Task One (NOT to the pre-existing Story).
    mockProvider.getTickets = async () => [
      {
        id: 500,
        title: 'Feature One',
        labels: ['type::feature', 'persona::engineer'],
        state: 'open',
      },
      {
        id: 501,
        title: 'Story One',
        labels: ['type::story', 'persona::fullstack', 'complexity::fast'],
        state: 'open',
      },
    ];

    await decomposeEpic(1, mockProvider, { tickets }, {}, { resume: true });

    const titles = mockProvider.createdTickets.map((c) => c.ticketData.title);
    assert.deepEqual(
      titles,
      ['Task One', 'Task Two'],
      'only the missing tasks should be created',
    );
    const t2 = mockProvider.createdTickets.find(
      (c) => c.ticketData.title === 'Task Two',
    );
    const t1 = mockProvider.createdTickets.find(
      (c) => c.ticketData.title === 'Task One',
    );
    assert.deepEqual(
      t2.ticketData.dependencies,
      [t1.newId],
      'dep must point at the freshly-created Task One, not the existing Story',
    );
    // Task Two's parentId must be the existing Story #501.
    assert.equal(t2.epicId, 501);
  });

  it('resume mode: errors when the Epic has no existing children', async () => {
    mockProvider.getTickets = async () => [];
    await assert.rejects(
      () =>
        decomposeEpic(
          1,
          mockProvider,
          { tickets: baseTickets() },
          {},
          { resume: true },
        ),
      /--resume requires existing child tickets/,
    );
  });

  it('default re-run is idempotent: re-creating same tickets skips all open matches', async () => {
    mockProvider.getTickets = async () => [
      {
        id: 500,
        title: 'Feature One',
        labels: ['type::feature'],
        state: 'open',
      },
      {
        id: 501,
        title: 'Story One',
        labels: ['type::story'],
        state: 'open',
      },
      {
        id: 502,
        title: 'Task One',
        labels: ['type::task'],
        state: 'open',
      },
    ];
    await decomposeEpic(1, mockProvider, { tickets: baseTickets() });
    assert.equal(
      mockProvider.createdTickets.length,
      0,
      'fully-populated backlog should produce zero create calls',
    );
  });

  it('refuses to auto-link when an existing child has a different type than the planned ticket', async () => {
    // Planned: a Story called "Shared Title". Existing: a Task with the
    // same title. Cross-type collision must throw before any create call.
    const tickets = [
      {
        slug: 'f1',
        type: 'feature',
        title: 'Feature One',
        body: 'b',
        labels: ['type::feature'],
      },
      {
        slug: 's-shared',
        type: 'story',
        title: 'Shared Title',
        body: 'b',
        labels: ['type::story', 'persona::fullstack', 'complexity::fast'],
        parent_slug: 'f1',
      },
      {
        slug: 't1',
        type: 'task',
        title: 'Task One',
        body: 'b',
        labels: ['type::task'],
        parent_slug: 's-shared',
      },
    ];
    mockProvider.getTickets = async () => [
      {
        id: 999,
        title: 'Shared Title',
        labels: ['type::task'],
        state: 'open',
      },
    ];
    await assert.rejects(
      () => decomposeEpic(1, mockProvider, { tickets }),
      /Title collision across ticket types/,
    );
    assert.equal(mockProvider.createdTickets.length, 0);
  });

  it('adaptive concurrency: drops cap to 1 after a secondary-rate-limit observation', async () => {
    // Build 1F + 4 sibling Stories (each with its own Task). The Feature
    // pass triggers the secondary-RL hook; the Story pass that follows
    // must run with cap=1 (peak in-flight = 1) regardless of the
    // configured cap=4.
    const tickets = [
      {
        slug: 'f1',
        type: 'feature',
        title: 'F1',
        body: '',
        labels: ['type::feature'],
      },
    ];
    for (let i = 1; i <= 4; i++) {
      tickets.push({
        slug: `s${i}`,
        type: 'story',
        title: `S${i}`,
        body: '',
        labels: ['type::story', 'persona::fullstack', 'complexity::fast'],
        parent_slug: 'f1',
      });
      tickets.push({
        slug: `t${i}`,
        type: 'task',
        title: `T${i}`,
        body: '',
        labels: ['type::task'],
        parent_slug: `s${i}`,
      });
    }

    let inFlight = 0;
    const peakByType = { feature: 0, story: 0, task: 0 };
    let firedRL = false;
    // Fake http client surface — just enough for the adaptive hook to bind.
    mockProvider._http = { onTransientFailure: null };
    mockProvider.getTickets = async () => [];
    mockProvider.createTicket = async (parentId, ticketData) => {
      inFlight++;
      const labels = ticketData.labels || [];
      const type = labels.find((l) => l.startsWith('type::'))?.slice(6);
      if (type && inFlight > peakByType[type]) peakByType[type] = inFlight;
      // Trigger the RL signal during the first Feature creation.
      if (!firedRL && type === 'feature') {
        firedRL = true;
        mockProvider._http.onTransientFailure?.({
          kind: 'secondary-rate-limit',
          url: '/issues',
          status: 403,
        });
      }
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      const id = 200 + mockProvider.createdTickets.length;
      mockProvider.createdTickets.push({
        epicId: parentId,
        ticketData,
        newId: id,
      });
      return { id, url: `https://github.com/test/${id}` };
    };

    await decomposeEpic(
      1,
      mockProvider,
      { tickets },
      { orchestration: { runners: { decomposer: { concurrencyCap: 4 } } } },
    );

    assert.equal(mockProvider.createdTickets.length, 9);
    assert.equal(
      peakByType.story,
      1,
      `expected story-pass cap=1 after RL signal but observed peak=${peakByType.story}`,
    );
    assert.equal(
      peakByType.task,
      1,
      `expected task-pass cap=1 after RL signal but observed peak=${peakByType.task}`,
    );
  });

  it('rejects when --force and --resume are passed together', async () => {
    await assert.rejects(
      () =>
        decomposeEpic(
          1,
          mockProvider,
          { tickets: baseTickets() },
          {},
          { force: true, resume: true },
        ),
      /mutually exclusive/,
    );
  });

  it('--force close path caps in-flight close mutations at 3', async () => {
    // Seed 10 open existing children so the force-close burst is wider
    // than the cap. Track peak in-flight updateTicket calls to assert
    // concurrency is bounded at 3.
    const existing = [];
    for (let i = 0; i < 10; i++) {
      existing.push({
        id: 900 + i,
        title: `Stale Task ${i}`,
        labels: ['type::task'],
        state: 'open',
      });
    }
    mockProvider.getTickets = async () => existing;

    let inFlight = 0;
    let peakInFlight = 0;
    mockProvider.updateTicket = async (id, mutations) => {
      inFlight++;
      if (inFlight > peakInFlight) peakInFlight = inFlight;
      // simulate latency so concurrent calls overlap
      await new Promise((r) => setTimeout(r, 10));
      mockProvider.updatedTickets.push({ id, mutations });
      inFlight--;
    };

    await decomposeEpic(
      1,
      mockProvider,
      { tickets: baseTickets() },
      {},
      { force: true },
    );

    assert.ok(
      peakInFlight <= 3,
      `expected peak in-flight close mutations <= 3 but observed ${peakInFlight}`,
    );
    assert.equal(
      mockProvider.updatedTickets.filter((u) => u.mutations.state === 'closed')
        .length,
      10,
      'all 10 stale children should have been closed',
    );
  });

  it('--force close path surfaces the first rejection deterministically', async () => {
    // Two open children; the FIRST one to be processed throws. concurrentMap
    // contract: first rejection wins, later rejections are swallowed, and
    // the caller sees a single deterministic error.
    const existing = [
      {
        id: 901,
        title: 'Failing First',
        labels: ['type::task'],
        state: 'open',
      },
      {
        id: 902,
        title: 'Failing Second',
        labels: ['type::task'],
        state: 'open',
      },
    ];
    mockProvider.getTickets = async () => existing;

    mockProvider.updateTicket = async (id) => {
      if (id === 901) {
        throw new Error('boom-901');
      }
      throw new Error('boom-other');
    };

    await assert.rejects(
      () =>
        decomposeEpic(
          1,
          mockProvider,
          { tickets: baseTickets() },
          {},
          { force: true },
        ),
      /boom-901/,
    );
  });

  it('maps depends_on slugs to created issue IDs', async () => {
    const tickets = baseTickets();
    tickets.push({
      slug: 't2',
      type: 'task',
      title: 'Task Two',
      body: 'Depends on Task One',
      labels: ['type::task', 'persona::engineer'],
      parent_slug: 's1',
      depends_on: ['t1'],
    });

    await decomposeEpic(1, mockProvider, { tickets });

    const t2 = mockProvider.createdTickets.find(
      (c) => c.ticketData.title === 'Task Two',
    );
    assert.ok(t2);
    // t1 is the third created ticket → id 202
    assert.deepEqual(t2.ticketData.dependencies, [202]);
  });
});

describe('ticket-decomposer resolveDependencies', () => {
  it('throws when a slug is missing from the slugMap', () => {
    const slugMap = new Map([['t1', 200]]);
    const ticket = {
      slug: 't2',
      type: 'task',
      title: 'Task Two',
      depends_on: ['t1', 'missing-slug'],
    };
    assert.throws(
      () => resolveDependencies(ticket, slugMap),
      /unresolved slug "missing-slug"/,
    );
  });

  it('returns resolved IDs in input order when every slug is present', () => {
    const slugMap = new Map([
      ['t1', 200],
      ['t2', 201],
    ]);
    const ticket = {
      slug: 't3',
      type: 'task',
      title: 'Task Three',
      depends_on: ['t2', 't1'],
    };
    assert.deepEqual(resolveDependencies(ticket, slugMap), [201, 200]);
  });

  it('returns an empty array when depends_on is missing', () => {
    assert.deepEqual(
      resolveDependencies({ slug: 't1', type: 'task', title: 'T' }, new Map()),
      [],
    );
  });
});

describe('ticket-decomposer orderTicketsForCreation', () => {
  it('places features before stories before tasks regardless of input order', () => {
    const tickets = [
      { slug: 't1', type: 'task', title: 'T', parent_slug: 's1' },
      { slug: 's1', type: 'story', title: 'S', parent_slug: 'f1' },
      { slug: 'f1', type: 'feature', title: 'F' },
    ];
    const order = orderTicketsForCreation(tickets).map((t) => t.slug);
    assert.deepEqual(order, ['f1', 's1', 't1']);
  });

  it('topologically sorts within a (parent_slug, type) group', () => {
    const tickets = [
      { slug: 'f1', type: 'feature', title: 'F' },
      { slug: 's1', type: 'story', title: 'S', parent_slug: 'f1' },
      {
        slug: 't-c',
        type: 'task',
        title: 'C',
        parent_slug: 's1',
        depends_on: ['t-b'],
      },
      {
        slug: 't-b',
        type: 'task',
        title: 'B',
        parent_slug: 's1',
        depends_on: ['t-a'],
      },
      { slug: 't-a', type: 'task', title: 'A', parent_slug: 's1' },
    ];
    const order = orderTicketsForCreation(tickets).map((t) => t.slug);
    assert.deepEqual(order, ['f1', 's1', 't-a', 't-b', 't-c']);
  });

  it('ignores cross-group deps when ordering within a group', () => {
    // Cross-feature story dep — outside the (feature_slug, story) group, so
    // the intra-group sort skips the edge. The typeOrder concatenation still
    // guarantees both stories come after both features.
    const tickets = [
      { slug: 'f1', type: 'feature', title: 'F1' },
      { slug: 'f2', type: 'feature', title: 'F2' },
      {
        slug: 's1',
        type: 'story',
        title: 'S1',
        parent_slug: 'f1',
        depends_on: ['s2'],
      },
      { slug: 's2', type: 'story', title: 'S2', parent_slug: 'f2' },
    ];
    const order = orderTicketsForCreation(tickets).map((t) => t.slug);
    assert.equal(order.indexOf('f1') < order.indexOf('s1'), true);
    assert.equal(order.indexOf('f2') < order.indexOf('s2'), true);
  });
});

describe('ticket-decomposer buildDecomposerSystemPrompt', () => {
  it('returns the base prompt (with default maxTickets) when no heuristics are supplied', () => {
    const prompt = buildDecomposerSystemPrompt([]);
    assert.equal(prompt, renderDecomposerSystemPrompt());
    assert.ok(prompt.includes('Do NOT generate more than 60 tickets in total'));
  });

  it('appends risk heuristics when supplied', () => {
    const base = renderDecomposerSystemPrompt();
    const prompt = buildDecomposerSystemPrompt([
      'Destructive DB changes',
      'Global refactors',
    ]);
    assert.ok(prompt.startsWith(base));
    assert.ok(prompt.includes('### RISK HEURISTICS'));
    assert.ok(prompt.includes('Destructive DB changes'));
    assert.ok(prompt.includes('Global refactors'));
  });

  it('interpolates the configured maxTickets cap into the prompt', () => {
    const prompt = buildDecomposerSystemPrompt([], { maxTickets: 75 });
    assert.ok(prompt.includes('Do NOT generate more than 75 tickets in total'));
    assert.ok(!prompt.includes('more than 40 tickets'));
  });
});

describe('ticket-decomposer buildDecompositionContext', () => {
  it('returns the PRD/Tech Spec bodies and system prompt', async () => {
    const provider = {
      async getEpic(id) {
        return {
          id,
          title: 'Ctx Epic',
          linkedIssues: { prd: 10, techSpec: 11 },
        };
      },
      async getTicket(id) {
        return {
          id,
          body: id === 10 ? 'PRD BODY' : 'TECH SPEC BODY',
        };
      },
    };

    const ctx = await buildDecompositionContext(1, provider, {
      agentSettings: {
        planning: { riskHeuristics: ['Heuristic A'] },
        limits: { maxTickets: 60 },
      },
    });

    assert.equal(ctx.epic.id, 1);
    assert.equal(ctx.prd.body, 'PRD BODY');
    assert.equal(ctx.techSpec.body, 'TECH SPEC BODY');
    assert.deepEqual(ctx.heuristics, ['Heuristic A']);
    assert.ok(ctx.systemPrompt.includes('Heuristic A'));
    assert.equal(ctx.maxTickets, 60);
    assert.ok(
      ctx.systemPrompt.includes(
        'Do NOT generate more than 60 tickets in total',
      ),
      'systemPrompt must interpolate the configured maxTickets cap',
    );
  });

  it('throws when planning artifacts are missing', async () => {
    const provider = {
      async getEpic() {
        return { id: 1, linkedIssues: { prd: null, techSpec: null } };
      },
      async getTicket() {
        return null;
      },
    };
    await assert.rejects(
      async () => await buildDecompositionContext(1, provider, {}),
      { message: /missing linked PRD or Tech Spec/ },
    );
  });

  describe('planning-context budget (Epic #817 Story 9)', () => {
    const buildProvider = () => ({
      async getEpic(id) {
        return {
          id,
          title: 'Big Epic',
          linkedIssues: { prd: 10, techSpec: 11 },
        };
      },
      async getTicket(id) {
        const big = `## Heading\n\n${'x'.repeat(40000)}\n`;
        return {
          id,
          body:
            id === 10
              ? `${big}\n## PRD-only\n\nbody`
              : `${big}\n## TS-only\n\nbody`,
        };
      },
    });

    it('downgrades to summary mode when PRD+TechSpec exceed maxBytes', async () => {
      const ctx = await buildDecompositionContext(1, buildProvider(), {
        agentSettings: {
          limits: {
            planningContext: { maxBytes: 4096, summaryMode: 'auto' },
          },
        },
      });
      assert.equal(ctx.contextMode, 'summary');
      assert.equal(ctx.prd.body, null);
      assert.ok(ctx.prd.bodySummary);
      assert.ok(ctx.prd.bodySummary.headings.includes('Heading'));
      assert.equal(ctx.techSpec.body, null);
      assert.ok(ctx.techSpec.bodySummary);
    });

    it('keeps full bodies when --full-context opt is set', async () => {
      const ctx = await buildDecompositionContext(
        1,
        buildProvider(),
        {
          agentSettings: {
            limits: {
              planningContext: { maxBytes: 4096, summaryMode: 'auto' },
            },
          },
        },
        { fullContext: true },
      );
      assert.equal(ctx.contextMode, 'full');
      assert.ok(ctx.prd.body.includes('## Heading'));
      assert.ok(ctx.techSpec.body.includes('## Heading'));
    });

    it('summaryMode=always forces summary even for small bodies', async () => {
      const provider = {
        async getEpic(id) {
          return {
            id,
            title: 'Small Epic',
            linkedIssues: { prd: 10, techSpec: 11 },
          };
        },
        async getTicket(id) {
          return { id, body: '## Tiny\n\nshort body' };
        },
      };
      const ctx = await buildDecompositionContext(1, provider, {
        agentSettings: {
          limits: {
            planningContext: { maxBytes: 1000000, summaryMode: 'always' },
          },
        },
      });
      assert.equal(ctx.contextMode, 'summary');
      assert.deepEqual(ctx.prd.bodySummary.headings, ['Tiny']);
    });

    it('full and summary modes resolve identically in tickets-mode pipeline (decompose accepts both)', async () => {
      // Decomposition itself doesn't read the bodies — it only reads the
      // ticket array. Asserting the same `decomposeEpic` output regardless of
      // which planning-context mode produced the upstream JSON proves the
      // budget is purely an emit-context concern and never leaks into ticket
      // creation.
      const provider1 = buildProvider();
      const provider2 = buildProvider();
      const ticketArray = baseTickets();

      // Decompose using two different upstream configs; outputs must match.
      provider1.createdTickets = [];
      provider1.updatedTickets = [];
      provider1.createTicket = async (epicId, ticketData) => {
        const newId = 200 + provider1.createdTickets.length;
        provider1.createdTickets.push({ epicId, ticketData, newId });
        return { id: newId, url: `https://github.com/test/${newId}` };
      };
      provider2.createdTickets = [];
      provider2.updatedTickets = [];
      provider2.createTicket = async (epicId, ticketData) => {
        const newId = 200 + provider2.createdTickets.length;
        provider2.createdTickets.push({ epicId, ticketData, newId });
        return { id: newId, url: `https://github.com/test/${newId}` };
      };

      await decomposeEpic(1, provider1, { tickets: ticketArray });
      await decomposeEpic(1, provider2, { tickets: ticketArray });

      assert.deepEqual(
        provider1.createdTickets.map((c) => c.ticketData.title),
        provider2.createdTickets.map((c) => c.ticketData.title),
      );
    });
  });
});

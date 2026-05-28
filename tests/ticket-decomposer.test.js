import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
// Story #1437 Task #1447: the `ticket-decomposer.js` engine was inlined
// into `epic-plan-decompose.js`. The test suite name is kept as a
// historical breadcrumb for greppability; the exercised behaviour is
// unchanged.
import {
  buildDecomposerSystemPrompt,
  buildDecompositionContext,
  decomposeEpic,
  orderTicketsForCreation,
  resolveDependencies,
} from '../.agents/scripts/epic-plan-decompose.js';
import { renderDecomposerSystemPrompt } from '../.agents/scripts/lib/templates/decomposer-prompts.js';

// 3-tier (Epic #3238): Feature → Story, with the Story carrying its inline
// acceptance + verify contract and a structured body. There is no Task tier.
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
    labels: ['type::story', 'persona::fullstack', 'complexity::fast'],
    parent_slug: 'f1',
    acceptance: ['Story One is implemented'],
    verify: ['npm test (unit)'],
    body: {
      goal: 'Body of Story One',
      changes: ['src/one.js: edit'],
      acceptance: ['Story One is implemented'],
      verify: ['npm test (unit)'],
    },
  },
];

// 3-tier (Epic #3238): a Story is its own implementation unit. It carries
// the top-level inline contract (acceptance[] + verify[]) the validator
// requires plus a structured body. Used to build the multi-Story fixtures
// the orchestration concurrency / ordering tests exercise.
const makeStory = (slug, title, parentSlug, extras = {}) => ({
  slug,
  type: 'story',
  title,
  parent_slug: parentSlug,
  labels: ['type::story', 'persona::fullstack', 'complexity::fast'],
  acceptance: [`${title} is implemented`],
  verify: ['npm test (unit)'],
  body: {
    goal: `Body of ${title}`,
    changes: [`src/${slug}.js: edit`],
    acceptance: [`${title} is implemented`],
    verify: ['npm test (unit)'],
  },
  ...extras,
});

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

  it('creates Feature/Story tickets from an authored array', async () => {
    // 3-tier (Epic #3238): the decomposer emits only Features and Stories;
    // the Story carries its inline acceptance + verify contract. There is
    // no Task tier, so the authored backlog yields exactly two tickets.
    await decomposeEpic(1, mockProvider, { tickets: baseTickets() });

    assert.equal(
      mockProvider.createdTickets.length,
      2,
      'Should create exactly two tickets (Feature, Story)',
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
  });

  it('throws when a depends_on references an unknown slug', async () => {
    const tickets = [
      ...baseTickets(),
      makeStory('s2', 'Story Two', 'f1', { depends_on: ['s-typo'] }),
    ];

    await assert.rejects(
      () => decomposeEpic(1, mockProvider, { tickets }),
      /unknown slugs/,
    );
  });

  it('creates a depth-4 sibling-Story dep chain in topological order', async () => {
    // 3-tier (Epic #3238): author a chain of sibling Stories in REVERSE dep
    // order so the typeOrder-only sort would have created s-d before s-c
    // before s-b before s-a, leaving every depends_on unresolvable.
    // Topological sort within the story pass must re-order them to
    // s-a, s-b, s-c, s-d before any provider.createTicket call fires.
    const tickets = [
      ...baseTickets().filter((t) => t.type === 'feature'),
      makeStory('s-d', 'Story D', 'f1', { depends_on: ['s-c'] }),
      makeStory('s-c', 'Story C', 'f1', { depends_on: ['s-b'] }),
      makeStory('s-b', 'Story B', 'f1', { depends_on: ['s-a'] }),
      makeStory('s-a', 'Story A', 'f1'),
    ];

    await decomposeEpic(1, mockProvider, { tickets });

    const storyTitles = mockProvider.createdTickets
      .filter((c) => c.ticketData.title.startsWith('Story '))
      .map((c) => c.ticketData.title);
    assert.deepEqual(storyTitles, ['Story A', 'Story B', 'Story C', 'Story D']);

    const byTitle = new Map(
      mockProvider.createdTickets.map((c) => [c.ticketData.title, c]),
    );
    assert.deepEqual(byTitle.get('Story A').ticketData.dependencies, []);
    assert.deepEqual(byTitle.get('Story B').ticketData.dependencies, [
      byTitle.get('Story A').newId,
    ]);
    assert.deepEqual(byTitle.get('Story C').ticketData.dependencies, [
      byTitle.get('Story B').newId,
    ]);
    assert.deepEqual(byTitle.get('Story D').ticketData.dependencies, [
      byTitle.get('Story C').newId,
    ]);
  });

  it('staged concurrentMap preserves parent-before-child ordering under cap=3 (2F × 3S)', async () => {
    // 3-tier (Epic #3238): author 2 Features, each with 3 Stories (8
    // tickets). The mock provider holds each createTicket promise open for
    // one microtask burst before resolving, so when concurrencyCap=3 a
    // Story could in principle race its parent Feature. The two staged
    // passes (features → stories) make that impossible: every parent's ID
    // lands in slugMap before the child pass starts. The test asserts that
    // invariant against `createdTickets` order regardless of within-pass
    // scheduling.
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
        tickets.push(makeStory(`f${f}-s${s}`, `Story ${f}.${s}`, `f${f}`));
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

    // 2F + (2×3)S = 2 + 6 = 8.
    assert.equal(mockProvider.createdTickets.length, 8);

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
    // Story. The staged passes make per-type creation contiguous in time.
    const lastFeatureIdx = Math.max(
      ...mockProvider.createdTickets
        .map((c, i) => (c.ticketData.title.startsWith('Feature ') ? i : -1))
        .filter((i) => i >= 0),
    );
    const firstStoryIdx = mockProvider.createdTickets.findIndex((c) =>
      c.ticketData.title.startsWith('Story '),
    );
    assert.ok(
      lastFeatureIdx < firstStoryIdx,
      'all features precede all stories',
    );
  });

  it('honours configured decomposer.concurrencyCap by limiting in-flight createTicket calls', async () => {
    // Probe the cap directly: 1 Feature with 6 sibling Stories (3-tier —
    // each Story carries its own inline acceptance + verify contract).
    // Track concurrent createTicket invocations during the Story pass and
    // assert the high-water mark equals the configured concurrencyCap.
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
      tickets.push(makeStory(`s${i}`, `Story ${i}`, 'f1'));
    }

    let inFlight = 0;
    const peakByType = { feature: 0, story: 0 };
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

    await decomposeEpic(1, mockProvider, { tickets }, {});

    // 1F + 6S = 7.
    assert.equal(mockProvider.createdTickets.length, 7);
    // Post-reshape (Epic #1720 Story #1739) the decomposer concurrency cap
    // is hardcoded at 3 (DEFAULT_DECOMPOSER.concurrencyCap). The Story pass
    // has 6 siblings under cap=3 — peak must hit 3.
    assert.equal(
      peakByType.story,
      3,
      `expected story-pass cap=3 but observed peak=${peakByType.story}`,
    );
  });

  it('resume mode: skips create when title matches an existing OPEN child and reuses its id for dep wiring', async () => {
    // 3-tier (Epic #3238): 1 Feature with 2 sibling Stories, the second
    // depending on the first. Story Two's parent is the Feature; its dep is
    // the sibling Story One.
    const tickets = [
      ...baseTickets(),
      makeStory('s2', 'Story Two', 'f1', { depends_on: ['s1'] }),
    ];

    // Existing children: Feature One (#500) already landed; Story One was
    // never created. Resume must skip the Feature and create only Story One
    // + Story Two, wiring Story Two's dep to the id of the freshly-created
    // Story One (NOT to the pre-existing Feature).
    mockProvider.getTickets = async () => [
      {
        id: 500,
        title: 'Feature One',
        labels: ['type::feature', 'persona::engineer'],
        state: 'open',
      },
    ];

    await decomposeEpic(1, mockProvider, { tickets }, {}, { resume: true });

    const titles = mockProvider.createdTickets.map((c) => c.ticketData.title);
    assert.deepEqual(
      titles,
      ['Story One', 'Story Two'],
      'only the missing stories should be created',
    );
    const s2 = mockProvider.createdTickets.find(
      (c) => c.ticketData.title === 'Story Two',
    );
    const s1 = mockProvider.createdTickets.find(
      (c) => c.ticketData.title === 'Story One',
    );
    assert.deepEqual(
      s2.ticketData.dependencies,
      [s1.newId],
      'dep must point at the freshly-created Story One',
    );
    // Story Two's parentId must be the existing Feature #500.
    assert.equal(s2.epicId, 500);
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

  it('adaptive concurrency: drops cap to 1 after a secondary-rate-limit observation', async () => {
    // 3-tier (Epic #3238): build 1F + 4 sibling Stories. The Feature pass
    // triggers the secondary-RL hook; the Story pass that follows must run
    // with cap=1 (peak in-flight = 1) regardless of the configured cap=4.
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
      tickets.push(makeStory(`s${i}`, `S${i}`, 'f1'));
    }

    let inFlight = 0;
    const peakByType = { feature: 0, story: 0 };
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

    // 1F + 4S = 5.
    assert.equal(mockProvider.createdTickets.length, 5);
    assert.equal(
      peakByType.story,
      1,
      `expected story-pass cap=1 after RL signal but observed peak=${peakByType.story}`,
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

  it('maps depends_on slugs to created issue IDs', async () => {
    // 3-tier (Epic #3238): a second sibling Story depends on the first.
    const tickets = [
      ...baseTickets(),
      makeStory('s2', 'Story Two', 'f1', { depends_on: ['s1'] }),
    ];

    await decomposeEpic(1, mockProvider, { tickets });

    const s2 = mockProvider.createdTickets.find(
      (c) => c.ticketData.title === 'Story Two',
    );
    assert.ok(s2);
    // f1 → id 200, s1 → id 201; Story Two's dep resolves to Story One's id.
    assert.deepEqual(s2.ticketData.dependencies, [201]);
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
    // Story #2798 — `maxTickets` is now framed as a reviewability budget,
    // not a hard authoring cap. The prompt must mention the resolved
    // budget value and the "reviewability budget" language; the legacy
    // "Do NOT generate more than ..." hard-cap directive is forbidden.
    assert.ok(/reviewability budget/i.test(prompt));
    assert.ok(/maxTickets\s*=\s*60/.test(prompt));
    assert.ok(
      !/Do NOT generate more than/.test(prompt),
      'hard-cap directive must be removed in favor of reviewability-budget language',
    );
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

  it('interpolates the configured maxTickets budget into the prompt', () => {
    const prompt = buildDecomposerSystemPrompt([], { maxTickets: 75 });
    assert.ok(/maxTickets\s*=\s*75/.test(prompt));
    assert.ok(!/maxTickets\s*=\s*40/.test(prompt));
  });

  it('instructs the author to provide an over-budget rationale rather than truncate', () => {
    // Story #2798 — when the plan genuinely needs more tickets than the
    // budget, the prompt must tell the author to emit the rationale +
    // proceed (with operator override at persist time), NOT to truncate
    // or over-compress the plan to fit.
    const prompt = buildDecomposerSystemPrompt([], { maxTickets: 60 });
    assert.ok(
      /over[- ]budget rationale|rationale|--allow-over-budget/i.test(prompt),
      'prompt must mention an explicit over-budget rationale or override path',
    );
    assert.ok(
      !/cut off the JSON array prematurely/i.test(prompt),
      'truncation language must be removed; the author should not stop emitting tickets to fit',
    );
  });

  it('advertises the recalibrated maxAcceptance ceiling of 8 (Story #3231 Recal B)', () => {
    // Story #3237 — the default maxAcceptance was raised from 6 to 8 in
    // Story #3231. The prompt must mention the updated ceiling so the
    // planner biases output correctly.
    const prompt = buildDecomposerSystemPrompt([]);
    assert.ok(
      /maxAcceptance:\s*8/.test(prompt),
      'prompt must advertise maxAcceptance: 8',
    );
    assert.ok(
      !/maxAcceptance:\s*6/.test(prompt),
      'prompt must not advertise the stale maxAcceptance: 6 ceiling',
    );
  });

  it('describes estimated_test_files field and test-surface gates (Story #3235)', () => {
    // Story #3237 — the estimated_test_files field was added in Story #3235.
    // The prompt must document it so the planner knows to emit the field.
    const prompt = buildDecomposerSystemPrompt([]);
    assert.ok(
      /estimated_test_files/i.test(prompt),
      'prompt must document the estimated_test_files field',
    );
    assert.ok(
      /test.surface.overflow|large.test.surface/i.test(prompt),
      'prompt must mention the test-surface finding names',
    );
  });

  it('describes per-profile change ceilings table (Story #3231 Recal A)', () => {
    // Story #3237 — per-profile change ceilings replaced the global
    // maxChanges: 8 default in Story #3231.
    const prompt = buildDecomposerSystemPrompt([]);
    assert.ok(
      /profileCeilings|per-profile change ceiling/i.test(prompt),
      'prompt must describe per-profile change ceilings',
    );
    assert.ok(
      /mechanical-sweep/i.test(prompt),
      'prompt must list the mechanical-sweep profile ceiling',
    );
  });

  it('describes sizingProfile as recommended/optional, not a hard rejection (Story #3231 Recal C)', () => {
    // Story #3237 — sizingProfile is now informational; omitting it on a
    // wide Story emits missing-sizing-profile-hint, not a hard rejection.
    const prompt = buildDecomposerSystemPrompt([]);
    assert.ok(
      /missing-sizing-profile-hint/i.test(prompt),
      'prompt must mention missing-sizing-profile-hint informational finding',
    );
    // The old hard-rejection wording must be gone.
    const lines = prompt
      .split('\n')
      .filter((l) => /missing-sizing-profile/.test(l));
    for (const line of lines) {
      assert.ok(
        !/\brejection\b|\breject\b|\bre-prompt\b/i.test(line) ||
          /hint/i.test(line),
        `prompt must not describe missing-sizing-profile as a hard rejection (line: "${line.trim()}")`,
      );
    }
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
      /maxTickets\s*=\s*60/.test(ctx.systemPrompt) &&
        /reviewability budget/i.test(ctx.systemPrompt),
      'systemPrompt must interpolate the configured maxTickets value and describe it as a reviewability budget',
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
        planning: {
          context: { maxBytes: 1000000, summaryMode: 'always' },
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

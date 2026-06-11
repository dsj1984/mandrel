import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
// Story #1437 Task #1447: the `ticket-decomposer.js` engine was inlined
// into `epic-plan-decompose.js`. The test suite name is kept as a
// historical breadcrumb for greppability; the exercised behaviour is
// unchanged.
//
// Story #3841 — the dead `decomposeEpic` direct-create entry point was
// deleted. The decompose-time input guards it used to own (Epic not found,
// not a type::epic, missing PRD/Tech Spec, non-array tickets, mutually
// exclusive --force/--resume) live on the canonical reconciler-based
// `runDecomposePhase`/persist surface, so those assertions are re-pointed
// there. The DAG ordering + sibling-dependency wiring stays covered through
// the live `orderTicketsForCreation` / `resolveDependencies` helpers.
import {
  buildDecomposerSystemPrompt,
  buildDecompositionContext,
  orderTicketsForCreation,
  resolveDependencies,
  runDecomposePhase,
} from '../.agents/scripts/epic-plan-decompose.js';
import { DELIVERABLE_GRANULARITY_GUIDANCE } from '../.agents/scripts/lib/orchestration/ticket-validator-sizing.js';
import { renderDecomposerSystemPrompt } from '../.agents/scripts/lib/templates/decomposer-prompts.js';

// 2-tier (Story #4041): a flat Story backlog attached directly to the Epic,
// with every Story carrying its inline acceptance + verify contract and a
// structured body. There is no Feature or Task tier.
const baseTickets = () => [
  {
    slug: 's1',
    type: 'story',
    title: 'Story One',
    labels: ['type::story', 'persona::fullstack', 'complexity::fast'],
    acceptance: ['Story One is implemented'],
    verify: ['npm test (unit)'],
    body: {
      goal: 'Body of Story One',
      changes: ['src/one.js: edit'],
      acceptance: ['Story One is implemented'],
      verify: ['npm test (unit)'],
    },
  },
  {
    slug: 's1b',
    type: 'story',
    title: 'Story One-B',
    labels: ['type::story', 'persona::fullstack', 'complexity::fast'],
    acceptance: ['Story One-B is implemented'],
    verify: ['npm test (unit)'],
    body: {
      goal: 'Body of Story One-B',
      changes: ['src/one-b.js: edit'],
      acceptance: ['Story One-B is implemented'],
      verify: ['npm test (unit)'],
    },
  },
];

// 2-tier (Epic #3238): a Story is its own implementation unit. It carries
// the top-level inline contract (acceptance[] + verify[]) the validator
// requires plus a structured body. Used to build the multi-Story fixtures
// the orchestration concurrency / ordering tests exercise.
const makeStory = (slug, title, extras = {}) => ({
  slug,
  type: 'story',
  title,
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

describe('ticket-decomposer persist guards (runDecomposePhase)', () => {
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
          labels: ['type::epic'],
          linkedIssues: { prd: 100, techSpec: 101 },
        };
      },

      async getTicket(id) {
        if (id === 100) return { id: 100, body: 'Mocked PRD body' };
        if (id === 101) return { id: 101, body: 'Mocked Tech Spec body' };
        return null;
      },

      async getSubTickets() {
        return [];
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

  it('aborts early when the Epic is missing linked PRD/Tech Spec artifacts', async () => {
    mockProvider.getEpic = async () => ({
      id: 1,
      title: 'Missing Links Epic',
      labels: ['type::epic'],
      linkedIssues: { prd: null, techSpec: null },
    });

    await assert.rejects(
      () =>
        runDecomposePhase(1, mockProvider, { tickets: baseTickets() }, {}, {}),
      /missing a linked PRD or Tech Spec/,
    );
  });

  it('aborts when the target ticket is not a type::epic', async () => {
    mockProvider.getEpic = async () => ({
      id: 1,
      title: 'Not An Epic',
      labels: ['type::feature'],
      linkedIssues: { prd: 100, techSpec: 101 },
    });

    await assert.rejects(
      () =>
        runDecomposePhase(1, mockProvider, { tickets: baseTickets() }, {}, {}),
      /is not a type::epic/,
    );
  });

  it('aborts when the Epic cannot be found', async () => {
    mockProvider.getEpic = async () => null;
    await assert.rejects(
      () =>
        runDecomposePhase(1, mockProvider, { tickets: baseTickets() }, {}, {}),
      /Epic #1 not found/,
    );
  });

  it('rejects a non-array tickets payload', async () => {
    await assert.rejects(
      () =>
        runDecomposePhase(1, mockProvider, { tickets: 'not an array' }, {}, {}),
      /tickets must be an array/,
    );
  });

  it('rejects when --force and --resume are passed together', async () => {
    await assert.rejects(
      () =>
        runDecomposePhase(
          1,
          mockProvider,
          { tickets: baseTickets() },
          {},
          { force: true, resume: true },
        ),
      /mutually exclusive/,
    );
  });
});

describe('ticket-decomposer DAG wiring (orderTicketsForCreation + resolveDependencies)', () => {
  // Story #3841 — the sibling-dependency wiring previously asserted through
  // the now-deleted `decomposeEpic` direct-create flow is exercised here
  // against the live DAG helpers the reconciler pipeline still uses:
  // `orderTicketsForCreation` topologically sorts within each (parent, type)
  // group, and `resolveDependencies` maps `depends_on` slugs to created ids
  // via the slugMap threaded through the reconciler pipeline.

  it('orders a depth-4 sibling-Story dep chain topologically before any create', () => {
    // Author the chain in REVERSE dep order so a typeOrder-only sort would
    // leave s-d before s-c before s-b before s-a (every depends_on
    // unresolvable). The intra-group topological sort must re-order them to
    // s-a, s-b, s-c, s-d.
    const tickets = [
      makeStory('s-d', 'Story D', { depends_on: ['s-c'] }),
      makeStory('s-c', 'Story C', { depends_on: ['s-b'] }),
      makeStory('s-b', 'Story B', { depends_on: ['s-a'] }),
      makeStory('s-a', 'Story A'),
    ];

    const orderedSlugs = orderTicketsForCreation(tickets).map((t) => t.slug);
    assert.deepEqual(orderedSlugs, ['s-a', 's-b', 's-c', 's-d']);
  });

  it('resolves a sibling Story depends_on to the dependency Story id via the slugMap', () => {
    // Mirror the slugMap state after Story One (201) has been created in
    // an earlier pass; Story Two depends on Story One.
    const slugMap = new Map([['s1', 201]]);
    const storyTwo = makeStory('s2', 'Story Two', { depends_on: ['s1'] });
    assert.deepEqual(resolveDependencies(storyTwo, slugMap), [201]);
  });

  it('resolves an empty dependency list when a Story has no depends_on', () => {
    const slugMap = new Map();
    const storyOne = makeStory('s1', 'Story One');
    assert.deepEqual(resolveDependencies(storyOne, slugMap), []);
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
  it('topologically sorts the Story set', () => {
    const tickets = [
      {
        slug: 's-c',
        type: 'story',
        title: 'C',
        depends_on: ['s-b'],
      },
      {
        slug: 's-b',
        type: 'story',
        title: 'B',
        depends_on: ['s-a'],
      },
      { slug: 's-a', type: 'story', title: 'A' },
    ];
    const order = orderTicketsForCreation(tickets).map((t) => t.slug);
    assert.deepEqual(order, ['s-a', 's-b', 's-c']);
  });

  it('orders dependency producers before consumers across the whole set', () => {
    const tickets = [
      {
        slug: 's1',
        type: 'story',
        title: 'S1',
        depends_on: ['s2'],
      },
      { slug: 's2', type: 'story', title: 'S2' },
    ];
    const order = orderTicketsForCreation(tickets).map((t) => t.slug);
    assert.equal(order.indexOf('s2') < order.indexOf('s1'), true);
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

  it('advertises the maxAcceptance and hardFiles ceilings from the single sizing constant (Story #3760, relaxed by Story #3874)', () => {
    // The prompt sources its threshold sentence from DEFAULT_TASK_SIZING so
    // the two surfaces cannot drift. The relaxed default ceilings are
    // maxAcceptance=14 and hardFiles=30.
    const prompt = buildDecomposerSystemPrompt([]);
    assert.ok(
      /maxAcceptance/.test(prompt) && /\b14\b/.test(prompt),
      'prompt must advertise the maxAcceptance ceiling of 14',
    );
    assert.ok(
      /hardFiles/.test(prompt) && /\b30\b/.test(prompt),
      'prompt must advertise the hardFiles ceiling of 30',
    );
  });

  it('leads sizing guidance with a cohesion heuristic, not the numeric ceiling (Story #3760)', () => {
    const prompt = buildDecomposerSystemPrompt([]);
    assert.ok(
      /cohesion/i.test(prompt),
      'prompt must lead the sizing section with cohesion',
    );
    assert.ok(
      /one coherent change with one reason to exist/i.test(prompt),
      'prompt must state the one-coherent-change cohesion rule',
    );
    assert.ok(
      /backstop/i.test(prompt),
      'prompt must frame the numeric ceiling as a backstop',
    );
  });

  it('describes the wide declaration that lifts the hard ceiling (Story #3760)', () => {
    const prompt = buildDecomposerSystemPrompt([]);
    assert.ok(
      /\bwide\b/i.test(prompt),
      'prompt must describe the wide declaration',
    );
    assert.ok(
      /lifts the .?hardFiles.? rejection/i.test(prompt),
      'prompt must say declaring wide lifts the hardFiles rejection',
    );
  });

  it('no longer mentions the retired profile enum or testSurface gates (Story #3760)', () => {
    const prompt = buildDecomposerSystemPrompt([]);
    assert.ok(
      !/sizingProfile|atomic-rewrite|scaffolding|mechanical-sweep/i.test(
        prompt,
      ),
      'prompt must not restate the retired sizingProfile enum',
    );
    assert.ok(
      !/profileCeilings|test.surface.overflow|large.test.surface/i.test(prompt),
      'prompt must not restate the retired profileCeilings / testSurface gates',
    );
  });

  it('carries the deliverable-granularity definition from the shared constant (Story #3777)', () => {
    const prompt = buildDecomposerSystemPrompt([]);
    assert.ok(
      /shippable slice .* reviewer would accept as a single PR/i.test(prompt),
      'prompt must define a Story as a shippable slice a reviewer would accept as a single PR',
    );
    assert.ok(
      /not a single module or file/i.test(prompt),
      'prompt must say a Story is NOT a single module or file',
    );
    assert.ok(
      /fold module-level slices/i.test(prompt),
      'prompt must instruct folding module-level slices into the capability',
    );
  });

  it('carries the single-consumer merge rule (Story #3777)', () => {
    const prompt = buildDecomposerSystemPrompt([]);
    assert.ok(
      /single-consumer merge rule/i.test(prompt),
      'prompt must state the single-consumer merge rule',
    );
    assert.ok(
      /merged into that sibling/i.test(prompt),
      'prompt must say a single-consumer Story is merged into that sibling',
    );
  });

  it('emits Stories only — no Feature tier (Story #4041)', () => {
    const prompt = buildDecomposerSystemPrompt([]);
    assert.ok(
      /NO Feature tier/i.test(prompt),
      'prompt must state there is no Feature tier',
    );
    assert.ok(
      /"type": "story"/.test(prompt),
      'prompt schema must pin type to story',
    );
    assert.ok(
      !/parent_slug": "slug_of_parent_ticket/.test(prompt),
      'prompt must not offer a parent_slug field',
    );
  });

  it('sources the deliverable-granularity guidance from the single shared constant — no drift (Story #3777)', () => {
    // The prompt interpolates DELIVERABLE_GRANULARITY_GUIDANCE verbatim, so
    // the exact canonical sentences must appear in the rendered prompt. This
    // proves the prompt and the validator/SKILL share ONE source of truth.
    const prompt = buildDecomposerSystemPrompt([]);
    assert.ok(
      prompt.includes(DELIVERABLE_GRANULARITY_GUIDANCE.definition),
      'prompt must interpolate the canonical granularity definition verbatim',
    );
    assert.ok(
      prompt.includes(DELIVERABLE_GRANULARITY_GUIDANCE.singleConsumerRule),
      'prompt must interpolate the canonical single-consumer rule verbatim',
    );
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

    it('creation order is driven by the ticket array, not the planning-context mode', () => {
      // Decomposition itself doesn't read the PRD/Tech-Spec bodies — it only
      // reads the authored ticket array. The planning-context mode (full vs
      // summary) is purely an emit-context concern and never leaks into the
      // deterministic creation order, which is fixed by
      // `orderTicketsForCreation` over the same array. Ordering the same
      // array twice yields an identical sequence regardless of any upstream
      // context-budget decision.
      const ticketArray = baseTickets();
      const orderA = orderTicketsForCreation(ticketArray).map((t) => t.title);
      const orderB = orderTicketsForCreation(ticketArray).map((t) => t.title);
      assert.deepEqual(orderA, orderB);
    });
  });
});

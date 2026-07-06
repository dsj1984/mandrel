import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
// Story #1437 Task #1447: the `ticket-decomposer.js` engine was inlined
// into `epic-plan-decompose.js`. The test suite name is kept as a
// historical breadcrumb for greppability; the exercised behaviour is
// unchanged.
//
// Story #3841 — the dead `decomposeEpic` direct-create entry point was
// deleted. The decompose-time input guards it used to own (Epic not found,
// not a type::epic, missing Tech Spec, non-array tickets, mutually
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
import { upsertEpicSection } from '../.agents/scripts/lib/epic-body-sections.js';
import {
  AUTHORING_ALTITUDE_GUIDANCE,
  DELIVERABLE_GRANULARITY_GUIDANCE,
} from '../.agents/scripts/lib/orchestration/ticket-validator-sizing.js';
import { renderDecomposerSystemPrompt } from '../.agents/scripts/lib/templates/decomposer-prompts.js';

// Story #4324 — the context::tech-spec / context::acceptance-spec ticket
// classes are retired: the Epic body is the single planning document. The
// decompose gate keys on the folded Tech Spec sections (managed region or a
// bare `## Delivery Slicing` heading) in the Epic body itself.
const TECH_SPEC_SECTION =
  '## Delivery Slicing\n\n| Slice | What ships | Independent? |\n| --- | --- | --- |\n| 1 | Everything | yes |';
const sectionedEpicBody = (base) =>
  upsertEpicSection(base, 'techSpec', TECH_SPEC_SECTION);

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
          body: sectionedEpicBody('Epic body.'),
          labels: ['type::epic'],
        };
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

  it('aborts early when the Epic body carries no Tech Spec sections', async () => {
    // Story #4324 — the decompose gate keys on the folded Tech Spec content
    // in the Epic body (no linked context ticket exists anymore).
    mockProvider.getEpic = async () => ({
      id: 1,
      title: 'Missing Sections Epic',
      body: 'Ideation prose only — no managed planning sections.',
      labels: ['type::epic'],
    });

    await assert.rejects(
      () =>
        runDecomposePhase(1, mockProvider, { tickets: baseTickets() }, {}, {}),
      /carries no Tech Spec sections \(no ## Delivery Slicing\)/,
    );
  });

  it('aborts when the target ticket is not a type::epic', async () => {
    mockProvider.getEpic = async () => ({
      id: 1,
      title: 'Not An Epic',
      body: sectionedEpicBody('Epic body.'),
      labels: ['type::story'],
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
    // Story #4163 — the framework-constant default budget is 80.
    assert.ok(/maxTickets\s*=\s*80/.test(prompt));
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

  it('advertises the hardFiles ceiling and advisory-only acceptance mass from the single sizing constant (Story #3760, relaxed by Story #3874; hard acceptance ceiling removed)', () => {
    // The prompt sources its threshold sentence from DEFAULT_TASK_SIZING so
    // the two surfaces cannot drift. The only remaining hard ceiling is
    // hardFiles=30; acceptance mass is advisory-only (softAcceptanceCount=10).
    const prompt = buildDecomposerSystemPrompt([]);
    assert.ok(
      !/maxAcceptance/.test(prompt),
      'prompt must not reference the removed maxAcceptance ceiling',
    );
    assert.ok(
      /Acceptance mass is \*\*advisory only\*\*/.test(prompt) &&
        /NO hard acceptance ceiling/.test(prompt),
      'prompt must state that acceptance mass is advisory-only with no hard ceiling',
    );
    assert.ok(
      /hardFiles/.test(prompt) && /\b30\b/.test(prompt),
      'prompt must advertise the hardFiles ceiling of 30',
    );
  });

  it('carries the delivery-schedule simulation section (story count must earn itself)', () => {
    const prompt = buildDecomposerSystemPrompt([]);
    assert.ok(
      /DELIVERY-SCHEDULE SIMULATION/.test(prompt),
      'prompt must carry the delivery-schedule simulation section',
    );
    assert.ok(
      /parallelism yield/i.test(prompt),
      'prompt must ask the author to compute the parallelism yield',
    );
    assert.ok(
      /Hot-file rule/.test(prompt),
      'prompt must state the hot-file re-slicing rule',
    );
    assert.ok(
      /risk isolation/.test(prompt) && /envelope pressure/.test(prompt),
      'prompt must enumerate the per-Story slot justifications',
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

  it('instructs the author to emit a reason_to_exist per Story (Story #4164)', () => {
    const prompt = buildDecomposerSystemPrompt([]);
    // The prompt must name the field and frame it as the machine-checkable
    // form of the cohesion rule the consolidate critic verifies.
    assert.ok(
      /reason[_ ]to[_ ]exist|reason to exist/i.test(prompt),
      'prompt must mention the reason to exist field',
    );
    assert.ok(
      /reason_to_exist/.test(prompt),
      'prompt must name the reason_to_exist meta field by its serialized key',
    );
    assert.ok(
      /epic-plan-consolidate/.test(prompt),
      'prompt must tie the reason to exist field to the consolidate critic',
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

  it('carries the soft envelope-floor guidance from the single shared constant — no drift (Story #4313)', () => {
    // The envelope-floor passage is single-sourced in
    // DELIVERABLE_GRANULARITY_GUIDANCE.envelopeFloor and interpolated verbatim,
    // so the exact canonical sentence must appear in the rendered prompt.
    const prompt = buildDecomposerSystemPrompt([]);
    assert.ok(
      prompt.includes(DELIVERABLE_GRANULARITY_GUIDANCE.envelopeFloor),
      'prompt must interpolate the canonical envelope-floor guidance verbatim',
    );
    // The guidance frames under-utilizing the envelope as a merge signal...
    assert.ok(
      /under-utilizing the envelope is a merge signal/i.test(prompt),
      'prompt must frame under-utilizing the delivery envelope as a merge signal',
    );
    // ...and names the per-Story delivery-session cost as the reason.
    assert.ok(
      /hydration, branch, PR, review, CI/i.test(prompt),
      'prompt must name the per-Story delivery-session cost (hydration, branch, PR, review, CI)',
    );
    // Soft guidance only: it is illustrative prose, not a threshold constant.
    assert.ok(
      /illustrative, not a threshold/i.test(prompt),
      'envelope-floor guidance must be phrased as guidance, not a numeric threshold',
    );
  });
});

describe('ticket-decomposer prompt single-sourcing (Story #4162)', () => {
  // The decomposer system-prompt BODY is single-sourced in
  // `decomposer-prompts.js`. The `epic-plan-decompose-author` SKILL references
  // that rendered prompt rather than embedding a second verbatim copy, so the
  // two surfaces cannot drift. This distinctive opening line is the
  // unmistakable marker of the full prompt body — it must appear in exactly one
  // of the two surfaces.
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const SKILL_PATH = path.join(
    __dirname,
    '..',
    '.agents',
    'skills',
    'core',
    'epic-plan-decompose-author',
    'SKILL.md',
  );
  const FULL_BODY_MARKER =
    'You are an expert Senior Project Manager and Orchestrator.\nYour job is to take an Epic (including its inline User Stories) and a Technical Specification and decompose them into a flat list of Story tickets';

  it('the JS template carries the full decomposer system-prompt body', () => {
    const prompt = renderDecomposerSystemPrompt();
    assert.ok(
      prompt.includes(FULL_BODY_MARKER),
      'decomposer-prompts.js must carry the full prompt body (the single source)',
    );
  });

  it('the SKILL references the prompt and does NOT carry a second full body — a guard test fails if both carry it', () => {
    const skill = readFileSync(SKILL_PATH, 'utf8');
    assert.ok(
      !skill.includes(FULL_BODY_MARKER),
      'SKILL.md must NOT embed a second verbatim copy of the full decomposer prompt body — reference the rendered prompt instead (Story #4162)',
    );
    assert.ok(
      /decomposer-prompts\.js/.test(skill),
      'SKILL.md must reference the single-source prompt template (decomposer-prompts.js)',
    );
  });

  it('no prompt surface mixes the soft reviewability-budget framing with a hard "Do NOT generate more than" cap (Story #4162)', () => {
    const prompt = renderDecomposerSystemPrompt();
    const skill = readFileSync(SKILL_PATH, 'utf8');
    for (const [name, text] of [
      ['rendered prompt', prompt],
      ['SKILL.md', skill],
    ]) {
      // Soft framing is present...
      assert.ok(
        /reviewability budget/i.test(text),
        `${name} must keep the soft reviewability-budget framing`,
      );
      // ...and the contradictory hard-cap line is gone.
      assert.ok(
        !/Do NOT generate more than/i.test(text),
        `${name} must not contain the hard "Do NOT generate more than" maxTickets cap (Story #4162)`,
      );
    }
  });

  it('the rendered prompt names the delivery token budget (maxTokenBudget) as a sizing input (Story #4162)', () => {
    const prompt = renderDecomposerSystemPrompt({ maxTokenBudget: 300000 });
    assert.ok(
      /maxTokenBudget/.test(prompt),
      'prompt must mention maxTokenBudget as a sizing input',
    );
    assert.ok(
      /\b300000\b/.test(prompt),
      'prompt must interpolate the configured maxTokenBudget value',
    );
    assert.ok(
      /token budget|delivery .*envelope|one-pass delivery envelope/i.test(
        prompt,
      ),
      'prompt must frame maxTokenBudget as the one-pass delivery envelope',
    );
  });

  it('renders the binding-vs-advisory authoring altitude in the prompt (Story #4272)', () => {
    const prompt = renderDecomposerSystemPrompt();
    // binding acceptance / verify vs advisory changes / references
    assert.ok(
      /binding contract/i.test(prompt),
      'prompt must name acceptance/verify as the binding contract',
    );
    assert.ok(
      /advisory implementation sketch/i.test(prompt),
      'prompt must frame changes/references as an advisory sketch the executor may revise',
    );
    // assert the OUTCOME, never pin an incidental helper/path
    assert.ok(
      /assert the \*\*outcome\*\*|capture the \*\*outcome\*\*/i.test(prompt) ||
        /the \*\*outcome\*\* independent/i.test(prompt),
      'prompt must instruct authoring acceptance to assert the outcome independent of file layout',
    );
    assert.ok(
      /never pin an incidental implementation detail/i.test(prompt),
      'prompt must forbid pinning an incidental helper name / private path into acceptance',
    );
  });

  it('renders the New-File Contract in the prompt (Story #4272)', () => {
    const prompt = renderDecomposerSystemPrompt();
    assert.ok(
      /New-File Contract/i.test(prompt),
      'prompt must state the New-File Contract',
    );
    assert.ok(
      /does NOT already exist on .?main.? MUST also appear in .* `changes\[\]` with `assumption: "creates"`/i.test(
        prompt,
      ),
      'prompt must require a not-on-main referenced path to appear in changes[] with assumption creates',
    );
  });

  it('retains the "advisory does not mean unvalidated" caveat in the prompt (Story #4272)', () => {
    const prompt = renderDecomposerSystemPrompt();
    assert.ok(
      /Advisory does not mean unvalidated/i.test(prompt),
      'prompt must keep the advisory-still-validated caveat',
    );
    assert.ok(
      /base-branch file-assumption probes/i.test(prompt) &&
        /security-baseline\.md/i.test(prompt),
      'caveat must name the base-branch probes and the inviolable security baseline',
    );
  });

  it('single-sources the altitude + New-File wording so the prompt and the SKILL cannot drift (Story #4272)', () => {
    const prompt = renderDecomposerSystemPrompt();
    const skill = readFileSync(SKILL_PATH, 'utf8');
    // The prompt interpolates AUTHORING_ALTITUDE_GUIDANCE verbatim; the SKILL
    // mirrors the same canonical sentences. Asserting each constant string is
    // present on BOTH surfaces is the drift gate — a divergent restatement on
    // either surface fails here.
    for (const canonical of [
      AUTHORING_ALTITUDE_GUIDANCE.altitude,
      AUTHORING_ALTITUDE_GUIDANCE.newFileContract,
      AUTHORING_ALTITUDE_GUIDANCE.advisoryCaveat,
    ]) {
      assert.ok(
        prompt.includes(canonical),
        'rendered prompt must interpolate the shared AUTHORING_ALTITUDE_GUIDANCE wording verbatim',
      );
      assert.ok(
        skill.includes(canonical),
        'SKILL.md must mirror the shared AUTHORING_ALTITUDE_GUIDANCE wording verbatim',
      );
    }
  });

  // Story #4301 — the wave-0 BDD scaffold contract must require the
  // namespaced per-Epic AC tag (`@epic-<id>-ac-N`) on every scaffolded
  // scenario AT SCAFFOLD TIME, not only at de-skip time. Without it,
  // acceptance-spec-reconciler.js (which matches only @epic-<id>-ac-* /
  // @pending tags) reports every AC as missing[] and finalize aborts.
  it('the WAVE-0 BDD scaffold section requires the namespaced @epic-<id>-ac-N tag, not just @skip (Story #4301)', () => {
    const prompt = renderDecomposerSystemPrompt();
    const waveZeroIdx = prompt.indexOf('WAVE-0 BDD SCAFFOLD STORY');
    assert.ok(
      waveZeroIdx >= 0,
      'prompt must carry the WAVE-0 scaffold section',
    );
    const scopeOverlapIdx = prompt.indexOf(
      'SCOPE-OVERLAP FLAGGING',
      waveZeroIdx,
    );
    const waveZeroSection = prompt.slice(
      waveZeroIdx,
      scopeOverlapIdx > 0 ? scopeOverlapIdx : undefined,
    );
    assert.ok(
      /@epic-<id>-ac-N/.test(waveZeroSection) ||
        /@epic-\d+-ac-\d+/.test(waveZeroSection),
      'WAVE-0 section must name the namespaced @epic-<id>-ac-N tag pattern',
    );
    assert.ok(
      /REQUIRED at scaffold time, not only at de-skip time/i.test(
        waveZeroSection,
      ),
      'WAVE-0 section must state the namespaced tag is required at scaffold time, not deferred to de-skip',
    );
    assert.ok(
      /acceptance-spec-reconciler\.js/.test(waveZeroSection),
      'WAVE-0 section must name acceptance-spec-reconciler.js as the consumer of the namespaced tag',
    );
  });

  it('interpolates the literal Epic ID into the @epic-<id>-ac-N example when epicId is supplied (Story #4301)', () => {
    const prompt = renderDecomposerSystemPrompt({ epicId: 4301 });
    assert.ok(
      /@epic-4301-ac-1/.test(prompt),
      'prompt must render the literal @epic-4301-ac-1 example when epicId=4301 is supplied',
    );
  });

  it('buildDecomposerSystemPrompt threads epicId through to the rendered prompt (Story #4301)', () => {
    const prompt = buildDecomposerSystemPrompt([], { epicId: 777 });
    assert.ok(
      /@epic-777-ac-1/.test(prompt),
      'buildDecomposerSystemPrompt must forward epicId into renderDecomposerSystemPrompt',
    );
  });
});

describe('ticket-decomposer buildDecompositionContext', () => {
  it('returns the Epic body (with folded Tech Spec sections) and system prompt', async () => {
    // Story #4324 retired the context-ticket classes: the Epic body is the
    // single planning document (ideation prose + folded Tech Spec sections),
    // surfaced as `ctx.epicBody`. There is no `techSpec` envelope key and no
    // second ticket fetch.
    const epicBody = sectionedEpicBody('EPIC BODY');
    const provider = {
      async getEpic(id) {
        return {
          id,
          title: 'Ctx Epic',
          body: epicBody,
        };
      },
    };

    const ctx = await buildDecompositionContext(1, provider, {
      planning: { riskHeuristics: ['Heuristic A'] },
    });

    assert.equal(ctx.epic.id, 1);
    assert.equal(ctx.epicBody.body, epicBody);
    assert.ok(
      !('techSpec' in ctx),
      'retired `techSpec` context field must be gone',
    );
    assert.deepEqual(ctx.heuristics, ['Heuristic A']);
    assert.ok(ctx.systemPrompt.includes('Heuristic A'));
    // Story #4163 — maxTickets is the framework constant (80), not config-driven.
    assert.equal(ctx.maxTickets, 80);
    assert.ok(
      /maxTickets\s*=\s*80/.test(ctx.systemPrompt) &&
        /reviewability budget/i.test(ctx.systemPrompt),
      'systemPrompt must interpolate the framework-constant maxTickets value and describe it as a reviewability budget',
    );
  });

  it('throws when the Epic body carries no Tech Spec sections', async () => {
    const provider = {
      async getEpic() {
        return { id: 1, body: 'Ideation prose only.' };
      },
    };
    await assert.rejects(
      async () => await buildDecompositionContext(1, provider, {}),
      { message: /carries no Tech Spec sections \(no ## Delivery Slicing\)/ },
    );
  });

  // Story #4301 — plan an Epic with a `new`-disposition AC row: the
  // generated authoring context's systemPrompt must require the namespaced
  // @epic-<id>-ac-N tag (not just @skip) on the wave-0 scaffold scenarios,
  // using the REAL Epic id fetched from the provider.
  it('the system prompt requires the literal @epic-<epicId>-ac-N tag for the Epic under decomposition (Story #4301)', async () => {
    // Story #4324 — the AC-ID table lives in the Epic body's managed
    // `## Acceptance Table` section, not on a linked Acceptance Spec ticket.
    const provider = {
      async getEpic(id) {
        return {
          id,
          title: 'Epic with new-disposition AC rows',
          body: upsertEpicSection(
            sectionedEpicBody('EPIC BODY'),
            'acceptanceTable',
            '## Acceptance Table\n| AC ID | Outcome | Feature File | Scenario | Disposition |\n| --- | --- | --- | --- | --- |\n| AC-1 | Invoice created | tests/features/billing/invoice.feature | Create invoice | new |',
          ),
        };
      },
    };

    const ctx = await buildDecompositionContext(4301, provider, {});

    assert.equal(ctx.epic.id, 4301);
    assert.ok(
      /@epic-4301-ac-1/.test(ctx.systemPrompt),
      'systemPrompt must require the literal @epic-4301-ac-1 tag for this Epic, not a generic placeholder',
    );
  });

  describe('planning-context budget (Epic #817 Story 9)', () => {
    // Story #4324 — the single budgeted authoring input is the Epic body
    // (surfaced as `ctx.epicBody`), which carries the folded Tech Spec
    // sections. The retired linked Tech Spec fetch is gone.
    const bigBody = (tail) => `## Heading\n\n${'x'.repeat(40000)}\n\n${tail}`;
    const buildProvider = () => ({
      async getEpic(id) {
        return {
          id,
          title: 'Big Epic',
          body: sectionedEpicBody(bigBody('## Epic-only\n\nbody')),
        };
      },
    });

    it('downgrades to summary mode when the Epic body exceeds maxBytes', async () => {
      const ctx = await buildDecompositionContext(1, buildProvider(), {
        planning: {
          context: { maxBytes: 4096, summaryMode: 'auto' },
        },
      });
      assert.equal(ctx.contextMode, 'summary');
      assert.equal(ctx.epicBody.body, null);
      assert.ok(ctx.epicBody.bodySummary);
      assert.ok(ctx.epicBody.bodySummary.headings.includes('Heading'));
      // The folded Tech Spec headings surface through the same summary.
      assert.ok(ctx.epicBody.bodySummary.headings.includes('Delivery Slicing'));
    });

    it('keeps full bodies when --full-context opt is set', async () => {
      const ctx = await buildDecompositionContext(
        1,
        buildProvider(),
        {
          planning: {
            context: { maxBytes: 4096, summaryMode: 'auto' },
          },
        },
        { fullContext: true },
      );
      assert.equal(ctx.contextMode, 'full');
      assert.ok(ctx.epicBody.body.includes('## Heading'));
      assert.ok(ctx.epicBody.body.includes('## Delivery Slicing'));
    });

    it('summaryMode=always forces summary even for small bodies', async () => {
      const provider = {
        async getEpic(id) {
          return {
            id,
            title: 'Small Epic',
            body: sectionedEpicBody('## Tiny\n\nshort body'),
          };
        },
      };
      const ctx = await buildDecompositionContext(1, provider, {
        planning: {
          context: { maxBytes: 1000000, summaryMode: 'always' },
        },
      });
      assert.equal(ctx.contextMode, 'summary');
      assert.deepEqual(ctx.epicBody.bodySummary.headings, [
        'Tiny',
        'Delivery Slicing',
      ]);
    });

    it('creation order is driven by the ticket array, not the planning-context mode', () => {
      // Decomposition itself doesn't read the Epic-body/Tech-Spec bodies — it only
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

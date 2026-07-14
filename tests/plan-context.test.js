/**
 * tests/plan-context.test.js — unit tests for the folded planner-context
 * envelope (Epic #4474, M3 PR2 — `/plan` collapse step 1).
 *
 * Covers the design's named PR2 test surface:
 *  - stdout purity: everything the emit path writes to stdout is exactly
 *    one `JSON.parse`-able payload (Logger output routed to stderr).
 *  - envelope schema snapshot: the sorted key set per mode.
 *  - mode-specific field presence: `duplicates`/`onePager` only in
 *    one-pager mode; seed carries `seed`/`onePagerSpec`.
 *  - dup-search fold parity: envelope `duplicates[]` deep-equals a direct
 *    `findSimilarOpenEpics` call over the same provider + one-pager.
 *  - envelope byte ceiling: serialized envelopes stay under
 *    `PLAN_CONTEXT_ENVELOPE_BYTE_CEILING`, including with a body at the
 *    planning-context budget cap.
 *  - systemPrompts fold: spec/acceptance render verbatim from
 *    `lib/templates/spec-author-prompts.js`; story includes the v2
 *    default-single policy; decompose matches the existing
 *    `buildDecomposerSystemPrompt` carrier.
 *  - legacy advisory helpers: deliveryShape/scopeTriage helpers remain
 *    exported for now, but are not embedded in any v2 Stage 3 envelope.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findSimilarOpenEpics } from '../.agents/scripts/lib/duplicate-search.js';
import {
  buildDeliveryShapeSignal,
  buildPlanContext,
  buildScopeTriageSignal,
  buildSystemPrompts,
  ONE_PAGER_AUTHORING_SPEC,
  PLAN_CONTEXT_ENVELOPE_BYTE_CEILING,
  TICKET_SCHEMA_DESCRIPTOR,
} from '../.agents/scripts/lib/orchestration/plan-context.js';
import { buildDecomposerSystemPrompt } from '../.agents/scripts/lib/orchestration/planning/decomposer-context.js';
import {
  renderAcceptanceSpecSystemPrompt,
  renderTechSpecSystemPrompt,
} from '../.agents/scripts/lib/templates/spec-author-prompts.js';
import { emitPlanContext } from '../.agents/scripts/plan-context.js';

const CLEAR_EPIC_BODY = `# Widget Epic

## Context

Users drop off during onboarding.

## Goal

Raise activation.

## Non-Goals

- Redesigning billing.

## Scope

- improve widget onboarding flow
- activation email
- progress meter

## Acceptance Criteria

- [ ] Activation rate is measured.
- [ ] Onboarding completes in one session.
`;

const ONE_PAGER = `# Widget onboarding

## Context

Users drop off during onboarding.

## Scope

- improve widget onboarding flow
- activation email
`;

const OPEN_EPICS = [
  {
    id: 9,
    title: 'Improve widget onboarding flow',
    body: '## Scope\n- widget onboarding improvements for user activation',
  },
  {
    id: 11,
    title: 'Unrelated database migration tooling',
    body: '## Scope\n- migrate schema pipeline',
  },
];

/** Minimal provider double covering every read the envelope build makes. */
function buildProvider({ body = CLEAR_EPIC_BODY, openStories = [] } = {}) {
  return {
    async getEpic(id) {
      return { id, title: 'Widget Epic', body };
    },
    async getTickets(_epicId, _filters) {
      return openStories;
    },
    async getEpics(_filters) {
      return OPEN_EPICS;
    },
    async getTicketComments(_id) {
      return [];
    },
  };
}

const SEED_MODE_KEYS = [
  'bddRunner',
  'bddScenarios',
  'codebaseSnapshot',
  'docsContext',
  'duplicates',
  'maxTickets',
  'maxTokenBudget',
  'memoryFreshness',
  'mode',
  'onePagerSpec',
  'planState',
  'preflightCeilings',
  'priorFeedback',
  'riskHeuristics',
  'seed',
  'systemPrompts',
  'ticketSchema',
];

const ONE_PAGER_MODE_KEYS = [
  'bddRunner',
  'bddScenarios',
  'codebaseSnapshot',
  'docsContext',
  'duplicates',
  'maxTickets',
  'maxTokenBudget',
  'memoryFreshness',
  'mode',
  'onePager',
  'planState',
  'preflightCeilings',
  'priorFeedback',
  'riskHeuristics',
  'systemPrompts',
  'ticketSchema',
];

describe('plan-context envelope schema (design §1 step 1)', () => {
  it('one-pager mode emits exactly the one-pager-mode key set', async () => {
    const env = await buildPlanContext({
      mode: 'one-pager',
      onePagerContent: ONE_PAGER,
      onePagerPath: 'temp/one-pager.md',
      provider: buildProvider(),
      config: { github: { owner: 'o', repo: 'r' } },
      settings: {},
    });
    assert.deepEqual(Object.keys(env).sort(), ONE_PAGER_MODE_KEYS);
    assert.equal(env.mode, 'one-pager');
    assert.equal(env.onePager.content, ONE_PAGER);
    assert.equal(env.planState, null);
  });

  it('seed mode emits the one-pager key set plus the additive seed fields (#4496)', async () => {
    const env = await buildPlanContext({
      mode: 'seed',
      seedText: ONE_PAGER,
      provider: buildProvider(),
      config: { github: { owner: 'o', repo: 'r' } },
      settings: {},
    });
    assert.deepEqual(Object.keys(env).sort(), SEED_MODE_KEYS);
    assert.equal(env.mode, 'seed');
    assert.equal(env.seed.text, ONE_PAGER);
    assert.ok(
      !('onePager' in env),
      'the one-pager does not exist yet in seed mode',
    );
    assert.equal(env.planState, null);
    assert.deepEqual(env.onePagerSpec, ONE_PAGER_AUTHORING_SPEC);
    assert.deepEqual(env.onePagerSpec.sections, [
      'Problem Statement',
      'Recommended Direction',
      'Key Assumptions',
      'MVP Scope',
      'Not Doing',
    ]);
  });

  it('rejects an unknown mode and an empty seed', async () => {
    await assert.rejects(
      () => buildPlanContext({ mode: 'bogus', provider: buildProvider() }),
      /unknown mode/,
    );
    await assert.rejects(
      () =>
        buildPlanContext({
          mode: 'seed',
          seedText: '   ',
          provider: buildProvider(),
        }),
      /non-empty seed text/,
    );
  });
});

describe('plan-context mode-specific field presence', () => {
  it('one-pager mode carries duplicates/onePager and omits seed fields', async () => {
    const opEnv = await buildPlanContext({
      mode: 'one-pager',
      onePagerContent: ONE_PAGER,
      provider: buildProvider(),
      config: {},
      settings: {},
    });
    assert.ok(Array.isArray(opEnv.duplicates));
    assert.equal(opEnv.onePager.content, ONE_PAGER);
    assert.ok(!('seed' in opEnv), 'seed must not leak into one-pager mode');
    assert.ok(
      !('onePagerSpec' in opEnv),
      'onePagerSpec must not leak into one-pager mode',
    );
    assert.ok(
      !('clarity' in opEnv),
      'retired epic-mode clarity must not leak into one-pager mode',
    );
    assert.ok(
      !('replan' in opEnv),
      'retired epic-mode replan must not leak into one-pager mode',
    );
  });
});

describe('plan-context dup-search fold parity vs library', () => {
  it('envelope duplicates[] deep-equals a direct findSimilarOpenEpics call', async () => {
    const provider = buildProvider();
    const config = { github: { owner: 'o', repo: 'r' } };
    const env = await buildPlanContext({
      mode: 'one-pager',
      onePagerContent: ONE_PAGER,
      provider,
      config,
      settings: {},
    });
    const direct = await findSimilarOpenEpics({
      onePager: ONE_PAGER,
      provider,
      owner: 'o',
      repo: 'r',
    });
    assert.ok(direct.length > 0, 'fixture must produce at least one candidate');
    assert.deepEqual(env.duplicates, direct);
  });

  it('seed mode runs the dup search off the raw seed text (#4496 fix 1)', async () => {
    const provider = buildProvider();
    const config = { github: { owner: 'o', repo: 'r' } };
    const env = await buildPlanContext({
      mode: 'seed',
      seedText: ONE_PAGER,
      provider,
      config,
      settings: {},
    });
    const direct = await findSimilarOpenEpics({
      onePager: ONE_PAGER,
      provider,
      owner: 'o',
      repo: 'r',
    });
    assert.ok(direct.length > 0, 'fixture must produce at least one candidate');
    assert.deepEqual(env.duplicates, direct);
  });

  it('degrades to an empty duplicates[] when the provider listing fails', async () => {
    const provider = buildProvider();
    provider.getEpics = async () => {
      throw new Error('rate limited');
    };
    const env = await buildPlanContext({
      mode: 'one-pager',
      onePagerContent: ONE_PAGER,
      provider,
      config: {},
      settings: {},
    });
    assert.deepEqual(env.duplicates, []);
  });
});

describe('plan-context systemPrompts fold', () => {
  it('renders spec/acceptance/story/decompose from the shared prompt carriers', async () => {
    const env = await buildPlanContext({
      mode: 'one-pager',
      onePagerContent: ONE_PAGER,
      provider: buildProvider(),
      config: { planning: { riskHeuristics: ['touches auth'] } },
      settings: {},
    });
    assert.equal(env.systemPrompts.spec, renderTechSpecSystemPrompt());
    assert.equal(
      env.systemPrompts.acceptance,
      renderAcceptanceSpecSystemPrompt(),
    );
    assert.equal(
      env.systemPrompts.decompose,
      buildDecomposerSystemPrompt(['touches auth'], {
        maxTickets: env.maxTickets,
        maxTokenBudget: env.maxTokenBudget,
        epicId: null,
      }),
    );
    assert.deepEqual(env.riskHeuristics, ['touches auth']);
    assert.match(env.systemPrompts.spec, /Engineering Architect/);
    assert.match(env.systemPrompts.acceptance, /Acceptance Engineer/);
    assert.match(env.systemPrompts.story, /v2 DEFAULT-SINGLE SPLIT POLICY/);
    assert.match(
      env.systemPrompts.story,
      /Do \*\*not\*\* emit `deliveryShape`/,
    );
    // The envelope's systemPrompts are exactly what the exported helper
    // renders for the same inputs, and the ticketSchema is the shared
    // frozen descriptor.
    assert.deepEqual(
      env.systemPrompts,
      buildSystemPrompts({
        heuristics: ['touches auth'],
        maxTickets: env.maxTickets,
        maxTokenBudget: env.maxTokenBudget,
        epicId: null,
      }),
    );
    assert.equal(env.ticketSchema, TICKET_SCHEMA_DESCRIPTOR);
    assert.equal(env.ticketSchema.itemFields.type.includes('story'), true);
  });
});

describe('plan-context deliveryShapeSignal (advisory, #4475 heuristics)', () => {
  it('recommends single for a delivery-slicing table of ≤ 2 slices', () => {
    const body = `## Delivery Slicing\n\n| Slice | What ships | Independent? |\n|---|---|---|\n| All of it | everything | Yes |\n`;
    const signal = buildDeliveryShapeSignal({ body });
    assert.equal(signal.recommendation, 'single');
    assert.equal(signal.advisory, true);
    assert.match(signal.reasons[0], /one-pass-sized/);
  });

  it('recommends single for a pure dependent chain (zero fan-out parallelism)', () => {
    const body = `## Delivery Slicing\n\n| Slice | What ships | Independent? |\n|---|---|---|\n| A | a | Yes |\n| B | b | No — needs A |\n| C | c | No — needs B |\n| D | d | No — needs C |\n`;
    const signal = buildDeliveryShapeSignal({ body });
    assert.equal(signal.recommendation, 'single');
    assert.match(signal.reasons[0], /pure dependent chain/);
  });

  it('recommends fan-out for a slicing table with independent parallelism', () => {
    const body = `## Delivery Slicing\n\n| Slice | What ships | Independent? |\n|---|---|---|\n| A | a | Yes |\n| B | b | Yes |\n| C | c | Yes |\n`;
    const signal = buildDeliveryShapeSignal({ body });
    assert.equal(signal.recommendation, 'fan-out');
  });

  it('defaults to fan-out when there is no sizing signal at all', () => {
    const signal = buildDeliveryShapeSignal({ body: 'freeform prose only' });
    assert.equal(signal.recommendation, 'fan-out');
    assert.match(signal.reasons[0], /defaulting to fan-out/);
  });

  it('uses the scope enumeration when no slicing table exists', () => {
    const single = buildDeliveryShapeSignal({
      body: '## Scope\n- one thing\n- another\n',
    });
    assert.equal(single.recommendation, 'single');
    const fanOut = buildDeliveryShapeSignal({
      body: '## Scope\n- a\n- b\n- c\n- d\n',
    });
    assert.equal(fanOut.recommendation, 'fan-out');
  });
});

describe('plan-context stdout purity (Story #2278 discipline)', () => {
  it('the emit path writes exactly one JSON.parse-able payload to stdout', async () => {
    // Capture everything that would land on the process stdout fd —
    // both the injected envelope stream and any stray console.log from
    // the folded builders (Logger routes to console.error once
    // routeAllOutputToStderr() has run; the CLI calls it before building).
    const { routeAllOutputToStderr } = await import(
      '../.agents/scripts/lib/Logger.js'
    );
    routeAllOutputToStderr();

    let captured = '';
    const capture = {
      write(chunk) {
        captured += chunk;
        return true;
      },
    };
    const originalLog = console.log;
    const strayStdout = [];
    console.log = (...args) => strayStdout.push(args.join(' '));
    let envelope;
    try {
      envelope = await emitPlanContext({
        mode: 'one-pager',
        onePagerContent: ONE_PAGER,
        provider: buildProvider(),
        config: {},
        settings: {},
        stdout: capture,
      });
    } finally {
      console.log = originalLog;
    }

    assert.deepEqual(
      strayStdout,
      [],
      `no builder may write to stdout during the envelope build: ${strayStdout.join('\n')}`,
    );
    const lines = captured.split('\n').filter((l) => l.length > 0);
    assert.equal(lines.length, 1, 'exactly one stdout line');
    const parsed = JSON.parse(lines[0]);
    assert.deepEqual(parsed, JSON.parse(JSON.stringify(envelope)));
    assert.equal(parsed.mode, 'one-pager');
  });
});

describe('plan-context envelope byte ceiling (PR2 named risk)', () => {
  it('one-pager and seed envelopes stay under the ceiling', async () => {
    const opEnv = await buildPlanContext({
      mode: 'one-pager',
      onePagerContent: ONE_PAGER,
      provider: buildProvider(),
      config: {},
      settings: {},
    });
    const seedEnv = await buildPlanContext({
      mode: 'seed',
      seedText: ONE_PAGER,
      provider: buildProvider(),
      config: {},
      settings: {},
    });
    for (const [name, env] of [
      ['one-pager', opEnv],
      ['seed', seedEnv],
    ]) {
      const bytes = Buffer.byteLength(JSON.stringify(env), 'utf-8');
      assert.ok(
        bytes < PLAN_CONTEXT_ENVELOPE_BYTE_CEILING,
        `${name} envelope is ${bytes} bytes — ceiling is ${PLAN_CONTEXT_ENVELOPE_BYTE_CEILING}`,
      );
    }
  });

  it('holds even when the one-pager sits at the planning-context budget cap', async () => {
    // A body larger than planningContext.maxBytes (50 KB default) downgrades
    // to the applyBudget summary representation — the ceiling must hold for
    // the worst legal case, not just tiny fixtures.
    const hugeBody = `${CLEAR_EPIC_BODY}\n## Appendix\n\n${'lorem ipsum dolor sit amet consectetur. '.repeat(4000)}`;
    const env = await buildPlanContext({
      mode: 'one-pager',
      onePagerContent: hugeBody,
      provider: buildProvider(),
      config: {},
      settings: {},
    });
    const bytes = Buffer.byteLength(JSON.stringify(env), 'utf-8');
    assert.ok(
      bytes < PLAN_CONTEXT_ENVELOPE_BYTE_CEILING,
      `budget-capped envelope is ${bytes} bytes — ceiling is ${PLAN_CONTEXT_ENVELOPE_BYTE_CEILING}`,
    );
    // One-pager mode keeps the raw content on the envelope; the budget
    // engages on the authoring-context fold (snapshot / docs), not by
    // nulling `onePager.content`.
    assert.equal(env.onePager.content, hugeBody);
  });
});

describe('plan-context scopeTriage helper (exported only, #4496 fix 6)', () => {
  it('is not embedded in the seed envelope after the v2 Stage 3 planning cutover', async () => {
    const env = await buildPlanContext({
      mode: 'seed',
      seedText: ONE_PAGER,
      provider: buildProvider(),
      config: {},
      settings: {},
    });
    assert.ok(
      !('scopeTriage' in env),
      'scopeTriage must not be embedded in seed-mode envelopes',
    );
  });

  it('verdicts epic when the seed enumerates 3+ candidate capabilities', () => {
    const signal = buildScopeTriageSignal({
      seedText:
        'Build the reporting surface:\n- export engine\n- scheduling\n- share links\n- audit log\n',
    });
    assert.equal(signal.verdict, 'epic');
    assert.match(signal.reasons[0], /enumerates 4 candidate capabilities/);
  });

  it('verdicts story for a short enumeration and for a delta-shaped seed', () => {
    const enumerated = buildScopeTriageSignal({
      seedText: 'Improve onboarding:\n- add a progress meter\n',
    });
    assert.equal(enumerated.verdict, 'story');

    const delta = buildScopeTriageSignal({
      seedText:
        'Fix the flaky retry in the evidence gate so CI stops re-running.',
    });
    assert.equal(delta.verdict, 'story');
    assert.match(delta.reasons[0], /delta-shaped seed/);
  });

  it('verdicts borderline when there is no enumeration and no delta signal', () => {
    const signal = buildScopeTriageSignal({
      seedText:
        'A better way to think about how planning context reaches the model.',
    });
    assert.equal(signal.verdict, 'borderline');
  });

  it('verdicts epic for a broad prose seed with no enumeration', () => {
    const signal = buildScopeTriageSignal({
      seedText: `${'word '.repeat(260)}`,
    });
    assert.equal(signal.verdict, 'epic');
    assert.match(signal.reasons[0], /broad prose seed/);
  });
});

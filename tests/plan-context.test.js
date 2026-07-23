/**
 * tests/plan-context.test.js — unit tests for the folded planner-context
 * envelope (Epic #4474, M3 PR2 — `/plan` collapse step 1).
 *
 * Covers the design's named PR2 test surface:
 *  - stdout purity: everything the emit path writes to stdout is exactly
 *    one `JSON.parse`-able payload (Logger output routed to stderr).
 *  - envelope schema snapshot: the sorted key set per mode.
 *  - mode-specific field presence: `duplicates`/`seed` in seed-file mode
 *    (`seed.content`); seed mode carries `seed.text`.
 *  - dup-search fold parity: envelope `duplicates[]` deep-equals a direct
 *    `findSimilarOpenStories` call over the same provider + seed.
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
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { findSimilarOpenStories } from '../.agents/scripts/lib/duplicate-search.js';
import {
  buildDeliveryShapeSignal,
  buildPlanContext,
  buildScopeTriageSignal,
  buildSystemPrompts,
  PLAN_CONTEXT_ENVELOPE_BYTE_CEILING,
  TICKET_SCHEMA_DESCRIPTOR,
} from '../.agents/scripts/lib/orchestration/plan-context.js';
import {
  loadPlanContextEnvelope,
  PLAN_CONTEXT_FILENAME,
  resolvePlanContextPath,
} from '../.agents/scripts/lib/orchestration/plan-persist/plan-context-source.js';
import { resolveSourceTicketIds } from '../.agents/scripts/lib/orchestration/plan-persist/supersede-ops.js';
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

const OPEN_STORIES = [
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
function buildProvider({
  body = CLEAR_EPIC_BODY,
  openStories = OPEN_STORIES,
} = {}) {
  return {
    async getEpic(id) {
      return { id, title: 'Widget Epic', body };
    },
    async getTicket(id) {
      return { id, number: id, title: 'Source ticket', body, labels: [] };
    },
    async getTickets(_epicId, _filters) {
      return openStories;
    },
    async listIssuesByLabel(_filters) {
      return openStories.map((s) => ({
        number: s.id,
        title: s.title,
        body: s.body,
      }));
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
  'complexitySignals',
  'docsContext',
  'duplicates',
  'maxTickets',
  'memoryFreshness',
  'mode',
  'planProfile',
  'planState',
  'priorFeedback',
  'riskHeuristics',
  'seed',
  'systemPrompts',
  'ticketSchema',
];

const SEED_FILE_MODE_KEYS = [
  'bddRunner',
  'bddScenarios',
  'codebaseSnapshot',
  'complexitySignals',
  'docsContext',
  'duplicates',
  'maxTickets',
  'memoryFreshness',
  'mode',
  'planProfile',
  'planState',
  'priorFeedback',
  'riskHeuristics',
  'seed',
  'systemPrompts',
  'ticketSchema',
];

describe('plan-context envelope schema (design §1 step 1)', () => {
  it('seed-file mode emits exactly the seed-file-mode key set', async () => {
    const env = await buildPlanContext({
      mode: 'seed-file',
      seedFileContent: ONE_PAGER,
      seedFilePath: 'temp/seed-file.md',
      provider: buildProvider(),
      config: { github: { owner: 'o', repo: 'r' } },
      settings: {},
    });
    assert.deepEqual(Object.keys(env).sort(), SEED_FILE_MODE_KEYS);
    assert.equal(env.mode, 'seed-file');
    assert.equal(env.seed.content, ONE_PAGER);
    assert.equal(env.planState, null);
  });

  it('seed mode emits the seed-mode key set (#4496)', async () => {
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
      'the legacy onePager field must not appear in seed mode',
    );
    assert.ok(
      !('onePagerSpec' in env),
      'the retired onePagerSpec descriptor must not appear in seed mode',
    );
    assert.equal(env.planState, null);
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
  it('seed-file mode carries duplicates/seed.content and omits onePagerSpec', async () => {
    const opEnv = await buildPlanContext({
      mode: 'seed-file',
      seedFileContent: ONE_PAGER,
      provider: buildProvider(),
      config: {},
      settings: {},
    });
    assert.ok(Array.isArray(opEnv.duplicates));
    assert.equal(opEnv.seed.content, ONE_PAGER);
    assert.ok(
      !('text' in opEnv.seed),
      'seed.text must not leak into seed-file mode',
    );
    assert.ok(
      !('onePagerSpec' in opEnv),
      'onePagerSpec must not leak into seed-file mode',
    );
    assert.ok(
      !('clarity' in opEnv),
      'retired epic-mode clarity must not leak into seed-file mode',
    );
    assert.ok(
      !('replan' in opEnv),
      'retired epic-mode replan must not leak into seed-file mode',
    );
  });
});

describe('plan-context dup-search fold parity vs library', () => {
  it('envelope duplicates[] deep-equals a direct findSimilarOpenStories call', async () => {
    const provider = buildProvider();
    const config = { github: { owner: 'o', repo: 'r' } };
    const env = await buildPlanContext({
      mode: 'seed-file',
      seedFileContent: ONE_PAGER,
      provider,
      config,
      settings: {},
    });
    const direct = await findSimilarOpenStories({
      seed: ONE_PAGER,
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
    const direct = await findSimilarOpenStories({
      seed: ONE_PAGER,
      provider,
      owner: 'o',
      repo: 'r',
    });
    assert.ok(direct.length > 0, 'fixture must produce at least one candidate');
    assert.deepEqual(env.duplicates, direct);
  });

  it('degrades to an empty duplicates[] when the provider listing fails', async () => {
    const provider = buildProvider();
    provider.listIssuesByLabel = async () => {
      throw new Error('rate limited');
    };
    const env = await buildPlanContext({
      mode: 'seed-file',
      seedFileContent: ONE_PAGER,
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
      mode: 'seed-file',
      seedFileContent: ONE_PAGER,
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
        mode: 'seed-file',
        seedFileContent: ONE_PAGER,
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
    assert.equal(parsed.mode, 'seed-file');
  });
});

describe('plan-context envelope byte ceiling — runtime enforcement', () => {
  // The ceiling used to be asserted only by the fixture tests below, which
  // bound nothing at runtime: the sizes that matter come from a consumer's
  // seed or --tickets source bodies, and no fixture sees those. The
  // documented cap (`planning.context.maxBytes`) resolved but was wired to
  // nothing and has since been removed (Story #4541), so this is the only
  // real bound on the path that needs one.
  /** A seed large enough to carry the envelope past the real ceiling. */
  const OVER_CEILING_SEED = 'lorem ipsum dolor sit amet consectetur. '.repeat(
    9000,
  );

  it('refuses an envelope over the ceiling rather than emitting it', async () => {
    // The risk the ceiling exists for: a seed (or --tickets source bodies)
    // large enough to blow the planner's context. This used to return a
    // happily unbounded envelope, because the only thing checking the ceiling
    // was a fixture test that never sees a consumer's input.
    await assert.rejects(
      () =>
        buildPlanContext({
          mode: 'seed',
          seedText: OVER_CEILING_SEED,
          provider: buildProvider(),
          config: {},
          settings: {},
        }),
      (err) => {
        assert.match(err.message, /planner-context ceiling/);
        assert.match(err.message, /"seed" envelope/);
        // The operator has to know what to trim, so the largest contributing
        // fields are named rather than just the total.
        assert.match(err.message, /Largest fields:/);
        assert.match(err.message, /seed \(\d+ KB\)/);
        assert.match(err.message, /Trim the seed/);
        return true;
      },
    );
  });

  it('refuses over-ceiling seed-file and tickets envelopes too', async () => {
    // Every mode returns through the one choke point, so none of them can
    // emit an unbounded envelope.
    await assert.rejects(
      () =>
        buildPlanContext({
          mode: 'seed-file',
          seedFileContent: OVER_CEILING_SEED,
          provider: buildProvider(),
          config: {},
          settings: {},
        }),
      /planner-context ceiling/,
    );
    await assert.rejects(
      () =>
        buildPlanContext({
          mode: 'tickets',
          ticketIds: [1],
          provider: buildProvider({ body: OVER_CEILING_SEED }),
          config: {},
          settings: {},
        }),
      /planner-context ceiling/,
    );
  });
});

describe('plan-context envelope byte ceiling (PR2 named risk)', () => {
  it('seed-file and seed envelopes stay under the ceiling', async () => {
    const seedFileEnv = await buildPlanContext({
      mode: 'seed-file',
      seedFileContent: ONE_PAGER,
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
      ['seed-file', seedFileEnv],
      ['seed', seedEnv],
    ]) {
      const bytes = Buffer.byteLength(JSON.stringify(env), 'utf-8');
      assert.ok(
        bytes < PLAN_CONTEXT_ENVELOPE_BYTE_CEILING,
        `${name} envelope is ${bytes} bytes — ceiling is ${PLAN_CONTEXT_ENVELOPE_BYTE_CEILING}`,
      );
    }
  });

  it('holds even for a seed far larger than the retired planning-context cap', async () => {
    // Story #4541: this used to claim an over-cap body "downgrades to the
    // applyBudget summary representation". It never did — both envelope
    // builders discard the budgeted body and ship the raw seed, which is
    // exactly what the final assertion below has always proved. The budget
    // pass and its --full-context flag are gone; the envelope byte ceiling
    // is the only live bound, and it must hold for a large seed.
    const hugeBody = `${CLEAR_EPIC_BODY}\n## Appendix\n\n${'lorem ipsum dolor sit amet consectetur. '.repeat(4000)}`;
    const env = await buildPlanContext({
      mode: 'seed-file',
      seedFileContent: hugeBody,
      provider: buildProvider(),
      config: {},
      settings: {},
    });
    const bytes = Buffer.byteLength(JSON.stringify(env), 'utf-8');
    assert.ok(
      bytes < PLAN_CONTEXT_ENVELOPE_BYTE_CEILING,
      `budget-capped envelope is ${bytes} bytes — ceiling is ${PLAN_CONTEXT_ENVELOPE_BYTE_CEILING}`,
    );
    // Seed-file mode carries the raw content verbatim — deliberate, and the
    // reason the budget pass was dead rather than merely redundant.
    assert.equal(env.seed.content, hugeBody);
  });

  it('carries no dead budget artifacts on the envelope (Story #4541)', async () => {
    const env = await buildPlanContext({
      mode: 'seed',
      seedText: ONE_PAGER,
      provider: buildProvider(),
      config: {},
      settings: {},
    });
    // `bodySummary` was the budget pass's downgrade output. Nothing read it,
    // and no builder ever put it on an envelope.
    assert.ok(!('bodySummary' in env));
    assert.ok(!('epic' in env));
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

describe('plan-context tickets mode — concurrent source-ticket fetch', () => {
  function deferred() {
    let resolve;
    const promise = new Promise((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  it('hydrates multiple ticket ids concurrently and preserves order', async () => {
    const ids = [101, 102, 103, 104];
    let inFlight = 0;
    let peak = 0;
    const release = deferred();
    const allStarted = deferred();

    const provider = buildProvider();
    provider.getTicket = async (id) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      if (peak >= ids.length) allStarted.resolve();
      await release.promise;
      inFlight--;
      return {
        id,
        number: id,
        title: `Ticket ${id}`,
        body: `Body for ${id}`,
        labels: ['type::story'],
        html_url: `https://github.com/o/r/issues/${id}`,
        state: 'open',
      };
    };

    const pending = buildPlanContext({
      mode: 'tickets',
      ticketIds: ids,
      provider,
      config: { github: { owner: 'o', repo: 'r' } },
      settings: {},
    });

    await Promise.race([
      allStarted.promise,
      new Promise((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `timed out waiting for concurrent getTicket (peak=${peak})`,
              ),
            ),
          2000,
        ),
      ),
    ]);
    assert.equal(peak, ids.length, 'expected all ids to fetch concurrently');
    release.resolve();

    const env = await pending;
    assert.equal(env.mode, 'tickets');
    assert.deepEqual(
      env.sourceTickets.map((t) => t.id),
      ids,
    );
    assert.deepEqual(
      env.sourceTickets.map((t) => t.title),
      ids.map((id) => `Ticket ${id}`),
    );
    for (const t of env.sourceTickets) {
      assert.deepEqual(t.labels, ['type::story']);
      assert.equal(t.url, `https://github.com/o/r/issues/${t.id}`);
      assert.equal(t.state, 'open');
    }
  });

  it('throws ticket #N not found when getTicket returns null', async () => {
    const provider = buildProvider();
    provider.getTicket = async (id) =>
      id === 202 ? null : { id, title: `T${id}`, body: '', labels: [] };

    await assert.rejects(
      () =>
        buildPlanContext({
          mode: 'tickets',
          ticketIds: [201, 202, 203],
          provider,
          config: {},
          settings: {},
        }),
      /ticket #202 not found/,
    );
  });
});

describe('plan-context --out envelope capture (Story #4554)', () => {
  const sink = { write: () => true };

  // The producer half of the flagless `--tickets` supersede path: persist can
  // only derive source ids from an envelope that actually reached disk.
  it('writes an envelope persist can read the source ids back out of', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'plan-ctx-out-'));
    const outPath = path.join(dir, PLAN_CONTEXT_FILENAME);

    const envelope = await emitPlanContext({
      mode: 'tickets',
      ticketIds: [4525, 4526],
      provider: buildProvider(),
      config: {},
      settings: {},
      outPath,
      stdout: sink,
    });
    assert.deepEqual(
      envelope.sourceTickets.map((t) => t.id),
      [4525, 4526],
    );

    // Round-trip through the exact reader plan-persist.js uses.
    const loaded = await loadPlanContextEnvelope(
      resolvePlanContextPath(null, dir),
    );
    assert.deepEqual(resolveSourceTicketIds({ envelope: loaded }), {
      ids: [4525, 4526],
      origin: 'envelope',
    });
    await rm(dir, { recursive: true, force: true });
  });

  it('creates missing parent directories for --out', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'plan-ctx-mkdir-'));
    const outPath = path.join(dir, 'nested', 'deeper', PLAN_CONTEXT_FILENAME);

    await emitPlanContext({
      mode: 'seed-file',
      seedFileContent: ONE_PAGER,
      provider: buildProvider(),
      config: {},
      settings: {},
      outPath,
      stdout: sink,
    });

    const written = JSON.parse(await readFile(outPath, 'utf8'));
    assert.equal(written.mode, 'seed-file');
    await rm(dir, { recursive: true, force: true });
  });

  // Story #4707 AC-5: one-shot authoring — a captured envelope is always
  // accompanied by the ready-to-fill stories template, so the authoring
  // middle starts from a fillable skeleton instead of discovering the
  // serializer contract by reading story-body.js source.
  it('emits the ready-to-fill stories template next to the envelope', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'plan-ctx-template-'));
    const outPath = path.join(dir, PLAN_CONTEXT_FILENAME);

    await emitPlanContext({
      mode: 'seed-file',
      seedFileContent: ONE_PAGER,
      provider: buildProvider(),
      config: {},
      settings: {},
      outPath,
      stdout: sink,
    });

    const template = JSON.parse(
      await readFile(path.join(dir, 'stories.template.json'), 'utf8'),
    );
    assert.ok(Array.isArray(template) && template.length === 1);
    assert.equal(template[0].type, 'story');
    assert.ok(Array.isArray(template[0].acceptance));
    assert.ok(Array.isArray(template[0].verify));
    await rm(dir, { recursive: true, force: true });
  });

  // Story #4708 AC-5: with --out the envelope is on disk, so stdout carries
  // a compact digest naming the artifact instead of the ~40KB payload.
  it('emits a compact digest on stdout when --out captures the envelope', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'plan-ctx-digest-'));
    const outPath = path.join(dir, PLAN_CONTEXT_FILENAME);
    let captured = '';
    const capture = {
      write(chunk) {
        captured += chunk;
        return true;
      },
    };

    await emitPlanContext({
      mode: 'tickets',
      ticketIds: [4525],
      provider: buildProvider(),
      config: {},
      settings: {},
      outPath,
      stdout: capture,
    });

    const lines = captured.split('\n').filter((l) => l.length > 0);
    assert.equal(lines.length, 1, 'exactly one stdout line');
    const digest = JSON.parse(lines[0]);
    assert.equal(digest.digest, 'plan-context');
    assert.equal(digest.out, path.resolve(outPath));
    assert.deepEqual(digest.sourceTickets, [4525]);
    assert.ok(
      lines[0].length < 2048,
      `digest line is ${lines[0].length} bytes — must stay under the ~2KB output contract`,
    );
    assert.ok(
      digest.bytes > lines[0].length,
      'full envelope is larger than the digest',
    );
    await rm(dir, { recursive: true, force: true });
  });

  it('writes nothing when --out is omitted (stdout-only remains the default)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'plan-ctx-noout-'));
    await emitPlanContext({
      mode: 'seed-file',
      seedFileContent: ONE_PAGER,
      provider: buildProvider(),
      config: {},
      settings: {},
      stdout: sink,
    });
    assert.deepEqual(await readdir(dir), []);
    await rm(dir, { recursive: true, force: true });
  });
});

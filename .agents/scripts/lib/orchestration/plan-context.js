/**
 * plan-context.js — single planner-context envelope build for `/plan`.
 *
 * Folds the authoring-context builders plus the cross-Story dup search into
 * ONE JSON envelope, so the authoring middle reads a single file instead of
 * shim-scripting library imports.
 *
 * Two operator modes (v2 Story-only):
 *   - `seed` / `seed-file` — freeform text (chat or on-disk). Carries
 *     `seed` plus `duplicates[]` (open-Story dup search).
 *   - `tickets` — one or more existing issue ids to analyze into proper
 *     Stories. Carries `sourceTickets[]` plus `duplicates[]` (excluding
 *     the source ids themselves).
 *
 * All fields are JSON-serialisable; the module performs no GitHub writes.
 * The only I/O surfaces are the injected `provider` (reads) and the
 * best-effort local scans the folded builders already perform.
 */

import { readFile } from 'node:fs/promises';
import { getLimits } from '../config-resolver.js';
import { findSimilarOpenStories } from '../duplicate-search.js';
import { Logger } from '../Logger.js';
import {
  renderAcceptanceSpecSystemPrompt,
  renderTechSpecSystemPrompt,
} from '../templates/spec-author-prompts.js';
import { concurrentMap } from '../util/concurrent-map.js';
import { buildComplexitySignals } from './complexity-gate.js';
import { parseDeliverySlicingTable } from './consolidation-precondition.js';
import { buildDocsDigest } from './docs-digest.js';
import { buildAuthoringContext } from './planning/authoring-context.js';
import { buildDecomposerSystemPrompt } from './planning/decomposer-context.js';

/** Bounded concurrency for `--tickets` source-ticket hydration. */
const SOURCE_TICKET_FETCH_CONCURRENCY = 4;
/**
 * Envelope byte ceiling (regression guard for the design's named PR2 risk:
 * two envelopes → one bigger one). This is the **only** live bound on
 * envelope size: Story #4541 removed the `applyBudget` pass from
 * `buildAuthoringContext`, because both builders below discard that budgeted
 * body and ship the raw seed on `seed.content` instead — the budget bounded
 * a field that never left the function.
 *
 * The envelope's bounded parts are: the tier-capped codebase snapshot
 * (~35 KB skinny on this repo), the three rendered system prompts (~15 KB),
 * and the digest-first `docsContext` (outline-only, or inline digest in
 * one-pager/seed mode). The seed itself is operator-supplied and carried
 * verbatim. Measured folded envelopes on this repo land at ~42 KB; 256 KB
 * (~64K tokens at the ≈4-chars/token estimate) gives >2× headroom over a
 * worst-case seed + medium-tier snapshot while staying an order of magnitude
 * under the session budget. The test suite asserts serialized envelopes stay
 * under this value — raise it only with a measured justification.
 */
export const PLAN_CONTEXT_ENVELOPE_BYTE_CEILING = 256_000;

/** Fields named in the over-ceiling error, to point at what to trim. */
const OVERSIZE_REPORT_FIELDS = 3;

/**
 * Fail closed when an assembled envelope exceeds
 * {@link PLAN_CONTEXT_ENVELOPE_BYTE_CEILING}.
 *
 * Until now the ceiling was enforced *only* by a test assertion over this
 * repo's own fixtures, which bounds nothing at runtime: the value it actually
 * has to hold for is a consumer's seed or `--tickets` source bodies, and no
 * test sees those. That left the documented planner-context cap resting
 * entirely on `planning.context.maxBytes` — which resolved but was wired to
 * nothing (its `applyBudget` pass lost its last caller in the v2 cutover), so
 * in practice no bound existed at all on the path that needed one. That key
 * and its budget module were removed outright in Story #4541; this ceiling is
 * the replacement.
 *
 * Failing closed is the right direction here and matches how an over-budget
 * `## Spec` is handled (`spec-spill.js`): an envelope this size does not
 * degrade the planner gracefully, it silently produces garbage Stories from a
 * truncated-by-the-host context. Better to refuse and say what to trim. The
 * bound is deliberately a fixed framework constant rather than an operator
 * knob — a cap the operator can raise past what the model can read is a cap
 * that fails silently again.
 *
 * Deliberately **not** exported: its only external caller would be a test, and
 * a test-only export is a production-dead one. It is reachable end to end
 * through {@link buildPlanContext}, which is where the behaviour matters.
 *
 * @param {object} envelope
 * @param {{ ceiling?: number }} [opts]
 * @returns {object} `envelope`, unchanged, when it fits.
 */
function assertPlanContextWithinCeiling(envelope, opts = {}) {
  const ceiling = opts.ceiling ?? PLAN_CONTEXT_ENVELOPE_BYTE_CEILING;
  const bytes = Buffer.byteLength(JSON.stringify(envelope) ?? '', 'utf-8');
  if (bytes <= ceiling) return envelope;

  const largest = Object.entries(envelope)
    .map(([field, value]) => [
      field,
      Buffer.byteLength(JSON.stringify(value) ?? '', 'utf-8'),
    ])
    .sort((a, b) => b[1] - a[1])
    .slice(0, OVERSIZE_REPORT_FIELDS)
    .map(([field, size]) => `${field} (${Math.round(size / 1024)} KB)`)
    .join(', ');

  throw new Error(
    `[plan-context] the assembled "${envelope?.mode}" envelope is ` +
      `${Math.round(bytes / 1024)} KB, over the ` +
      `${Math.round(ceiling / 1024)} KB planner-context ceiling. Largest ` +
      `fields: ${largest}. Trim the seed, plan fewer --tickets source issues ` +
      'in one run, or narrow `planning.codebaseSnapshot`. Raising the ceiling ' +
      'needs a measured justification — see PLAN_CONTEXT_ENVELOPE_BYTE_CEILING.',
  );
}

/**
 * Compact, machine-readable descriptor of the `tickets.json` array the
 * authoring pass writes and `validateAndNormalizeTickets` gates at persist
 * time. A descriptor, not a validator: the deterministic gate stays in the
 * persist half (design § 1 step 3); this field exists so the authoring
 * middle knows the shape without re-reading the decomposer prompt prose.
 */
export const TICKET_SCHEMA_DESCRIPTOR = Object.freeze({
  shape: 'array',
  itemFields: Object.freeze({
    slug: 'string — ^[a-z0-9][a-z0-9-]*$ (hyphen-case, unique per decompose)',
    type: "string — literal 'story' (2-tier hierarchy: Epic → Story only)",
    title: 'string — short descriptive title',
    body: 'string — serialized Story-body markdown (never a JSON object); omit the ## Acceptance / ## Verify sections, persist syncs them in',
    acceptance:
      'string[] — top-level testable criteria; the machine contract, authored here and not in the body',
    verify:
      'string[] — top-level exact commands/test paths with (<tier>); the machine contract, authored here and not in the body',
    labels:
      "string[]? — extra labels to apply; 'type::story' is applied automatically. agent::*, type::*, and persona::* are rejected (runtime-owned or retired axes)",
    depends_on: 'string[]? — sibling Story slugs that block execution',
  }),
  validatedBy:
    'validateAndNormalizeTickets (lib/orchestration/ticket-validator.js) at persist time',
});

/**
 * Filename of the ready-to-fill Story authoring template `plan-context.js`
 * writes next to the captured envelope (Story #4707).
 */
export const STORIES_TEMPLATE_FILENAME = 'stories.template.json';

/**
 * Build the template's `changes[]` entries from the envelope's advisory
 * complexity signals (Story #4723). Each seed-predicted path is
 * pre-resolved to its creates-vs-refactors assumption against the repo
 * snapshot the signals already probed: a path present in the repo is a
 * `refactors-existing`, a missing one is a `creates`. Order follows
 * `predictedPaths` (first appearance in the seed). Falls back to the
 * single instructive placeholder entry when the seed predicted no paths.
 *
 * @param {{
 *   predictedPaths?: string[],
 *   repoState?: { existingPaths?: string[], missingPaths?: string[] },
 * }|null|undefined} complexitySignals
 * @returns {Array<{ path: string, assumption: string }>}
 */
function buildTemplateChanges(complexitySignals) {
  const predicted = Array.isArray(complexitySignals?.predictedPaths)
    ? complexitySignals.predictedPaths.filter(
        (p) => typeof p === 'string' && p.length > 0,
      )
    : [];
  if (predicted.length === 0) {
    return [{ path: 'path/to/file.ext', assumption: 'refactors-existing' }];
  }
  const existing = new Set(
    Array.isArray(complexitySignals?.repoState?.existingPaths)
      ? complexitySignals.repoState.existingPaths
      : [],
  );
  return predicted.map((path) => ({
    path,
    assumption: existing.has(path) ? 'refactors-existing' : 'creates',
  }));
}

/**
 * Render the ready-to-fill `stories.json` authoring template (Story #4707).
 *
 * One-shot authoring: the planner copies this file to `stories.json`, fills
 * the placeholder values, and runs persist — no step requires reading
 * `story-body.js` source or re-poking the envelope for format discovery
 * (bench: ~7 of 17 plan turns were format discovery). The template uses the
 * **structured-object body** shape, which persist parses and serializes to
 * the canonical markdown itself (`parse` accepts an object;
 * `assembleOnePlanStory` re-serializes canonically), so the serializer
 * contract never has to be reverse-engineered by the author. `acceptance[]`
 * / `verify[]` live at the ticket's top level — the machine contract persist
 * syncs into the body.
 *
 * Correct-by-construction skeleton (Story #4723): the emitted `verify[]`
 * placeholder already ends with a valid `(tier)` tag (swap `(unit)` for
 * `(contract)` / `(e2e)` / `(validate)` where appropriate), and when the
 * envelope's `complexitySignals` predicted a footprint the `changes[]`
 * entries arrive pre-resolved to creates-vs-refactors against the repo
 * snapshot — a faithfully-filled skeleton passes the persist ticket
 * validators without a mechanical round-trip. The persist gates stay
 * authoritative (they probe the base branch ref, not the working tree).
 *
 * Pure and deterministic; the output is valid JSON (parseable as-is), with
 * instructive placeholder values rather than comments.
 *
 * @param {{ complexitySignals?: object|null }} [opts] Envelope signals to
 *   pre-resolve the skeleton against; omit for the bare placeholder shape.
 * @returns {string} Pretty-printed JSON template content.
 */
export function renderStoriesTemplate({ complexitySignals = null } = {}) {
  const template = [
    {
      slug: 'fill-hyphen-case-slug',
      type: 'story',
      title: 'Fill: short descriptive title',
      body: {
        goal: 'Fill: one sentence stating why this Story exists.',
        spec:
          'Optional — contract and invariants only: interfaces, status ' +
          'codes, security invariants, and load-bearing constraints with ' +
          'their why. Implementation choices belong to the deliverer unless ' +
          'load-bearing. No per-file behavior paragraphs, no current-state ' +
          'narration. Keep it under ~250 words (soft advisory budget). ' +
          'Delete this field when acceptance[] carries the whole contract.',
        changes: buildTemplateChanges(complexitySignals),
        non_goals: [],
        reason_to_exist:
          'Fill: the single coherent reason this Story exists (one sentence).',
      },
      acceptance: [
        'Fill: a testable, observable criterion (a command exits 0, a file exists, a test matches)',
      ],
      verify: [
        'Fill: exact command or test path — keep the trailing tier tag valid: unit, contract, e2e, or validate (unit)',
      ],
      depends_on: [],
    },
  ];
  return `${JSON.stringify(template, null, 2)}\n`;
}

/**
 * Count top-level enumerated items (`- `, `* `, `1. `) anywhere in a
 * free-form seed text. Unlike {@link countScopeItems} this does not require
 * a scope-shaped heading — a raw `--seed` text rarely has one.
 *
 * @param {string} text
 * @returns {number}
 */
function countEnumeratedItems(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  return text
    .split(/\r?\n/)
    .filter((line) => /^\s*(?:[-*]|\d+\.)\s+\S/.test(line)).length;
}

/**
 * Delta-shaped change-request verbs — the `core/scope-triage` skill's
 * change-request rubric routes these to `story` by default when the
 * footprint stays inside Story width.
 */
const DELTA_VERB_RE =
  /\b(fix(?:es)?|tweak(?:s)?|extend(?:s)?|update(?:s)?|adjust(?:s)?|rename(?:s)?|correct(?:s)?|patch(?:es)?|bug|regression|flaky)\b/i;

/**
 * Deterministic, CLI-applied scope-triage verdict over a raw `--seed` text
 * (#4496 fix 6). Embedding the verdict in the `--seed` envelope removes the
 * two skill Reads (`core/scope-triage` + the gate fragment's rubric pass)
 * from the headless path; the attended path keeps the skill-based judgment.
 *
 * The heuristics anchor to the same sizing SSOT the skill anchors to —
 * `DELIVERABLE_GRANULARITY_GUIDANCE` / `DEFAULT_MODEL_CAPACITY` in
 * `ticket-validator-sizing.js` (one Story = one coherent capability slice;
 * multiple independent capabilities = an Epic) — and to the skill's
 * change-request delta rubric. Like the skill, the verdict is **advisory**:
 * being wrong in the `epic` direction is cheap (the consolidation critic and
 * the sizing validator catch an over-planned Story later), and `borderline`
 * is a first-class output, not a forced call.
 *
 * @param {{ seedText?: string }} args
 * @returns {{ verdict: 'epic'|'story'|'borderline', reasons: string[], advisory: true, appliedBy: 'cli' }}
 */
export function buildScopeTriageSignal({ seedText = '' } = {}) {
  const advisory = /** @type {const} */ (true);
  const appliedBy = /** @type {const} */ ('cli');
  const text = typeof seedText === 'string' ? seedText : '';
  const listItems = countEnumeratedItems(text);
  const wordCount = text.split(/\s+/).filter(Boolean).length;

  if (listItems >= 3) {
    return {
      verdict: 'epic',
      reasons: [
        `seed enumerates ${listItems} candidate capabilities — a genuine fan-out surface`,
      ],
      advisory,
      appliedBy,
    };
  }
  if (listItems >= 1) {
    return {
      verdict: 'story',
      reasons: [
        `seed enumerates ${listItems} capability item(s) — one coherent change with one reason to exist`,
      ],
      advisory,
      appliedBy,
    };
  }
  if (DELTA_VERB_RE.test(text) && wordCount <= 120) {
    return {
      verdict: 'story',
      reasons: [
        'delta-shaped seed (change-request verb, no capability enumeration) within Story width',
      ],
      advisory,
      appliedBy,
    };
  }
  if (wordCount >= 250) {
    return {
      verdict: 'epic',
      reasons: [
        `broad prose seed (~${wordCount} words) with no enumeration — plausibly multiple independent capabilities`,
      ],
      advisory,
      appliedBy,
    };
  }
  return {
    verdict: 'borderline',
    reasons: [
      'no capability enumeration and no clear delta signal — could be one ambitious Story or a small Epic; the operator (or the --yes Recommended branch) decides',
    ],
    advisory,
    appliedBy,
  };
}

/**
 * Resolve the planning risk heuristics list from the canonical config
 * block (same resolution the decompose context uses).
 *
 * @param {object} config
 * @returns {string[]}
 */
function resolveRiskHeuristics(config = {}) {
  if (Array.isArray(config.planning?.riskHeuristics)) {
    return config.planning.riskHeuristics;
  }
  return [];
}

/**
 * Count top-level enumerated items (`- `, `* `, `1. `) under the first
 * scope-shaped `## ` heading (Scope / MVP Scope / Proposed Scope / Work
 * Breakdown / Capabilities), up to the next `## ` heading. Returns `null`
 * when no scope-shaped heading exists — the caller treats that as "no
 * sizing signal" and defaults to fan-out.
 *
 * @param {string} body
 * @returns {number|null}
 */
function countScopeItems(body) {
  if (typeof body !== 'string' || body.length === 0) return null;
  const lines = body.split(/\r?\n/);
  const headingIdx = lines.findIndex((line) =>
    /^##\s+(?:(?:MVP\s+|Proposed\s+)?Scope(?:\s+\([^)]+\))?|Work\s+Breakdown|Capabilities)\s*$/i.test(
      line.trim(),
    ),
  );
  if (headingIdx === -1) return null;
  let count = 0;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s+/.test(line)) break;
    if (/^\s*(?:[-*]|\d+\.)\s+\S/.test(line)) count += 1;
  }
  return count;
}

/**
 * Advisory single-vs-fan-out delivery-shape signal (design § 1 step 1;
 * routing pilot #4475). Derived from the same size/shape heuristics the
 * scope-triage rubric anchors to — the Delivery Slicing table when the Epic
 * body already carries one (slice count + "Independent?" chain shape,
 * via the Phase 8.3 precondition parser), else a scope-enumeration count.
 *
 * **Advisory only, fan-out by default.** This signal changes no routing
 * behaviour in this PR: the deliver-side reader is #4475's scope, and until
 * it lands the recommendation defaults to `fan-out` for every ambiguous
 * case. `single` is recommended only on clear one-pass indicators: a
 * slicing table proposing ≤ 2 slices, a pure dependent chain (zero
 * realized parallelism from the Story tier — the N=2 bench finding), or a
 * scope enumeration of ≤ 2 capabilities.
 *
 * @param {{ body: string }} args
 * @returns {{ recommendation: 'single'|'fan-out', reasons: string[], advisory: true }}
 */
export function buildDeliveryShapeSignal({ body } = {}) {
  const advisory = /** @type {const} */ (true);
  const rows = parseDeliverySlicingTable(body ?? '');

  if (Array.isArray(rows) && rows.length > 0) {
    if (rows.length <= 2) {
      return {
        recommendation: 'single',
        reasons: [
          `delivery-slicing table proposes ${rows.length} slice(s) — one-pass-sized`,
        ],
        advisory,
      };
    }
    const chain = rows.slice(1).every((r) => r.independent === false);
    if (chain) {
      return {
        recommendation: 'single',
        reasons: [
          `delivery-slicing table is a pure dependent chain (${rows.length} slices, every non-first slice "Independent? No") — zero parallelism value from Story fan-out`,
        ],
        advisory,
      };
    }
    return {
      recommendation: 'fan-out',
      reasons: [
        `delivery-slicing table proposes ${rows.length} slices with independent parallelism`,
      ],
      advisory,
    };
  }

  const scopeItems = countScopeItems(body ?? '');
  if (scopeItems !== null && scopeItems > 0 && scopeItems <= 2) {
    return {
      recommendation: 'single',
      reasons: [
        `scope enumerates ${scopeItems} capability item(s) — one-pass-sized`,
      ],
      advisory,
    };
  }
  if (scopeItems !== null && scopeItems > 2) {
    return {
      recommendation: 'fan-out',
      reasons: [`scope enumerates ${scopeItems} capability items`],
      advisory,
    };
  }
  return {
    recommendation: 'fan-out',
    reasons: [
      'no delivery-slicing table or scope enumeration to size against — defaulting to fan-out',
    ],
    advisory,
  };
}

/**
 * Render the three authoring system prompts the collapsed pipeline's
 * single authoring pass consumes. The spec/acceptance prompts render from
 * `lib/templates/spec-author-prompts.js` (the M3/M8 handshake — envelope
 * authoritative from day one); the decompose prompt reuses the existing
 * Story #4162 carrier including the risk-heuristics suffix.
 *
 * @param {{ heuristics?: string[], maxTickets?: number }} args
 * @returns {{ spec: string, acceptance: string, decompose: string }}
 */
export function buildSystemPrompts({ heuristics = [], maxTickets } = {}) {
  const decompose = buildDecomposerSystemPrompt(heuristics, {
    maxTickets,
  });
  return {
    spec: renderTechSpecSystemPrompt(),
    acceptance: renderAcceptanceSpecSystemPrompt(),
    // v2 Stage 3: default-single author prompt (decompose text + split policy).
    story: `${decompose}

#### v2 DEFAULT-SINGLE SPLIT POLICY:

Emit **exactly one Story** in \`stories.json\` unless the pieces have
near-zero overlap or sit across an architectural seam. Coupled work stays
one Story — put intra-session checkpoints in \`## Slicing\` and fold the
Tech Spec into \`## Spec\` (inline only; over-budget Specs mean split or
tighten — never write under \`docs/\`). Do **not** emit \`deliveryShape\`.
When N>1, every acceptance criterion must belong to exactly one Story,
and each Story carries its own \`## Spec\` (no shared techspec.md fold).
`,
    decompose,
  };
}

/**
 * Run the open-Story duplicate search. Failures degrade to [] — triage
 * signal, not a gate.
 *
 * @param {{
 *   seed: string,
 *   provider: object,
 *   config: object,
 *   excludeIds?: Iterable<number|string>,
 * }} args
 * @returns {Promise<Array<object>>}
 */
async function searchStoryDuplicates({
  seed,
  provider,
  config,
  excludeIds = [],
}) {
  try {
    return await findSimilarOpenStories({
      seed,
      provider,
      owner: config.github?.owner,
      repo: config.github?.repo,
      excludeIds,
    });
  } catch (err) {
    Logger.warn(
      `[plan-context] duplicate search degraded to no candidates: ${err?.message ?? err}`,
    );
    return [];
  }
}

/**
 * Build the seed-file (ideation) envelope. No parent ticket
 * exists yet — creation moves to the persist half — so the open-Story
 * dup search is the mode's gating input. `docsContext` is inline-digest:
 * there is no plan temp directory to anchor a digest file to yet.
 */
async function buildSeedFileModeEnvelope({
  seedFilePath,
  seedFileContent,
  provider,
  config,
  settings,
  cwd,
  modeLabel = 'seed-file',
}) {
  const content =
    seedFileContent ?? (await readFile(seedFilePath ?? '', 'utf-8'));
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new Error(
      `[plan-context] seed-file at ${seedFilePath ?? '(inline)'} is empty — nothing to plan from.`,
    );
  }

  const duplicates = await searchStoryDuplicates({
    seed: content,
    provider,
    config,
  });

  // Fold the authoring-context builders grounded in the seed prose.
  // `docsContextFiles` is emptied for this call: the per-plan digest-file
  // path needs a plan id that does not exist yet — the inline digest
  // below replaces it.
  const authoring = await buildAuthoringContext(
    0,
    /* provider (unused behind the prefetch seam) */ {},
    { ...settings, docsContextFiles: [] },
    {
      epic: { id: 0, title: seedFilePath ?? 'seed', body: content },
      github: config.github ?? null,
      cwd,
    },
  );

  const paths = settings?.paths ?? {};
  const inlineDigest = await buildDocsDigest({
    docsContextFiles: settings?.docsContextFiles,
    docsRoot: paths.docsRoot,
  });
  const docsContext =
    inlineDigest == null
      ? null
      : { mode: 'digest-inline', digest: inlineDigest };

  const limits = getLimits(config);
  const heuristics = resolveRiskHeuristics(config);

  return {
    mode: modeLabel,
    seed: { path: seedFilePath ?? null, content },
    // Advisory complexity signals only (Story #4722): no route, no routing
    // authority. The planner authors the trivial-vs-standard verdict; persist
    // validates a lite claim against the authored Story's shape.
    complexitySignals: buildComplexitySignals({
      seedText: content,
      config,
      riskHeuristics: heuristics,
      cwd,
    }),
    duplicates,
    docsContext,
    codebaseSnapshot: authoring.codebaseSnapshot,
    bddRunner: authoring.bddRunner,
    bddScenarios: authoring.bddScenarios,
    memoryFreshness: authoring.memoryFreshness,
    priorFeedback: authoring.priorFeedback,
    ticketSchema: TICKET_SCHEMA_DESCRIPTOR,
    maxTickets: limits.maxTickets,
    riskHeuristics: heuristics,
    systemPrompts: buildSystemPrompts({
      heuristics,
      maxTickets: limits.maxTickets,
    }),
    planState: null,
    // N=1 default: author one Story; skip Epic-scale decompose ceremony.
    planProfile: 'story-default',
  };
}

/**
 * Build the seed-mode (chat text) envelope. The seed-file does not exist
 * yet: the dup search and the authoring-context fold both run off the raw
 * seed text (N=1 default — no Epic-scale decompose).
 */
async function buildSeedModeEnvelope({
  seedText,
  provider,
  config,
  settings,
  cwd,
}) {
  if (typeof seedText !== 'string' || seedText.trim().length === 0) {
    throw new Error(
      '[plan-context] --seed requires non-empty seed text — nothing to plan from.',
    );
  }
  const base = await buildSeedFileModeEnvelope({
    seedFilePath: undefined,
    seedFileContent: seedText,
    provider,
    config,
    settings,
    cwd,
    modeLabel: 'seed',
  });
  const { seed: _seed, ...rest } = base;
  return {
    ...rest,
    mode: 'seed',
    seed: { text: seedText, path: null },
  };
}

/**
 * Fetch source tickets for `--tickets` mode.
 * Hydrates ids concurrently (bounded) while preserving input order.
 *
 * @param {number[]} ticketIds
 * @param {object} provider
 * @returns {Promise<Array<{ id:number, title:string, body:string, labels:string[], url?:string }>>}
 */
async function fetchSourceTickets(ticketIds, provider) {
  if (!provider || typeof provider.getTicket !== 'function') {
    throw new Error(
      '[plan-context] tickets mode requires provider.getTicket()',
    );
  }
  return concurrentMap(
    ticketIds,
    async (id) => {
      const ticket = await provider.getTicket(id);
      if (!ticket) {
        throw new Error(`[plan-context] ticket #${id} not found`);
      }
      return {
        id: Number(ticket.id ?? ticket.number ?? id),
        title: ticket.title ?? '',
        body: ticket.body ?? '',
        labels: Array.isArray(ticket.labels)
          ? ticket.labels
              .map((l) => (typeof l === 'string' ? l : l?.name))
              .filter(Boolean)
          : [],
        url: ticket.html_url ?? ticket.url ?? undefined,
        state: ticket.state ?? undefined,
      };
    },
    { concurrency: SOURCE_TICKET_FETCH_CONCURRENCY },
  );
}

/**
 * Build the tickets-mode envelope — analyze existing issue(s) into proper
 * Stories. Dup search excludes the source ids so a ticket is not reported
 * as a duplicate of itself.
 */
async function buildTicketsModeEnvelope({
  ticketIds,
  provider,
  config,
  settings,
  cwd,
}) {
  if (!Array.isArray(ticketIds) || ticketIds.length === 0) {
    throw new Error(
      '[plan-context] --tickets requires one or more positive issue ids.',
    );
  }
  const sourceTickets = await fetchSourceTickets(ticketIds, provider);
  const seed = sourceTickets
    .map((t) => `# ${t.title}\n\n${t.body}`)
    .join('\n\n---\n\n');

  const duplicates = await searchStoryDuplicates({
    seed,
    provider,
    config,
    excludeIds: ticketIds,
  });

  const authoring = await buildAuthoringContext(
    0,
    {},
    { ...settings, docsContextFiles: [] },
    {
      epic: {
        id: 0,
        title: sourceTickets[0]?.title ?? 'tickets',
        body: seed,
      },
      github: config.github ?? null,
      cwd,
    },
  );

  const paths = settings?.paths ?? {};
  const inlineDigest = await buildDocsDigest({
    docsContextFiles: settings?.docsContextFiles,
    docsRoot: paths.docsRoot,
  });
  const docsContext =
    inlineDigest == null
      ? null
      : { mode: 'digest-inline', digest: inlineDigest };

  const limits = getLimits(config);
  const heuristics = resolveRiskHeuristics(config);

  return {
    mode: 'tickets',
    sourceTickets,
    seed: { text: seed, path: null },
    complexitySignals: buildComplexitySignals({
      seedText: seed,
      config,
      riskHeuristics: heuristics,
      cwd,
    }),
    duplicates,
    docsContext,
    codebaseSnapshot: authoring.codebaseSnapshot,
    bddRunner: authoring.bddRunner,
    bddScenarios: authoring.bddScenarios,
    memoryFreshness: authoring.memoryFreshness,
    priorFeedback: authoring.priorFeedback,
    ticketSchema: TICKET_SCHEMA_DESCRIPTOR,
    maxTickets: limits.maxTickets,
    riskHeuristics: heuristics,
    systemPrompts: buildSystemPrompts({
      heuristics,
      maxTickets: limits.maxTickets,
    }),
    planState: null,
    planProfile:
      ticketIds.length === 1 ? 'story-default' : 'story-from-tickets',
    instruction:
      'Analyze the source ticket(s) and author proper type::story ' +
      'ticket(s) under the default-single split policy. Prefer rewriting ' +
      'the source into one well-formed Story (N=1) unless the split policy ' +
      'applies. Do not open an Epic.',
  };
}

/**
 * Build the single planner-context envelope.
 *
 * Every mode returns through here, which makes this the one place the
 * envelope's total size is decided — and therefore the only honest place to
 * bound it (see {@link assertPlanContextWithinCeiling}).
 *
 * @param {{
 *   mode: 'seed-file'|'seed'|'tickets',
 *   seedFilePath?: string,
 *   seedFileContent?: string,
 *   seedText?: string,
 *   ticketIds?: number[],
 *   provider: object,
 *   config: object,
 *   settings: object,
 *   cwd?: string,
 * }} args
 * @returns {Promise<object>} the JSON-serialisable envelope.
 */
export async function buildPlanContext({
  mode,
  seedFilePath,
  seedFileContent,
  seedText,
  ticketIds,
  provider,
  config = {},
  settings = {},
  cwd,
}) {
  return assertPlanContextWithinCeiling(
    await buildPlanContextEnvelope({
      mode,
      seedFilePath,
      seedFileContent,
      seedText,
      ticketIds,
      provider,
      config,
      settings,
      cwd,
    }),
  );
}

/**
 * Mode dispatch for {@link buildPlanContext}. Split out so the ceiling check
 * wraps every mode exactly once.
 */
async function buildPlanContextEnvelope({
  mode,
  seedFilePath,
  seedFileContent,
  seedText,
  ticketIds,
  provider,
  config,
  settings,
  cwd,
}) {
  if (mode === 'seed-file') {
    if (!seedFilePath && typeof seedFileContent !== 'string') {
      throw new Error(
        '[plan-context] seed-file mode requires --seed-file <path>.',
      );
    }
    return buildSeedFileModeEnvelope({
      seedFilePath,
      seedFileContent,
      provider,
      config,
      settings,
      cwd,
      modeLabel: 'seed-file',
    });
  }
  if (mode === 'seed') {
    return buildSeedModeEnvelope({
      seedText,
      provider,
      config,
      settings,
      cwd,
    });
  }
  if (mode === 'tickets') {
    return buildTicketsModeEnvelope({
      ticketIds,
      provider,
      config,
      settings,
      cwd,
    });
  }
  throw new Error(
    `[plan-context] unknown mode "${mode}" — expected "seed", "seed-file", or "tickets".`,
  );
}

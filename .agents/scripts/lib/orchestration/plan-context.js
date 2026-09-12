/**
 * plan-context.js — single planner-context envelope build for `/mandrel-plan`.
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
import { readAuditRulesSync } from '../audit-suite/audit-rules-reader.js';
import {
  hasWebSurface,
  matchesAnyFilePattern,
} from '../audit-suite/selector.js';
import { findSimilarOpenStories } from '../duplicate-search.js';
import { Logger } from '../Logger.js';
import { parse as parseStoryBody } from '../story-body/story-body.js';
import {
  renderStoryAuthorCore,
  renderStorySplitRules,
} from '../templates/decomposer-prompts.js';
import {
  renderAcceptanceSpecSystemPrompt,
  renderTechSpecSystemPrompt,
} from '../templates/spec-author-prompts.js';
import { concurrentMap, FANOUT_CONCURRENCY } from '../util/concurrent-map.js';
import { buildComplexitySignals } from './complexity-gate.js';
import { findDependencyCandidates } from './dependency-candidates.js';
import { buildDocsDigest } from './docs-digest.js';
import { findOpenEpicCandidates } from './epic-candidates.js';
import { buildAuthoringContext } from './planning/authoring-context.js';

/**
 * Envelope byte ceiling (regression guard for the design's named PR2 risk:
 * two envelopes → one bigger one). This is the **only** live bound on
 * envelope size: Story #4541 removed the `applyBudget` pass from
 * `buildAuthoringContext`, because both builders below discard that budgeted
 * body and ship the raw seed on `seed.content` instead — the budget bounded
 * a field that never left the function.
 *
 * A measured seed-mode envelope on this repo (a thin `.feature` corpus) is
 * ~120 KB, dominated by the digest-first `docsContext` (~63 KB inline
 * digest) and the rendered `systemPrompts` (~54 KB); every other field is
 * under 1 KB. Story #4811 retired the tier-capped codebase snapshot that
 * used to sit alongside them (~35 KB skinny here). This measurement is
 * **not** representative of every consumer, though: Story #4977 found
 * `bddScenarios` at 118 KB on a consumer with a mature Gherkin corpus —
 * larger than `docsContext` and `systemPrompts` combined, consuming nearly
 * all of the ceiling's headroom on its own, because the scanner applied no
 * cap. `bddScenarios` is now truncated to `BDD_SCENARIOS_BYTE_BUDGET`
 * (`lib/bdd-scenario-budget.js`, ≤24 KB) before it reaches this envelope,
 * so the seed remains the only field this ceiling leaves genuinely
 * unbounded. 256 KB (~64K tokens at the ≈4-chars/token estimate) leaves
 * roughly 2× headroom over the fixed-floor measurement above while staying
 * well under the session budget. An envelope over it is truncated with a
 * `truncated` note rather than refused (Story #5312) — raise the ceiling
 * only with a measured justification.
 */
export const PLAN_CONTEXT_ENVELOPE_BYTE_CEILING = 256_000;

/** Marker appended to a string field the cap had to cut. */
const TRUNCATION_MARKER =
  '\n\n[… truncated by plan-context: PLAN_CONTEXT_ENVELOPE_BYTE_CEILING …]';

/** Bounded number of cap rounds — each round cuts the current largest field. */
const MAX_TRUNCATION_ROUNDS = 8;

/**
 * Byte length of a JSON-serialised value.
 *
 * @param {unknown} value
 * @returns {number}
 */
function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf-8');
}

/**
 * Cut a string to fit `excess` fewer bytes, keeping a leading prefix and
 * appending the truncation marker.
 *
 * @param {string} text
 * @param {number} excess
 * @returns {string}
 */
function truncateString(text, excess) {
  // A second cut of the same field must not stack a second marker.
  const bare = text.endsWith(TRUNCATION_MARKER)
    ? text.slice(0, -TRUNCATION_MARKER.length)
    : text;
  const keep = Math.max(
    0,
    Buffer.byteLength(bare, 'utf-8') - excess - TRUNCATION_MARKER.length,
  );
  return `${Buffer.from(bare, 'utf-8').subarray(0, keep).toString('utf-8')}${TRUNCATION_MARKER}`;
}

/**
 * Cut one envelope field down by roughly `excess` bytes. Three shapes are
 * cuttable: a string (cut to a prefix), an array (drop tail entries until it
 * fits), and an object whose largest string property is cut in place — which
 * covers `seed.content`, `docsContext.digest` and every list field. Returns
 * `null` for a shape nothing here can shrink.
 *
 * @param {unknown} value
 * @param {number} excess
 * @returns {{ value: unknown, note: string }|null}
 */
function truncateField(value, excess) {
  if (typeof value === 'string') {
    return {
      value: truncateString(value, excess),
      note: `text cut to a prefix (${excess} bytes over)`,
    };
  }
  if (Array.isArray(value)) {
    let kept = value.length;
    let bytes = jsonBytes(value);
    const target = bytes - excess;
    while (kept > 0 && bytes > target) {
      kept -= 1;
      bytes = jsonBytes(value.slice(0, kept));
    }
    return {
      value: value.slice(0, kept),
      note: `kept ${kept} of ${value.length} entries`,
    };
  }
  if (value && typeof value === 'object') {
    const [key] = Object.entries(value)
      .filter(([, v]) => typeof v === 'string')
      .map(([k, v]) => [k, Buffer.byteLength(v, 'utf-8')])
      .sort((a, b) => b[1] - a[1])[0] ?? [null];
    if (key === null) return null;
    return {
      value: { ...value, [key]: truncateString(value[key], excess) },
      note: `.${key} cut to a prefix (${excess} bytes over)`,
    };
  }
  return null;
}

/**
 * Fit an assembled envelope under {@link PLAN_CONTEXT_ENVELOPE_BYTE_CEILING}
 * by truncating its largest fields, recording every cut on a `truncated`
 * field so the planner can see what it did not get.
 *
 * Until Story #5312 this refused the envelope outright and exited non-zero
 * naming what to trim. That was the wrong direction for a bound whose only
 * job is to keep the planner's context readable: an oversize seed or
 * `--tickets` body is an operator's real input, and refusing to plan from it
 * cost a re-run for a ceiling the operator had no way to act on (the seed is
 * carried verbatim by design). A truncated envelope with a note is a plan
 * that runs on the part that fits and says so; a refusal is no plan at all.
 * The bound itself stays a fixed framework constant — a cap the operator can
 * raise past what the model can read fails silently again.
 *
 * Deliberately **not** exported: its only external caller would be a test, and
 * a test-only export is a production-dead one. It is reachable end to end
 * through {@link buildPlanContext}, which is where the behaviour matters.
 *
 * @param {object} envelope
 * @param {{ ceiling?: number }} [opts]
 * @returns {object} `envelope` unchanged when it fits; otherwise a truncated
 *   copy carrying `truncated: Array<{ field, originalBytes, keptBytes, note }>`.
 */
function capPlanContextEnvelope(envelope, opts = {}) {
  const ceiling = opts.ceiling ?? PLAN_CONTEXT_ENVELOPE_BYTE_CEILING;
  if (jsonBytes(envelope) <= ceiling) return envelope;

  const next = { ...envelope };
  const truncated = [];
  for (let round = 0; round < MAX_TRUNCATION_ROUNDS; round += 1) {
    const total = jsonBytes({ ...next, truncated });
    if (total <= ceiling) break;
    // JSON escaping of the marker and the note itself cost a few bytes the
    // raw cut cannot see; over-cut by a small margin so the dominant field
    // absorbs the whole excess rather than a residual spilling onto the next
    // largest one (which is the planner's own prompt).
    const excess = total - ceiling + 128;
    // The largest field that can be cut — re-cut on a later round rather than
    // moving on to a smaller field it never had to touch.
    const candidates = Object.entries(next)
      .map(([field, value]) => [field, jsonBytes(value)])
      .sort((a, b) => b[1] - a[1]);
    let applied = false;
    for (const [field, bytes] of candidates) {
      const cut = truncateField(next[field], excess);
      if (cut === null) continue;
      next[field] = cut.value;
      const record = truncated.find((t) => t.field === field);
      if (record) {
        record.keptBytes = jsonBytes(cut.value);
        record.note = cut.note;
      } else {
        truncated.push({
          field,
          originalBytes: bytes,
          keptBytes: jsonBytes(cut.value),
          note: cut.note,
        });
      }
      applied = true;
      break;
    }
    if (!applied) break;
  }
  Logger.warn(
    `[plan-context] the assembled "${envelope?.mode}" envelope was over the ` +
      `${Math.round(ceiling / 1024)} KB planner-context ceiling — truncated ` +
      `${truncated.map((t) => `${t.field} (${t.note})`).join(', ')}. ` +
      "See the envelope's `truncated` field.",
  );
  return { ...next, truncated };
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
 * Correct-by-construction skeleton (Story #4723): when the envelope's
 * `complexitySignals` predicted a footprint the `changes[]` entries arrive
 * pre-resolved to creates-vs-refactors against the repo snapshot — a
 * faithfully-filled skeleton passes the persist ticket validators without a
 * mechanical round-trip. The persist gates stay
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
          'narration. As long as the work needs. ' +
          'Delete this field when acceptance[] carries the whole contract.',
        changes: buildTemplateChanges(complexitySignals),
        non_goals: [],
      },
      acceptance: [
        'Fill: an outcome a PR reviewer can confirm from the diff and the verify output (three to six items)',
      ],
      verify: [
        'Fill: exact command or test path — the mechanical check the acceptance item rests on',
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
 * The heuristics anchor to the same granularity SSOT the skill anchors to —
 * `DELIVERABLE_GRANULARITY_GUIDANCE` in `ticket-validator-sizing.js` (one
 * Story = one coherent capability slice; multiple independent capabilities =
 * an Epic) — and to the skill's change-request delta rubric. Like the skill,
 * the verdict is **advisory**: being wrong in the `epic` direction is cheap,
 * and `borderline` is a first-class output, not a forced call.
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
 * The `audit-rules.json` lens `target` value marking a lens applicable only to
 * a project with a rendered frontend.
 */
const WEB_LENS_TARGET = 'web';

/**
 * How many matched UI paths the `uiSurface` signal carries. The signal rides the
 * `--out` stdout digest, which has a ~2KB contract, and a seed can predict up to
 * `MAX_PREDICTED_PATHS` paths — enumerating all of them would let one UI-heavy
 * seed blow that budget. The full count travels beside the sample as
 * `matchedPathCount`, so nothing is silently lost.
 */
const UI_MATCHED_PATH_SAMPLE = 5;

/**
 * Union of the `triggers.filePatterns` globs every `target: "web"` lens
 * registers in `audit-rules.json` — the framework's shipped declaration of
 * "this path is part of a rendered UI surface". Read from the manifest rather
 * than re-listed here: a second copy of the glob set would be a second thing to
 * keep in sync, and the manifest is already the place an operator extends it.
 *
 * @param {{ audits?: Record<string, object> }} rules
 * @returns {string[]} Deduplicated globs, in manifest order.
 */
function resolveWebFilePatterns(rules) {
  const patterns = new Set();
  for (const entry of Object.values(rules?.audits ?? {})) {
    if (entry?.target !== WEB_LENS_TARGET) continue;
    for (const glob of entry?.triggers?.filePatterns ?? []) {
      if (typeof glob === 'string' && glob !== '') patterns.add(glob);
    }
  }
  return [...patterns];
}

/**
 * Which predicted paths sit on a UI surface, per the web lens globs.
 *
 * An unreadable manifest is **indeterminate**, not "no match": the signal fails
 * OPEN in the same direction {@link hasWebSurface} does, because a spurious
 * mention of an operator-invoked command costs nothing while a missed one costs
 * the whole point of the offer.
 *
 * @param {string[]} predictedPaths
 * @returns {{ matchedPaths: string[], indeterminate: boolean }}
 */
function resolveWebFootprintMatch(predictedPaths) {
  let patterns;
  try {
    patterns = resolveWebFilePatterns(readAuditRulesSync());
  } catch {
    return { matchedPaths: [], indeterminate: true };
  }
  return {
    matchedPaths: predictedPaths.filter((p) =>
      matchesAnyFilePattern(patterns, [p]),
    ),
    indeterminate: false,
  };
}

/**
 * The one sentence a `uiSurface` signal carries — why the offer fires, or why it
 * does not. Kept in one place so the fired and unfired shapes stay one object.
 *
 * @param {{
 *   detected: boolean,
 *   webSurface: boolean,
 *   indeterminate: boolean,
 *   sample: string[],
 *   count: number,
 * }} facts
 * @returns {string}
 */
function uiSurfaceReason({
  detected,
  webSurface,
  indeterminate,
  sample,
  count,
}) {
  if (!detected) {
    return webSurface
      ? 'no predicted path matches a web lens filePattern — nothing to prototype'
      : 'project has no rendered web surface — nothing to prototype';
  }
  if (indeterminate) {
    return 'web-capable project and the UI-path manifest could not be read — offering /prototype rather than dropping the option';
  }
  const elided = count - sample.length;
  const shown =
    elided > 0 ? `${sample.join(', ')}, +${elided} more` : sample.join(', ');
  return `web-capable project and the predicted footprint touches ${count} UI path(s) (${shown}) — the operator may want /prototype before UI acceptance criteria are authored`;
}

/**
 * Derive the advisory **UI-surface** signal from a seed's predicted footprint.
 *
 * Two observables, both already shipped, ANDed together:
 *
 *   1. the project is web-capable at all (`hasWebSurface` — the same
 *      applicability predicate the `target: "web"` audit lenses gate on), and
 *   2. at least one predicted path matches a web lens `filePattern`.
 *
 * No new detection surface and no new `.agentrc.json` key: both halves are
 * derived from the consumer's own checkout, so a frontend-less project — this
 * repository included — resolves falsey and the offer never fires.
 *
 * The signal carries **no routing authority** (`automatic: false`): `/mandrel-plan`
 * may say that a plan touches UI and that `/prototype` exists, and must never
 * invoke it. Pure over its inputs and total — a malformed signal bag or an
 * unreadable manifest degrades, never throws.
 *
 * @param {{
 *   complexitySignals?: object|null,
 *   config?: object,
 *   cwd?: string,
 * }} [args]
 * @returns {{
 *   detected: boolean,
 *   automatic: false,
 *   advisory: true,
 *   webSurface: boolean,
 *   matchedPaths: string[],
 *   matchedPathCount: number,
 *   reasons: string[],
 * }} `matchedPaths` is a bounded sample
 *   ({@link UI_MATCHED_PATH_SAMPLE}); `matchedPathCount` is the full total.
 */
function buildUiSurfaceSignal({ complexitySignals, config, cwd } = {}) {
  const predictedPaths = Array.isArray(complexitySignals?.predictedPaths)
    ? complexitySignals.predictedPaths.filter((p) => typeof p === 'string')
    : [];
  const projectRoot =
    typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd();

  let webSurface;
  try {
    webSurface = hasWebSurface({ config, projectRoot });
  } catch {
    webSurface = true; // indeterminate ⇒ fail open
  }

  const { matchedPaths, indeterminate } =
    resolveWebFootprintMatch(predictedPaths);
  const detected = webSurface && (indeterminate || matchedPaths.length > 0);
  const sample = matchedPaths.slice(0, UI_MATCHED_PATH_SAMPLE);

  return {
    detected,
    automatic: /** @type {const} */ (false),
    advisory: /** @type {const} */ (true),
    webSurface,
    matchedPaths: sample,
    matchedPathCount: matchedPaths.length,
    reasons: [
      uiSurfaceReason({
        detected,
        webSurface,
        indeterminate,
        sample,
        count: matchedPaths.length,
      }),
    ],
  };
}

/**
 * Attach the advisory routing/offer signals to a complexity-signals bag as
 * **nested** fields (Story #4741). Nesting — rather than new top-level envelope
 * keys — keeps every existing per-mode envelope key set byte-stable: both are
 * derived from the signals they ride on.
 *
 * @param {object} complexitySignals
 * @param {{ config?: object, cwd?: string }} [context]
 * @returns {object} the same signals plus `uiSurface`.
 */
function withAdvisorySignals(complexitySignals, { config, cwd } = {}) {
  return {
    ...complexitySignals,
    uiSurface: buildUiSurfaceSignal({ complexitySignals, config, cwd }),
  };
}

/**
 * Render the authoring system prompts the collapsed pipeline's single
 * authoring pass consumes. The spec/acceptance prompts render from
 * `lib/templates/spec-author-prompts.js` (the M3/M8 handshake — envelope
 * authoritative from day one); the story prompt is the N=1 core from
 * `lib/templates/decomposer-prompts.js`, with the schedule and partition
 * rules a planner reads only when the default-single split policy clears
 * carried separately as `storySplitRules` (Story #5312).
 *
 * @returns {{ spec: string, acceptance: string, story: string, storySplitRules: string }}
 */
export function buildSystemPrompts() {
  return {
    spec: renderTechSpecSystemPrompt(),
    acceptance: renderAcceptanceSpecSystemPrompt(),
    story: renderStoryAuthorCore(),
    storySplitRules: renderStorySplitRules(),
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
 * Gather the independent envelope inputs — the open-Story duplicate search,
 * the folded authoring context, the inline docs digest, and (Story #5155) the
 * open-Epic and cross-plan-dependency candidate lists — under bounded
 * concurrency (Story #4952).
 *
 * None of them reads a value the others produce, so the result is a pure
 * function of `seed` and the injected config: the assembled envelope is
 * **byte-identical** to the serial build for the same inputs, whichever order
 * the three happen to settle in. `concurrentMap` preserves input order, so the
 * destructuring below is positional and stable.
 *
 * `docsContextFiles` is emptied for the `buildAuthoringContext` call: the
 * per-plan digest-file path needs a plan id that does not exist yet — the
 * inline digest gathered alongside it replaces that pointer.
 *
 * @param {{
 *   seed: string,
 *   epicTitle: string,
 *   excludeIds?: Iterable<number|string>,
 *   provider: object,
 *   config: object,
 *   settings: object,
 *   cwd?: string,
 * }} args
 * @returns {Promise<{
 *   duplicates: Array<object>,
 *   authoring: object,
 *   epicCandidates: Array<object>,
 *   dependencyCandidates: Array<object>,
 *   docsContext: { mode: 'digest-inline', digest: string }|null,
 * }>}
 */
async function gatherEnvelopeInputs({
  seed,
  epicTitle,
  excludeIds = [],
  predictedPaths = [],
  provider,
  config,
  settings,
  cwd,
}) {
  const paths = settings?.paths ?? {};
  const [
    duplicates,
    authoring,
    inlineDigest,
    epicCandidates,
    dependencyCandidates,
  ] = await concurrentMap(
    [
      () => searchStoryDuplicates({ seed, provider, config, excludeIds }),
      () =>
        buildAuthoringContext(
          0,
          /* provider (unused behind the prefetch seam) */ {},
          { ...settings, docsContextFiles: [] },
          {
            epic: { id: 0, title: epicTitle, body: seed },
            github: config.github ?? null,
            cwd,
            // Story #5182 — the memory-hygiene advisory's two thresholds.
            // They live on `planning`, not the `project` block `settings`
            // carries, so they ride the opts bag rather than that legacy one.
            memoryPool: config.planning?.memoryPool ?? null,
          },
        ),
      () =>
        buildDocsDigest({
          docsContextFiles: settings?.docsContextFiles,
          docsRoot: paths.docsRoot,
        }),
      // Story #5155 — the two cross-plan lookups. Both are advisory triage
      // lists offered at Gate #3, independent of every other gather and of
      // each other, so they join the same bounded fan-out rather than adding
      // two more serial round-trips to the operator's wait.
      () =>
        findOpenEpicCandidates({
          seed,
          provider,
          owner: config.github?.owner,
          repo: config.github?.repo,
        }),
      () =>
        findDependencyCandidates({
          predictedPaths,
          provider,
          owner: config.github?.owner,
          repo: config.github?.repo,
          excludeIds,
        }),
    ],
    (gather) => gather(),
    // The per-mode envelope gathers (Story #4952): the duplicate search, the
    // authoring-context fold and the docs digest have no data dependency on
    // one another, so their serialization was incidental and `/mandrel-plan` paid it
    // with the operator waiting at Gate #1.
    { concurrency: FANOUT_CONCURRENCY },
  );

  return {
    duplicates,
    authoring,
    epicCandidates,
    dependencyCandidates,
    docsContext:
      inlineDigest == null
        ? null
        : { mode: 'digest-inline', digest: inlineDigest },
  };
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

  // Hoisted above the gather (Story #5155): the dependency-candidate lookup
  // intersects against `predictedPaths`, so the signals have to exist before
  // the fan-out starts. `buildComplexitySignals` is synchronous and reads
  // nothing the gather produces, so hoisting it changes cost, not output.
  const complexitySignals = withAdvisorySignals(
    buildComplexitySignals({ seedText: content, cwd }),
    { config, cwd },
  );

  // Dup search, the authoring-context fold grounded in the seed prose, the
  // inline docs digest and the two cross-plan candidate lists are independent
  // — gathered concurrently (Story #4952, Story #5155).
  const {
    duplicates,
    authoring,
    docsContext,
    epicCandidates,
    dependencyCandidates,
  } = await gatherEnvelopeInputs({
    seed: content,
    epicTitle: seedFilePath ?? 'seed',
    predictedPaths: complexitySignals.predictedPaths,
    provider,
    config,
    settings,
    cwd,
  });

  return {
    mode: modeLabel,
    seed: { path: seedFilePath ?? null, content },
    // Advisory complexity signals only: no route, no routing authority. The
    // nested `uiSurface` is the advisory /prototype offer — never an
    // automatic reroute.
    complexitySignals,
    duplicates,
    epicCandidates,
    dependencyCandidates,
    docsContext,
    bddRunner: authoring.bddRunner,
    bddScenarios: authoring.bddScenarios,
    memoryPoolAdvisory: authoring.memoryPoolAdvisory,
    priorFeedback: authoring.priorFeedback,
    ticketSchema: TICKET_SCHEMA_DESCRIPTOR,
    systemPrompts: buildSystemPrompts(),
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
    // `--tickets` source-ticket hydration: one independent read per id.
    { concurrency: FANOUT_CONCURRENCY },
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

  // Hoisted for the same reason as seed-file mode (Story #5155).
  const complexitySignals = withAdvisorySignals(
    buildComplexitySignals({ seedText: seed, cwd }),
    { config, cwd },
  );

  // Same independent gathers as seed-file mode, concurrent under the same
  // bound (Story #4952); only the source-ticket hydration above is a genuine
  // data dependency, because `seed` is derived from it.
  const {
    duplicates,
    authoring,
    docsContext,
    epicCandidates,
    dependencyCandidates,
  } = await gatherEnvelopeInputs({
    seed,
    epicTitle: sourceTickets[0]?.title ?? 'tickets',
    excludeIds: ticketIds,
    predictedPaths: complexitySignals.predictedPaths,
    provider,
    config,
    settings,
    cwd,
  });

  return {
    mode: 'tickets',
    sourceTickets,
    seed: { text: seed, path: null },
    complexitySignals,
    duplicates,
    epicCandidates,
    dependencyCandidates,
    docsContext,
    bddRunner: authoring.bddRunner,
    bddScenarios: authoring.bddScenarios,
    memoryPoolAdvisory: authoring.memoryPoolAdvisory,
    priorFeedback: authoring.priorFeedback,
    ticketSchema: TICKET_SCHEMA_DESCRIPTOR,
    systemPrompts: buildSystemPrompts(),
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
 * Parse a prior Story body into its acceptance criteria and delivered file
 * map. Total: an unparseable body degrades to empty lists (a delta envelope
 * grounded on whatever survived), never a throw.
 *
 * @param {string} priorBody
 * @returns {{ priorAcceptance: string[], deliveredFiles: string[] }}
 */
function extractPriorArtifacts(priorBody) {
  let parsed;
  try {
    parsed = parseStoryBody(priorBody).body;
  } catch {
    return { priorAcceptance: [], deliveredFiles: [] };
  }
  const priorAcceptance = Array.isArray(parsed.acceptance)
    ? parsed.acceptance.filter((a) => typeof a === 'string' && a.length > 0)
    : [];
  const deliveredFiles = Array.isArray(parsed.changes)
    ? parsed.changes
        .map((c) => (c && typeof c === 'object' ? c.path : c))
        .filter((p) => typeof p === 'string' && p.length > 0)
    : [];
  return { priorAcceptance, deliveredFiles };
}

/**
 * Build the amendment (delta) envelope — `plan-context --amends #<id>`
 * (Story #4741 AC-4, R3-A). The heavy-amendment counterpart to routing a
 * light amendment through the light path: instead of re-interrogating the
 * repo from scratch (`buildAuthoringContext`'s codebase snapshot and the BDD /
 * memory / feedback probes), the envelope composes a DELTA from what already
 * exists — the prior Story's body, its acceptance criteria (the real
 * contract), and its delivered file map — so a follow-up change plans from the
 * shape already shipped.
 *
 * The semantic steps that reach the ticket are preserved: the open-Story
 * duplicate search (excluding the amended Story itself) and the authoring
 * system prompts still ride the envelope. What is
 * dropped is only the from-scratch repo interrogation the prior artifacts
 * already stand in for — that is the round-trip diet, not an amputation.
 *
 * @param {{
 *   amendsId: number,
 *   provider: object,
 *   config: object,
 *   settings: object,
 *   cwd?: string,
 * }} args
 * @returns {Promise<object>}
 */
async function buildAmendmentModeEnvelope({
  amendsId,
  provider,
  config,
  settings: _settings,
  cwd,
}) {
  if (!provider || typeof provider.getTicket !== 'function') {
    throw new Error(
      '[plan-context] --amends requires provider.getTicket() to load the prior Story.',
    );
  }
  const prior = await provider.getTicket(amendsId);
  if (!prior) {
    throw new Error(
      `[plan-context] --amends #${amendsId}: prior Story not found — nothing to amend.`,
    );
  }
  const priorBody = typeof prior.body === 'string' ? prior.body : '';
  const { priorAcceptance, deliveredFiles } = extractPriorArtifacts(priorBody);

  // Story #4952 — this builder's independent-gather set has exactly one
  // member. `provider.getTicket` above is a hard data dependency (the prior
  // body IS the seed), and the mode deliberately carries no authoring-context
  // fold and no docs digest — the prior artifacts are the grounding. It still
  // goes through the same bounded gather as the other two builders so one file
  // does not carry two ways of gathering independent envelope inputs.
  const [duplicates] = await concurrentMap(
    [
      () =>
        searchStoryDuplicates({
          seed: priorBody,
          provider,
          config,
          excludeIds: [amendsId],
        }),
    ],
    (gather) => gather(),
    // Same independent-gather fan-out as the seed-mode envelope above.
    { concurrency: FANOUT_CONCURRENCY },
  );

  return {
    mode: 'amends',
    amends: {
      id: Number(prior.id ?? prior.number ?? amendsId),
      title: prior.title ?? '',
      priorBody,
      priorAcceptance,
      deliveredFiles,
    },
    // The prior body is the seed the delta is authored against.
    seed: { text: priorBody, path: null },
    complexitySignals: withAdvisorySignals(
      buildComplexitySignals({ seedText: priorBody, cwd }),
      { config, cwd },
    ),
    duplicates,
    // No plan temp dir and no from-scratch repo interrogation — the prior
    // artifacts are the grounding, so there is no docs digest to anchor.
    docsContext: null,
    ticketSchema: TICKET_SCHEMA_DESCRIPTOR,
    systemPrompts: buildSystemPrompts(),
    planState: null,
    planProfile: 'story-amendment',
  };
}

/**
 * Build the single planner-context envelope.
 *
 * Every mode returns through here, which makes this the one place the
 * envelope's total size is decided — and therefore the only honest place to
 * bound it (see {@link capPlanContextEnvelope}).
 *
 * @param {{
 *   mode: 'seed-file'|'seed'|'tickets'|'amends',
 *   seedFilePath?: string,
 *   seedFileContent?: string,
 *   seedText?: string,
 *   ticketIds?: number[],
 *   amendsId?: number,
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
  amendsId,
  provider,
  config = {},
  settings = {},
  cwd,
}) {
  return capPlanContextEnvelope(
    await buildPlanContextEnvelope({
      mode,
      seedFilePath,
      seedFileContent,
      seedText,
      ticketIds,
      amendsId,
      provider,
      config,
      settings,
      cwd,
    }),
  );
}

/**
 * Mode dispatch for {@link buildPlanContext}. Split out so the ceiling cap
 * wraps every mode exactly once.
 */
async function buildPlanContextEnvelope({
  mode,
  seedFilePath,
  seedFileContent,
  seedText,
  ticketIds,
  amendsId,
  provider,
  config,
  settings,
  cwd,
}) {
  if (mode === 'amends') {
    return buildAmendmentModeEnvelope({
      amendsId,
      provider,
      config,
      settings,
      cwd,
    });
  }
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
    `[plan-context] unknown mode "${mode}" — expected "seed", "seed-file", "tickets", or "amends".`,
  );
}

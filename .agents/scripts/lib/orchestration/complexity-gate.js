/**
 * lib/orchestration/complexity-gate.js — shape-derived complexity routing
 * (Story #4722, superseding the word-count gate of Stories #4683/#4707).
 *
 * ## Route on the work, not the words
 *
 * The original gate routed a planning seed on its **word count**
 * (`maxSeedWords`), which is the wrong proxy in both directions: a detailed
 * prompt can describe trivial work, a terse one complex work. The bench
 * cohort (mandrel-bench 2.10.0) observed both failure modes — a lite verdict
 * fired at plan time and was then lost (a swallowed label write) or ignored
 * (deliver spawned a full story-worker anyway). This module now routes on the
 * **objective shape of the authored work**, staged across the pipeline:
 *
 *   1. **Plan time — signals, not routing.** {@link buildComplexitySignals}
 *      emits advisory complexity *signals* (enumerated-artifact count,
 *      risk-heuristic hits, repo state of predicted paths, sensitive-path
 *      classes) carrying **no routing authority**. There is no word ceiling.
 *   2. **Planner judgment, ledgered.** The planner owns the
 *      trivial-vs-standard verdict ({@link resolvePlannerRouteVerdict}) —
 *      `lite` only with a recorded reason, persisted on plan state. This
 *      generalizes the former one-way `applyPlannerDowngrade` seam into the
 *      authored verdict itself; the conservative default without a recorded
 *      reason is `full`.
 *   3. **Deterministic backstop at persist.** After authoring, the work has
 *      measurable shape: {@link deriveStoryShape} reads the Story's own
 *      `changes[]` count, acceptance-criteria count, creates-vs-refactors
 *      mix, and sensitive-path classes against {@link STORY_SHAPE_CEILINGS}.
 *      A `lite` claim whose shape exceeds the ceilings **fails closed to
 *      `full`** (`run-plan-persist.js`).
 *   4. **Deliver re-derives.** `/deliver` computes the route from the fetched
 *      Story body via the **same** shape function at dispatch
 *      ({@link resolveStoryDispatchMode}) and honors it: a lite-shaped Story
 *      executes inline — no story-worker sub-agent boot, no fresh
 *      acceptance-critic dispatch — while every `single-story-close.js` gate
 *      runs unchanged. The `route::lite` label is a **human-visible hint
 *      only**, never the control signal: a lost label or an unread marker can
 *      no longer misroute delivery. Ahead of the shape read sits one
 *      shape-independent rule (Story #4736): a **single-Story run** is inline
 *      whatever its shape, because sub-agent isolation buys nothing when
 *      there is no concurrent sibling to isolate from.
 *
 * The shape taxonomy is deliberately the one `review-depth.js` already
 * applies to the landed diff at close (`deriveChangeLevel` over the
 * `audit-rules.json` sensitive-path classes): **predicted shape at dispatch,
 * actual diff at close** — one taxonomy, two read points. And sensitivity
 * always wins: a small change whose footprint intersects a sensitive-path
 * class routes `full`, which keeps its fresh acceptance critic
 * (`ceremony-routing.js` routes a high derived level to a fresh spawn).
 *
 * ## What "lite" changes and — critically — what it never changes
 *
 * The lite route collapses the **advisory ceremony** only: the story-worker
 * sub-agent boot and the fresh acceptance-critic spawn. It **never** relaxes
 * a non-negotiable. {@link LITE_PATH_INVARIANTS} is the machine-readable
 * contract that the lite path still produces a Story ticket, still lands via
 * a PR to `main`, still runs every repo quality gate, and still honours
 * `rules/security-baseline.md`. Those gates run in `single-story-close.js`
 * regardless of route; the router cannot and does not switch them off.
 *
 * ## Configuration
 *
 * Operators tune the surface via `planning.complexityGate` in `.agentrc.json`:
 *
 *   - `enabled`      (default `true`) — `false` disables lite routing
 *     everywhere: persist refuses lite claims and dispatch always takes the
 *     sub-agent path.
 *   - `maxArtifacts` (default `1`)    — enumerated-artifact signal threshold;
 *     an **input signal** for the planner, no longer a deterministic router.
 *
 * `maxSeedWords` is **removed** (hard cutover): word count routes nothing.
 *
 * @typedef {'lite'|'full'} ComplexityRoute
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  extractChangePaths,
  parse as parseStoryBody,
} from '../story-body/story-body.js';
import { deriveChangeLevel } from './review-depth.js';

/**
 * Framework defaults for the complexity-routing surface. The SSOT the config
 * schema mirror and the configuration reference both cite. `maxSeedWords` is
 * gone: seed word count carries no routing authority (Story #4722).
 */
const DEFAULT_COMPLEXITY_GATE = Object.freeze({
  enabled: true,
  maxArtifacts: 1,
});

/**
 * The persisted route marker for a lite-routed Story.
 *
 * **A human-visible hint only (Story #4722)** — never the control signal.
 * Persist still applies it so a lite cohort is filterable in the GitHub UI,
 * but `/deliver` derives the route from the Story body's own shape
 * ({@link resolveStoryDispatchMode}); a Story with the label whose shape
 * derives `full` dispatches as a sub-agent, and a lite-shaped Story with the
 * label absent (or its write failed) still executes inline.
 */
export const LITE_ROUTE_LABEL = 'route::lite';

/**
 * Shape ceilings a Story must fit for the `lite` route
 * ({@link deriveStoryShape}). Framework constants, not operator knobs — a
 * ceiling an operator can widen past what the inline path can safely absorb
 * is a ceiling that fails silently. Conservative by construction: `lite` is
 * for genuinely trivial, mostly-additive, non-sensitive scopes.
 *
 *   - `maxChanges`          — total `changes[]` entries (e.g. one artifact
 *                             plus its test).
 *   - `maxAcceptance`       — acceptance-criteria count; more criteria means
 *                             more contract than a trivial scope carries.
 *   - `maxNonCreateChanges` — entries whose assumption is not `creates`
 *                             (refactors-existing / deletes / exists). A lite
 *                             change is mostly additive; touching existing
 *                             surfaces is where trivial-looking work stops
 *                             being trivial.
 *
 * Module-private, exposed as the `ceilings` field on every
 * {@link deriveStoryShape} decision — so there is no test-only export to
 * leave production-dead.
 */
const STORY_SHAPE_CEILINGS = Object.freeze({
  maxChanges: 2,
  maxAcceptance: 3,
  maxNonCreateChanges: 1,
});

/**
 * The non-negotiables the ceremony-lite path preserves (Story #4683 AC-2):
 * collapsing ceremony never means dropping the Story ticket, the PR-to-`main`
 * landing, the repo quality gates, or the security baseline. Attached
 * verbatim to every route decision's `preserves` field so a downstream reader
 * (or contract test) can assert the invariants held on either route.
 */
const LITE_PATH_INVARIANTS = Object.freeze({
  storyTicket: true,
  prToMain: true,
  repoGates: true,
  securityBaseline: true,
});

/**
 * Coerce a candidate ceiling into a non-negative integer, falling back to the
 * framework default for anything malformed — a stray `-1` or `NaN` must never
 * widen the lite path (fail conservative).
 *
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function normalizeCeiling(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.floor(value);
}

/**
 * Resolve the effective complexity-gate config, shallow-overlaying an
 * operator `planning.complexityGate` block onto
 * {@link DEFAULT_COMPLEXITY_GATE}. Accepts the full resolved config, the bare
 * `planning` bag, or the bare `complexityGate` bag, mirroring the tolerant
 * unwrap the other routing accessors use.
 *
 * Exported for persist (`run-plan-persist.js#resolveEffectiveRoute`), which
 * consults `enabled` to refuse a planner lite claim when the gate is off —
 * the schema's documented contract, and the same switch dispatch reads in
 * {@link resolveStoryDispatchMode}, so the two read points cannot disagree
 * about whether lite routing is live.
 *
 * @param {object | null | undefined} config
 * @returns {{ enabled: boolean, maxArtifacts: number }}
 */
export function resolveComplexityGate(config) {
  const raw =
    config?.planning?.complexityGate ?? config?.complexityGate ?? config ?? {};
  const bag = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled:
      typeof bag.enabled === 'boolean'
        ? bag.enabled
        : DEFAULT_COMPLEXITY_GATE.enabled,
    maxArtifacts: normalizeCeiling(
      bag.maxArtifacts,
      DEFAULT_COMPLEXITY_GATE.maxArtifacts,
    ),
  };
}

/**
 * Count top-level enumerated items (`- `, `* `, `1. `) in a free-form seed —
 * each enumerated line is one predicted artifact.
 *
 * @param {string} text
 * @returns {number}
 */
function countSeedArtifacts(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  return text
    .split(/\r?\n/)
    .filter((line) => /^\s*(?:[-*]|\d+\.)\s+\S/.test(line)).length;
}

/** Cap on predicted-path extraction, to bound pathological seeds. */
const MAX_PREDICTED_PATHS = 50;

/**
 * Extract path-like tokens (at least one `/` plus a dotted extension) from a
 * free-form seed — the predicted footprint the sensitive-path and repo-state
 * signals classify.
 *
 * @param {string} text
 * @returns {string[]} Deduplicated, in order of first appearance.
 */
function extractPredictedPaths(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const re = /(?:^|[\s`'"([])((?:[\w@.-]+\/)+[\w@.-]+\.[A-Za-z0-9]{1,8})/gm;
  const seen = new Set();
  let match = re.exec(text);
  while (match !== null && seen.size < MAX_PREDICTED_PATHS) {
    seen.add(match[1]);
    match = re.exec(text);
  }
  return [...seen];
}

/**
 * Build the advisory complexity **signals** for a planning seed
 * (Story #4722 AC-2). Signals, not routing: the result carries
 * `routingAuthority: false` and no `route` field — the planner reads these
 * alongside its own judgment ({@link resolvePlannerRouteVerdict}) and the
 * deterministic shape backstop validates the authored Story at persist.
 *
 *   - `artifactCount`         — enumerated items in the seed, with the
 *                               configured `maxArtifacts` threshold beside it
 *                               as one input signal.
 *   - `riskHeuristicHits`     — `planning.riskHeuristics` phrases present in
 *                               the seed (same substring matcher the
 *                               pre-mortem critic uses).
 *   - `predictedPaths` / `repoState` — path-like tokens in the seed and
 *                               which of them exist in the repo (existing
 *                               paths predict refactors; missing predict
 *                               creates).
 *   - `sensitivePathClasses`  — `audit-rules.json` sensitive-path classes the
 *                               predicted footprint intersects (the same
 *                               taxonomy close applies to the landed diff).
 *
 * Total: never throws; a failed classification degrades to an empty class
 * list (the honest "no signal", never a verdict).
 *
 * @param {{
 *   seedText?: string,
 *   config?: object,
 *   riskHeuristics?: string[],
 *   cwd?: string,
 *   pathExistsFn?: (absPath: string) => boolean,
 *   injectedRules?: object,
 *   selectSensitivePathClassesFn?: Function,
 * }} [args]
 * @returns {{
 *   artifactCount: number,
 *   maxArtifacts: number,
 *   riskHeuristicHits: string[],
 *   predictedPaths: string[],
 *   repoState: { existingPaths: string[], missingPaths: string[] },
 *   sensitivePathClasses: string[],
 *   gate: { enabled: boolean },
 *   advisory: true,
 *   routingAuthority: false,
 * }}
 */
export function buildComplexitySignals({
  seedText = '',
  config,
  riskHeuristics = [],
  cwd,
  pathExistsFn = existsSync,
  injectedRules,
  selectSensitivePathClassesFn,
} = {}) {
  const gate = resolveComplexityGate(config);
  const text = typeof seedText === 'string' ? seedText : '';
  const haystack = text.toLowerCase();

  const riskHeuristicHits = (
    Array.isArray(riskHeuristics) ? riskHeuristics : []
  ).filter(
    (phrase) =>
      typeof phrase === 'string' &&
      phrase.trim().length > 0 &&
      haystack.includes(phrase.trim().toLowerCase()),
  );

  const predictedPaths = extractPredictedPaths(text);
  const root = typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd();
  const existingPaths = [];
  const missingPaths = [];
  for (const p of predictedPaths) {
    let exists = false;
    try {
      exists = pathExistsFn(path.resolve(root, p)) === true;
    } catch {
      exists = false;
    }
    (exists ? existingPaths : missingPaths).push(p);
  }

  const { classes } = deriveChangeLevel({
    changedFiles: predictedPaths,
    injectedRules,
    selectSensitivePathClassesFn,
  });

  return {
    artifactCount: countSeedArtifacts(text),
    maxArtifacts: gate.maxArtifacts,
    riskHeuristicHits,
    predictedPaths,
    repoState: { existingPaths, missingPaths },
    sensitivePathClasses: classes,
    gate: { enabled: gate.enabled },
    advisory: /** @type {const} */ (true),
    routingAuthority: /** @type {const} */ (false),
  };
}

/**
 * Resolve the planner's authored trivial-vs-standard verdict
 * (Story #4722 AC-2, generalizing the former one-way `applyPlannerDowngrade`
 * seam into the verdict itself).
 *
 * The planner — not a word count — owns the judgment, and the contract keeps
 * it auditable: `lite` **only** with a non-empty recorded reason (carried on
 * `authored` and ledgered on every created Story's `story-plan-state`
 * checkpoint by persist). Absent a recorded reason the conservative default
 * stands: `full`, with `authored: null`. Pure and total.
 *
 * The verdict is a **claim**, not the decision — persist validates it against
 * the authored Story's shape ({@link deriveStoryShape}) and fails closed to
 * `full` when the shape exceeds the ceilings.
 *
 * @param {{ reason?: unknown }} [args]
 * @returns {{
 *   route: ComplexityRoute,
 *   reasons: string[],
 *   authored: Readonly<{ route: 'lite', reason: string }>|null,
 *   preserves: typeof LITE_PATH_INVARIANTS,
 * }}
 */
export function resolvePlannerRouteVerdict({ reason } = {}) {
  const recorded = typeof reason === 'string' ? reason.trim() : '';
  if (recorded === '') {
    return {
      route: 'full',
      reasons: [
        'no authored lite verdict (no recorded reason) — standard full route',
      ],
      authored: null,
      preserves: LITE_PATH_INVARIANTS,
    };
  }
  return {
    route: 'lite',
    reasons: [`planner verdict: lite (recorded reason): ${recorded}`],
    authored: Object.freeze({ route: 'lite', reason: recorded }),
    preserves: LITE_PATH_INVARIANTS,
  };
}

/**
 * Derive the complexity route from an authored Story's **objective shape**
 * (Story #4722 AC-3/AC-4) — the single shape function persist's backstop and
 * `/deliver`'s dispatch derivation both read, so the two can never disagree
 * about the same body.
 *
 * `lite` requires **every** signal to agree, against
 * {@link STORY_SHAPE_CEILINGS}:
 *
 *   - a declared, parseable, glob-free `changes[]` footprint of at most
 *     `maxChanges` entries, at most `maxNonCreateChanges` of which touch
 *     existing surfaces (creates-vs-refactors mix);
 *   - at most `maxAcceptance` acceptance criteria (and at least one — a Story
 *     with no contract cannot be judged trivial);
 *   - a footprint intersecting **no** sensitive-path class
 *     (`deriveChangeLevel`, the taxonomy close applies to the landed diff).
 *     Sensitivity always wins (AC-6): a sensitive footprint routes `full`,
 *     which keeps the fresh acceptance critic via `ceremony-routing.js`.
 *
 * Everything else — including an unknown/undeclared footprint or an
 * unreadable sensitive-path manifest — fails toward `full`. Total: never
 * throws.
 *
 * @param {{
 *   changes?: unknown,
 *   acceptance?: unknown,
 *   injectedRules?: object,
 *   selectSensitivePathClassesFn?: Function,
 * }} [args]
 * @returns {{
 *   route: ComplexityRoute,
 *   reasons: string[],
 *   shape: {
 *     changeCount: number,
 *     acceptanceCount: number,
 *     createCount: number,
 *     nonCreateCount: number,
 *     sensitiveClasses: string[],
 *   }|null,
 *   ceilings: typeof STORY_SHAPE_CEILINGS,
 *   preserves: typeof LITE_PATH_INVARIANTS,
 * }}
 */
export function deriveStoryShape({
  changes,
  acceptance,
  injectedRules,
  selectSensitivePathClassesFn,
} = {}) {
  const ceilings = STORY_SHAPE_CEILINGS;
  const preserves = LITE_PATH_INVARIANTS;
  const decide = (route, reason, shape = null) => ({
    route,
    reasons: [reason],
    shape,
    ceilings,
    preserves,
  });

  if (!Array.isArray(changes) || changes.length === 0) {
    return decide(
      'full',
      'no changes[] declared — the footprint is unknown, so the shape cannot be judged trivial; conservative full route',
    );
  }

  let entries;
  try {
    entries = extractChangePaths(changes);
  } catch (err) {
    return decide(
      'full',
      `changes[] could not be read (${err?.message ?? err}) — unknown footprint; conservative full route`,
    );
  }

  const acceptanceList = Array.isArray(acceptance) ? acceptance : [];
  const nonCreateCount = changes.filter(
    (entry) =>
      !(entry && typeof entry === 'object' && entry.assumption === 'creates'),
  ).length;
  const { level, classes } = deriveChangeLevel({
    changedFiles: entries.map((e) => e.path),
    injectedRules,
    selectSensitivePathClassesFn,
  });
  const shape = {
    changeCount: changes.length,
    acceptanceCount: acceptanceList.length,
    createCount: changes.length - nonCreateCount,
    nonCreateCount,
    sensitiveClasses: classes,
  };

  if (entries.some((e) => e.isGlob)) {
    return decide(
      'full',
      'changes[] contains a glob path — unknown footprint width; conservative full route',
      shape,
    );
  }
  if (shape.changeCount > ceilings.maxChanges) {
    return decide(
      'full',
      `changes[] declares ${shape.changeCount} entries (> maxChanges ${ceilings.maxChanges}) — not a trivial footprint; full route`,
      shape,
    );
  }
  if (shape.acceptanceCount === 0) {
    return decide(
      'full',
      'no acceptance criteria — the contract cannot be judged trivial; conservative full route',
      shape,
    );
  }
  if (shape.acceptanceCount > ceilings.maxAcceptance) {
    return decide(
      'full',
      `${shape.acceptanceCount} acceptance criteria (> maxAcceptance ${ceilings.maxAcceptance}) — more contract than a trivial scope carries; full route`,
      shape,
    );
  }
  if (shape.nonCreateCount > ceilings.maxNonCreateChanges) {
    return decide(
      'full',
      `${shape.nonCreateCount} non-create change(s) (> maxNonCreateChanges ${ceilings.maxNonCreateChanges}) — a mostly-refactoring mix is not a trivial additive scope; full route`,
      shape,
    );
  }
  if (shape.sensitiveClasses.length > 0) {
    return decide(
      'full',
      `footprint intersects sensitive-path class(es) ${shape.sensitiveClasses.join(', ')} — sensitivity wins over a small shape; full route (fresh acceptance critic retained)`,
      shape,
    );
  }
  if (level !== 'low') {
    // `deriveChangeLevel` degraded to its null fail-safe (unreadable
    // manifest / failed selector): there is no evidence the footprint is
    // non-sensitive, and a classification failure must never buy lite.
    return decide(
      'full',
      'sensitive-path classification unavailable — cannot verify the footprint is non-sensitive; conservative full route',
      shape,
    );
  }

  return decide(
    'lite',
    `trivial shape: ${shape.changeCount} change(s) ≤ ${ceilings.maxChanges}, ${shape.acceptanceCount} acceptance criteria ≤ ${ceilings.maxAcceptance}, ${shape.nonCreateCount} non-create ≤ ${ceilings.maxNonCreateChanges}, no sensitive-path class — inline-eligible; non-negotiables preserved`,
    shape,
  );
}

/**
 * Derive the complexity route from a Story's **serialized body markdown** —
 * the deliver-side entry to {@link deriveStoryShape} (`/deliver` already
 * fetches the body; the route is computed from it, never from a label). An
 * unparseable body degrades to `full`: unknown shape is not trivial shape.
 *
 * Module-private, reachable end to end through
 * {@link resolveStoryDispatchMode} (which returns the derived route) — so
 * there is no test-only export to leave production-dead.
 *
 * @param {string} body Serialized Story-body markdown.
 * @param {{ injectedRules?: object, selectSensitivePathClassesFn?: Function }} [opts]
 * @returns {ReturnType<typeof deriveStoryShape>}
 */
function deriveStoryRouteFromBody(body, opts = {}) {
  let parsed;
  try {
    parsed = parseStoryBody(String(body ?? '')).body;
  } catch (err) {
    return {
      route: 'full',
      reasons: [
        `Story body is unparseable (${err?.message ?? err}) — shape unknown; conservative full route`,
      ],
      shape: null,
      ceilings: STORY_SHAPE_CEILINGS,
      preserves: LITE_PATH_INVARIANTS,
    };
  }
  return deriveStoryShape({
    changes: parsed?.changes,
    acceptance: parsed?.acceptance,
    injectedRules: opts.injectedRules,
    selectSensitivePathClassesFn: opts.selectSensitivePathClassesFn,
  });
}

/**
 * Best-effort route derivation for reporting, when the *mode* is already
 * pinned by run topology and only `route` remains to be filled in. A body
 * that will not parse yields `null` rather than throwing — the caller is not
 * asking the shape to decide anything.
 *
 * @param {unknown} body
 * @param {{ injectedRules?: object, selectSensitivePathClassesFn?: Function }} opts
 * @returns {ReturnType<typeof deriveStoryShape>|null}
 */
function routeForReporting(body, opts) {
  if (typeof body !== 'string' || body.trim() === '') return null;
  return deriveStoryRouteFromBody(body, opts);
}

/**
 * Decide how `/deliver` executes a Story.
 *
 * Two independent premises, checked in this order:
 *
 * 1. **Run topology (Story #4736).** A run delivering a *single* Story
 *    executes **inline**, whatever its shape. Sub-agent isolation is
 *    load-bearing only for CONCURRENT dispatch — two workers sharing a
 *    checkout would race on worktrees and branch refs — and a one-Story run
 *    has no sibling to race. It therefore pays the spawn premium (a boot is
 *    a cache WRITE at full rate, where an inline continuation is a cache read
 *    at ~10%; ~$1.43/M vs ~$1.07/M on comparable bench work) for nothing.
 *    This is a fact about the run, not about the work, so the shape gate's
 *    `enabled` switch — which governs *shape derivation* — does not reach it.
 * 2. **Shape (Story #4722 AC-4/AC-5).** For a multi-Story run, the decision
 *    comes **from the Story body's own shape**, never from the `route::lite`
 *    label: a lite-shaped Story executes inline; everything else — a
 *    full-shaped body, a missing/unparseable body, or the gate disabled via
 *    `planning.complexityGate.enabled=false` — dispatches as a sub-agent,
 *    the conservative default.
 *
 * The label is read only to report hint consistency in `reasons`: with the
 * label absent (or its write failed) a lite-shaped Story still runs inline,
 * and with the label present on a full-shaped Story the shape wins.
 *
 * Inline execution removes model-side fan-out only — it changes **where** the
 * engine runs, never **what** runs. Every deterministic
 * `single-story-close.js` gate, the PR to `main`, and the
 * `story-deliver-terminal` envelope are identical in both modes; see the
 * module header's non-negotiables.
 *
 * @param {{
 *   body?: unknown,
 *   labels?: unknown,
 *   config?: object,
 *   storyCount?: unknown,
 *   injectedRules?: object,
 *   selectSensitivePathClassesFn?: Function,
 * }} [args] `storyCount` is the number of Stories the invoking `/deliver` run
 *   resolved. Omitted (or not a positive integer) means "unknown run size",
 *   which falls through to the shape decision — never to an assumed 1.
 * @returns {{ mode: 'inline'|'subagent', reasons: string[], route: ReturnType<typeof deriveStoryShape>|null }}
 */
export function resolveStoryDispatchMode({
  body,
  labels,
  config,
  storyCount,
  injectedRules,
  selectSensitivePathClassesFn,
} = {}) {
  const labelList = Array.isArray(labels)
    ? labels.filter((l) => typeof l === 'string')
    : [];
  const hasHint = labelList.includes(LITE_ROUTE_LABEL);
  const hintNote = hasHint
    ? `the ${LITE_ROUTE_LABEL} label is present (hint only — the derived shape is the control signal)`
    : `the ${LITE_ROUTE_LABEL} label is absent (hint only — the derived shape is the control signal)`;

  if (storyCount === 1) {
    return {
      mode: 'inline',
      reasons: [
        'single-Story run — execute deliver-story inline; sub-agent isolation is load-bearing only for concurrent dispatch, and a one-Story run has no sibling to race (close gates, PR, and terminal envelope unchanged)',
        hintNote,
      ],
      route: routeForReporting(body, {
        injectedRules,
        selectSensitivePathClassesFn,
      }),
    };
  }

  const gate = resolveComplexityGate(config);
  if (!gate.enabled) {
    return {
      mode: 'subagent',
      reasons: [
        'complexity routing disabled (planning.complexityGate.enabled=false) — standard sub-agent dispatch',
      ],
      route: null,
    };
  }

  if (typeof body !== 'string' || body.trim() === '') {
    return {
      mode: 'subagent',
      reasons: [
        'no Story body to derive shape from — conservative sub-agent dispatch',
        hintNote,
      ],
      route: null,
    };
  }

  const route = deriveStoryRouteFromBody(body, {
    injectedRules,
    selectSensitivePathClassesFn,
  });
  if (route.route === 'lite') {
    return {
      mode: 'inline',
      reasons: [
        `lite-shaped Story — execute deliver-story inline; no story-worker or acceptance-critic sub-agent dispatch (close gates unchanged): ${route.reasons[0]}`,
        hintNote,
      ],
      route,
    };
  }
  return {
    mode: 'subagent',
    reasons: [`full-shaped Story — ${route.reasons[0]}`, hintNote],
    route,
  };
}

/**
 * lib/orchestration/light-suitability.js — the `/deliver-light` suitability
 * gate and diff backstop (Story #4740).
 *
 * ## Why a light entry point exists
 *
 * mandrel-bench 2.12.0 forensics attributed the framework arm's cost to
 * **session multiplication** — repeated cold framework boots (2 for a one-file
 * greenfield build, 4 for a change request) — where the bare control does
 * comparable small work in a single session, lacking only the quality gates
 * and the landing guarantee. `/deliver-light` closes that gap: one session
 * straight to execution from an operator prompt, landing through the
 * **unchanged** `single-story-close.js` path. This module is the reusable
 * decision core the light workflow drives; it owns **no** git, branch, PR, or
 * label mutation — those stay in the shared engine scripts.
 *
 * ## Four invariants keep it proportional, not a planning bypass
 *
 *   1. **Suitability gate ({@link deriveLightSuitability}).** The prompt's
 *      predicted footprint is judged by the **shared shape machinery**
 *      ({@link module:lib/orchestration/complexity-gate.deriveStoryShape} over
 *      {@link module:lib/orchestration/complexity-gate.STORY_SHAPE_CEILINGS})
 *      **and** a ledgered model verdict carrying a recorded reason
 *      ({@link resolveLedgeredVerdict}). Both must agree on `lite`; either
 *      falling short fails closed to `full`.
 *   2. **Over-scope stops, never silently proceeds ({@link
 *      resolveLightGateOutcome}).** An over-ceiling prompt does **not**
 *      hard-fail — it STOPS and asks the operator to escalate to `/plan` or
 *      proceed light. Under `--yes` (unattended) it fails closed to
 *      recommending `/plan`.
 *   3. **Diff-derived backstop ({@link checkLightDiffBackstop}).** After
 *      implementation the **actual** change set is re-checked with
 *      {@link module:lib/orchestration/review-depth.deriveChangeLevel} plus a
 *      file-count ceiling — the diff is the real scope signal — and an
 *      over-ceiling diff is blocked rather than landed silently.
 *   4. **Minimal receipt Story ({@link buildReceiptStoryTicket}).** A
 *      `type::story` ticket is authored inline so `refs #`, history, telemetry,
 *      and the `agent::executing -> agent::done` state machine survive.
 *
 * Every function here is pure and total: inputs in, decision out, no I/O and no
 * throws (except {@link buildReceiptStoryTicket}, which rejects an empty
 * prompt — a receipt with no prompt has nothing to record).
 *
 * @module lib/orchestration/light-suitability
 */

import { deriveStoryShape, STORY_SHAPE_CEILINGS } from './complexity-gate.js';
import { deriveChangeLevel } from './review-depth.js';

/**
 * File-count ceiling for the **actual landed** change set the diff backstop
 * ({@link checkLightDiffBackstop}) enforces. The predicted-shape ceiling caps
 * `changes[]` at `maxChanges` (one artifact plus its test); the actual diff may
 * legitimately run a touch wider (a generated projection, a snapshot), but a
 * genuinely-light change stays small. Conservative by construction — a ceiling
 * an operator could widen past what a single session safely absorbs is a
 * ceiling that fails silently, so this is a framework constant, not a knob.
 */
export const LIGHT_DIFF_CEILINGS = Object.freeze({
  maxFiles: 4,
});

/**
 * Coerce a candidate `maxFiles` ceiling into a positive integer, falling back
 * to the framework default for anything malformed — a stray `0`, `-1`, or `NaN`
 * must never widen (or zero out) the light diff ceiling.
 *
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function normalizeMaxFiles(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    return fallback;
  }
  return Math.floor(value);
}

/**
 * Resolve the model's trivial-vs-standard verdict, held to the same ledgering
 * contract the planner's authored verdict is
 * ({@link module:lib/orchestration/complexity-gate.resolvePlannerRouteVerdict}):
 * a `lite` route counts **only** with a non-empty recorded reason. A lite claim
 * without a recorded reason, or any non-`lite` route, fails closed to `full` —
 * an unaudited "trust me, it's small" never buys the light path.
 *
 * Pure and total.
 *
 * @param {{ route?: unknown, reason?: unknown }} [verdict]
 * @returns {{
 *   route: 'lite'|'full',
 *   reason: string|null,
 *   recorded: boolean,
 *   note: string,
 * }}
 */
export function resolveLedgeredVerdict({ route, reason } = {}) {
  const recordedReason = typeof reason === 'string' ? reason.trim() : '';
  if (route !== 'lite') {
    return {
      route: 'full',
      reason: recordedReason || null,
      recorded: recordedReason !== '',
      note: 'model verdict is not lite — standard /plan route',
    };
  }
  if (recordedReason === '') {
    return {
      route: 'full',
      reason: null,
      recorded: false,
      note: 'lite claim without a recorded reason — fails closed to full (the verdict must be ledgered)',
    };
  }
  return {
    route: 'lite',
    reason: recordedReason,
    recorded: true,
    note: `model verdict: lite (recorded reason): ${recordedReason}`,
  };
}

/**
 * Judge whether an operator prompt's predicted footprint is suitable for the
 * light path. The deterministic shape derivation and the ledgered model verdict
 * must **both** agree on `lite`; anything else — an over-ceiling shape, a
 * sensitive-path footprint, an unledgered verdict — resolves to `full` (the
 * conservative default that routes the operator to `/plan`).
 *
 * Pure and total: never throws, never mutates its inputs.
 *
 * @param {{
 *   predictedChanges?: unknown,
 *   predictedAcceptance?: unknown,
 *   verdict?: { route?: unknown, reason?: unknown },
 *   injectedRules?: object,
 *   selectSensitivePathClassesFn?: Function,
 * }} [args]
 * @returns {{
 *   suitable: boolean,
 *   route: 'lite'|'full',
 *   shape: ReturnType<typeof deriveStoryShape>,
 *   ledger: ReturnType<typeof resolveLedgeredVerdict>,
 *   ceilings: typeof STORY_SHAPE_CEILINGS,
 *   reasons: string[],
 * }}
 */
export function deriveLightSuitability({
  predictedChanges,
  predictedAcceptance,
  verdict,
  injectedRules,
  selectSensitivePathClassesFn,
} = {}) {
  const ledger = resolveLedgeredVerdict(verdict ?? {});
  const shape = deriveStoryShape({
    changes: predictedChanges,
    acceptance: predictedAcceptance,
    injectedRules,
    selectSensitivePathClassesFn,
  });
  const suitable = shape.route === 'lite' && ledger.route === 'lite';
  return {
    suitable,
    route: suitable ? 'lite' : 'full',
    shape,
    ledger,
    ceilings: STORY_SHAPE_CEILINGS,
    reasons: [`shape: ${shape.reasons[0]}`, `verdict: ${ledger.note}`],
  };
}

/**
 * Resolve what the light gate does with a suitability decision (Story #4740
 * AC-3). Over-scope never hard-fails: it STOPS and asks the operator to choose,
 * unless the run is unattended (`--yes`), where it fails closed to recommending
 * `/plan` rather than silently proceeding light.
 *
 *   - suitable          → `proceed-light`
 *   - over-scope + attended (`yes:false`)  → `ask-operator` (escalate | proceed)
 *   - over-scope + unattended (`yes:true`) → `escalate-plan`
 *
 * Pure and total.
 *
 * @param {{ suitability?: { suitable?: boolean, reasons?: string[] }, yes?: boolean }} [args]
 * @returns {{ action: 'proceed-light'|'ask-operator'|'escalate-plan', options?: string[], reasons: string[] }}
 */
export function resolveLightGateOutcome({ suitability, yes = false } = {}) {
  const reasons = Array.isArray(suitability?.reasons)
    ? [...suitability.reasons]
    : [];

  if (suitability?.suitable === true) {
    return {
      action: 'proceed-light',
      reasons: [
        ...reasons,
        'predicted shape and ledgered verdict both lite — proceed light',
      ],
    };
  }

  if (yes === true) {
    return {
      action: 'escalate-plan',
      reasons: [
        ...reasons,
        '--yes on over-scope fails closed to /plan (never silently proceeds light)',
      ],
    };
  }

  return {
    action: 'ask-operator',
    options: ['escalate-plan', 'proceed-light'],
    reasons: [
      ...reasons,
      'predicted scope exceeds the light ceilings — STOP and ask the operator to escalate to /plan or proceed light',
    ],
  };
}

/**
 * Diff-derived backstop (Story #4740 AC-4): re-check the **actual** change set
 * after implementation, because the diff — not the prompt — is the real scope
 * signal. Blocks (rather than landing) when the diff intersects a sensitive-
 * path class, exceeds the file-count ceiling, or cannot be classified. A clean
 * result is the only path that lands light.
 *
 * Reuses close's own {@link module:lib/orchestration/review-depth.deriveChangeLevel}
 * — one taxonomy, applied to the predicted shape at the gate and the actual
 * diff here — so the two read points can never disagree about what is sensitive.
 *
 * Pure and total.
 *
 * @param {{
 *   changedFiles?: unknown,
 *   ceilings?: { maxFiles?: number },
 *   injectedRules?: object,
 *   selectSensitivePathClassesFn?: Function,
 * }} [args]
 * @returns {{
 *   blocked: boolean,
 *   level: 'low'|'high'|null,
 *   classes: string[],
 *   fileCount: number|null,
 *   ceilings: { maxFiles: number },
 *   reasons: string[],
 * }}
 */
export function checkLightDiffBackstop({
  changedFiles,
  ceilings,
  injectedRules,
  selectSensitivePathClassesFn,
} = {}) {
  const maxFiles = normalizeMaxFiles(
    ceilings?.maxFiles,
    LIGHT_DIFF_CEILINGS.maxFiles,
  );
  const files = Array.isArray(changedFiles)
    ? changedFiles.filter((f) => typeof f === 'string' && f.trim() !== '')
    : null;

  if (files === null || files.length === 0) {
    return {
      blocked: true,
      level: null,
      classes: [],
      fileCount: files === null ? null : 0,
      ceilings: { maxFiles },
      reasons: [
        'actual change set is unknown or empty — cannot verify the diff is light; escalate to /plan',
      ],
    };
  }

  const { level, classes } = deriveChangeLevel({
    changedFiles: files,
    injectedRules,
    selectSensitivePathClassesFn,
  });

  const reasons = [];
  if (classes.length > 0) {
    reasons.push(
      `diff intersects sensitive-path class(es) ${classes.join(', ')} — escalate to /plan (do not land light)`,
    );
  }
  if (files.length > maxFiles) {
    reasons.push(
      `diff touches ${files.length} file(s) (> maxFiles ${maxFiles}) — escalate to /plan (do not land light)`,
    );
  }
  if (level !== 'low' && classes.length === 0) {
    reasons.push(
      'sensitive-path classification unavailable — cannot verify the diff is non-sensitive; escalate to /plan',
    );
  }

  const blocked = reasons.length > 0;
  return {
    blocked,
    level,
    classes,
    fileCount: files.length,
    ceilings: { maxFiles },
    reasons: blocked
      ? reasons
      : [
          `diff is light: ${files.length} file(s) ≤ ${maxFiles}, no sensitive-path class — safe to land`,
        ],
  };
}

/** Cap on a receipt slug's length — keep the branch/id readable. */
const RECEIPT_SLUG_MAX = 48;

/**
 * Derive a stable, lowercase, hyphenated slug from a prompt.
 *
 * @param {string} text
 * @returns {string}
 */
function slugifyPrompt(text) {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, RECEIPT_SLUG_MAX)
    .replace(/-+$/g, '');
  return slug === '' ? 'light-change' : slug;
}

/** Cap on a receipt title's length. */
const RECEIPT_TITLE_MAX = 72;

/**
 * Coerce an `--amends` argument (`#123`, `123`, or `123` as a number) into a
 * positive integer issue number, or `null` when absent/malformed.
 *
 * @param {unknown} amends
 * @returns {number|null}
 */
function normalizeAmends(amends) {
  if (typeof amends === 'number' && Number.isInteger(amends) && amends > 0) {
    return amends;
  }
  if (typeof amends === 'string') {
    const match = amends.trim().match(/^#?(\d+)$/);
    if (match) {
      const n = Number.parseInt(match[1], 10);
      if (Number.isInteger(n) && n > 0) return n;
    }
  }
  return null;
}

/**
 * One-line receipt title from the prompt, prefixed for an amendment.
 *
 * @param {string} text
 * @param {number|null} amendsId
 * @returns {string}
 */
function deriveReceiptTitle(text, amendsId) {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  const prefix = amendsId !== null ? `Amend #${amendsId}: ` : '';
  const room = RECEIPT_TITLE_MAX - prefix.length;
  const body =
    oneLine.length > room
      ? `${oneLine.slice(0, room - 1).trimEnd()}…`
      : oneLine;
  return `${prefix}${body}`;
}

/**
 * Map an actual/predicted changed-file list into `changes[]` PathEntry objects
 * for the receipt body. Every entry is recorded as `refactors-existing` — the
 * conservative assumption, since the light path is not asserting creates.
 *
 * @param {unknown} changedFiles
 * @returns {Array<{ path: string, assumption: string }>}
 */
function toReceiptChanges(changedFiles) {
  const list = Array.isArray(changedFiles) ? changedFiles : [];
  const seen = new Set();
  const entries = [];
  for (const f of list) {
    if (typeof f !== 'string' || f.trim() === '' || seen.has(f.trim()))
      continue;
    seen.add(f.trim());
    entries.push({ path: f.trim(), assumption: 'refactors-existing' });
  }
  return entries;
}

/**
 * Build the minimal receipt `type::story` ticket for the light path
 * (Story #4740 AC-5) — the input `assemblePlanStories` / `createStoryIssues`
 * consume, so the light path reuses the plan-persist story-creation surface
 * rather than reimplementing issue authoring. The body carries the operator
 * prompt (goal + spec) and the diff-derived footprint (`changes[]`), so history
 * and `refs #<id>` on the commit survive.
 *
 * @param {{ prompt?: unknown, changedFiles?: unknown, amends?: unknown }} [args]
 * @returns {{ slug: string, title: string, body: object, labels: string[] }}
 */
export function buildReceiptStoryTicket({ prompt, changedFiles, amends } = {}) {
  const text = typeof prompt === 'string' ? prompt.trim() : '';
  if (text === '') {
    throw new Error(
      '[light-suitability] a non-empty prompt is required to build a receipt Story',
    );
  }
  const amendsId = normalizeAmends(amends);
  const amendNote = amendsId !== null ? ` Amends #${amendsId}.` : '';
  const changes = toReceiptChanges(changedFiles);

  return {
    slug: slugifyPrompt(text),
    title: deriveReceiptTitle(text, amendsId),
    labels: [],
    body: {
      goal: `${text}${amendNote}`,
      spec:
        `Delivered via /deliver-light as a validated single-session change — ` +
        `the /plan session is removed for genuinely small work while every ` +
        `single-story-close gate runs byte-identical.${amendNote} ` +
        `Operator prompt: ${text}`,
      changes,
      acceptance: [
        'The change described by the prompt is implemented and lands through ' +
          'the unchanged single-story-close path with every close gate passing.',
      ],
      verify: ['npm test (unit)'],
    },
  };
}

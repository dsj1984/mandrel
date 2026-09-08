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
 *      falling short fails closed to `full`. The shape axes are effort and
 *      risk — distinct change kinds, a coarse magnitude bucket, uncertainty,
 *      and epic-scope span — never artifact counts (Story #4764), so this gate
 *      is deliberately **coarse**: it rejects clearly-epic work, and invariant
 *      3 below does the real enforcement against ground truth.
 *   2. **Over-scope stops, never silently proceeds ({@link
 *      resolveLightGateOutcome}).** An over-ceiling prompt does **not**
 *      hard-fail — it STOPS and asks the operator to escalate to `/mandrel-plan` or
 *      proceed light. Both answers are executable: `proceed-light` is recorded
 *      through {@link resolveOperatorOverride}, which waives a *size
 *      prediction* only, never a risk rule, and only with a human present.
 *      Under `--yes` (unattended) it fails closed to recommending `/mandrel-plan`.
 *   3. **Diff-derived backstop ({@link checkLightDiffBackstop}).** After
 *      implementation the **actual** change set is re-checked with
 *      {@link module:lib/orchestration/review-depth.deriveChangeLevel} plus the
 *      implementation-only magnitude ceilings of {@link LIGHT_DIFF_CEILINGS} —
 *      the diff is the real scope signal — and an over-ceiling diff is blocked
 *      rather than landed silently. Story #4856 moved this from a `maxFiles: 4`
 *      cardinality ceiling to changed lines over implementation files, and made
 *      a block **recycle** its receipt Story through `/mandrel-plan` tickets mode
 *      instead of orphaning it.
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

import {
  deriveStoryShape,
  SHAPE_CODES,
  STORY_SHAPE_CEILINGS,
} from './complexity-gate.js';
import { deriveChangeLevel } from './review-depth.js';

/**
 * The shape objections an attended operator may waive (Story #4815) — an
 * **allowlist**, deliberately, so a rule added to
 * {@link module:lib/orchestration/complexity-gate.SHAPE_CODES} later is
 * non-negotiable until someone decides otherwise here. A denylist would make
 * every new rule silently overridable.
 *
 * These four are the *size predictions*: coarse by design (§ Scope by effort),
 * and already bounded for real by {@link checkLightDiffBackstop} against the
 * landed diff. Everything absent is absent on purpose — `migration-span` and
 * `sensitive-path` are **risk**, not size, and the unknown-footprint codes
 * describe a shape that was never judged, so there is no false positive to
 * appeal.
 */
export const OVERRIDABLE_SHAPE_CODES = Object.freeze([
  SHAPE_CODES.CHANGE_KINDS,
  SHAPE_CODES.MAGNITUDE,
  SHAPE_CODES.UNCERTAINTY,
  SHAPE_CODES.DEPLOYABLE_SPAN,
]);

/**
 * Detect the **un-waivable** risk rules a predicted footprint trips —
 * `sensitive-path` and `migration-span`, the complement of
 * {@link OVERRIDABLE_SHAPE_CODES} — **independent of which rule the shape
 * decision happened to record** (Story #4875).
 *
 * No re-slicing, shrinking, or operator answer satisfies one: a footprint
 * intersecting a sensitive-path class routes `full` however small the change,
 * and the diff backstop refuses the same footprint again at the end. But
 * {@link deriveStoryShape} reports only the **first** rule a shape trips and
 * evaluates the ceiling rules first, so a prompt tripping both `change-kinds`
 * and `sensitive-path` is reported as a size objection — which reads as
 * appealable, is waivable by an attended operator, and sends the work all the
 * way to an implementation the backstop then refuses.
 *
 * The recovery is that the shape decision attaches the built effort shape to
 * every footprint it can judge at all, and that shape carries the risk facts
 * (`sensitiveClasses`, `migrationSpan`) whether or not a risk rule fired.
 * Reading them here surfaces the objection first-hit reporting hides — the
 * difference between a wasted session and a redirected one.
 *
 * Pure and total.
 *
 * @param {{ shape?: { sensitiveClasses?: unknown, migrationSpan?: unknown } }} [decision]
 *   A {@link deriveStoryShape} return value.
 * @returns {{
 *   present: boolean,
 *   code: string|null,
 *   classes: string[],
 *   reason: string|null,
 * }}
 */
function deriveUnwaivableRisk(decision) {
  const shape = decision?.shape ?? null;
  const classes = Array.isArray(shape?.sensitiveClasses)
    ? shape.sensitiveClasses.filter(
        (c) => typeof c === 'string' && c.trim() !== '',
      )
    : [];
  if (classes.length > 0) {
    return {
      present: true,
      code: SHAPE_CODES.SENSITIVE_PATH,
      classes,
      reason:
        `un-waivable: the predicted footprint intersects sensitive-path ` +
        `class(es) ${classes.join(', ')} — this is risk, not size, so no ` +
        `re-slicing, shrinking, or operator override satisfies it and the ` +
        `diff backstop would refuse the same footprint after the work is ` +
        `finished; take this to /mandrel-plan now`,
    };
  }
  if (shape?.migrationSpan === true) {
    return {
      present: true,
      code: SHAPE_CODES.MIGRATION_SPAN,
      classes: [],
      reason:
        `un-waivable: the predicted footprint pairs a migration with its ` +
        `consumers — this is risk, not size, so no re-slicing or operator ` +
        `override satisfies it; take this to /mandrel-plan now`,
    };
  }
  return { present: false, code: null, classes: [], reason: null };
}

/**
 * Ceilings for the **actual landed** change set the diff backstop
 * ({@link checkLightDiffBackstop}) enforces, measured on the change's
 * implementation half (Story #4856 — see
 * {@link module:lib/orchestration/diff-magnitude} for the measured case and the
 * companion-class boundary).
 *
 * The backstop reads ground truth, so it is where size is genuinely enforced;
 * the prediction gate above it is a declaration and stays coarse (Story #4764).
 * What changed is the **axis**: this used to be `maxFiles: 4`, a cardinality
 * ceiling that rejected 79% of this repository's real merged work while passing
 * a three-file 323-line rewrite.
 *
 *   - `maxImplLines` — additions plus deletions across implementation files.
 *                      Simulated over 41 merges, 1000 admits 83% of real work
 *                      and rejects exactly the genuinely large changes.
 *   - `maxImplFiles` — implementation files touched, a *sprawl* tripwire rather
 *                      than a size gate. Set to `DEFAULT_DIFF_WIDTH.softFiles`
 *                      so the light path and `review-depth.js` stop holding two
 *                      different definitions of a narrow diff.
 *
 * Framework constants, not knobs: a ceiling an operator could widen past what a
 * single session safely absorbs is a ceiling that fails silently.
 */
export const LIGHT_DIFF_CEILINGS = Object.freeze({
  maxImplLines: 1000,
  maxImplFiles: 15,
});

/**
 * Coerce a candidate ceiling into a positive integer, falling back to the
 * framework default for anything malformed — a stray `0`, `-1`, or `NaN` must
 * never widen (or zero out) a light diff ceiling.
 *
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function normalizeCeiling(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    return fallback;
  }
  return Math.floor(value);
}

/**
 * Resolve the effective diff ceilings from a caller-supplied partial override.
 *
 * @param {{ maxImplLines?: unknown, maxImplFiles?: unknown }} [ceilings]
 * @returns {{ maxImplLines: number, maxImplFiles: number }}
 */
function resolveDiffCeilings(ceilings) {
  return {
    maxImplLines: normalizeCeiling(
      ceilings?.maxImplLines,
      LIGHT_DIFF_CEILINGS.maxImplLines,
    ),
    maxImplFiles: normalizeCeiling(
      ceilings?.maxImplFiles,
      LIGHT_DIFF_CEILINGS.maxImplFiles,
    ),
  };
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
      note: 'model verdict is not lite — standard /mandrel-plan route',
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
 * light path. The deterministic effort/risk derivation and the ledgered model
 * verdict must **both** agree on `lite`; anything else — clearly-epic work, a
 * sensitive-path footprint, an unledgered verdict — resolves to `full` (the
 * conservative default that routes the operator to `/mandrel-plan`).
 *
 * The predicted axes are declared by the caller: `predictedKinds` (the distinct
 * kinds of change; absent, each entry's `assumption` is its kind, so N
 * instances of one mechanical edit count once), `predictedMagnitude`
 * (`trivial` | `moderate` | `substantial`), and `predictedUncertainty`
 * (`determined` | `needs-design`). A malformed bucket fails closed; an absent
 * one carries no signal, because a marginal footprint must not be rejected on
 * counts the diff backstop is the right place to enforce.
 *
 * Pure and total: never throws, never mutates its inputs.
 *
 * @param {{
 *   predictedChanges?: unknown,
 *   predictedAcceptance?: unknown,
 *   predictedKinds?: unknown,
 *   predictedMagnitude?: unknown,
 *   predictedUncertainty?: unknown,
 *   verdict?: { route?: unknown, reason?: unknown },
 *   injectedRules?: object,
 *   selectSensitivePathClassesFn?: Function,
 * }} [args]
 * @returns {{
 *   suitable: boolean,
 *   route: 'lite'|'full',
 *   shape: ReturnType<typeof deriveStoryShape>,
 *   ledger: ReturnType<typeof resolveLedgeredVerdict>,
 *   unwaivable: ReturnType<typeof deriveUnwaivableRisk>,
 *   ceilings: typeof STORY_SHAPE_CEILINGS,
 *   reasons: string[],
 * }} `unwaivable` names an absolute risk rule the predicted footprint trips
 *   even when the recorded `shape.code` is a size prediction (Story #4875), so
 *   the operator learns at prediction time that no override can help.
 */
export function deriveLightSuitability({
  predictedChanges,
  predictedAcceptance,
  predictedKinds,
  predictedMagnitude,
  predictedUncertainty,
  verdict,
  injectedRules,
  selectSensitivePathClassesFn,
} = {}) {
  const ledger = resolveLedgeredVerdict(verdict ?? {});
  const shape = deriveStoryShape({
    changes: predictedChanges,
    acceptance: predictedAcceptance,
    kinds: predictedKinds,
    magnitude: predictedMagnitude,
    uncertainty: predictedUncertainty,
    injectedRules,
    selectSensitivePathClassesFn,
  });
  const unwaivable = deriveUnwaivableRisk(shape);
  // A tripped risk rule is decisive on its own: the shape decision may have
  // recorded an earlier ceiling rule, but a sensitive footprint can never be
  // lite, so the conjunction must not be able to read `suitable` from a shape
  // whose recorded code was waived downstream.
  const suitable =
    shape.route === 'lite' && ledger.route === 'lite' && !unwaivable.present;
  const reasons = [`shape: ${shape.reasons[0]}`];
  if (unwaivable.present) reasons.push(unwaivable.reason);
  reasons.push(`verdict: ${ledger.note}`);
  return {
    suitable,
    route: suitable ? 'lite' : 'full',
    shape,
    ledger,
    unwaivable,
    ceilings: STORY_SHAPE_CEILINGS,
    reasons,
  };
}

/**
 * Adjudicate an operator's recorded `proceed-light` answer to the gate's own
 * question (Story #4815). The gate has always *offered* `proceed-light` as one
 * of two options; before this there was no input that could carry the answer,
 * so the only way past a coarse prediction was to re-shape the declaration
 * until the gate stopped objecting — precisely the under-declaring the coarse
 * design anticipates.
 *
 * Applying it takes **all** of:
 *
 *   1. **The gate actually objected.** An override cannot pre-authorize a
 *      scope nothing rejected.
 *   2. **The run is attended.** `--yes` means nobody is at the keyboard, so
 *      there is no operator whose answer this could be (§ Escalation is
 *      terminal). Checked here as well as at the CLI, so the pure core carries
 *      the guarantee rather than the shell.
 *   3. **The objection is a size prediction** — a code in
 *      {@link OVERRIDABLE_SHAPE_CODES}, **and** the footprint trips no
 *      un-waivable risk rule ({@link deriveUnwaivableRisk}, Story #4875).
 *      Sensitivity and migration
 *      span are risk and stay absolute however small the change — including
 *      when an earlier ceiling rule is the one the shape recorded.
 *   4. **The ledgered verdict is already `lite`.** The override substitutes for
 *      the *shape* half of the conjunction only; an unaudited "trust me, it's
 *      small" buys nothing it did not buy before.
 *
 * A refusal is reported, never silent — an operator who typed the flag must
 * learn why it did not take. Pure and total.
 *
 * @param {{
 *   suitability?: object,
 *   yes?: boolean,
 *   operatorOverride?: unknown,
 * }} [args] `operatorOverride` is the operator's recorded reason; blank or
 *   absent means no override was requested.
 * @returns {{
 *   applied: boolean,
 *   record: { recordedReason: string, overriddenCode: string, overriddenReason: string }|null,
 *   note: string|null,
 * }}
 */
export function resolveOperatorOverride({
  suitability,
  yes = false,
  operatorOverride,
} = {}) {
  const recordedReason =
    typeof operatorOverride === 'string' ? operatorOverride.trim() : '';
  const refuse = (note) => ({ applied: false, record: null, note });

  if (recordedReason === '') return refuse(null);
  if (suitability?.suitable === true) {
    return refuse(
      'operator override ignored — the gate raised no objection to override',
    );
  }
  if (yes === true) {
    return refuse(
      'operator override refused — it is attended-only, and --yes means nobody is at the keyboard; over-scope still fails closed to /mandrel-plan',
    );
  }

  const code = suitability?.shape?.code ?? null;
  // Checked BEFORE the overridable-code test on purpose (Story #4875): when a
  // footprint trips both a ceiling rule and a risk rule, the shape records the
  // ceiling rule, which IS overridable — so testing the recorded code alone
  // would apply the override and send un-landable work to the backstop.
  const unwaivable = suitability?.unwaivable;
  if (unwaivable?.present === true) {
    return refuse(
      `operator override refused — the predicted footprint also trips the ` +
        `un-waivable "${unwaivable.code}" rule${
          unwaivable.classes.length > 0
            ? ` (${unwaivable.classes.join(', ')})`
            : ''
        }; waiving the size prediction cannot make this land light, and the ` +
        `diff backstop would refuse the finished work. Escalate to /mandrel-plan.`,
    );
  }
  if (!OVERRIDABLE_SHAPE_CODES.includes(code)) {
    return refuse(
      `operator override refused — "${code ?? 'unknown'}" is not an overridable size prediction (overridable: ${OVERRIDABLE_SHAPE_CODES.join(', ')}); risk rules and unknown footprints are non-negotiable`,
    );
  }
  if (suitability?.ledger?.route !== 'lite') {
    return refuse(
      'operator override refused — it substitutes for the predicted shape only; the model verdict must still be a ledgered lite with a recorded reason',
    );
  }

  return {
    applied: true,
    record: {
      recordedReason,
      overriddenCode: code,
      overriddenReason: suitability?.shape?.reasons?.[0] ?? '',
    },
    note: `operator override applied — proceeding light despite "${code}"; recorded reason: ${recordedReason}. The diff backstop still bounds the actual change set.`,
  };
}

/**
 * Resolve what the light gate does with a suitability decision (Story #4740
 * AC-3). Over-scope never hard-fails: it STOPS and asks the operator to choose,
 * unless the run is unattended (`--yes`), where it fails closed to recommending
 * `/mandrel-plan` rather than silently proceeding light.
 *
 *   - suitable          → `proceed-light`
 *   - over-scope + attended (`yes:false`)  → `ask-operator` (escalate | proceed)
 *   - over-scope + attended + an applied operator override (Story #4815)
 *                                          → `proceed-light`, carrying the
 *                                            decision in `override`
 *   - over-scope + unattended (`yes:true`) → `escalate-plan`
 *
 * The override is adjudicated by {@link resolveOperatorOverride} and cannot
 * reach the unattended branch: `escalate-plan` is resolved first and the
 * override refuses itself under `yes` anyway.
 *
 * Pure and total.
 *
 * @param {{
 *   suitability?: { suitable?: boolean, reasons?: string[] },
 *   yes?: boolean,
 *   operatorOverride?: unknown,
 * }} [args]
 * @returns {{
 *   action: 'proceed-light'|'ask-operator'|'escalate-plan',
 *   options?: string[],
 *   override?: object,
 *   reasons: string[],
 * }}
 */
export function resolveLightGateOutcome({
  suitability,
  yes = false,
  operatorOverride,
} = {}) {
  const override = resolveOperatorOverride({
    suitability,
    yes,
    operatorOverride,
  });
  const reasons = Array.isArray(suitability?.reasons)
    ? [...suitability.reasons]
    : [];
  if (override.note !== null) reasons.push(override.note);

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
        '--yes on over-scope fails closed to /mandrel-plan (never silently proceeds light)',
      ],
    };
  }

  if (override.applied) {
    return {
      action: 'proceed-light',
      override: override.record,
      reasons: [
        ...reasons,
        'predicted scope exceeded a light ceiling and the operator answered proceed-light — proceeding on the recorded override',
      ],
    };
  }

  return {
    action: 'ask-operator',
    options: ['escalate-plan', 'proceed-light'],
    reasons: [
      ...reasons,
      'predicted scope exceeds the light ceilings — STOP and ask the operator to escalate to /mandrel-plan or proceed light',
    ],
  };
}

/**
 * The refusal classes a blocked diff backstop can carry — the machine-readable
 * half of a verdict whose `reasons[]` are prose (Story #5238).
 *
 * One value per blocked verdict, and the reason it exists is downstream: the
 * refusal's friction category is derived from it
 * ({@link module:lib/observability/runtime-friction.lightScopeRejectedCategory}),
 * and the category is the ONLY key the retro composer separates buckets on.
 * Under one bare category an empty-diff refusal and a `public-api` refusal
 * aggregated into a single "recurred 2 times" follow-up with nothing in common
 * (issue #5237) — the roll-up's shape fingerprint could not tell them apart
 * either, because it hashes detail keys and every refusal carries the same set.
 *
 * Kept coarse on purpose: a class must be stable enough that N refusals of one
 * cause still coalesce into the recurrence evidence the ceilings are
 * recalibrated from.
 *
 * @typedef {{ reason: string, refusalClass: string }} Objection
 */
export const LIGHT_REFUSAL_CLASSES = Object.freeze({
  /** The diff could not be enumerated, or enumerated to nothing. */
  CHANGE_SET_UNKNOWN: 'change-set-unknown',
  /** Enumerated-empty, but the worktree carries uncommitted changes. */
  UNCOMMITTED_WORK: 'uncommitted-work',
  /** The change set intersects a registered sensitive-path class. */
  SENSITIVE_PATH: 'sensitive-path',
  /** Sensitivity could not be classified, so non-sensitivity is unproven. */
  SENSITIVITY_UNKNOWN: 'sensitivity-unknown',
  /** The implementation magnitude could not be measured. */
  MAGNITUDE_UNKNOWN: 'magnitude-unknown',
  /** Measured magnitude exceeded a light ceiling. */
  OVER_CEILING: 'over-ceiling',
});

/**
 * Name the branch a commit-first refusal tells the agent to commit on, with a
 * generic stand-in when the caller supplied none. Pure.
 *
 * @param {unknown} storyBranch
 * @returns {string}
 */
function describeStoryBranch(storyBranch) {
  const name = typeof storyBranch === 'string' ? storyBranch.trim() : '';
  return name === '' ? 'the Story branch' : name;
}

/**
 * Diff-derived backstop (Story #4740 AC-4, re-based on magnitude by Story
 * #4856): re-check the **actual** change set after implementation, because the
 * diff — not the prompt — is the real scope signal. Blocks (rather than landing)
 * when the diff intersects a sensitive-path class, exceeds an implementation
 * ceiling, or cannot be measured. A clean result is the only path that lands
 * light.
 *
 * Two inputs, two different scopes, and the difference is load-bearing:
 *
 *   - `changedFiles` is the **full** change set, companions included, and is
 *     what sensitive-path derivation reads. Exempting a companion from the
 *     *count* must never exempt it from *risk* — a test file under a registered
 *     sensitive class still blocks.
 *   - `magnitude` is the implementation-only summary from
 *     {@link module:lib/orchestration/diff-magnitude.summarizeDiffMagnitude}.
 *     `null` means the magnitude could not be measured, which blocks: absence
 *     of evidence is not evidence the diff is small.
 *
 * Reuses close's own {@link module:lib/orchestration/review-depth.deriveChangeLevel}
 * — one taxonomy, applied to the predicted shape at the gate and the actual
 * diff here — so the two read points can never disagree about what is sensitive.
 *
 * Pure and total.
 *
 * @param {{
 *   changedFiles?: unknown,
 *   magnitude?: { implFiles?: number, implLines?: number }|null,
 *   ceilings?: { maxImplLines?: number, maxImplFiles?: number },
 *   injectedRules?: object,
 *   selectSensitivePathClassesFn?: Function,
 *   storyBranch?: string,
 *   uncommittedWork?: boolean,
 * }} [args] `uncommittedWork` is the caller's dirty-worktree probe result: the
 *   backstop reads COMMITTED state, so an implemented-but-uncommitted run
 *   measures an empty diff, and the door for that is `git commit` — not an
 *   escalation. It only ever refines an enumerated-empty verdict's guidance;
 *   the verdict itself still blocks. `storyBranch` names the branch that
 *   guidance points at.
 * @returns {{
 *   blocked: boolean,
 *   level: 'low'|'high'|null,
 *   classes: string[],
 *   fileCount: number|null,
 *   magnitude: { implFiles: number, implLines: number }|null,
 *   ceilings: { maxImplLines: number, maxImplFiles: number },
 *   refusalClass: string|null,
 *   reasons: string[],
 * }} `refusalClass` is `null` on a clean verdict and exactly one
 *   {@link LIGHT_REFUSAL_CLASSES} value on every blocked one.
 */
export function checkLightDiffBackstop({
  changedFiles,
  magnitude,
  ceilings,
  injectedRules,
  selectSensitivePathClassesFn,
  storyBranch,
  uncommittedWork = false,
} = {}) {
  const resolved = resolveDiffCeilings(ceilings);
  const files = Array.isArray(changedFiles)
    ? changedFiles.filter((f) => typeof f === 'string' && f.trim() !== '')
    : null;

  if (files === null || files.length === 0) {
    // An ENUMERATED-empty diff over a dirty worktree is a different event from
    // an unverifiable one, and blocking is right for both — but only one of
    // them is about scope. The caller's probe distinguishes them; `files ===
    // null` never can, because a `git diff` that failed outright is exactly
    // the case where nothing about the change is known.
    const uncommitted = files !== null && uncommittedWork === true;
    return {
      blocked: true,
      level: null,
      classes: [],
      fileCount: files === null ? null : 0,
      magnitude: null,
      ceilings: resolved,
      refusalClass: uncommitted
        ? LIGHT_REFUSAL_CLASSES.UNCOMMITTED_WORK
        : LIGHT_REFUSAL_CLASSES.CHANGE_SET_UNKNOWN,
      reasons: [
        uncommitted
          ? `the change set is empty but the worktree has uncommitted changes — commit them on ${describeStoryBranch(storyBranch)}, then re-run the backstop; nothing here is over-scope, so do NOT escalate to /mandrel-plan`
          : 'actual change set is unknown or empty — cannot verify the diff is light; escalate to /mandrel-plan',
      ],
    };
  }

  const { level, classes } = deriveChangeLevel({
    changedFiles: files,
    injectedRules,
    selectSensitivePathClassesFn,
  });
  const measured = normalizeMagnitude(magnitude);

  const objections = [
    ...describeSensitivity({ level, classes }),
    ...describeMagnitude(measured, resolved),
  ];

  const blocked = objections.length > 0;
  return {
    blocked,
    level,
    classes,
    fileCount: files.length,
    magnitude: measured,
    ceilings: resolved,
    // Objection ORDER is the class precedence: sensitivity is derived before
    // magnitude, so a diff that is both sensitive and over-ceiling files as a
    // sensitive-path refusal. That is the right way round — the ceiling is
    // recalibratable, the sensitive path is not.
    refusalClass: blocked ? objections[0].refusalClass : null,
    reasons: blocked
      ? objections.map((objection) => objection.reason)
      : [
          `diff is light: ${measured.implLines} implementation line(s) ≤ ${resolved.maxImplLines} ` +
            `across ${measured.implFiles} implementation file(s) ≤ ${resolved.maxImplFiles} ` +
            `(${files.length} file(s) total, companions exempt), no sensitive-path class — safe to land`,
        ],
  };
}

/**
 * Coerce a magnitude summary into non-negative integer counts, or `null` when
 * it was not measurable. Pure.
 *
 * @param {unknown} magnitude
 * @returns {{ implFiles: number, implLines: number }|null}
 */
function normalizeMagnitude(magnitude) {
  const implFiles = magnitude?.implFiles;
  const implLines = magnitude?.implLines;
  if (!Number.isFinite(implFiles) || !Number.isFinite(implLines)) return null;
  if (implFiles < 0 || implLines < 0) return null;
  return { implFiles: Math.floor(implFiles), implLines: Math.floor(implLines) };
}

/**
 * Sensitivity objections, over the **full** change set. Pure.
 *
 * @param {{ level: 'low'|'high'|null, classes: string[] }} derived
 * @returns {Objection[]}
 */
function describeSensitivity({ level, classes }) {
  if (classes.length > 0) {
    return [
      {
        refusalClass: LIGHT_REFUSAL_CLASSES.SENSITIVE_PATH,
        reason: `diff intersects sensitive-path class(es) ${classes.join(', ')} — escalate to /mandrel-plan (do not land light)`,
      },
    ];
  }
  if (level !== 'low') {
    return [
      {
        refusalClass: LIGHT_REFUSAL_CLASSES.SENSITIVITY_UNKNOWN,
        reason:
          'sensitive-path classification unavailable — cannot verify the diff is non-sensitive; escalate to /mandrel-plan',
      },
    ];
  }
  return [];
}

/**
 * Magnitude objections, over the implementation half only. Pure.
 *
 * @param {{ implFiles: number, implLines: number }|null} measured
 * @param {{ maxImplLines: number, maxImplFiles: number }} ceilings
 * @returns {Objection[]}
 */
function describeMagnitude(measured, ceilings) {
  if (measured === null) {
    return [
      {
        refusalClass: LIGHT_REFUSAL_CLASSES.MAGNITUDE_UNKNOWN,
        reason:
          'change magnitude could not be measured (unreadable or unparseable numstat) — cannot verify the diff is light; escalate to /mandrel-plan',
      },
    ];
  }
  const objections = [];
  if (measured.implLines > ceilings.maxImplLines) {
    objections.push({
      refusalClass: LIGHT_REFUSAL_CLASSES.OVER_CEILING,
      reason: `diff changes ${measured.implLines} implementation line(s) (> maxImplLines ${ceilings.maxImplLines}) — escalate to /mandrel-plan (do not land light)`,
    });
  }
  if (measured.implFiles > ceilings.maxImplFiles) {
    objections.push({
      refusalClass: LIGHT_REFUSAL_CLASSES.OVER_CEILING,
      reason: `diff spans ${measured.implFiles} implementation file(s) (> maxImplFiles ${ceilings.maxImplFiles}) — escalate to /mandrel-plan (do not land light)`,
    });
  }
  return objections;
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
 * Render an applied operator override as an audit paragraph for the receipt
 * body (Story #4815). An override that leaves no trace on the ticket is an
 * invisible decision: the whole point of routing it through the receipt is
 * that a later reader can see the gate objected, on what grounds, and who
 * decided to proceed anyway.
 *
 * @param {unknown} override The `record` from {@link resolveOperatorOverride}.
 * @returns {string} A leading-space-prefixed sentence, or `''` when absent.
 */
function renderOverrideNote(override) {
  if (!override || typeof override !== 'object') return '';
  const { overriddenCode, overriddenReason, recordedReason } = override;
  if (typeof recordedReason !== 'string' || recordedReason.trim() === '') {
    return '';
  }
  return (
    ` OPERATOR SCOPE OVERRIDE: the suitability gate objected on ` +
    `"${overriddenCode}" (${overriddenReason}) and the operator answered ` +
    `proceed-light — recorded reason: ${recordedReason.trim()}. The ` +
    `prediction was waived, not the diff backstop, which still bounds the ` +
    `landed change set.`
  );
}

/**
 * Build the minimal receipt `type::story` ticket for the light path
 * (Story #4740 AC-5) — the input `assemblePlanStories` / `createStoryIssues`
 * consume, so the light path reuses the plan-persist story-creation surface
 * rather than reimplementing issue authoring. The body carries the operator
 * prompt (goal + spec), the diff-derived footprint (`changes[]`), and any
 * operator scope override, so history and `refs #<id>` on the commit survive.
 *
 * @param {{
 *   prompt?: unknown,
 *   changedFiles?: unknown,
 *   amends?: unknown,
 *   override?: unknown,
 * }} [args]
 * @returns {{ slug: string, title: string, body: object, labels: string[] }}
 */
export function buildReceiptStoryTicket({
  prompt,
  changedFiles,
  amends,
  override,
} = {}) {
  const text = typeof prompt === 'string' ? prompt.trim() : '';
  if (text === '') {
    throw new Error(
      '[light-suitability] a non-empty prompt is required to build a receipt Story',
    );
  }
  const amendsId = normalizeAmends(amends);
  const amendNote = amendsId !== null ? ` Amends #${amendsId}.` : '';
  const changes = toReceiptChanges(changedFiles);
  const overrideNote = renderOverrideNote(override);

  return {
    slug: slugifyPrompt(text),
    title: deriveReceiptTitle(text, amendsId),
    labels: [],
    body: {
      goal: `${text}${amendNote}`,
      spec:
        `Delivered via /deliver-light as a validated single-session change — ` +
        `the /mandrel-plan session is removed for genuinely small work while every ` +
        `single-story-close gate runs byte-identical.${amendNote}` +
        `${overrideNote} ` +
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

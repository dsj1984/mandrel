/**
 * lib/orchestration/light-suitability.js — pure `/deliver-light` decision
 * core (no git/PR/label mutation). Nothing the caller declares about its own
 * size decides: the gate reads risk off predicted paths plus a recorded
 * reason, and the diff backstop is the only size block.
 *
 * @module lib/orchestration/light-suitability
 */

import { deriveStoryShape, SHAPE_CODES } from './complexity-gate.js';
import { deriveChangeLevel } from './review-depth.js';

/**
 * Read from the risk shape, not the recorded `code`: first-hit reporting can
 * hide a risk rule behind a fixable one.
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
        `re-slicing or shrinking satisfies it and the ` +
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
        `consumers — this is risk, not size, so no re-slicing ` +
        `satisfies it; take this to /mandrel-plan now`,
    };
  }
  return { present: false, code: null, classes: [], reason: null };
}

/**
 * Implementation-half ceilings (companions exempt); `maxImplFiles` matches
 * `DEFAULT_DIFF_WIDTH.softFiles`. Constants: a widenable ceiling fails silently.
 */
export const LIGHT_DIFF_CEILINGS = Object.freeze({
  maxImplLines: 1000,
  maxImplFiles: 15,
});

/**
 * A malformed ceiling falls back to the default, never widens or zeroes.
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
 * No recorded reason fails closed to `full`.
 *
 * @param {{ reason?: unknown }} [verdict]
 * @returns {{
 *   reason: string|null,
 *   recorded: boolean,
 *   note: string,
 * }}
 */
export function resolveLedgeredVerdict({ reason } = {}) {
  const recordedReason = typeof reason === 'string' ? reason.trim() : '';
  if (recordedReason === '') {
    return {
      reason: null,
      recorded: false,
      note: 'no recorded reason — fails closed to full (the light verdict must be ledgered)',
    };
  }
  return {
    reason: recordedReason,
    recorded: true,
    note: `light verdict (recorded reason): ${recordedReason}`,
  };
}

/**
 * Refuses only on un-waivable risk or an un-ledgered verdict; size is bounded
 * later by {@link checkLightDiffBackstop}.
 *
 * @param {{
 *   predictedChanges?: unknown,
 *   verdict?: { reason?: unknown },
 *   injectedRules?: object,
 *   selectSensitivePathClassesFn?: Function,
 * }} [args]
 * @returns {{
 *   suitable: boolean,
 *   shape: ReturnType<typeof deriveStoryShape>,
 *   ledger: ReturnType<typeof resolveLedgeredVerdict>,
 *   unwaivable: ReturnType<typeof deriveUnwaivableRisk>,
 *   reasons: string[],
 * }}
 */
export function deriveLightSuitability({
  predictedChanges,
  verdict,
  injectedRules,
  selectSensitivePathClassesFn,
} = {}) {
  const ledger = resolveLedgeredVerdict(verdict ?? {});
  const shape = deriveStoryShape({
    changes: predictedChanges,
    injectedRules,
    selectSensitivePathClassesFn,
  });
  const unwaivable = deriveUnwaivableRisk(shape);
  const suitable = ledger.recorded && !unwaivable.present;
  const reasons = [`shape: ${shape.reasons[0]}`];
  if (unwaivable.present) reasons.push(unwaivable.reason);
  reasons.push(`verdict: ${ledger.note}`);
  return { suitable, shape, ledger, unwaivable, reasons };
}

/**
 * @param {{
 *   suitability?: { suitable?: boolean, reasons?: string[] },
 * }} [args]
 * @returns {{
 *   action: 'proceed-light'|'escalate-plan',
 *   reasons: string[],
 * }}
 */
export function resolveLightGateOutcome({ suitability } = {}) {
  const reasons = Array.isArray(suitability?.reasons)
    ? [...suitability.reasons]
    : [];

  if (suitability?.suitable === true) {
    return {
      action: 'proceed-light',
      reasons: [
        ...reasons,
        'ledgered verdict recorded and no un-waivable risk rule fired — proceed light; the diff backstop bounds the actual change set',
      ],
    };
  }

  return {
    action: 'escalate-plan',
    reasons: [
      ...reasons,
      'the verdict is un-ledgered or an un-waivable risk rule fired — fails closed to /mandrel-plan (never silently proceeds light)',
    ],
  };
}

/**
 * One class per blocked verdict; retro buckets split only on the friction
 * category derived from it. Kept coarse so repeats of one cause coalesce.
 *
 * @typedef {{ reason: string, refusalClass: string }} Objection
 */
export const LIGHT_REFUSAL_CLASSES = Object.freeze({
  CHANGE_SET_UNKNOWN: 'change-set-unknown',
  /** Enumerated-empty, but the worktree carries uncommitted changes. */
  UNCOMMITTED_WORK: 'uncommitted-work',
  SENSITIVE_PATH: 'sensitive-path',
  SENSITIVITY_UNKNOWN: 'sensitivity-unknown',
  MAGNITUDE_UNKNOWN: 'magnitude-unknown',
  OVER_CEILING: 'over-ceiling',
});

/**
 * @param {unknown} storyBranch
 * @returns {string}
 */
function describeStoryBranch(storyBranch) {
  const name = typeof storyBranch === 'string' ? storyBranch.trim() : '';
  return name === '' ? 'the Story branch' : name;
}

/**
 * Re-check the ACTUAL diff; anything unmeasurable blocks. `changedFiles` is
 * the full set — a companion exempt from the count is never exempt from
 * risk. Shares close's `deriveChangeLevel`, so gate and backstop agree.
 *
 * @param {{
 *   changedFiles?: unknown,
 *   magnitude?: { implFiles?: number, implLines?: number }|null,
 *   ceilings?: { maxImplLines?: number, maxImplFiles?: number },
 *   injectedRules?: object,
 *   selectSensitivePathClassesFn?: Function,
 *   storyBranch?: string,
 *   uncommittedWork?: boolean,
 * }} [args] `uncommittedWork` only redirects guidance to `git commit`.
 * @returns {{
 *   blocked: boolean,
 *   level: 'low'|'high'|null,
 *   classes: string[],
 *   fileCount: number|null,
 *   magnitude: { implFiles: number, implLines: number }|null,
 *   ceilings: { maxImplLines: number, maxImplFiles: number },
 *   refusalClass: string|null,
 *   reasons: string[],
 * }}
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
    // `files === null` (git diff failed) can never be the uncommitted case.
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
    // Order is precedence: sensitivity wins over magnitude, since a ceiling
    // is recalibratable and a sensitive path is not.
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

const RECEIPT_SLUG_MAX = 48;

/**
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

const RECEIPT_TITLE_MAX = 72;

/**
 * `#<n>`, `<n>` or a number → positive issue number, else `null`.
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
 * All `refactors-existing`: the light path does not assert creates.
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
 * Minimal receipt Story in plan-persist's input shape; throws on empty prompt.
 *
 * @param {{
 *   prompt?: unknown,
 *   changedFiles?: unknown,
 *   amends?: unknown,
 * }} [args]
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
        `the /mandrel-plan session is removed for genuinely small work while every ` +
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

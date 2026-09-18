/**
 * Review-depth authority. The change level is derived from the changed files
 * (a fact, not a planner's claim), so it is safe to reduce ceremony on. Both
 * functions are total; any failure degrades toward `standard`, never `light`.
 *
 * @typedef {'light'|'standard'|'deep'} ReviewDepth
 * @typedef {'low'|'high'} ChangeLevel
 */

import { selectSensitivePathClasses } from '../audit-suite/selector.js';

/** Classify review diff width only — not planning sizing ceilings. */
export const DEFAULT_DIFF_WIDTH = Object.freeze({
  softFiles: 15,
  hardFiles: 30,
});

/**
 * `high` when the changed files hit a `sensitivePaths` class in
 * `audit-rules.json` — this is what keeps a narrow auth or migration diff
 * deep. Single source of the level for review depth and dispatch routing
 * (predicted footprint vs actual diff). `null` on an empty set or unreadable
 * manifest; consumers treat `null` as the more thorough posture. Never throws.
 *
 * @param {{
 *   changedFiles?: string[]|null,
 *   injectedRules?: object,
 *   selectSensitivePathClassesFn?: typeof selectSensitivePathClasses,
 * }} [input]
 * @returns {{ level: ChangeLevel|null, classes: string[] }}
 */
export function deriveChangeLevel(input = {}) {
  const changedFiles =
    input && typeof input === 'object' ? input.changedFiles : null;
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) {
    return { level: null, classes: [] };
  }

  const select =
    input.selectSensitivePathClassesFn ?? selectSensitivePathClasses;
  let classes;
  try {
    classes = select({ changedFiles, injectedRules: input.injectedRules });
  } catch {
    // An unreadable/invalid manifest is not evidence the change is safe.
    return { level: null, classes: [] };
  }
  const matched = Array.isArray(classes) ? classes : [];
  return { level: matched.length > 0 ? 'high' : 'low', classes: matched };
}

/**
 * `null` = width unknown: neither triggers `deep` nor blocks `light`.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function normalizeChangedFileCount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.floor(value);
}

/**
 * `deep` on a sensitive path or a wide diff; `light` only when known-low and
 * small; otherwise `standard`.
 *
 * @param {{
 *   derivedLevel?: (ChangeLevel|string|null|undefined),
 *   changedFileCount?: (number|null|undefined),
 *   diffWidth?: { softFiles?: number, hardFiles?: number }|null,
 * }} [input]
 * @returns {ReviewDepth}
 */
export function resolveDepth(input = {}) {
  const derivedLevel =
    input && typeof input === 'object' ? input.derivedLevel : undefined;
  const changedFileCount =
    input && typeof input === 'object'
      ? normalizeChangedFileCount(input.changedFileCount)
      : null;

  const override =
    input && typeof input === 'object' ? (input.diffWidth ?? {}) : {};
  const mergedWidth = {
    ...DEFAULT_DIFF_WIDTH,
    ...override,
  };
  const { softFiles, hardFiles } = mergedWidth;

  const isWide = changedFileCount !== null && changedFileCount > hardFiles;
  const isSmall = changedFileCount === null || changedFileCount <= softFiles;

  if (derivedLevel === 'high' || isWide) return 'deep';
  if (derivedLevel === 'low' && isSmall) return 'light';
  return 'standard';
}

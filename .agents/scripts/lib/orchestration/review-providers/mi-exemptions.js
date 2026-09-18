/**
 * review-providers/mi-exemptions.js — the MI gate's `ignoreGlobs`, as the
 * native review provider reads them, so the review never raises a critical
 * finding on a file the ratchet itself exempts.
 */

import { getQuality } from '../../config/quality.js';
import { resolveConfig } from '../../config-resolver.js';
import { isIgnoredByGlobs } from '../../maintainability-utils.js';

/**
 * An unresolvable config yields `[]` (score everything) — deliberately, since
 * scoring nothing would silently retire the dimension.
 *
 * @param {{ resolveConfigFn?: typeof resolveConfig, getQualityFn?: typeof getQuality }} [deps]
 * @returns {string[]} minimatch patterns; `[]` when unset or unresolvable.
 */
export function resolveMaintainabilityIgnoreGlobs({
  resolveConfigFn = resolveConfig,
  getQualityFn = getQuality,
} = {}) {
  try {
    const globs = getQualityFn(resolveConfigFn())?.maintainability?.ignoreGlobs;
    return Array.isArray(globs) ? globs.slice() : [];
  } catch {
    return [];
  }
}

/**
 * Matches through `isIgnoredByGlobs`, the same rule the baseline uses; a
 * local `minimatch` would let the two surfaces disagree.
 *
 * @param {string[]} files
 * @param {string[]} ignoreGlobs
 * @param {string} cwd root for repo-relative glob resolution
 * @returns {{ scored: string[], ignored: string[] }}
 */
function partitionByIgnoreGlobs(files, ignoreGlobs, cwd) {
  if (!Array.isArray(ignoreGlobs) || ignoreGlobs.length === 0) {
    return { scored: files, ignored: [] };
  }
  const scored = [];
  const ignored = [];
  for (const relPath of files) {
    if (isIgnoredByGlobs(relPath, ignoreGlobs, cwd)) ignored.push(relPath);
    else scored.push(relPath);
  }
  return { scored, ignored };
}

/**
 * Name the exempted files, since silence cannot tell "healthy" from "never scored".
 *
 * @param {string[]|undefined} ignoredFiles
 * @returns {string|null}
 */
function formatExemptionNotice(ignoredFiles) {
  const files = Array.isArray(ignoredFiles) ? ignoredFiles : [];
  if (files.length === 0) return null;
  return (
    `[native-review] Maintainability: ${files.length} changed file(s) exempt via ` +
    `delivery.quality.gates.maintainability.ignoreGlobs — not scored: ${files.join(', ')}.`
  );
}

/**
 * @param {string[]} changedFiles
 * @param {{
 *   cwd: string,
 *   resolveIgnoreGlobsFn?: typeof resolveMaintainabilityIgnoreGlobs,
 * }} opts
 * @returns {{ scored: string[], ignored: string[], notice: string|null }}
 */
export function scopeMaintainabilityFiles(
  changedFiles,
  { cwd, resolveIgnoreGlobsFn = resolveMaintainabilityIgnoreGlobs } = {},
) {
  const { scored, ignored } = partitionByIgnoreGlobs(
    changedFiles,
    resolveIgnoreGlobsFn(),
    cwd,
  );
  return { scored, ignored, notice: formatExemptionNotice(ignored) };
}

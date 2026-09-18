/**
 * crap-preview-incremental.js — resolve `runCrapPreview`'s incremental-join
 * `scanAndScore` input (Story #4981).
 *
 * Split into its own file (rather than added inline to `preview-gates.js`)
 * so the Story's opt-in wiring lands as new code, not a same-file expansion
 * of the pre-existing preview runner.
 */
import { getChangedFiles, resolveChangedFilesRef } from '../changed-files.js';

/**
 * Resolve the `incremental` option `scanAndScore` (`crap-utils.js`) expects,
 * or `null` when incremental mode is disabled or the changed-files ref could
 * not be resolved — a resolution failure falls back to full-scope rather
 * than silently relaxing the gate.
 *
 * The join's ref comes from `resolveChangedFilesRef` (Story #5365), the same
 * rule capture applies: the `--changed-since` ref the preview was handed wins
 * over a configured `baseRef`, so one hook invocation cannot resolve two.
 *
 * Gated by `incrementalCoverage.baselineJoin` alone (Story #5173). It MUST
 * NOT consult `skipWhenUnchanged`: the join loosens what the gate demands,
 * while the skip only decides whether a capture runs, so a consumer that took
 * the saving has not thereby asked for the loosening.
 *
 * @param {{
 *   crap: { incrementalCoverage?: { baselineJoin?: boolean, baseRef?: string } },
 *   diffRef: string | null,
 *   cwd: string,
 *   baselineRows: Array<object>,
 *   getChangedFilesImpl?: typeof getChangedFiles,
 * }} opts
 * @returns {{ touchedFiles: Set<string>, baselineRows: Array<object> } | null}
 */
export function resolveCrapPreviewIncremental({
  crap,
  diffRef,
  cwd,
  baselineRows,
  getChangedFilesImpl = getChangedFiles,
}) {
  if (crap.incrementalCoverage?.baselineJoin !== true) return null;
  const baseRef = resolveChangedFilesRef({ crap, ref: diffRef });
  try {
    const touchedFiles = new Set(getChangedFilesImpl({ ref: baseRef, cwd }));
    return { touchedFiles, baselineRows };
  } catch {
    return null;
  }
}

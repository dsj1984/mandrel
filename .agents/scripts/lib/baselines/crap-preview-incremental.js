import { getChangedFiles, resolveChangedFilesRef } from '../changed-files.js';

/**
 * The `incremental` option for `scanAndScore`, or `null` (full scope) when
 * disabled or the changed-files ref fails — never a silently relaxed gate.
 * The preview's `--changed-since` ref wins over configured `baseRef`, so one
 * hook invocation resolves one ref. Gated by `baselineJoin` alone, never
 * `skipWhenUnchanged`: skipping a capture is not consent to loosen the gate.
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

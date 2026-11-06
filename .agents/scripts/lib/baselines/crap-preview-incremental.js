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
 *   baseBranch?: string,
 *   cwd: string,
 *   baselineRows: Array<object>,
 *   getChangedFilesImpl?: typeof getChangedFiles,
 * }} opts
 * @returns {{ touchedFiles: Set<string>, baselineRows: Array<object> } | null}
 */
export function resolveCrapPreviewIncremental({
  crap,
  diffRef,
  baseBranch,
  cwd,
  baselineRows,
  getChangedFilesImpl = getChangedFiles,
}) {
  if (crap.incrementalCoverage?.baselineJoin !== true) return null;
  const ref = resolveChangedFilesRef({ crap, ref: diffRef, baseBranch });
  const touchedFiles = readTouched(getChangedFilesImpl, ref, cwd);
  return touchedFiles && { touchedFiles, baselineRows };
}

function readTouched(getChangedFilesImpl, ref, cwd) {
  try {
    return new Set(getChangedFilesImpl({ ref, cwd }));
  } catch {
    return null;
  }
}

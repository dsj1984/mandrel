/** Wires `resolveCoverageRefreshScope` to the on-disk artifact and c8 scope. */
import fs from 'node:fs';
import path from 'node:path';
import {
  buildScopePredicate,
  readArtifactCaptureScope,
  readCoverageFinal,
  resolveCoverageRefreshScope,
  scoreCoverageFinal,
} from '../coverage-baseline.js';
import { deriveScopeFromDiff } from './refresh-service.js';

/**
 * `refreshBaseline` scope options for `update-coverage-baseline.js`.
 *
 * @param {string} cwd
 * @param {{
 *   fullScope: boolean,
 *   diffScopeRef: string | null,
 *   loadScope: (cwd: string) => { include?: string[], exclude?: string[] },
 *   readCaptureScope?: typeof readArtifactCaptureScope,
 *   readCoverage?: typeof readCoverageFinal,
 *   existsSync?: typeof fs.existsSync,
 *   deriveDiff?: typeof deriveScopeFromDiff,
 * }} opts
 */
export function resolveUpdaterRefreshScope(
  cwd,
  {
    fullScope,
    diffScopeRef,
    loadScope,
    readCaptureScope = readArtifactCaptureScope,
    readCoverage = readCoverageFinal,
    existsSync = fs.existsSync,
    deriveDiff = deriveScopeFromDiff,
  },
) {
  const c8 = () => {
    const config = loadScope(cwd);
    return buildScopePredicate({
      include: config.include ?? [],
      exclude: config.exclude ?? [],
    });
  };
  return resolveCoverageRefreshScope({
    cwd,
    fullScope,
    diffScopeRef,
    readCaptureScope,
    listMeasured: () =>
      Object.keys(
        scoreCoverageFinal({ raw: readCoverage(cwd), cwd, scope: c8() }),
      ),
    inCoverageScope: (file) =>
      c8()(file) && existsSync(path.resolve(cwd, file)),
    deriveDiffFiles: (baseRef) =>
      deriveDiff({ baseRef, headRef: 'HEAD', predicate: () => true, cwd }),
  });
}

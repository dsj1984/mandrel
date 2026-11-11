import path from 'node:path';
import { loadCoverage } from '../coverage-utils.js';
import { previewCoveragePath, previewNotRun } from './crap-preview-touched.js';

/** The coverage to score, or the not-run result; a named artifact skips the stamp check. */
export function resolvePreviewCoverage({
  coverageArtifact,
  crap,
  cwd,
  ...rest
}) {
  if (coverageArtifact) return { coverage: loadCoverage(coverageArtifact) };
  const notRun = previewNotRun({ crap, cwd, ...rest });
  if (notRun) return { notRun };
  const configured = path.resolve(cwd, previewCoveragePath(crap));
  return { coverage: loadCoverage(configured) };
}

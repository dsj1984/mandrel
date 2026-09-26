/**
 * `captureScope: "affected"` capture path for `coverage-capture.js`. The
 * consumer owns how its suite is scoped; mandrel only names the base ref and
 * keeps the artifact complete-looking for every per-file reader.
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveChangedFilesRef } from './changed-files.js';
import { reportCaptureFailure, stampCapturedTree } from './coverage-capture.js';
import { tryIncrementalCapture } from './coverage-capture-incremental.js';

const AFFECTED_CAPTURE_SCRIPT = 'test:coverage:affected';
const COVERAGE_BASE_REF_ENV = 'MANDREL_COVERAGE_BASE_REF';

/**
 * `true` when the affected path should run. A configured scope with no
 * script warns and returns `false`, so the caller runs full scope.
 *
 * @param {{
 *   coverage: { captureScope?: string } | undefined,
 *   scripts: Record<string, string>,
 *   hasNpmScriptImpl: (scripts: object, name: string) => boolean,
 *   logger: { warn: Function },
 * }} opts
 * @returns {boolean}
 */
function shouldCaptureAffected({
  coverage,
  scripts,
  hasNpmScriptImpl,
  logger,
}) {
  if (coverage?.captureScope !== 'affected') return false;
  if (hasNpmScriptImpl(scripts, AFFECTED_CAPTURE_SCRIPT)) return true;
  logger.warn(
    `[coverage-capture] ⚠ captureScope is "affected" but package.json has no "${AFFECTED_CAPTURE_SCRIPT}" script — running the full npm run test:coverage instead.`,
  );
  return false;
}

/**
 * Affected capture when it applies, else incremental mode; `null` means
 * neither applies and the caller runs full scope.
 *
 * @param {Parameters<typeof runAffectedCapture>[0] & {
 *   readPackageScriptsImpl: (cwd: string) => Record<string, string>,
 *   hasNpmScriptImpl: (scripts: object, name: string) => boolean,
 * }} opts
 * @returns {Promise<number | null>}
 */
export async function tryScopedCapture({
  readPackageScriptsImpl,
  hasNpmScriptImpl,
  ...opts
}) {
  const applies = shouldCaptureAffected({
    coverage: opts.coverage,
    scripts: readPackageScriptsImpl(opts.args.cwd),
    hasNpmScriptImpl,
    logger: opts.logger,
  });
  return applies
    ? await runAffectedCapture(opts)
    : await tryIncrementalCapture(opts);
}

/**
 * Scoped rows win; a prior row survives only when its file is neither
 * re-measured nor in `dropFiles` (the change set), so a changed file the
 * scoped run skipped stays absent and fails closed downstream.
 *
 * @param {{
 *   prior: Record<string, object> | null,
 *   scoped: Record<string, object>,
 *   cwd: string,
 *   dropFiles: string[],
 * }} opts Artifact maps are keyed by absolute path; `dropFiles` are repo-relative.
 * @returns {Record<string, object>}
 */
function mergeCoverageArtifacts({ prior, scoped, cwd, dropFiles }) {
  const drop = new Set(dropFiles.map((f) => path.resolve(cwd, f)));
  const merged = {};
  for (const [abs, entry] of Object.entries(prior ?? {})) {
    if (!drop.has(path.resolve(abs))) merged[abs] = entry;
  }
  return Object.assign(merged, scoped);
}

/**
 * @param {string} abs
 * @param {typeof fs} fsImpl
 * @returns {Record<string, object> | null} `null` when absent or unparseable.
 */
function readArtifact(abs, fsImpl) {
  try {
    return JSON.parse(fsImpl.readFileSync(abs, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * @returns {string[] | null} `null` when the change set cannot be read.
 */
function readChangedFiles({ getChangedFilesImpl, ref, cwd, logger }) {
  try {
    return getChangedFilesImpl({ ref, cwd });
  } catch (err) {
    logger.warn(
      `[coverage-capture] ⚠ affected mode: ${err?.message ?? err} — capturing without a prior-artifact merge.`,
    );
    return null;
  }
}

/**
 * Spawn the scoped script with the base ref in env, merge over the prior
 * artifact and stamp it `affected`. Honours `skipWhenUnchanged` exactly as
 * incremental mode does. With an unreadable change set nothing prior is
 * merged: a stale row for a changed file must never read as fresh.
 *
 * @param {{
 *   crap: object,
 *   coverage: object,
 *   args: { ref: string | null, cwd: string },
 *   getChangedFilesImpl: Function,
 *   filterFilesUnderTargetsImpl: Function,
 *   isCoverageFreshImpl: Function,
 *   runCaptureImpl: Function,
 *   computeContentDigestImpl: Function,
 *   writeCaptureStampImpl: Function,
 *   logger: { info: Function, warn: Function, error: Function },
 *   fsImpl?: typeof fs,
 * }} opts
 * @returns {Promise<number>} process exit code
 */
async function runAffectedCapture({
  crap,
  coverage,
  args,
  getChangedFilesImpl,
  filterFilesUnderTargetsImpl,
  isCoverageFreshImpl,
  runCaptureImpl,
  computeContentDigestImpl,
  writeCaptureStampImpl,
  logger,
  fsImpl = fs,
}) {
  const ref = resolveChangedFilesRef({ crap, ref: args.ref });
  const changed = readChangedFiles({
    getChangedFilesImpl,
    ref,
    cwd: args.cwd,
    logger,
  });
  const scopedFiles = filterFilesUnderTargetsImpl(changed, crap.targetDirs);
  const skipWhenUnchanged =
    crap.incrementalCoverage?.skipWhenUnchanged === true;
  if (skipWhenUnchanged && changed && scopedFiles.length === 0) {
    logger.info(
      `[coverage-capture] Affected mode: no changed files under [${crap.targetDirs.join(', ')}] vs ${ref} — skipping capture.`,
    );
    return 0;
  }

  const probe = () =>
    isCoverageFreshImpl({
      coveragePath: crap.coveragePath,
      targetDirs: crap.targetDirs,
      cwd: args.cwd,
      requireScope: 'affected',
    });
  if (probe().fresh) {
    logger.info(
      `[coverage-capture] Coverage at ${crap.coveragePath} is fresh (affected) — skipping capture.`,
    );
    return 0;
  }

  const artifactAbs = path.resolve(args.cwd, crap.coveragePath);
  const prior = changed ? readArtifact(artifactAbs, fsImpl) : null;
  const preDigest = computeContentDigestImpl(args.cwd, crap.targetDirs);
  const code = await runCaptureImpl({
    cwd: args.cwd,
    timeoutMs: coverage?.timeoutMs,
    script: AFFECTED_CAPTURE_SCRIPT,
    env: { [COVERAGE_BASE_REF_ENV]: ref },
    log: (m) => logger.info(m),
    recheckFresh: () => probe().fresh === true,
  });
  if (code !== 0) return reportCaptureFailure(code, logger);

  const scoped = readArtifact(artifactAbs, fsImpl);
  if (scoped === null) {
    logger.error(
      `[coverage-capture] ✖ npm run ${AFFECTED_CAPTURE_SCRIPT} exited 0 but wrote no readable artifact at ${crap.coveragePath} — point its coverage output there.`,
    );
    return 1;
  }
  const merged = mergeCoverageArtifacts({
    prior,
    scoped,
    cwd: args.cwd,
    dropFiles: changed ?? [],
  });
  fsImpl.writeFileSync(artifactAbs, JSON.stringify(merged));

  stampCapturedTree({
    preDigest,
    cwd: args.cwd,
    targetDirs: crap.targetDirs,
    coveragePath: crap.coveragePath,
    scope: 'affected',
    files: scopedFiles,
    ref,
    computeContentDigestImpl,
    writeCaptureStampImpl,
    logger,
  });
  return 0;
}

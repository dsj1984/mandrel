/**
 * coverage-capture.js — ensure `coverage/coverage-final.json` is present and
 * fresh before any CRAP gate (close-validation pre-flight, pre-push, CI) reads
 * it. The CRAP scorer treats "no coverage" as "skip the method" under the
 * default `requireCoverage: true` policy, so a missing or stale artifact
 * silently weakens the gate. This helper closes that hole by capturing
 * coverage in-band when it is missing or older than the CRAP-target sources.
 *
 * Pure functions live here; the spawn wiring lives in
 * `.agents/scripts/coverage-capture.js` (CLI). Importers test freshness via
 * `isCoverageFresh` and decide whether to delegate to `runCapture`.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Walk a directory tree and return the newest mtime (ms since epoch) seen
 * across `.js` and `.mjs` files. Symlinks, missing dirs, and unreadable nodes
 * resolve to 0 so the caller treats "no sources" the same as "ancient sources"
 * — both mean "any existing coverage is fresh enough".
 *
 * Exported for unit testing.
 *
 * @param {string} cwd Absolute repo root.
 * @param {string[]} targetDirs Repo-relative directories to scan.
 * @param {{ statSync?: typeof fs.statSync, readdirSync?: typeof fs.readdirSync }} [io]
 * @returns {number} Newest mtime in ms, or 0 when no source files exist.
 */
export function newestSourceMtime(cwd, targetDirs, io = {}) {
  const statSync = io.statSync ?? fs.statSync;
  const readdirSync = io.readdirSync ?? fs.readdirSync;
  let newest = 0;

  const visit = (abs) => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const childAbs = path.join(abs, entry.name);
      if (entry.isDirectory()) {
        visit(childAbs);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.js') && !entry.name.endsWith('.mjs')) continue;
      try {
        const m = statSync(childAbs).mtimeMs;
        if (m > newest) newest = m;
      } catch {
        // ignore unreadable file
      }
    }
  };

  for (const dir of targetDirs) {
    if (!dir) continue;
    visit(path.resolve(cwd, dir));
  }
  return newest;
}

/**
 * Resolve the capture-stamp path that sits next to the coverage artifact.
 * The stamp persists the content digest of the CRAP-target sources at the
 * moment coverage was last captured, so freshness can be decided by content
 * rather than mtime (mtime churns on branch switches / checkouts even when
 * content is unchanged).
 *
 * @param {string} cwd Absolute repo root.
 * @param {string} coveragePath Repo-relative coverage artifact path.
 * @returns {string} Absolute stamp path (`<coverage-dir>/.capture-stamp.json`).
 */
export function captureStampPath(cwd, coveragePath) {
  return path.join(
    path.dirname(path.resolve(cwd, coveragePath)),
    '.capture-stamp.json',
  );
}

const SOURCE_EXT_RE = /\.(?:js|mjs)$/;

/**
 * Compute a stable content digest of the `.js`/`.mjs` sources under
 * `targetDirs`: the `git ls-files -s` listing (mode + blob SHA + path) of
 * tracked content, plus the on-disk bytes of any dirty working-tree files.
 * Checkout/branch churn leaves blob SHAs untouched, so the digest only moves
 * when content actually changes.
 *
 * Returns `null` when the digest cannot be computed (git unavailable, not a
 * repo, empty target list) so callers can fall back to the mtime heuristic.
 *
 * @param {string} cwd Absolute repo root.
 * @param {string[]} targetDirs Repo-relative directories to digest.
 * @param {{ spawnSync?: typeof spawnSync, readFileSync?: typeof fs.readFileSync }} [io]
 * @returns {string | null} Hex SHA-256 digest, or null when unavailable.
 */
export function computeContentDigest(cwd, targetDirs, io = {}) {
  const spawn = io.spawnSync ?? spawnSync;
  const readFileSync = io.readFileSync ?? fs.readFileSync;
  const dirs = (targetDirs ?? []).filter(
    (d) => typeof d === 'string' && d.length > 0,
  );
  if (dirs.length === 0) return null;

  const git = (...args) => {
    const res = spawn('git', args, { cwd, encoding: 'utf8' });
    if (res?.error || res?.status !== 0) {
      throw res?.error ?? new Error(res?.stderr || `git ${args[0]} failed`);
    }
    return res.stdout ?? '';
  };

  try {
    const hash = crypto.createHash('sha256');
    const tracked = git('ls-files', '-s', '--', ...dirs)
      .split('\n')
      .filter((line) => SOURCE_EXT_RE.test(line.trimEnd()));
    hash.update(tracked.join('\n'));

    // Dirty working-tree files are not represented by their index blob SHA,
    // so fold in their on-disk bytes (or absence) explicitly.
    const dirty = git('status', '--porcelain', '--', ...dirs)
      .split('\n')
      .filter((line) => line.length > 3);
    for (const line of dirty) {
      let file = line.slice(3).trim();
      if (file.includes(' -> ')) file = file.split(' -> ').pop();
      file = file.replace(/^"|"$/g, '');
      if (!SOURCE_EXT_RE.test(file)) continue;
      hash.update(`\0${file}\0`);
      try {
        hash.update(readFileSync(path.resolve(cwd, file)));
      } catch {
        hash.update('<absent>');
      }
    }
    return hash.digest('hex');
  } catch {
    return null;
  }
}

/**
 * Persist the capture stamp next to the coverage artifact. Best-effort: a
 * write failure returns `false` rather than throwing — the worst case is a
 * fall back to the mtime heuristic on the next freshness check.
 *
 * @param {{
 *   cwd: string,
 *   coveragePath: string,
 *   digest: string,
 *   writeFileSync?: typeof fs.writeFileSync,
 * }} opts
 * @returns {boolean} True when the stamp was written.
 */
export function writeCaptureStamp({
  cwd,
  coveragePath,
  digest,
  writeFileSync = fs.writeFileSync,
}) {
  if (typeof digest !== 'string' || digest.length === 0) return false;
  try {
    writeFileSync(
      captureStampPath(cwd, coveragePath),
      `${JSON.stringify({ digest, capturedAt: new Date().toISOString() }, null, 2)}\n`,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Decide whether the existing coverage artifact is "fresh".
 *
 * Primary test (content-aware, Story #3982): when a capture stamp exists
 * next to the artifact, compare its persisted digest against the current
 * content digest of `targetDirs`. Equal digests → fresh; different → stale.
 * Branch switches and checkouts that bump mtimes without changing content
 * no longer invalidate coverage.
 *
 * Fallback (stamp absent / unreadable / digest unavailable): the original
 * mtime heuristic — artifact at least as new as the newest source file
 * under `targetDirs`. Missing files, missing target dirs, or any IO error
 * resolve to `false` so the caller captures rather than trusting stale data.
 *
 * @param {{
 *   coveragePath: string,
 *   targetDirs: string[],
 *   cwd: string,
 *   statSync?: typeof fs.statSync,
 *   readdirSync?: typeof fs.readdirSync,
 *   existsSync?: typeof fs.existsSync,
 *   readFileSync?: typeof fs.readFileSync,
 *   computeDigest?: typeof computeContentDigest,
 * }} opts
 * @returns {{ fresh: boolean, reason: 'missing' | 'stale' | 'fresh' | 'no-sources' }}
 */
export function isCoverageFresh({
  coveragePath,
  targetDirs,
  cwd,
  statSync = fs.statSync,
  readdirSync = fs.readdirSync,
  existsSync = fs.existsSync,
  readFileSync = fs.readFileSync,
  computeDigest = computeContentDigest,
}) {
  const absCoverage = path.resolve(cwd, coveragePath);
  if (!existsSync(absCoverage)) return { fresh: false, reason: 'missing' };

  const stampPath = captureStampPath(cwd, coveragePath);
  if (existsSync(stampPath)) {
    let stamp = null;
    try {
      stamp = JSON.parse(readFileSync(stampPath, 'utf8'));
    } catch {
      // Corrupt/unreadable stamp → fall through to the mtime heuristic.
    }
    if (typeof stamp?.digest === 'string' && stamp.digest.length > 0) {
      const current = computeDigest(cwd, targetDirs);
      if (typeof current === 'string' && current.length > 0) {
        return current === stamp.digest
          ? { fresh: true, reason: 'fresh' }
          : { fresh: false, reason: 'stale' };
      }
    }
  }

  let coverageMtime;
  try {
    coverageMtime = statSync(absCoverage).mtimeMs;
  } catch {
    return { fresh: false, reason: 'missing' };
  }

  const newestSrc = newestSourceMtime(cwd, targetDirs, {
    statSync,
    readdirSync,
  });
  if (newestSrc === 0) return { fresh: true, reason: 'no-sources' };
  return coverageMtime >= newestSrc
    ? { fresh: true, reason: 'fresh' }
    : { fresh: false, reason: 'stale' };
}

/**
 * Decide whether any of `changedFiles` lives under one of `targetDirs`.
 * Used by the pre-push fast-path so we can skip the (slow) coverage capture
 * when the push touches only files outside the CRAP scoring scope.
 *
 * Both inputs are forward-slash-normalised; `targetDirs` are matched as path
 * prefixes followed by `/`. An empty changed-file list returns `false`.
 *
 * @param {string[]} changedFiles
 * @param {string[]} targetDirs
 * @returns {boolean}
 */
export function anyChangedUnderTargets(changedFiles, targetDirs) {
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) return false;
  if (!Array.isArray(targetDirs) || targetDirs.length === 0) return false;
  const norms = targetDirs
    .filter((d) => typeof d === 'string' && d.length > 0)
    .map((d) => d.replace(/\\/g, '/').replace(/\/+$/, ''));
  return changedFiles.some((file) => {
    const f = String(file).replace(/\\/g, '/');
    return norms.some((dir) => f === dir || f.startsWith(`${dir}/`));
  });
}

/**
 * Exit code surfaced when the bounded `npm run test:coverage` spawn was
 * killed by the timeout watchdog. Matches the GNU `timeout(1)` convention so
 * the close-validation caller can branch on "hang" (124) vs. "tests failed"
 * (any other non-zero status). Story #2136 / Task #2142.
 */
export const COVERAGE_TIMEOUT_EXIT_CODE = 124;

/**
 * Spawn `npm run test:coverage` in `cwd` with a bounded wall clock. Inherits
 * stdio so the operator sees the raw test output. Returns the exit status; a
 * non-zero exit means the caller should propagate the failure (a broken test
 * suite cannot be papered over by the CRAP gate).
 *
 * The `timeoutMs` budget is enforced by `spawnSync` with `killSignal:
 * 'SIGKILL'` — Node fires the signal at the budget boundary and the result
 * surfaces with `signal: 'SIGKILL'`. We translate that into the GNU
 * `timeout(1)` convention exit code 124 so callers can pattern-match a
 * runaway runner without inspecting signal names.
 *
 * @param {{
 *   cwd: string,
 *   timeoutMs?: number,
 *   runner?: typeof spawnSync,
 *   log?: (m: string) => void,
 * }} opts
 * @returns {number}
 */
export function runCapture({
  cwd,
  timeoutMs,
  runner = spawnSync,
  log = () => {},
} = {}) {
  log('[coverage-capture] ▶ npm run test:coverage');
  const spawnOpts = {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    killSignal: 'SIGKILL',
  };
  if (
    typeof timeoutMs === 'number' &&
    Number.isFinite(timeoutMs) &&
    timeoutMs > 0
  ) {
    spawnOpts.timeout = timeoutMs;
  }
  const res = runner('npm', ['run', 'test:coverage'], spawnOpts);
  // A timeout-induced kill surfaces as `signal: 'SIGKILL'` (or, on some
  // platforms, as a non-numeric status). Either signal indicates the
  // watchdog tripped — surface the GNU `timeout` convention 124 so the
  // caller can distinguish a hang from a normal test-suite failure.
  if (res?.signal === 'SIGKILL') {
    log(
      `[coverage-capture] ⏱ npm run test:coverage exceeded ${timeoutMs}ms — killed (SIGKILL). Returning exit ${COVERAGE_TIMEOUT_EXIT_CODE}.`,
    );
    return COVERAGE_TIMEOUT_EXIT_CODE;
  }
  return res.status ?? 1;
}

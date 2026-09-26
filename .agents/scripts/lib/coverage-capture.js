/**
 * Keep `coverage/coverage-final.json` present and fresh before a CRAP gate
 * reads it: the scorer skips uncovered methods, so a stale artifact silently
 * weakens the gate.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { LOCK_WAIT_EXPIRED_EXIT_CODE } from './full-suite-lock.js';
import { TIMEOUT_EXIT_CODE } from './process-group.js';
import {
  isScorableSourceFile,
  SCORABLE_SOURCE_EXT_RE,
} from './source-extensions.js';
import { runSupervisedSuite } from './supervised-suite.js';

/**
 * Newest mtime across the scorable sources the CRAP scanner walks; unreadable
 * nodes are skipped. 0 means "found nothing", never "fresh".
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
      if (!isScorableSourceFile(entry.name)) continue;
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
 * The stamp records the sources' content digest at capture time, so freshness
 * survives mtime churn from checkouts.
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

/**
 * Fold dirty scorable files' on-disk bytes (or absence) into `hash`; their
 * index blob SHA does not represent them.
 *
 * @param {{
 *   hash: import('node:crypto').Hash,
 *   cwd: string,
 *   readFileSync: typeof fs.readFileSync,
 *   porcelain: string,
 * }} opts `porcelain` is raw `git status --porcelain` output.
 * @returns {number} Count of scorable dirty files folded in.
 */
function foldDirtySources({ hash, cwd, readFileSync, porcelain }) {
  let count = 0;
  for (const line of porcelain.split('\n').filter((l) => l.length > 3)) {
    let file = line.slice(3).trim();
    if (file.includes(' -> ')) file = file.split(' -> ').pop();
    file = file.replace(/^"|"$/g, '');
    if (!SCORABLE_SOURCE_EXT_RE.test(file)) continue;
    count += 1;
    hash.update(`\0${file}\0`);
    try {
      hash.update(readFileSync(path.resolve(cwd, file)));
    } catch {
      hash.update('<absent>');
    }
  }
  return count;
}

/**
 * Digest of the scorable sources under `targetDirs`: `git ls-files -s` of
 * tracked content plus dirty files' bytes, so it moves only on content change.
 * `null` means unavailable (no git, no dirs, or zero matching files — a hash
 * of empty input would pin the artifact permanently fresh).
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
      .filter((line) => SCORABLE_SOURCE_EXT_RE.test(line.trimEnd()));
    hash.update(tracked.join('\n'));

    const scorableDirty = foldDirtySources({
      hash,
      cwd,
      readFileSync,
      porcelain: git('status', '--porcelain', '--', ...dirs),
    });
    if (tracked.length + scorableDirty === 0) return null;
    return hash.digest('hex');
  } catch {
    return null;
  }
}

/**
 * Best-effort: a write failure returns `false` (next check falls back to
 * mtime). Full-scope callers omit `scope`, keeping the `{ digest, capturedAt }`
 * shape.
 *
 * @param {{
 *   cwd: string,
 *   coveragePath: string,
 *   digest: string,
 *   scope?: 'full' | 'incremental' | 'affected',
 *   files?: string[],
 *   ref?: string,
 *   writeFileSync?: typeof fs.writeFileSync,
 * }} opts
 * @returns {boolean} True when the stamp was written.
 */
export function writeCaptureStamp({
  cwd,
  coveragePath,
  digest,
  scope,
  files,
  ref,
  writeFileSync = fs.writeFileSync,
}) {
  if (typeof digest !== 'string' || digest.length === 0) return false;
  const payload = { digest, capturedAt: new Date().toISOString() };
  if (scope !== undefined) payload.scope = scope;
  if (Array.isArray(files)) payload.files = [...files].sort();
  if (typeof ref === 'string' && ref.length > 0) payload.ref = ref;
  try {
    writeFileSync(
      captureStampPath(cwd, coveragePath),
      `${JSON.stringify(payload, null, 2)}\n`,
    );
    return true;
  } catch {
    return false;
  }
}

/** Stamp scopes narrower than `full`; each satisfies only its own probe. */
const PARTIAL_STAMP_SCOPES = new Set(['incremental', 'affected']);

/**
 * @param {{digest?: unknown, scope?: unknown} | null} stamp
 * @param {'full' | 'incremental' | 'affected'} requireScope
 * @returns {{ digest: string } | { scopeMismatch: true } | null} `null`
 *   falls through to the mtime heuristic.
 */
function readStampForScope(stamp, requireScope) {
  if (typeof stamp?.digest !== 'string' || stamp.digest.length === 0) {
    return null;
  }
  if (PARTIAL_STAMP_SCOPES.has(stamp.scope) && stamp.scope !== requireScope) {
    return { scopeMismatch: true };
  }
  return { digest: stamp.digest };
}

/**
 * Stamp digest vs current digest when a stamp exists; otherwise artifact
 * mtime vs newest source. IO errors resolve stale. Both paths fail closed
 * (`no-sources`) on an empty source set — "found nothing" is not "nothing
 * changed". A partial (incremental / affected) stamp satisfies only a probe
 * of its own scope; a stamp with no `scope` is full-scope.
 *
 * @param {{
 *   coveragePath: string,
 *   targetDirs: string[],
 *   cwd: string,
 *   requireScope?: 'full' | 'incremental' | 'affected',
 *   statSync?: typeof fs.statSync,
 *   readdirSync?: typeof fs.readdirSync,
 *   existsSync?: typeof fs.existsSync,
 *   readFileSync?: typeof fs.readFileSync,
 *   computeDigest?: typeof computeContentDigest,
 * }} opts
 * @returns {{ fresh: boolean, reason: 'missing' | 'stale' | 'fresh' | 'no-sources' | 'scope-mismatch' }}
 */
export function isCoverageFresh({
  coveragePath,
  targetDirs,
  cwd,
  requireScope = 'full',
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
    const resolved = readStampForScope(stamp, requireScope);
    if (resolved?.scopeMismatch) {
      return { fresh: false, reason: 'scope-mismatch' };
    }
    if (resolved) {
      const current = computeDigest(cwd, targetDirs);
      if (typeof current === 'string' && current.length > 0) {
        return current === resolved.digest
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
  if (newestSrc === 0) return { fresh: false, reason: 'no-sources' };
  return coverageMtime >= newestSrc
    ? { fresh: true, reason: 'fresh' }
    : { fresh: false, reason: 'stale' };
}

/**
 * `no-sources` usually means a misconfigured `targetDirs`, so it names the
 * walked dirs and the key to fix.
 *
 * @param {{ reason?: string }} freshness Verdict from {@link isCoverageFresh}.
 * @param {string[]} targetDirs The CRAP scan scope that was walked.
 * @returns {string} The reason, annotated when it needs explaining.
 */
export function describeFreshness(freshness, targetDirs) {
  const reason = freshness?.reason;
  if (reason !== 'no-sources') return String(reason);
  const dirs = (targetDirs ?? []).join(', ');
  return `${reason} — no scorable source file found under [${dirs}]; if that does not name this project's sources, fix quality.gates.crap.targetDirs`;
}

const CREDITING_INVOCATION =
  'node <main-repo>/.agents/scripts/coverage-capture.js --cwd <workCwd>';

/**
 * Announce (or, under `--require-credited`, refuse) an uncredited full-suite
 * capture — before the spawn, while it is still actionable. Read-only, so it
 * never takes the host lock.
 *
 * @param {{
 *   requireCredited?: boolean,
 *   logger: { info: Function, warn: Function, error: Function },
 * }} opts `requireCredited` is a per-invocation CLI opt-in, never config:
 *   from config it would also refuse the invocation that deposits credit.
 * @returns {number | null} A non-zero exit code the caller MUST return
 *   without spawning the suite, or `null` to proceed with the capture.
 */
function announceUncreditedCapture({ requireCredited = false, logger }) {
  const preamble =
    'no credited capture stamp covers this change set — ' +
    `the full suite is about to run. Deposit credit before the push with: ${CREDITING_INVOCATION}`;
  if (requireCredited) {
    logger.error(
      `[coverage-capture] ✖ ${preamble} (--require-credited was passed, so this run is refused instead of paid for).`,
    );
    return 1;
  }
  logger.warn(`[coverage-capture] ⚠ ${preamble}`);
  return null;
}

/**
 * Wrap a capture runner so the announcement is inseparable from the spawn.
 * Composes outside `lockedCapture`, so a refusal never acquires the lock.
 *
 * @param {(opts: object) => Promise<number>|number} runCaptureFn
 * @param {{ requireCredited?: boolean, logger: object }} policy
 * @returns {(opts?: object) => Promise<number>} Exit code, or a refusal code
 *   without spawning.
 */
export function creditedCapture(runCaptureFn, { requireCredited, logger }) {
  return async (captureOpts = {}) => {
    const refusal = announceUncreditedCapture({ requireCredited, logger });
    return refusal === null ? await runCaptureFn(captureOpts) : refusal;
  };
}

/**
 * Stamp the pre-spawn digest (the tree the run measured), and write nothing
 * when the post-run digest differs — the artifact then describes a tree no
 * longer on disk. A `null` post-digest is "unavailable", not "changed".
 *
 * @param {{
 *   preDigest: string|null,
 *   cwd: string,
 *   targetDirs: string[],
 *   coveragePath: string,
 *   scope?: 'full' | 'incremental' | 'affected',
 *   files?: string[],
 *   ref?: string,
 *   computeContentDigestImpl: typeof computeContentDigest,
 *   writeCaptureStampImpl: typeof writeCaptureStamp,
 *   logger: { info: Function, warn: Function, error: Function },
 * }} opts
 * @returns {boolean} Whether a stamp was written.
 */
export function stampCapturedTree({
  preDigest,
  cwd,
  targetDirs,
  coveragePath,
  scope,
  files,
  ref,
  computeContentDigestImpl,
  writeCaptureStampImpl,
  logger,
}) {
  if (!preDigest) return false;
  const postDigest = computeContentDigestImpl(cwd, targetDirs);
  if (postDigest && postDigest !== preDigest) {
    logger.warn(
      '[coverage-capture] ⚠ the tree moved while the suite ran — the coverage ' +
        'artifact measures sources that are no longer on disk, so no capture ' +
        'stamp was written. The next capture will re-run against the current tree.',
    );
    return false;
  }
  const written = writeCaptureStampImpl({
    cwd,
    coveragePath,
    digest: preDigest,
    ...(scope === undefined ? {} : { scope }),
    ...(files === undefined ? {} : { files }),
    ...(ref === undefined ? {} : { ref }),
  });
  if (written) {
    logger.info(
      `[coverage-capture] Wrote content-digest capture stamp${scope ? ` (${scope} scope)` : ''}.`,
    );
  }
  return written;
}

/**
 * Changed files under a `targetDirs` prefix, forward-slash-normalised.
 *
 * @param {string[]} changedFiles
 * @param {string[]} targetDirs
 * @returns {string[]} Forward-slash-normalised matches, in `changedFiles` order.
 */
export function filterFilesUnderTargets(changedFiles, targetDirs) {
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) return [];
  if (!Array.isArray(targetDirs) || targetDirs.length === 0) return [];
  const norms = targetDirs
    .filter((d) => typeof d === 'string' && d.length > 0)
    .map((d) => d.replace(/\\/g, '/').replace(/\/+$/, ''));
  return changedFiles
    .map((file) => String(file).replace(/\\/g, '/'))
    .filter((f) => norms.some((dir) => f === dir || f.startsWith(`${dir}/`)));
}

/**
 * Pre-push fast path: skip capture when nothing in CRAP scope changed.
 *
 * @param {string[]} changedFiles
 * @param {string[]} targetDirs
 * @returns {boolean}
 */
export function anyChangedUnderTargets(changedFiles, targetDirs) {
  return filterFilesUnderTargets(changedFiles, targetDirs).length > 0;
}

/** GNU `timeout(1)` code, so callers tell a hang (124) from failing tests. */
export const COVERAGE_TIMEOUT_EXIT_CODE = TIMEOUT_EXIT_CODE;

/**
 * Spawn `npm run <script>` asynchronously as its own process group, so
 * the lock heartbeat keeps running and a timeout or signal kills every
 * worker. Takes no positional file args: node's runner would execute a
 * forwarded source file as a test instead of filtering the suite. Scope a
 * run through `env` instead.
 *
 * `timeoutMs` is armed at spawn — the lock wait before it (`lockWaitMs`,
 * supplied by `lockedCapture`) never spends it — and re-armed when the suite
 * signals `MANDREL_SUITE_READY_FILE`. `onTimings` receives the three figures;
 * the remaining options are {@link runSupervisedSuite}'s.
 *
 * @param {{
 *   cwd: string,
 *   timeoutMs?: number,
 *   script?: string,
 *   env?: Record<string, string>,
 *   spawnImpl?: Function,
 *   log?: (m: string) => void,
 *   lockWaitMs?: number,
 *   onTimings?: (timings: import('./supervised-suite.js').SuiteTimings) => void,
 * }} opts
 * @returns {Promise<number>}
 */
export function runCapture(opts = {}) {
  const { script = 'test:coverage', log = () => {} } = opts;
  const args = ['run', script];
  log(`[coverage-capture] ▶ npm ${args.join(' ')}`);
  return runSupervisedSuite({
    ...opts,
    cmd: 'npm',
    args,
    onTimeout: () =>
      log(
        `[coverage-capture] ⏱ npm run ${script} exceeded ${opts.timeoutMs}ms — killed its process group. Returning exit ${COVERAGE_TIMEOUT_EXIT_CODE}.`,
      ),
  });
}

/**
 * Exits that are not a failing suite, each with its own report: an expired
 * lock wait ran nothing, and a timeout killed the suite before any verdict.
 */
const NON_FAILURE_CAPTURE_EXITS = Object.freeze({
  [LOCK_WAIT_EXPIRED_EXIT_CODE]: [
    'info',
    (code) =>
      `[coverage-capture] ⏸ the full-suite lock wait expired with another suite still running, so this capture was deferred — no suite ran. Exiting ${code}; re-run it once that suite finishes.`,
  ],
  [COVERAGE_TIMEOUT_EXIT_CODE]: [
    'error',
    (code) =>
      `[coverage-capture] ⏱ npm run test:coverage timed out and was killed (exit ${code}) — no test verdict exists. This is usually host contention, not a failing test; re-run once the host is quieter.`,
  ],
});

const FAILING_SUITE_REPORT = Object.freeze([
  'error',
  (code) =>
    `[coverage-capture] ✖ npm run test:coverage exited ${code}. Fix failing tests or coverage-threshold breaches before re-running the CRAP gate.`,
]);

/**
 * Report a non-zero capture; an expired lock wait or a timeout is not a
 * failing suite, so neither prints the failing-tests line.
 *
 * @param {number} code
 * @param {{ info: Function, error: Function }} logger
 * @returns {number}
 */
export function reportCaptureFailure(code, logger) {
  const [level, message] =
    NON_FAILURE_CAPTURE_EXITS[code] ?? FAILING_SUITE_REPORT;
  logger[level](message(code));
  return code;
}

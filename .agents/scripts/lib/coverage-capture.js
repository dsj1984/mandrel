/**
 * Keep the coverage artifact (`coverage.coveragePath`) present and fresh
 * before a CRAP or coverage gate reads it: the scorer skips uncovered
 * methods, so a stale artifact silently weakens the gate.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnChild } from './child-exec.js';
import { COVERAGE_CAPTURE_DEFAULTS } from './config/gates/coverage.schema.js';
import { packageScriptArgv } from './detect-package-manager.js';
import { LOCK_WAIT_EXPIRED_EXIT_CODE } from './full-suite-lock.js';
import { Logger } from './Logger.js';
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
 * survives mtime churn from checkouts. It is keyed per artifact, beside it, so
 * two artifacts may share a directory without cross-crediting freshness.
 *
 * @param {string} cwd Absolute repo root.
 * @param {string} coveragePath Repo-relative coverage artifact path.
 * @returns {string} Absolute stamp path (`<dir>/.capture-stamp.<basename>.json`).
 */
export function captureStampPath(cwd, coveragePath) {
  const abs = path.resolve(cwd, coveragePath);
  return path.join(
    path.dirname(abs),
    `.capture-stamp.${path.basename(abs)}.json`,
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
 *   select?: (file: string) => boolean,
 * }} opts `porcelain` is raw `git status --porcelain` output; `select`
 *   picks which dirty paths fold in (default: scorable sources).
 * @returns {number} Count of selected dirty files folded in.
 */
function foldDirtySources({
  hash,
  cwd,
  readFileSync,
  porcelain,
  select = (file) => SCORABLE_SOURCE_EXT_RE.test(file),
}) {
  let count = 0;
  for (const line of porcelain.split('\n').filter((l) => l.length > 3)) {
    let file = line.slice(3).trim();
    if (file.includes(' -> ')) file = file.split(' -> ').pop();
    file = file.replace(/^"|"$/g, '');
    if (!select(file)) continue;
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
 * A digest's git runner, through `spawnChild` so a repo whose index listing
 * outgrows Node's 1 MiB default buffer still digests (no ENOBUFS). A failure
 * throws an error tagged with the subcommand, for the warning.
 *
 * @param {string} cwd
 * @param {{ spawnSync?: Function }} io `io.spawnSync` is the test seam.
 * @returns {(...args: string[]) => string}
 */
function digestGit(cwd, io) {
  return (...args) => {
    const res = spawnChild('git', args, { cwd, run: io.spawnSync });
    if (res?.error || res?.status !== 0) {
      const err =
        res?.error ?? new Error(res?.stderr || `git ${args[0]} failed`);
      err.gitSubcommand = args[0];
      if (err.code === undefined) err.code = `exit ${res?.status}`;
      throw err;
    }
    return res.stdout ?? '';
  };
}

/**
 * No digest never matches, so an unfreshable stamp is announced, not silent.
 *
 * @param {Error & { gitSubcommand?: string, code?: string }} err
 * @param {{ logger?: { warn: Function } }} io
 * @returns {null}
 */
function warnDigestUnavailable(err, io) {
  const logger = io.logger ?? Logger;
  const subcommand = err?.gitSubcommand ?? 'digest';
  logger.warn(
    `[coverage-capture] ⚠ git ${subcommand} failed (${err?.code ?? 'unknown'}); digest unavailable, stamp cannot read fresh.`,
  );
  return null;
}

/**
 * Digest of the scorable sources under `targetDirs`: `git ls-files -s` of
 * tracked content plus dirty files' bytes, so it moves only on content change.
 * `null` means unavailable (no git, no dirs, or zero matching files — a hash
 * of empty input would pin the artifact permanently fresh).
 *
 * @param {string} cwd Absolute repo root.
 * @param {string[]} targetDirs Repo-relative directories to digest.
 * @param {{ spawnSync?: Function, readFileSync?: typeof fs.readFileSync, logger?: { warn: Function } }} [io]
 * @returns {string | null} Hex SHA-256 digest, or null when unavailable.
 */
export function computeContentDigest(cwd, targetDirs, io = {}) {
  const readFileSync = io.readFileSync ?? fs.readFileSync;
  const dirs = (targetDirs ?? []).filter(
    (d) => typeof d === 'string' && d.length > 0,
  );
  if (dirs.length === 0) return null;

  const git = digestGit(cwd, io);

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
  } catch (err) {
    return warnDigestUnavailable(err, io);
  }
}

/** Gate-written output: a baseline-refresh commit must not void the run it records. */
const SUITE_DIGEST_EXCLUDED_DIRS = Object.freeze(['baselines']);

/** @param {string|null|undefined} coveragePath */
function suiteDigestExcludedDirs(coveragePath) {
  const coverageDir = path.posix.dirname(
    String(coveragePath ?? '').replace(/\\/g, '/'),
  );
  return [...SUITE_DIGEST_EXCLUDED_DIRS, coverageDir].filter(
    (dir) => dir !== '.' && dir.length > 0,
  );
}

/**
 * The changed paths that move {@link computeTreeDigest}, so spend the stamp.
 *
 * @param {string[]} files
 * @param {string|null} [coveragePath]
 * @returns {string[]}
 */
export function filterSuiteInputPaths(files, coveragePath = null) {
  const dirs = suiteDigestExcludedDirs(coveragePath);
  return (Array.isArray(files) ? files : []).filter((file) => {
    const norm = String(file).replace(/\\/g, '/');
    return !dirs.some((dir) => norm === dir || norm.startsWith(`${dir}/`));
  });
}

/**
 * Digest of every suite input: tracked and dirty paths (untracked included)
 * at any extension, minus the baselines and the coverage directory. The
 * source digest says the artifact matches the sources; this one says the
 * suite ran on this tree. `null` (no git) never matches.
 *
 * @param {string} cwd
 * @param {string} coveragePath
 * @param {{ spawnSync?: Function, readFileSync?: typeof fs.readFileSync, logger?: { warn: Function } }} [io]
 * @returns {string | null}
 */
export function computeTreeDigest(cwd, coveragePath, io = {}) {
  const readFileSync = io.readFileSync ?? fs.readFileSync;
  const pathspec = [
    '--',
    '.',
    ...suiteDigestExcludedDirs(coveragePath).map((dir) => `:(exclude)${dir}`),
  ];
  const git = digestGit(cwd, io);
  try {
    const hash = crypto.createHash('sha256');
    hash.update(git('ls-files', '-s', ...pathspec));
    foldDirtySources({
      hash,
      cwd,
      readFileSync,
      porcelain: git(
        'status',
        '--porcelain',
        '--untracked-files=all',
        ...pathspec,
      ),
      select: () => true,
    });
    return hash.digest('hex');
  } catch (err) {
    return warnDigestUnavailable(err, io);
  }
}

/** @param {string} value */
const nonEmpty = (value) => typeof value === 'string' && value.length > 0;

/** Scoped-stamp fields, each written only when it carries a value. */
function optionalStampFields({ scope, files, ref, commit }) {
  const out = {};
  if (scope !== undefined) out.scope = scope;
  if (Array.isArray(files)) out.files = [...files].sort();
  if (nonEmpty(ref)) out.ref = ref;
  if (nonEmpty(commit)) out.commit = commit;
  return out;
}

/** @param {Record<string, unknown>} fields */
function definedOnly(fields) {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  );
}

/**
 * Best-effort: a write failure returns `false` (next check falls back to
 * mtime). Full-scope callers omit `scope`, keeping the `{ digest, capturedAt }`
 * shape. `commit` is the HEAD sha the run measured; a stamp without it reads
 * exactly as before and is never delta-refresh eligible.
 *
 * @param {{
 *   cwd: string,
 *   coveragePath: string,
 *   digest: string,
 *   scope?: 'full' | 'incremental' | 'affected',
 *   files?: string[],
 *   ref?: string,
 *   commit?: string | null,
 *   treeDigest?: string | null,
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
  commit,
  treeDigest,
  writeFileSync = fs.writeFileSync,
}) {
  if (typeof digest !== 'string' || digest.length === 0) return false;
  const payload = {
    digest,
    capturedAt: new Date().toISOString(),
    treeDigest,
    ...optionalStampFields({ scope, files, ref, commit }),
  };
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
 * @returns {{ digest: string, treeDigest: string | null } | { scopeMismatch: true } | null} `null`
 *   means no usable stamp: nothing vouches for the artifact.
 */
function readStampForScope(stamp, requireScope) {
  if (typeof stamp?.digest !== 'string' || stamp.digest.length === 0) {
    return null;
  }
  if (PARTIAL_STAMP_SCOPES.has(stamp.scope) && stamp.scope !== requireScope) {
    return { scopeMismatch: true };
  }
  return {
    digest: stamp.digest,
    treeDigest: nonEmpty(stamp.treeDigest) ? stamp.treeDigest : null,
  };
}

/**
 * @param {{ resolved: { digest: string, treeDigest: string | null }, current: string, computeTree: typeof computeTreeDigest, cwd: string, coveragePath: string }} opts
 * @returns {boolean}
 */
function stampMatchesTree({
  resolved,
  current,
  computeTree,
  cwd,
  coveragePath,
}) {
  if (current !== resolved.digest || resolved.treeDigest === null) return false;
  return computeTree(cwd, coveragePath) === resolved.treeDigest;
}

/**
 * Only a matching stamp vouches for the artifact, because only a green run
 * writes one; artifact mtime says when a run wrote it, never that the run
 * passed, so a red run's artifact must not read as fresh. Without a verdict,
 * `no-sources` (empty source set — "found nothing" is not "nothing changed")
 * outranks `unstamped`. A partial (incremental / affected) stamp satisfies
 * only a probe of its own scope; a stamp with no `scope` is full-scope.
 * Fresh needs both digests; a stamp without a tree digest is `stale`.
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
 *   computeTree?: typeof computeTreeDigest,
 * }} opts
 * @returns {{ fresh: boolean, reason: 'missing' | 'stale' | 'fresh' | 'no-sources' | 'scope-mismatch' | 'unstamped' }}
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
  computeTree = computeTreeDigest,
}) {
  const absCoverage = path.resolve(cwd, coveragePath);
  if (!existsSync(absCoverage)) return { fresh: false, reason: 'missing' };

  const stampPath = captureStampPath(cwd, coveragePath);
  if (existsSync(stampPath)) {
    let stamp = null;
    try {
      stamp = JSON.parse(readFileSync(stampPath, 'utf8'));
    } catch {
      // Corrupt/unreadable stamp vouches for nothing.
    }
    const resolved = readStampForScope(stamp, requireScope);
    if (resolved?.scopeMismatch) {
      return { fresh: false, reason: 'scope-mismatch' };
    }
    if (resolved) {
      const current = computeDigest(cwd, targetDirs);
      if (typeof current === 'string' && current.length > 0) {
        return stampMatchesTree({
          resolved,
          current,
          computeTree,
          cwd,
          coveragePath,
        })
          ? { fresh: true, reason: 'fresh' }
          : { fresh: false, reason: 'stale' };
      }
    }
  }

  const newestSrc = newestSourceMtime(cwd, targetDirs, {
    statSync,
    readdirSync,
  });
  return {
    fresh: false,
    reason: newestSrc === 0 ? 'no-sources' : 'unstamped',
  };
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
 * The capture contract every coverage consumer leans on: the capture script
 * writes Istanbul per-file JSON at `coveragePath`. A summary-only reporter
 * cannot feed the coverage or CRAP baselines (CRAP joins per-function maps).
 *
 * @param {string} abs Absolute artifact path that was looked for.
 * @returns {string}
 */
function missingCoverageArtifactMessage(
  abs,
  script = COVERAGE_CAPTURE_DEFAULTS.captureScript,
  configKey = 'delivery.quality.gates.coverage.coveragePath',
) {
  return (
    `coverage artifact not found at ${abs}. The \`${script}\` script must ` +
    'write Istanbul per-file JSON (the `json` reporter → coverage-final.json) ' +
    `at ${configKey}; a \`json-summary\` ` +
    '(coverage-summary.json) alone cannot feed the coverage or CRAP baselines.'
  );
}

/**
 * Fatal on every scope: zero scored rows would let the scope merge delete the
 * in-scope rows.
 */
export class MissingCoverageArtifactError extends Error {
  constructor(abs, { prefix = '', cause } = {}) {
    super(
      `${prefix}${missingCoverageArtifactMessage(abs)}`,
      cause === undefined ? undefined : { cause },
    );
    this.name = 'MissingCoverageArtifactError';
    this.artifactPath = abs;
  }
}

/**
 * Wrap a capture runner so a green run that left no artifact at
 * `coveragePath` exits 1: a broken capture contract, not a capture. Every
 * capture path already returns before stamping on a non-zero code. `script`
 * and `configKey` name the capture source in the refusal (an
 * own CRAP source runs `crap.captureScript` into `crap.coveragePath`).
 *
 * @param {(opts: object) => Promise<number>} run
 * @param {{ cwd: string, coveragePath: string,
 *   existsSync?: (p: string) => boolean,
 *   script?: string, configKey?: string,
 *   logger: { error: Function } }} opts
 * @returns {(opts: object) => Promise<number>}
 */
export function requireCaptureArtifact(
  run,
  { cwd, coveragePath, existsSync = fs.existsSync, script, configKey, logger },
) {
  return async (captureOpts) => {
    const code = await run(captureOpts);
    if (code !== 0) return code;
    const abs = path.resolve(cwd, coveragePath);
    if (existsSync(abs)) return 0;
    logger.error(
      `[coverage-capture] ✖ ${script ?? COVERAGE_CAPTURE_DEFAULTS.captureScript} passed but ${missingCoverageArtifactMessage(abs, script, configKey)}`,
    );
    return 1;
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
 *   commit?: string | null,
 *   preTreeDigest?: string | null,
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
  commit,
  preTreeDigest,
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
    ...definedOnly({
      scope,
      files,
      ref,
      commit: commit || undefined,
      treeDigest: preTreeDigest || undefined,
    }),
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

/**
 * @param {{ cwd: string, coveragePath?: string }} opts No `coveragePath`,
 *   no stamp to drop.
 */
function dropCaptureStamp({ cwd, coveragePath }) {
  if (!coveragePath) return;
  fs.rmSync(captureStampPath(cwd, coveragePath), { force: true });
}

/** GNU `timeout(1)` code, so callers tell a hang (124) from failing tests. */
export const COVERAGE_TIMEOUT_EXIT_CODE = TIMEOUT_EXIT_CODE;

/**
 * Spawn `<pm> run <script>` (the detected package manager, see
 * `packageScriptArgv`) asynchronously as its own process group, so
 * the lock heartbeat keeps running and a timeout or signal kills every
 * worker. Takes no positional file args: node's runner would execute a
 * forwarded source file as a test instead of filtering the suite. Scope a
 * run through `env` instead. Given `coveragePath`, the capture stamp is
 * removed before the spawn: the suite is about to overwrite the artifact, so
 * a red, killed or crashed run must leave no stamp vouching for it — only
 * `stampCapturedTree` after a green run restores one.
 *
 * @param {{
 *   cwd: string,
 *   coveragePath?: string,
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
  const { script = COVERAGE_CAPTURE_DEFAULTS.captureScript, log = () => {} } =
    opts;
  dropCaptureStamp(opts);
  const [cmd, ...args] = packageScriptArgv(opts.cwd ?? process.cwd(), script);
  const command = [cmd, ...args].join(' ');
  log(`[coverage-capture] ▶ ${command}`);
  return runSupervisedSuite({
    ...opts,
    cmd,
    args,
    onTimeout: () =>
      log(
        `[coverage-capture] ⏱ ${command} exceeded ${opts.timeoutMs}ms — killed its process group. Returning exit ${COVERAGE_TIMEOUT_EXIT_CODE}.`,
      ),
  });
}

/** @param {number} code */
function lockWaitExpiredMessage(code) {
  return `[coverage-capture] ⏸ the full-suite lock wait expired with another suite still running, so this capture was deferred — no suite ran. Exiting ${code}; re-run it once that suite finishes.`;
}

/**
 * @param {number} code
 * @param {string} script
 */
function timeoutMessage(code, script) {
  return `[coverage-capture] ⏱ the ${script} capture script timed out and was killed (exit ${code}) — no test verdict exists. This is usually host contention, not a failing test; re-run once the host is quieter.`;
}

/**
 * @param {number} code
 * @param {string} script
 */
function failingSuiteMessage(code, script) {
  return `[coverage-capture] ✖ the ${script} capture script exited ${code}. Fix failing tests or coverage-threshold breaches before re-running the CRAP gate.`;
}

/**
 * Exits that are not a failing suite, each with its own report: an expired
 * lock wait ran nothing, and a timeout killed the suite before any verdict.
 * Named functions: V8 coverage omitted an inline arrow here, so CRAP could
 * not resolve it.
 */
const NON_FAILURE_CAPTURE_EXITS = Object.freeze({
  [LOCK_WAIT_EXPIRED_EXIT_CODE]: ['info', lockWaitExpiredMessage],
  [COVERAGE_TIMEOUT_EXIT_CODE]: ['error', timeoutMessage],
});

const FAILING_SUITE_REPORT = Object.freeze(['error', failingSuiteMessage]);

/**
 * Report a non-zero capture; an expired lock wait or a timeout is not a
 * failing suite, so neither prints the failing-tests line. `script` is the
 * one the pass ran (an own CRAP source runs `crap.captureScript`).
 *
 * @param {number} code
 * @param {{ info: Function, error: Function }} logger
 * @param {string} [script]
 * @returns {number}
 */
export function reportCaptureFailure(
  code,
  logger,
  script = COVERAGE_CAPTURE_DEFAULTS.captureScript,
) {
  const [level, message] =
    NON_FAILURE_CAPTURE_EXITS[code] ?? FAILING_SUITE_REPORT;
  logger[level](message(code, script));
  return code;
}

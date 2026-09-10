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
import {
  isScorableSourceFile,
  SCORABLE_SOURCE_EXT_RE,
} from './source-extensions.js';

/**
 * Walk a directory tree and return the newest mtime (ms since epoch) seen
 * across the scorable source files (`source-extensions.js`) — the same set
 * the CRAP scanner walks, so freshness tracks exactly what the gate scores.
 * Symlinks, missing dirs, and unreadable nodes resolve to 0.
 *
 * A 0 return means "discovery found nothing", which {@link isCoverageFresh}
 * treats as an absence of evidence rather than as freshness — see its
 * `no-sources` contract.
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

/**
 * Fold every dirty scorable working-tree file under the scanned dirs into
 * `hash`, and report how many there were.
 *
 * Dirty files are not represented by their index blob SHA, so their on-disk
 * bytes (or absence) go in explicitly. Split out of
 * {@link computeContentDigest} to keep that function's complexity at its
 * committed CRAP floor.
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
 * Compute a stable content digest of the scorable sources
 * (`source-extensions.js`) under `targetDirs`: the `git ls-files -s` listing (mode + blob SHA + path) of
 * tracked content, plus the on-disk bytes of any dirty working-tree files.
 * Checkout/branch churn leaves blob SHAs untouched, so the digest only moves
 * when content actually changes.
 *
 * Returns `null` when the digest cannot be computed (git unavailable, not a
 * repo, empty target list) so callers can fall back to the mtime heuristic.
 * A target list that matches **no** scorable file is the same "unavailable"
 * case, not a digest over zero files: this path is the primary freshness
 * test, so returning a real hash of empty input would pin the artifact
 * permanently fresh and make the mtime path's fail-closed verdict
 * unreachable (Story #5076).
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
    // Discovery found nothing to digest: hashing the empty input would yield
    // a constant that can never go stale, so report "unavailable" instead and
    // let the caller's fail-closed mtime path decide.
    if (tracked.length + scorableDirty === 0) return null;
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
 * `scope` / `files` / `ref` are Story #4981 additions for incremental-mode
 * capture. They are written to the stamp **only when the caller supplies
 * `scope`** — the default (full-scope) call sites never pass it, so the
 * emitted JSON stays the exact `{ digest, capturedAt }` shape byte-for-byte
 * (AC-5). `isCoverageFresh` reads `scope` back to refuse letting a scoped
 * stamp satisfy a full-scope freshness probe (AC-4).
 *
 * @param {{
 *   cwd: string,
 *   coveragePath: string,
 *   digest: string,
 *   scope?: 'full' | 'incremental',
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

/**
 * Read a persisted capture stamp's digest and scope tag back into the shape
 * `isCoverageFresh` needs, applying the Story #4981 scope-asymmetry rule
 * (AC-4) in one place. Extracted so the parent function's own branching
 * stays under the cyclomatic ceiling.
 *
 * @param {{digest?: unknown, scope?: unknown} | null} stamp
 * @param {'full' | 'incremental'} requireScope
 * @returns {{ digest: string } | { scopeMismatch: true } | null} `null`
 *   means the stamp is missing/unreadable/digest-less — fall through to the
 *   mtime heuristic.
 */
function readStampForScope(stamp, requireScope) {
  if (typeof stamp?.digest !== 'string' || stamp.digest.length === 0) {
    return null;
  }
  const stampScope = stamp.scope === 'incremental' ? 'incremental' : 'full';
  if (stampScope === 'incremental' && requireScope !== 'incremental') {
    return { scopeMismatch: true };
  }
  return { digest: stamp.digest };
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
 * **Both paths fail closed on an empty source set (Story #5076).** Finding no
 * scorable source under `targetDirs` means the check learned nothing, so it
 * reports `{ fresh: false, reason: 'no-sources' }` and the caller captures.
 * The alternative — treating "found nothing" as "nothing changed" — is how a
 * `js|mjs`-only selector left the CRAP gate green while measuring nothing in
 * every TypeScript consumer.
 *
 * **Scope asymmetry (Story #4981, AC-4).** A stamp written by an incremental
 * capture (`scope: 'incremental'`) only covers the files the diff touched —
 * it must never satisfy a caller that requires the full-scope guarantee
 * (`requireScope` defaults to `'full'`, matching every pre-existing caller
 * byte-for-byte). A full-scope stamp (or a legacy stamp with no `scope`
 * field, which predates this Story and is therefore full-scope by
 * construction) satisfies either probe.
 *
 * @param {{
 *   coveragePath: string,
 *   targetDirs: string[],
 *   cwd: string,
 *   requireScope?: 'full' | 'incremental',
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
  // Source discovery found nothing. That is an absence of evidence, never a
  // freshness guarantee — trusting it silently disables the capture (and with
  // it the CRAP gate) for any tree the walk cannot see (Story #5076).
  if (newestSrc === 0) return { fresh: false, reason: 'no-sources' };
  return coverageMtime >= newestSrc
    ? { fresh: true, reason: 'fresh' }
    : { fresh: false, reason: 'stale' };
}

/**
 * Render a freshness verdict for the operator-facing capture log.
 *
 * Every reason but `no-sources` speaks for itself. That one does not: failing
 * closed on an empty source walk is correct, but bare it reads as an
 * unexplained full capture on every run, and the cause is far more often a
 * `targetDirs` that does not name the project's sources than a genuine
 * recapture — so the walked dirs and the key to fix are named inline
 * (Story #5076).
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

/**
 * The invocation that deposits capture credit for a Story branch. Named in
 * the uncredited-capture announcement so a reader of a close log sees the
 * command that would have avoided the cost, not just the cost.
 */
const CREDITING_INVOCATION =
  'node <main-repo>/.agents/scripts/coverage-capture.js --cwd <workCwd>';

/**
 * Announce — and, when the consumer requires credit, refuse — a full-suite
 * capture that no committed stamp covers.
 *
 * Every caller invokes this immediately before it would spawn the suite, and
 * the ordering is the whole point. The capture itself is the most expensive
 * thing a close does; discovering that it ran uncredited is only actionable
 * while it is still ahead of you, not once it is visible as a `durationMs`
 * in `validation-evidence.json` twelve minutes later.
 *
 * The probe is read-only by construction: every caller has already decided
 * to capture by the time it runs, and it writes nothing — so it never takes
 * the full-suite host lock and can never itself be the reason a close waits.
 *
 * @param {{
 *   requireCredited?: boolean,
 *   logger: { info: Function, warn: Function, error: Function },
 * }} opts `requireCredited` comes from the CLI's `--require-credited`
 *   argument, which the close gate passes when
 *   `delivery.execution.requireCreditedCapture` is set (default false →
 *   announce and run). Story #5278: it is deliberately NOT read from config
 *   here — that made the refusal cover the depositing invocation too, leaving
 *   no way to earn the credit it demanded.
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
 * Compose the uncredited-capture probe over a capture runner, so the
 * announcement is structurally inseparable from the spawn it describes.
 *
 * This mirrors `lockedCapture`, and for the same reason: there are two
 * capture paths (full-scope and incremental) and neither should have to
 * remember the policy. Wrapping the runner they share means a third path
 * added later inherits the probe for free, and that the warning can never be
 * emitted for a capture that does not happen — or omitted for one that does.
 *
 * It composes OUTSIDE `lockedCapture`, so a refusal costs nothing: the host
 * lock is never acquired for a run that is about to be declined.
 *
 * @param {(opts: object) => number} runCaptureFn The (possibly already
 *   lock-wrapped) capture runner.
 * @param {{ requireCredited?: boolean, logger: object }} policy
 * @returns {(opts?: object) => number} A runner returning the capture's exit
 *   code, or a non-zero refusal code without having spawned anything.
 */
export function creditedCapture(runCaptureFn, { requireCredited, logger }) {
  return (captureOpts = {}) => {
    const refusal = announceUncreditedCapture({ requireCredited, logger });
    return refusal === null ? runCaptureFn(captureOpts) : refusal;
  };
}

/**
 * Write the capture stamp for a run that has just finished — but only when
 * the tree it measured is still the tree on disk (Story #5278).
 *
 * The stamp is a claim about content: "coverage/coverage-final.json reflects
 * sources digesting to X". Computing X *after* the suite finishes makes that
 * claim false whenever anything moved while the suite ran — a sibling
 * worktree's write, a rebase, an editor save minutes into a ten-minute run.
 * The digest taken **before** the spawn is the one the run actually measured,
 * so that is the value written, and a post-run digest that disagrees means
 * the artifact describes a tree nobody has any more: no stamp is written at
 * all, and the next reader captures rather than crediting a run against
 * sources it never saw.
 *
 * A `null` on either digest is "unavailable", not "changed" — the same
 * fail-open the pre-#5278 code had, since without a digest there is nothing
 * to stamp.
 *
 * @param {{
 *   preDigest: string|null,
 *   cwd: string,
 *   targetDirs: string[],
 *   coveragePath: string,
 *   scope?: 'full' | 'incremental',
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
 * Narrow `changedFiles` to the subset that lives under one of `targetDirs`.
 *
 * Both inputs are forward-slash-normalised; `targetDirs` are matched as path
 * prefixes followed by `/`. Shared by `anyChangedUnderTargets` (the pre-push
 * fast-path boolean) and the incremental-coverage scope resolver (Story
 * #4981), which needs the actual file list rather than a yes/no.
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
 * Decide whether any of `changedFiles` lives under one of `targetDirs`.
 * Used by the pre-push fast-path so we can skip the (slow) coverage capture
 * when the push touches only files outside the CRAP scoring scope.
 *
 * An empty changed-file list returns `false`.
 *
 * @param {string[]} changedFiles
 * @param {string[]} targetDirs
 * @returns {boolean}
 */
export function anyChangedUnderTargets(changedFiles, targetDirs) {
  return filterFilesUnderTargets(changedFiles, targetDirs).length > 0;
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
 * The spawn takes **no positional file arguments**. Story #4981 forwarded the
 * changed-file list as `npm run test:coverage -- <files...>` on the premise
 * that a test runner treats trailing positionals as filters over the suite.
 * Node's runner does not: it treats each path as a test file to execute, so a
 * forwarded *source* file runs as a trivially-passing test and the real suite
 * never runs. `run-coverage.js` discarded the list, which is the only reason
 * that never bit; Story #5063 measured it and Story #5065 removed the
 * plumbing rather than leave a parameter whose obvious "fix" empties the
 * coverage artifact.
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
  const args = ['run', 'test:coverage'];
  log(`[coverage-capture] ▶ npm ${args.join(' ')}`);
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
  const res = runner('npm', args, spawnOpts);
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

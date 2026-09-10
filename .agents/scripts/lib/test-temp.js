/**
 * Managed test temp directories (Story #4808).
 *
 * The suite used to mint `os.tmpdir()` directories directly at ~71 call
 * sites across 25 files that never reaped them, accumulating tens of
 * thousands of entries per run into a temp root shared with self-hosted CI
 * runners. The damaging axis is **entry count**, not bytes: a runner's
 * job-started hook scanning an 841k-entry temp root burned 5m29s inside the
 * job clock and timed jobs out.
 *
 * Per-call-site teardown had already failed 25 times, so this module makes
 * teardown structural instead: a directory cannot be created without its
 * reaping already registered.
 *
 * ## Why one suite root
 *
 * A guard over a *shared* `os.tmpdir()` cannot attribute an entry to this
 * suite. A prefix allowlist rots the moment someone invents a new prefix,
 * and a bare "no new entries" assertion false-positives on any unrelated
 * process that happened to run concurrently. Nesting every managed
 * directory inside a single per-process root
 * (`mandrel-suite-<pid>-<random>`) makes attribution exact: the guard asks
 * only whether a *suite root* survived, which is a question about this
 * suite alone. The suite contributes exactly one shared-root entry per
 * process, and reaps it.
 *
 * ## Why the root is never published to children
 *
 * Deliberately unlike `MANDREL_TEST_TEMP_ROOT` (the scratch seam in
 * `test-env.js` / `config/temp-paths.js`, which children inherit): each
 * process owns its own suite root, so "did I create it?" is always
 * answerable locally and a child can never reap its parent's root
 * mid-run.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import picomatch from 'picomatch';

/**
 * Directory-name prefix identifying a per-process suite root. The guard
 * matches on this, so it is the one string both sides must agree on.
 */
export const SUITE_ROOT_PREFIX = 'mandrel-suite-';

/**
 * Reserved snapshot-manifest key under which the guard records the suite
 * roots observed at `--snapshot` time. It cannot collide with a stream
 * entry: those are always `*.ndjson` relative paths.
 */
export const SUITE_ROOTS_KEY = '#suiteRoots';

/** Default `warn` sink: one line on stderr, shared by every seam below. */
const stderrWarn = (msg) => process.stderr.write(`${msg}\n`);

/**
 * Remove one directory, reporting a failure rather than throwing it.
 *
 * Both reapers need exactly this: a suite that passed must not start
 * failing because a directory could not be unlinked (a Windows file lock, a
 * read-only mount). The leak is the lesser defect, and the guard reports it
 * separately.
 *
 * @param {string} target absolute path to remove
 * @param {string} label what `target` is, for the failure message
 * @param {typeof fs} fsImpl
 * @param {(msg: string) => void} warn
 * @returns {void}
 */
function rmQuietly(target, label, fsImpl, warn) {
  try {
    fsImpl.rmSync(target, { recursive: true, force: true });
  } catch (err) {
    warn(`[test-temp] failed to reap ${label} ${target}: ${err.message}`);
  }
}

/** Per-process suite root, or `null` before the first `makeTempDir`. */
let _suiteRoot = null;

/** Guards against registering the exit reaper more than once. */
let _reaperRegistered = false;

/** Lead-in of the one warning a root disappearing mid-run produces. */
const VANISHED =
  '[test-temp] suite temp root disappeared mid-run (removed by something ' +
  'outside this process):';

/**
 * Test-only: forget the per-process suite root without removing it, so a
 * test can exercise the creation branch repeatedly in one process.
 */
export function _resetSuiteTempRootForTests() {
  _suiteRoot = null;
  _reaperRegistered = false;
}

/**
 * Report the suite root this process currently owns, without minting one.
 *
 * Test-only in spirit, but also the honest way for a failing fixture to say
 * whether the root still exists when it reports a copy failure: asking
 * {@link suiteTempRoot} would *create* one and destroy the evidence.
 *
 * @returns {string|null}
 */
export function _currentSuiteTempRoot() {
  return _suiteRoot;
}

/**
 * Remove this process's suite root and everything under it.
 *
 * A teardown failure is reported on stderr and swallowed — see
 * {@link rmQuietly}.
 *
 * Only the process that minted the root can reach a non-null `_suiteRoot`,
 * so this is creator-only by construction. It reads that variable *live*
 * rather than a path captured at arming time, which is what keeps a root
 * re-created mid-run (see {@link suiteTempRoot}) reapable and a root it has
 * replaced unreachable — a stale path is never passed to `rmSync`.
 *
 * @param {{ fsImpl?: typeof fs, warn?: (msg: string) => void }} [deps]
 * @returns {string|null} the removed root, or `null` when there was none
 */
export function reapSuiteTempRoot({ fsImpl = fs, warn = stderrWarn } = {}) {
  const root = _suiteRoot;
  if (root === null) return null;
  _suiteRoot = null;
  rmQuietly(root, 'suite temp root', fsImpl, warn);
  return root;
}

/**
 * Resolve (creating on first use) this process's suite root.
 *
 * The reaper is registered on `exit` at creation time, so a directory
 * cannot exist without its teardown already armed — including when the
 * suite fails, since a failing `node --test` run still exits normally.
 *
 * ## Why the memoised path is re-checked every call
 *
 * The root lives under a temp tree this process does not own exclusively
 * (see the module docstring: a `/tmp` shared with self-hosted runners, an
 * OS or operator pruner). Memoising the path without re-checking it made a
 * single external removal terminal: every later `makeTempDir` in the
 * process failed with an `ENOENT` naming an interior path, and with 204
 * call sites reaching this helper one deletion cascaded through the rest
 * of the file. Re-creating is strictly better than failing — nothing in
 * the suite holds a handle to the root itself, only to directories minted
 * beneath it, which the removal already took.
 *
 * The reaper armed at first use needs no re-arming: it reads `_suiteRoot`
 * live, so it already covers whatever root this process owns at exit.
 * Re-creation leaves the replaced path unreachable, so the creator-only
 * invariant holds — this process still reaps only a root it minted, and
 * never one it has replaced.
 *
 * @param {{ fsImpl?: typeof fs, tmpdir?: () => string, onExit?: (fn: () => void) => void, warn?: (msg: string) => void }} [deps]
 * @returns {string} absolute path to the suite root
 */
export function suiteTempRoot({
  fsImpl = fs,
  tmpdir = os.tmpdir,
  onExit = (fn) => process.once('exit', fn),
  warn = stderrWarn,
} = {}) {
  if (_suiteRoot !== null && fsImpl.existsSync(_suiteRoot)) return _suiteRoot;
  return mintSuiteRoot(fsImpl, tmpdir, onExit, warn);
}

/**
 * Mint the process's suite root — the first one, or a replacement for one
 * that disappeared underneath it — and arm the reaper if nothing has.
 *
 * Separate from {@link suiteTempRoot} so the hot path stays the single
 * existence check callers pay on every `makeTempDir`, and the recovery it
 * guards reads as the exceptional branch it is.
 *
 * @param {typeof fs} fsImpl
 * @param {() => string} tmpdir
 * @param {(fn: () => void) => void} onExit
 * @param {(msg: string) => void} warn
 * @returns {string} absolute path to the new suite root
 */
function mintSuiteRoot(fsImpl, tmpdir, onExit, warn) {
  const vanished = _suiteRoot;
  const base = tmpdir();
  // The pruner that took the root may have taken its parent too; a
  // recursive mkdir on an existing directory is a no-op on first use.
  fsImpl.mkdirSync(base, { recursive: true });
  _suiteRoot = fsImpl.mkdtempSync(
    path.join(base, `${SUITE_ROOT_PREFIX}${process.pid}-`),
  );
  // Say it once, loudly: this is the only trace that something outside the
  // process touched the temp tree, and the incident it explains (#5272) was
  // filed against the wrong mechanism for want of it.
  if (vanished !== null)
    warn(`${VANISHED} ${vanished}; re-created as ${_suiteRoot}`);
  if (!_reaperRegistered) {
    _reaperRegistered = true;
    onExit(() => reapSuiteTempRoot({ fsImpl }));
  }
  return _suiteRoot;
}

/**
 * Create a fresh temp directory for a test, nested inside this process's
 * suite root and reaped with it.
 *
 * Drop-in for `mkdtempSync(path.join(os.tmpdir(), prefix))` — the returned
 * path is absolute and unique, so call sites change only where the
 * directory comes from, never how it is used.
 *
 * A vanished suite root is re-created by {@link suiteTempRoot} first, so
 * this never fails with an `ENOENT` naming a directory the caller did not
 * ask for.
 *
 * @param {string} [prefix='t-'] label kept for readability in a stack trace
 * @param {{ fsImpl?: typeof fs, tmpdir?: () => string, onExit?: (fn: () => void) => void, warn?: (msg: string) => void }} [deps]
 * @returns {string} absolute path to the new directory
 */
export function makeTempDir(prefix = 't-', deps = {}) {
  const root = suiteTempRoot(deps);
  const fsImpl = deps.fsImpl ?? fs;
  return fsImpl.mkdtempSync(path.join(root, prefix));
}

/**
 * Register removal of one specific scratch directory at process exit.
 *
 * For the two scratch seams (`test-env.js`, `config/temp-paths.js`) that
 * mint a root *outside* the suite tree because children inherit its path
 * through `MANDREL_TEST_TEMP_ROOT`. Call this only from the branch that
 * actually minted the directory — a process that inherited the path must
 * never reap it, or it deletes its parent's scratch mid-run.
 *
 * Teardown failures are swallowed for the same reason as
 * {@link reapSuiteTempRoot} — see {@link rmQuietly}.
 *
 * @param {string} dirPath absolute path this process minted
 * @param {{ fsImpl?: typeof fs, onExit?: (fn: () => void) => void, warn?: (msg: string) => void }} [deps]
 * @returns {void}
 */
export function reapOnExit(
  dirPath,
  {
    fsImpl = fs,
    onExit = (fn) => process.once('exit', fn),
    warn = stderrWarn,
  } = {},
) {
  onExit(() => rmQuietly(dirPath, 'scratch dir', fsImpl, warn));
}

/**
 * List the suite roots currently present in `tmpDir`, sorted.
 *
 * Names only (not absolute paths) so the guard can diff them against a
 * recorded snapshot without embedding the temp root's absolute location.
 *
 * @param {string} tmpDir
 * @param {{ fsImpl?: typeof fs }} [deps]
 * @returns {string[]}
 */
export function listSuiteTempRoots(tmpDir, { fsImpl = fs } = {}) {
  if (!fsImpl.existsSync(tmpDir)) return [];
  return fsImpl
    .readdirSync(tmpDir, { withFileTypes: true })
    .filter(
      (ent) => ent.isDirectory() && ent.name.startsWith(SUITE_ROOT_PREFIX),
    )
    .map((ent) => ent.name)
    .sort();
}

/**
 * Suite roots that appeared since the snapshot and are still on disk —
 * i.e. roots this suite run created and failed to reap.
 *
 * Diffing against the snapshot rather than asserting an empty set is what
 * keeps a concurrently-running suite (another checkout, another worktree)
 * from failing this one.
 *
 * @param {string} tmpDir
 * @param {string[]} snapshotRoots
 * @param {{ fsImpl?: typeof fs }} [deps]
 * @returns {string[]}
 */
export function survivingSuiteTempRoots(tmpDir, snapshotRoots, deps = {}) {
  const known = new Set(snapshotRoots ?? []);
  return listSuiteTempRoots(tmpDir, deps).filter((name) => !known.has(name));
}

/**
 * Matches a `mkdtemp` / `mkdtempSync` call whose argument reaches
 * `tmpdir()`. The lookahead spans the call's argument text rather than
 * trying to balance parentheses, so it catches every shape in use:
 * `mkdtempSync(path.join(os.tmpdir(), 'x-'))`, `mkdtempSync(join(tmpdir(),
 * 'x-'))`, and `fs.mkdtempSync(...)`.
 */
const RAW_TMPDIR_MKDTEMP =
  /mkdtemp(?:Sync)?\s*\([^;\n]{0,200}?tmpdir\s*\(\s*\)/;

/**
 * Opt-out marker for a line that must call `mkdtemp` against the real OS
 * temp root — the guard's own tests, and the scratch seams that
 * deliberately mint a root outside the suite tree.
 */
const LINT_ESCAPE = 'test-temp-allow';

/**
 * Flag test files that mint OS temp directories directly instead of going
 * through {@link makeTempDir}.
 *
 * This is the half of the backstop that catches the *next* leaking file at
 * authoring time rather than after it has already leaked, so it is scoped
 * to explicitly-passed globs: `check-test-temp-hygiene.js` ships in the
 * materialized `.agents/` payload, and a consumer's tests are none of this
 * rule's business.
 *
 * @param {string} repoRoot
 * @param {string[]} globs repo-relative picomatch patterns
 * @param {{ fsImpl?: typeof fs }} [deps]
 * @returns {{ file: string, line: number, text: string }[]}
 */
export function findRawTmpdirMkdtemp(repoRoot, globs, { fsImpl = fs } = {}) {
  const patterns = (globs ?? []).filter(Boolean);
  // Negation is handled here rather than handed to picomatch: passing a
  // mixed `['a/**', '!a/b']` array makes the `!` entry read as its own
  // positive "everything but a/b" matcher, which silently *widens* the
  // scan instead of narrowing it.
  const include = patterns.filter((p) => !p.startsWith('!'));
  const exclude = patterns
    .filter((p) => p.startsWith('!'))
    .map((p) => p.slice(1));
  if (include.length === 0) return [];
  const isIncluded = picomatch(include);
  const isExcluded = exclude.length > 0 ? picomatch(exclude) : () => false;
  const findings = [];
  for (const rel of walkFiles(repoRoot, fsImpl)) {
    if (!isIncluded(rel) || isExcluded(rel)) continue;
    const lines = fsImpl
      .readFileSync(path.join(repoRoot, rel), 'utf8')
      .split('\n');
    lines.forEach((text, i) => {
      if (!RAW_TMPDIR_MKDTEMP.test(text)) return;
      if (text.includes(LINT_ESCAPE)) return;
      if (i > 0 && lines[i - 1].includes(LINT_ESCAPE)) return;
      findings.push({ file: rel, line: i + 1, text: text.trim() });
    });
  }
  return findings;
}

/**
 * Walk `root` for JavaScript sources, returning POSIX-normalised relative
 * paths. Unlike the `test-isolate` walker this descends dot-prefixed
 * directories (the `.agents/` payload carries `__tests__` trees) while
 * still skipping the trees that are never source: `node_modules`,
 * `.worktrees`, and `.git`.
 *
 * @param {string} root
 * @param {typeof fs} fsImpl
 * @returns {string[]}
 */
function walkFiles(root, fsImpl) {
  const out = [];
  const skip = new Set(['node_modules', '.worktrees', '.git', 'temp']);
  const walk = (dir, prefix) => {
    if (!fsImpl.existsSync(dir)) return;
    for (const ent of fsImpl.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(ent.name)) continue;
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        walk(path.join(dir, ent.name), rel);
      } else if (/\.(?:js|mjs|cjs)$/.test(ent.name)) {
        out.push(rel);
      }
    }
  };
  walk(root, '');
  return out.sort();
}

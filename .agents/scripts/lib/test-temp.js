/**
 * Managed test temp dirs: none exists without its reaping registered. All
 * nest in one per-process suite root, so the leak guard attributes exactly;
 * the root is never published to children, so none can reap its parent's.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import picomatch from 'picomatch';

/** Suite-root name prefix; the guard matches on it. */
export const SUITE_ROOT_PREFIX = 'mandrel-suite-';

/**
 * Snapshot-manifest key for suite roots; cannot collide with a stream entry
 * (always a `*.ndjson` relative path).
 */
export const SUITE_ROOTS_KEY = '#suiteRoots';

const stderrWarn = (msg) => process.stderr.write(`${msg}\n`);

/**
 * Remove a directory, reporting rather than throwing: a passing suite must
 * not fail on an unlinkable directory (Windows lock, read-only mount).
 *
 * @param {string} target absolute path to remove
 * @param {string} label
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

let _suiteRoot = null;

let _reaperRegistered = false;

const VANISHED =
  '[test-temp] suite temp root disappeared mid-run (removed by something ' +
  'outside this process):';

/**
 * Suite roots this process minted and later found gone. Recovery must not be
 * silent: the exit reaper turns this list into a failing verdict.
 */
const _vanishedRoots = [];

const VANISHED_EXIT_CODE = 1;

/**
 * Never lowers an exit code already set: a real test failure is the more
 * informative verdict.
 *
 * @param {number} code
 * @returns {void}
 */
function raiseExitCode(code) {
  if (!process.exitCode) process.exitCode = code;
}

/** Test-only: forget the suite root without removing it. */
export function _resetSuiteTempRootForTests() {
  _suiteRoot = null;
  _reaperRegistered = false;
  _vanishedRoots.length = 0;
}

/**
 * Report every root that vanished under this process and fail the run.
 *
 * @param {{ warn?: (msg: string) => void, setExitCode?: (code: number) => void }} [deps]
 * @returns {void}
 */
function reportVanishedRoots({
  warn = stderrWarn,
  setExitCode = raiseExitCode,
} = {}) {
  if (_vanishedRoots.length === 0) return;
  warn(
    `[test-temp] FAIL — ${_vanishedRoots.length} suite temp root(s) disappeared mid-run:\n` +
      _vanishedRoots.map((root) => `  - ${root}`).join('\n') +
      '\n[test-temp] the suite recovered by re-minting, so the tests passed — but something outside this process is deleting the temp tree, and a fixture that hits the window between the removal and the re-mint fails with an unattributable ENOENT (#5272). Find the pruner before trusting this run.',
  );
  setExitCode(VANISHED_EXIT_CODE);
}

/**
 * The suite root this process owns, without minting one (asking
 * {@link suiteTempRoot} would create one and destroy the evidence).
 *
 * @returns {string|null}
 */
export function _currentSuiteTempRoot() {
  return _suiteRoot;
}

/**
 * Remove this process's suite root. Creator-only by construction; reads
 * `_suiteRoot` live so a re-minted root is reaped and a replaced one never is.
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
 * Re-checked every call: one external prune must not cascade ENOENT through
 * later `makeTempDir`s, and nothing holds a handle to the root itself.
 *
 * @param {{ fsImpl?: typeof fs, tmpdir?: () => string, onExit?: (fn: () => void) => void, warn?: (msg: string) => void, setExitCode?: (code: number) => void }} [deps]
 * @returns {string} absolute path to the suite root
 */
export function suiteTempRoot(deps = {}) {
  const fsImpl = deps.fsImpl ?? fs;
  if (_suiteRoot !== null && fsImpl.existsSync(_suiteRoot)) return _suiteRoot;
  return mintSuiteRoot(deps);
}

/**
 * @param {{ fsImpl?: typeof fs, tmpdir?: () => string, onExit?: (fn: () => void) => void, warn?: (msg: string) => void, setExitCode?: (code: number) => void }} deps
 * @returns {string} absolute path to the new suite root
 */
function mintSuiteRoot({
  fsImpl = fs,
  tmpdir = os.tmpdir,
  onExit = (fn) => process.once('exit', fn),
  warn = stderrWarn,
  setExitCode = raiseExitCode,
} = {}) {
  const vanished = _suiteRoot;
  const base = tmpdir();
  // Never re-create the OS temp root itself: it would get this process's
  // umask instead of sticky 1777, hiding a broken machine behind a pass.
  if (!fsImpl.existsSync(base))
    throw new Error(
      `[test-temp] OS temp root ${base} does not exist; refusing to create it. Something removed the system temp directory (or TMPDIR points at a path that was never created) — fix the environment rather than letting the suite mint it.`,
    );
  _suiteRoot = fsImpl.mkdtempSync(
    path.join(base, `${SUITE_ROOT_PREFIX}${process.pid}-`),
  );
  if (vanished !== null) {
    _vanishedRoots.push(vanished);
    warn(`${VANISHED} ${vanished}; re-created as ${_suiteRoot}`);
  }
  if (!_reaperRegistered) {
    _reaperRegistered = true;
    onExit(() => {
      reapSuiteTempRoot({ fsImpl, warn });
      reportVanishedRoots({ warn, setExitCode });
    });
  }
  return _suiteRoot;
}

/**
 * Drop-in for `mkdtempSync(path.join(os.tmpdir(), prefix))`, nested in the
 * suite root and reaped with it.
 *
 * @param {string} [prefix='t-']
 * @param {{ fsImpl?: typeof fs, tmpdir?: () => string, onExit?: (fn: () => void) => void, warn?: (msg: string) => void }} [deps]
 * @returns {string} absolute path to the new directory
 */
export function makeTempDir(prefix = 't-', deps = {}) {
  const root = suiteTempRoot(deps);
  const fsImpl = deps.fsImpl ?? fs;
  return fsImpl.mkdtempSync(path.join(root, prefix));
}

/**
 * Register removal of a scratch directory at exit, for seams that mint
 * outside the suite tree. Call only from the branch that minted it — an
 * inheriting process would delete its parent's scratch mid-run.
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
 * Suite roots created since the snapshot and still on disk. Diffing against
 * the snapshot keeps a concurrent suite from failing this one.
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
 * A `mkdtemp`/`mkdtempSync` call whose argument reaches `tmpdir()`; spans the
 * argument text instead of balancing parentheses.
 */
const RAW_TMPDIR_MKDTEMP =
  /mkdtemp(?:Sync)?\s*\([^;\n]{0,200}?tmpdir\s*\(\s*\)/;

/** Opt-out marker for a line that must mint against the real OS temp root. */
const LINT_ESCAPE = 'test-temp-allow';

/**
 * Raw OS-temp mints outside {@link makeTempDir}, in explicit globs only.
 *
 * @param {string} repoRoot
 * @param {string[]} globs repo-relative picomatch patterns
 * @param {{ fsImpl?: typeof fs }} [deps]
 * @returns {{ file: string, line: number, text: string }[]}
 */
export function findRawTmpdirMkdtemp(repoRoot, globs, { fsImpl = fs } = {}) {
  const patterns = (globs ?? []).filter(Boolean);
  // Split negations out: in a mixed picomatch array a `!` entry is its own
  // positive matcher, which widens the scan instead of narrowing it.
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
 * POSIX-relative JS sources under `root`; descends dot-directories (the
 * `.agents/` payload has `__tests__`) but skips non-source trees.
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

/**
 * `temp/run-<id>/` path-resolution helper (Epic #1030 Story #1039).
 *
 * Single source of truth for every artifact path that lives under
 * `project.paths.tempRoot`. Every script that previously hand-rolled
 * a flat `temp/<artifact>-run-<id>.<ext>` path migrates to call one of
 * these helpers. The Tech Spec (#1032) names this module as the cutover
 * grep target — `temp/.*-epic-` should be empty across `.agents/scripts`
 * once the migration Stories land.
 *
 * Layout:
 *   temp/run-<eid>/
 *     ├─ techspec.md
 *     ├─ manifest.md          (dispatch manifest)
 *     ├─ retro.md             (mirror of GitHub retro at Epic close)
 *     ├─ lifecycle.ndjson     (lifecycle bus ledger)
 *     ├─ checkpoints/...      (pre-v2 epic-runner state store; retained layout)
 *     ├─ <name>               (runArtifactPath escape hatch)
 *     └─ stories/
 *        └─ story-<sid>/
 *           ├─ manifest.md       (story dispatch manifest)
 *           ├─ signals.ndjson    (append-only signals writer)
 *           └─ <name>            (storyArtifactPath escape hatch)
 *
 * Standalone Stories (no parent Epic) follow the same shape under
 * `<tempRoot>/standalone/stories/story-<sid>/`. The `stories/` segment
 * was introduced by Story #2940 to visually separate per-Epic artifacts
 * from per-Story siblings.
 *
 * tempRoot resolution: the helper accepts an optional `config` argument
 * (the full resolved config or a partial bag with `project.paths.tempRoot`);
 * when omitted it lazy-loads via `resolveConfig()` so
 * call sites already inside the resolver can pass their own bag and avoid the
 * round-trip. The missing-tempRoot fallback resolves to `'temp'` — the
 * framework default shipped in `.agents/docs/agentrc-reference.json`. Note that the
 * AJV schema marks `tempRoot` as required for any loaded `.agentrc.json`, so
 * the fallback only matters in zero-config callers (tests, ad-hoc scripts).
 *
 * Main-checkout anchoring (Story #3900): the Epic/Story directory helpers
 * resolve a *relative* `tempRoot` against the **main checkout root** (the
 * parent of `git rev-parse --git-common-dir`) rather than `process.cwd()`.
 * Without this, a story child that `cd`s into `.worktrees/story-<id>/` before
 * emitting a lifecycle record would append it to
 * `<worktree>/temp/run-N/lifecycle.ndjson`, while the `/deliver` host
 * (running from the main checkout) reads the main-checkout copy — so the
 * host never sees the child's records (the audit-#3513 bug class; its
 * original `story.heartbeat` instance is gone with that emitter, but the
 * divergence applies to every ledger writer). Anchoring the
 * ledger to the git common dir makes the worktree child writer and the
 * main-checkout host reader converge on a single file regardless of cwd. An
 * absolute `tempRoot` is honoured verbatim; only relative roots are anchored.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Cache the resolved main-checkout root per spawn cwd so the
 * `git rev-parse` shell-out runs at most once per distinct working
 * directory in a process. The cache key is the `cwd` the resolution ran
 * against (defaulting to `process.cwd()`); a `null` value records a prior
 * miss so we don't re-spawn git on a non-repo path.
 */
const _mainCheckoutRootCache = new Map();

/**
 * Resolve the **main checkout root** for a given working directory by
 * shelling out to `git rev-parse --git-common-dir` and taking its parent.
 *
 * In a linked worktree (`git worktree add`), `--git-common-dir` returns the
 * *parent* repo's `.git/` (the shared object store), so its parent directory
 * is the main checkout root — exactly the anchor we want for cwd-independent
 * lifecycle ledger paths. In the main checkout itself it returns `.git`, so
 * the parent is the main checkout root too. The two cases converge.
 *
 * Returns `null` when the path is not a git repository or git is
 * unavailable, so callers fall back to the relative (cwd-anchored) path.
 *
 * @param {string} [cwd=process.cwd()]
 * @param {{ exec?: typeof execFileSync }} [deps] Injectable for tests.
 * @returns {string|null}
 */
export function mainCheckoutRoot(cwd = process.cwd(), deps = {}) {
  const exec = deps.exec ?? execFileSync;
  // Only memoize the real (non-injected) resolver so tests stay deterministic.
  const memoize = !deps.exec;
  if (memoize && _mainCheckoutRootCache.has(cwd)) {
    return _mainCheckoutRootCache.get(cwd);
  }
  let resolved = null;
  try {
    const out = exec('git', ['rev-parse', '--git-common-dir'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out) {
      const commonDir = path.isAbsolute(out) ? out : path.resolve(cwd, out);
      resolved = path.dirname(commonDir);
    }
  } catch {
    // Not a git repo, or git unavailable — fall back to the relative path.
    resolved = null;
  }
  if (memoize) _mainCheckoutRootCache.set(cwd, resolved);
  return resolved;
}

/**
 * Test-only: clear the main-checkout-root memoization cache so a suite can
 * exercise multiple repo roots in one process without cross-test bleed.
 */
export function _clearMainCheckoutRootCache() {
  _mainCheckoutRootCache.clear();
}

/**
 * Environment variable naming an absolute per-process scratch tempRoot that
 * every stream writer must land in during a test run (Story #4696).
 *
 * The shared test bootstrap (`lib/test-env.js`) sets this to a fresh
 * `os.tmpdir()` directory before spawning the test runner, so any test that
 * reaches a writer (`signals-writer`, the lifecycle `LedgerWriter`, etc.)
 * *without* explicitly injecting an absolute tempRoot still resolves under
 * scratch instead of the repo's real `temp/` tree. This is the single
 * injection seam: because every path helper funnels a relative root through
 * `anchorTempRoot`, one redirect here covers all writers regardless of how
 * each one resolved its root.
 */
export const TEST_TEMP_ROOT_ENV = 'MANDREL_TEST_TEMP_ROOT';

/**
 * Resolve the absolute scratch tempRoot override, or `null` when none is
 * configured. Only an **absolute** value is honoured — a relative override
 * would re-anchor against the repo tree and defeat the isolation, so it is
 * ignored (treated as unset). Module-internal: the behaviour is exercised
 * through `anchorTempRoot`, so it is deliberately not exported (keeps the
 * public seam to `anchorTempRoot` + `TEST_TEMP_ROOT_ENV`).
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {string|null}
 */
function testScratchTempRoot(env = process.env) {
  const override = env?.[TEST_TEMP_ROOT_ENV];
  return typeof override === 'string' &&
    override.length > 0 &&
    path.isAbsolute(override)
    ? override
    : null;
}

/**
 * Environment variable that opts a test-context process back into the real
 * `temp/` tree (Story #4711). The `anchorTempRoot` test-context fallback
 * refuses to anchor a relative root into the repo's telemetry tree when the
 * process is a node:test context; a test that genuinely needs the real tree
 * sets this to `'1'` on its own spawn — an explicit, greppable opt-out
 * instead of a silent bypass.
 */
export const TEST_ALLOW_REAL_TEMP_ENV = 'MANDREL_TEST_ALLOW_REAL_TEMP';

/**
 * Per-process memo for the lazily-created test-context scratch dir, so every
 * relative-root resolution in one test process converges on a single scratch
 * tree (mirrors the `_mainCheckoutRootCache` pattern above).
 */
let _testContextScratchDir = null;

/**
 * Test-only: clear the test-context scratch memo so a suite can exercise the
 * lazy-arming branch repeatedly in one process.
 */
export function _clearTestContextScratchCache() {
  _testContextScratchDir = null;
}

/**
 * Is this process a node:test context? True when the env carries
 * `NODE_TEST_CONTEXT` (set by the node:test runner on every spawned test
 * child, regardless of how the runner itself was launched) or when the
 * process was started with the `--test` flag (a direct `node --test <file>`
 * runner process, or in-process isolation modes).
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {string[]} execArgv
 * @returns {boolean}
 */
function inNodeTestContext(env, execArgv) {
  return Boolean(env?.NODE_TEST_CONTEXT) || execArgv.includes('--test');
}

/**
 * Anchor a resolved `tempRoot` to the main checkout root when it is a
 * relative path (Story #3900). Absolute roots are returned verbatim; a
 * relative root is joined onto the main checkout root so every caller
 * resolves the same on-disk ledger regardless of the process cwd. When the
 * main checkout cannot be resolved (non-repo, git unavailable) the relative
 * root is returned unchanged so behaviour degrades to the prior
 * cwd-relative semantics rather than throwing.
 *
 * Test isolation (Story #4696): when the scratch override
 * (`MANDREL_TEST_TEMP_ROOT`) is set, a relative root is joined onto the
 * scratch dir instead of the main checkout root, so a writer that reaches
 * the default (or any relative) root under the test bootstrap lands in
 * scratch and never pollutes the repo's real `temp/` telemetry tree. An
 * absolute root injected by a well-behaved test still bypasses the redirect
 * verbatim.
 *
 * Process-level arming (Story #4711): the wrapper-armed override above only
 * covers processes spawned by `run-tests.js` — a direct `node --test <file>`
 * run used to bypass it and append fixture records to the real tree. When no
 * override is armed but the process *is* a node:test context (see
 * `inNodeTestContext`), a per-process scratch dir is created lazily and the
 * relative root anchors there instead. The scratch dir is memoized and — for
 * the real `process.env` — written back to `MANDREL_TEST_TEMP_ROOT` so child
 * processes the test spawns inherit the same scratch tree. Escape hatch: a
 * test that genuinely needs the real tree sets
 * `MANDREL_TEST_ALLOW_REAL_TEMP=1` (`TEST_ALLOW_REAL_TEMP_ENV`) to restore
 * main-checkout anchoring; the `check-test-temp-hygiene` guard remains the
 * backstop either way.
 *
 * @param {string} tempRoot
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @param {{ mkdtemp?: typeof mkdtempSync, execArgv?: string[] }} [deps]
 *   Injectable for tests.
 * @returns {string}
 */
export function anchorTempRoot(tempRoot, env = process.env, deps = {}) {
  if (path.isAbsolute(tempRoot)) return tempRoot;
  const scratch = testScratchTempRoot(env);
  if (scratch) return path.join(scratch, tempRoot);
  const execArgv = deps.execArgv ?? process.execArgv;
  if (
    inNodeTestContext(env, execArgv) &&
    env?.[TEST_ALLOW_REAL_TEMP_ENV] !== '1'
  ) {
    if (_testContextScratchDir === null) {
      const mkdtemp = deps.mkdtemp ?? mkdtempSync;
      _testContextScratchDir = mkdtemp(
        path.join(os.tmpdir(), 'mandrel-test-temp-'),
      );
      if (env === process.env) {
        // Children spawned by this test process inherit the same scratch.
        process.env[TEST_TEMP_ROOT_ENV] = _testContextScratchDir;
      }
    }
    return path.join(_testContextScratchDir, tempRoot);
  }
  const root = mainCheckoutRoot();
  return root ? path.join(root, tempRoot) : tempRoot;
}

/**
 * Synchronous tempRoot extraction. Accepts the canonical full resolved
 * config (`{ project, ... }`) and reads `project.paths.tempRoot`.
 *
 * Returns `'temp'` for `undefined` / non-object input or when
 * `project.paths.tempRoot` is missing / empty / non-string.
 *
 * Cross-script callers that already hold a resolved config should pass it
 * here; bare callers omit the argument and accept the framework default.
 *
 * @param {object} [config]
 * @returns {string}
 */
export function tempRootFrom(config) {
  if (!config || typeof config !== 'object') return 'temp';
  // Post-reshape canonical shape: paths live under `project.paths.*`.
  const tempRoot = config.project?.paths?.tempRoot;
  return typeof tempRoot === 'string' && tempRoot.length > 0
    ? tempRoot
    : 'temp';
}

const runId = (id) => {
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`[temp-paths] runId must be a positive integer; got ${id}`);
  }
  return id;
};

/**
 * Story #2874 — accept `null` as the standalone-story sentinel.
 * Story-level helpers (storyTempDir, signalsFile, etc.) route
 * `eid === null` to `<tempRoot>/standalone/story-<sid>/` so that
 * standalone Stories (no parent Epic) still get a stable on-disk
 * home for signals + traces. All other invalid values still throw.
 */
const storyEpicId = (id) => {
  if (id === null) return null;
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(
      `[temp-paths] epicId must be a positive integer or null; got ${id}`,
    );
  }
  return id;
};

const storyId = (id) => {
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(
      `[temp-paths] storyId must be a positive integer; got ${id}`,
    );
  }
  return id;
};

const artifactName = (name) => {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('[temp-paths] artifact name must be a non-empty string');
  }
  // Reject path traversal — every artifact must live directly under the
  // resolved Epic / Story dir. Forward slashes and back slashes alike are
  // rejected so Windows callers can't sneak `..\foo` past the guard.
  if (name.includes('/') || name.includes('\\') || name === '..') {
    throw new Error(
      `[temp-paths] artifact name must not contain path separators; got ${JSON.stringify(name)}`,
    );
  }
  return name;
};

/**
 * `temp/run-<id>/` — every run-scoped artifact lives under here.
 *
 * @param {number} rid
 * @param {object} [config]
 * @returns {string}
 */
export function runTempDir(rid, config) {
  return path.join(anchorTempRoot(tempRootFrom(config)), `run-${runId(rid)}`);
}

/**
 * `temp/run-<eid>/stories/story-<sid>/` — every Story-scoped artifact
 * lives under here.
 *
 * Story #2874: accepts `eid === null` for standalone Stories (no
 * parent Epic). The standalone variant routes to
 * `<tempRoot>/standalone/stories/story-<sid>/` so signals + traces from
 * `/single-story-deliver` runs still land in a stable, scannable
 * location instead of being dropped on the floor.
 *
 * Story #2940 introduced the intermediate `stories/` segment so that
 * per-Epic top-level artifacts (`techspec.md`, `manifest.md`,
 * `retro.md`, `lifecycle.ndjson`, `baselines/`, `checkpoints/`) are
 * visually and structurally separated from the per-Story siblings.
 *
 * @param {number|null} eid
 * @param {number} sid
 * @param {object} [config]
 * @returns {string}
 */
export function storyTempDir(eid, sid, config) {
  const checkedEid = storyEpicId(eid);
  const parent =
    checkedEid === null
      ? path.join(anchorTempRoot(tempRootFrom(config)), 'standalone')
      : runTempDir(checkedEid, config);
  return path.join(parent, 'stories', `story-${storyId(sid)}`);
}

/**
 * `temp/run-<eid>/stories/story-<sid>/signals.ndjson` — append-only
 * signal stream consumed by the analyzer (Epic #1030 AC1).
 *
 * @param {number} eid
 * @param {number} sid
 * @param {object} [config]
 * @returns {string}
 */
export function signalsFile(eid, sid, config) {
  return path.join(storyTempDir(eid, sid, config), 'signals.ndjson');
}

/**
 * `temp/run-<eid>/stories/story-<sid>/lifecycle.ndjson` — the story-scope
 * ledger destination for lifecycle events emitted directly by a Story
 * (rather than routed through the Epic-scoped bus ledger). Story #4426
 * (Epic #4425) introduces the first consumer: a standalone
 * `single-story-close` run (no parent Epic) emitting `merge.unlanded`
 * needs an on-disk home even though there is no `run-<id>/` directory to
 * anchor the event to.
 *
 * Mirrors `runLedgerPath` exactly, one level down: `eid === null` routes
 * through `storyTempDir`'s standalone branch to
 * `<tempRoot>/standalone/stories/story-<sid>/lifecycle.ndjson`; a real
 * `eid` routes to `<tempRoot>/run-<eid>/stories/story-<sid>/lifecycle.ndjson`,
 * so an Epic-attached Story's story-scope ledger sits alongside its
 * `signals.ndjson` sibling.
 *
 * @param {number|null} eid
 * @param {number} sid
 * @param {object} [config]
 * @returns {string}
 */
export const storyLedgerPath = (eid, sid, config) =>
  storyArtifactPath(eid, sid, 'lifecycle.ndjson', config);

/**
 * Escape hatch for an Epic-level artifact whose name isn't part of the
 * canonical layout (one of the per-Epic perf surfaces, retro mirror, etc.).
 * Use the named helpers below for the canonical files; reserve this one
 * for ad-hoc additions.
 *
 * @param {number} eid
 * @param {string} name
 * @param {object} [config]
 * @returns {string}
 */
export function runArtifactPath(eid, name, config) {
  return path.join(runTempDir(eid, config), artifactName(name));
}

/**
 * Escape hatch for a Story-level artifact whose name isn't part of the
 * canonical layout (signals.ndjson + manifest.md ship named helpers).
 *
 * @param {number} eid
 * @param {number} sid
 * @param {string} name
 * @param {object} [config]
 * @returns {string}
 */
function storyArtifactPath(eid, sid, name, config) {
  return path.join(storyTempDir(eid, sid, config), artifactName(name));
}

/**
 * `temp/run-<eid>/lifecycle.ndjson` — append-only lifecycle bus ledger
 * (Story #2510). The LedgerWriter persists every emitted/completed/failed
 * record here; the TraceLogger renders the companion markdown from it.
 *
 * The path is also the canonical input the standalone `lifecycle-emit`
 * CLI feeds to `buildDefaultListenerChain` when assembling the default
 * listener roster for an out-of-runner emit.
 *
 * @param {number} eid
 * @param {object} [config]
 * @returns {string}
 */
export const runLedgerPath = (eid, config) =>
  runArtifactPath(eid, 'lifecycle.ndjson', config);

// --- Canonical Story-level filenames ---

export const storyManifestPath = (eid, sid, config) =>
  storyArtifactPath(eid, sid, 'manifest.md', config);

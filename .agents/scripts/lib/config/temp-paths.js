/**
 * `temp/epic-<id>/` path-resolution helper (Epic #1030 Story #1039).
 *
 * Single source of truth for every artifact path that lives under
 * `project.paths.tempRoot`. Every script that previously hand-rolled
 * a flat `temp/<artifact>-epic-<id>.<ext>` path migrates to call one of
 * these helpers. The Tech Spec (#1032) names this module as the cutover
 * grep target — `temp/.*-epic-` should be empty across `.agents/scripts`
 * once the migration Stories land.
 *
 * Layout:
 *   temp/epic-<eid>/
 *     ├─ prd.md
 *     ├─ techspec.md
 *     ├─ manifest.md          (dispatch manifest)
 *     ├─ retro.md             (mirror of GitHub retro at Epic close)
 *     ├─ perf-report.md       (analyzer output, Epic-level)
 *     ├─ lifecycle.ndjson     (lifecycle bus ledger)
 *     ├─ checkpoints/...      (epic-runner state store)
 *     ├─ <name>               (epicArtifactPath escape hatch)
 *     └─ stories/
 *        └─ story-<sid>/
 *           ├─ manifest.md       (story dispatch manifest)
 *           ├─ signals.ndjson    (append-only signals writer)
 *           ├─ perf-summary.md
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
 * calling `story-phase.js` would append `story.heartbeat` records to
 * `<worktree>/temp/epic-N/lifecycle.ndjson`, while the `/deliver` host
 * (running from the main checkout) reads the main-checkout copy — so the
 * idle-watchdog never sees heartbeats and the Epic-lease guard silently
 * reclaims live foreign claims (the audit-#3513 bug class). Anchoring the
 * ledger to the git common dir makes the worktree child writer and the
 * main-checkout host reader converge on a single file regardless of cwd. An
 * absolute `tempRoot` is honoured verbatim; only relative roots are anchored.
 */

import { execFileSync } from 'node:child_process';
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
 * Anchor a resolved `tempRoot` to the main checkout root when it is a
 * relative path (Story #3900). Absolute roots are returned verbatim; a
 * relative root is joined onto the main checkout root so every caller
 * resolves the same on-disk ledger regardless of the process cwd. When the
 * main checkout cannot be resolved (non-repo, git unavailable) the relative
 * root is returned unchanged so behaviour degrades to the prior
 * cwd-relative semantics rather than throwing.
 *
 * @param {string} tempRoot
 * @returns {string}
 */
function anchorTempRoot(tempRoot) {
  if (path.isAbsolute(tempRoot)) return tempRoot;
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

const epicId = (id) => {
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(
      `[temp-paths] epicId must be a positive integer; got ${id}`,
    );
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
 * `temp/epic-<eid>/` — every Epic-scoped artifact lives under here.
 *
 * @param {number} eid
 * @param {object} [config]
 * @returns {string}
 */
export function epicTempDir(eid, config) {
  return path.join(anchorTempRoot(tempRootFrom(config)), `epic-${epicId(eid)}`);
}

/**
 * `temp/epic-<eid>/stories/story-<sid>/` — every Story-scoped artifact
 * lives under here.
 *
 * Story #2874: accepts `eid === null` for standalone Stories (no
 * parent Epic). The standalone variant routes to
 * `<tempRoot>/standalone/stories/story-<sid>/` so signals + traces from
 * `/single-story-deliver` runs still land in a stable, scannable
 * location instead of being dropped on the floor.
 *
 * Story #2940 introduced the intermediate `stories/` segment so that
 * per-Epic top-level artifacts (`prd.md`, `techspec.md`, `manifest.md`,
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
      : epicTempDir(checkedEid, config);
  return path.join(parent, 'stories', `story-${storyId(sid)}`);
}

/**
 * `temp/epic-<eid>/stories/story-<sid>/signals.ndjson` — append-only
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
export function epicArtifactPath(eid, name, config) {
  return path.join(epicTempDir(eid, config), artifactName(name));
}

/**
 * Escape hatch for a Story-level artifact whose name isn't part of the
 * canonical layout (signals.ndjson + perf-summary.md + manifest.md ship
 * named helpers).
 *
 * @param {number} eid
 * @param {number} sid
 * @param {string} name
 * @param {object} [config]
 * @returns {string}
 */
export function storyArtifactPath(eid, sid, name, config) {
  return path.join(storyTempDir(eid, sid, config), artifactName(name));
}

// --- Canonical Epic-level filenames (Tech Spec #1032 §tempRoot) ---

export const epicPrdPath = (eid, config) =>
  epicArtifactPath(eid, 'prd.md', config);
export const epicTechSpecPath = (eid, config) =>
  epicArtifactPath(eid, 'techspec.md', config);
export const epicManifestPath = (eid, config) =>
  epicArtifactPath(eid, 'manifest.md', config);
export const epicRetroMirrorPath = (eid, config) =>
  epicArtifactPath(eid, 'retro.md', config);
export const epicPerfReportPath = (eid, config) =>
  epicArtifactPath(eid, 'perf-report.md', config);

/**
 * `temp/epic-<eid>/epic-perf-report.json` — canonical JSON snapshot of
 * the `epic-perf-report` payload persisted at /deliver close
 * (Epic #3019 / Story #3029 / Task #3040). When present alongside the
 * `epic-perf-report` structured comment, the report is discoverable
 * from the file system without round-tripping the ticketing provider,
 * and the `epic-handoff` structured close comment links it by relative
 * path.
 *
 * @param {number} eid
 * @param {object} [config]
 * @returns {string}
 */
export const epicPerfReportJsonPath = (eid, config) =>
  epicArtifactPath(eid, 'epic-perf-report.json', config);

/**
 * `temp/epic-<eid>/lifecycle.ndjson` — append-only lifecycle bus ledger
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
export const epicLedgerPath = (eid, config) =>
  epicArtifactPath(eid, 'lifecycle.ndjson', config);

// --- Canonical Story-level filenames ---

export const storyManifestPath = (eid, sid, config) =>
  storyArtifactPath(eid, sid, 'manifest.md', config);
export const storyPerfSummaryPath = (eid, sid, config) =>
  storyArtifactPath(eid, sid, 'perf-summary.md', config);

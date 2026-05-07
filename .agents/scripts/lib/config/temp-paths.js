/**
 * `temp/epic-<id>/` path-resolution helper (Epic #1030 Story #1039).
 *
 * Single source of truth for every artifact path that lives under
 * `agentSettings.paths.tempRoot`. Every script that previously hand-rolled
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
 *     ├─ checkpoints/...      (epic-runner checkpointer)
 *     ├─ <name>               (epicArtifactPath escape hatch)
 *     └─ story-<sid>/
 *        ├─ manifest.md       (story dispatch manifest)
 *        ├─ signals.ndjson    (append-only signals writer)
 *        ├─ perf-summary.md
 *        └─ <name>            (storyArtifactPath escape hatch)
 *
 * tempRoot resolution: the helper accepts an optional `config` argument
 * (the full resolved config or the bare `agentSettings` bag); when omitted
 * it lazy-loads via `resolveConfig()` so call sites already inside the
 * resolver can pass their own bag and avoid the round-trip. The
 * missing-tempRoot fallback resolves to `'temp'` — the framework default
 * shipped in `.agents/default-agentrc.json`. Note that the AJV schema
 * marks `tempRoot` as required for any loaded `.agentrc.json`, so the
 * fallback only matters in zero-config callers (tests, ad-hoc scripts).
 */

import path from 'node:path';

let _resolveConfig;

/**
 * Lazy import of `resolveConfig` to side-step a circular module graph
 * (`config-resolver.js` re-exports from this directory and importing it
 * eagerly would resolve `temp-paths.js` before `lib/config/limits.js` is
 * ready). The resolver itself caches per-root, so the inner call is cheap.
 */
async function getResolveConfig() {
  if (!_resolveConfig) {
    const mod = await import('../config-resolver.js');
    _resolveConfig = mod.resolveConfig;
  }
  return _resolveConfig;
}

/**
 * Synchronous tempRoot extraction. Accepts:
 *   - a full resolved config `{ settings, ... }`,
 *   - an `agentSettings` bag,
 *   - a `paths` bag,
 *   - or `undefined` (returns the default `'temp'`).
 *
 * Cross-script callers that already hold a resolved config should pass it
 * here; bare callers omit the argument and accept the framework default.
 *
 * @param {object} [config]
 * @returns {string}
 */
export function tempRootFrom(config) {
  if (!config || typeof config !== 'object') return 'temp';
  const settings = config.settings ?? config.agentSettings ?? config;
  const paths = settings?.paths ?? config?.paths;
  const tempRoot = paths?.tempRoot;
  return typeof tempRoot === 'string' && tempRoot.length > 0
    ? tempRoot
    : 'temp';
}

/**
 * Async tempRoot resolver. When the caller cannot pass a config bag, this
 * loads the project's `.agentrc.json` via `resolveConfig` (cached per
 * root). Most `.agents/scripts` consumers should prefer the synchronous
 * variant by threading their already-resolved config through.
 *
 * @param {{ cwd?: string }} [opts]
 * @returns {Promise<string>}
 */
export async function tempRootAsync(opts) {
  const resolveConfig = await getResolveConfig();
  const resolved = resolveConfig({ cwd: opts?.cwd });
  return tempRootFrom(resolved);
}

const epicId = (id) => {
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(
      `[temp-paths] epicId must be a positive integer; got ${id}`,
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
  return path.join(tempRootFrom(config), `epic-${epicId(eid)}`);
}

/**
 * `temp/epic-<eid>/story-<sid>/` — every Story-scoped artifact lives
 * under here.
 *
 * @param {number} eid
 * @param {number} sid
 * @param {object} [config]
 * @returns {string}
 */
export function storyTempDir(eid, sid, config) {
  return path.join(epicTempDir(eid, config), `story-${storyId(sid)}`);
}

/**
 * `temp/epic-<eid>/story-<sid>/signals.ndjson` — append-only signal
 * stream consumed by the analyzer (Epic #1030 AC1).
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

// --- Canonical Story-level filenames ---

export const storyManifestPath = (eid, sid, config) =>
  storyArtifactPath(eid, sid, 'manifest.md', config);
export const storyPerfSummaryPath = (eid, sid, config) =>
  storyArtifactPath(eid, sid, 'perf-summary.md', config);

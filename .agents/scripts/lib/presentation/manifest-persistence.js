/**
 * manifest-persistence.js
 *
 * File I/O for dispatch / story manifests. All fs writes land under the
 * per-Epic tree (`temp/epic-<id>/manifest.{md,json}` for Epic dispatch
 * manifests; `temp/epic-<id>/stories/story-<sid>/manifest.{md,json}` for Story
 * execution manifests — see Epic #1030 Story #1040 / Task #1053). The
 * formatter is injected so this module is testable against a tmpdir
 * without touching the real filesystem layout.
 *
 * Story manifests with multiple stories that span Epic IDs (rare —
 * happens only when the dispatcher is run against a hand-rolled cohort)
 * fall back to the first story's epicId. Manifests with no resolvable
 * epicId resolve to the legacy flat layout (`temp/story-manifest-*`)
 * which is still understood by downstream cleanup paths.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  epicArtifactPath,
  storyArtifactPath,
  tempRootFrom,
} from '../config/temp-paths.js';
import { resolveConfig } from '../config-resolver.js';
import {
  formatManifestMarkdown,
  formatStoryManifestMarkdown,
} from './manifest-formatter.js';

function getProjectRoot() {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(__dirname, '../../../..');
}

/**
 * Build a config bag whose `tempRoot` is an ABSOLUTE path anchored to the
 * caller-supplied `projectRoot` (Story #3900).
 *
 * The on-disk dispatch / story manifests are a per-Epic *operator view*
 * bound to a specific project root the caller already knows — not a
 * lifecycle ledger that must be cwd-independent. The `temp-paths` helpers
 * now anchor a *relative* `tempRoot` to the main checkout (the git common
 * dir's parent), which is correct for the ledger but wrong here: it would
 * ignore the explicit `projectRoot` (e.g. a test tmpdir, or a sandboxed
 * dispatcher root). Pre-absolutising the `tempRoot` against `projectRoot`
 * makes the helpers honour it verbatim (absolute roots skip git anchoring),
 * so manifest writes always land under the project root the caller named.
 *
 * @param {string} projectRoot
 * @param {object|undefined} resolved Resolved config (or undefined).
 * @returns {object} A config bag with an absolute `project.paths.tempRoot`.
 */
function absoluteTempRootConfig(projectRoot, resolved) {
  const tempRoot = tempRootFrom(resolved);
  const absoluteTempRoot = path.isAbsolute(tempRoot)
    ? tempRoot
    : path.join(projectRoot, tempRoot);
  return { project: { paths: { tempRoot: absoluteTempRoot } } };
}

/**
 * Resolve absolute path for a legacy flat dispatch-manifest sibling.
 */
function legacyOrphanPath(epicId, ext, projectRoot, resolved) {
  const rel = epicArtifactPath(
    epicId,
    `dispatch-manifest-${epicId}.${ext}`,
    resolved,
  );
  return path.isAbsolute(rel) ? rel : path.join(projectRoot, rel);
}

/**
 * Sweep one legacy orphan; returns the path if removed, else null.
 */
function sweepOne(target) {
  try {
    if (!fs.existsSync(target)) return null;
    fs.rmSync(target, { force: true });
    return target;
  } catch {
    return null;
  }
}

/**
 * Sweep legacy flat-layout dispatch-manifest siblings out of the per-Epic
 * temp dir. The Epic manifest layout migrated from
 * `temp/epic-<id>/dispatch-manifest-<id>.{md,json}` to
 * `temp/epic-<id>/manifest.{md,json}` in Epic #1030 / Story #1040;
 * sweeping on each render keeps a single canonical artefact in the
 * epic dir. Idempotent: returns `{ removed: [] }` when nothing to do.
 *
 * @param {number} epicId
 * @param {{ projectRoot?: string, config?: object, logger?: { info?: Function } }} [opts]
 */
export function deleteLegacyFlatManifest(epicId, opts = {}) {
  const projectRoot = opts.projectRoot ?? getProjectRoot();
  const resolved = opts.config ?? safeResolveConfig(projectRoot);
  const logger = opts.logger ?? console;
  const tempPathsConfig = absoluteTempRootConfig(projectRoot, resolved);

  const targets = ['md', 'json'].map((ext) =>
    legacyOrphanPath(epicId, ext, projectRoot, tempPathsConfig),
  );
  const removed = targets.map(sweepOne).filter(Boolean);

  if (removed.length > 0 && typeof logger?.info === 'function') {
    logger.info(
      `[manifest-persistence] Swept ${removed.length} legacy flat dispatch-manifest orphan(s) for Epic #${epicId}: ${removed.join(', ')}`,
    );
  }

  return { removed };
}

/**
 * Atomic write-then-rename. On any failure, best-effort remove the `.tmp`
 * file and rethrow so the caller can surface a structured result.
 *
 * Exported so other writers (e.g. `render-manifest.js`) can route their
 * `.md` / `.json` artefact writes through the same crash-safe primitive.
 */
export function atomicWrite(finalPath, content) {
  const tmpPath = `${finalPath}.tmp`;
  try {
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.renameSync(tmpPath, finalPath);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // best-effort; original error is what the caller needs
    }
    throw err;
  }
}

/**
 * Persist a manifest to `temp/`. Story-execution manifests write a
 * `story-manifest-<key>.{json,md}` pair keyed on story IDs; Epic manifests
 * write a `dispatch-manifest-<epicId>.{json,md}` pair. Each file is written
 * via an atomic write-then-rename sequence. On failure the caller receives
 * the error string and the `.tmp` residue is removed — the final path is
 * left untouched.
 *
 * When `opts.markdown` is provided (a pre-rendered Markdown string), it is
 * used in place of `formatManifestMarkdown(manifest)`. This is the
 * injection seam the dispatcher uses to route through `fromSpec` when a
 * spec file is present alongside the Epic (Story #1501) without
 * coupling persistence to the spec loader.
 *
 * Config resolution: the caller may pass the canonical resolved config
 * via `opts.config` (story-init does this to avoid a redundant resolve);
 * otherwise the helper lazy-resolves so `epicArtifactPath` /
 * `storyArtifactPath` honour any `project.paths.tempRoot` override.
 *
 * @param {object} manifest
 * @param {{ projectRoot?: string, config?: object, markdown?: string }} [opts]
 * @returns {{ persisted: boolean, path: string|null, error: string|null }}
 */
export function persistManifest(manifest, opts = {}) {
  const projectRoot = opts.projectRoot ?? getProjectRoot();
  const resolved = opts.config ?? safeResolveConfig(projectRoot);
  // Anchor manifest artifact paths to the explicit projectRoot (Story #3900)
  // rather than letting temp-paths anchor a relative tempRoot to the main
  // checkout — these manifests are a per-project operator view.
  const tempPathsConfig = absoluteTempRootConfig(projectRoot, resolved);

  let jsonPath = null;
  let mdPath = null;

  if (manifest.type === 'story-execution') {
    // Story manifests live under `temp/epic-<eid>/stories/story-<sid>/`. When the
    // manifest carries multiple stories, fall back to the first entry's
    // epicId for the directory key (the dispatcher only ever bundles
    // stories that share an Epic; the multi-Epic case is a hand-rolled
    // cohort we tolerate but don't optimise for). Stories with no
    // resolvable epicId fall through to the legacy flat layout so
    // downstream cleanup paths keep finding them.
    const stories = manifest.stories ?? [];
    const epicId = stories.find((s) => s?.epicId)?.epicId;
    const key = stories.map((s) => s.storyId).join('-');
    if (epicId && stories.length === 1 && stories[0]?.storyId) {
      const sid = stories[0].storyId;
      const rel = storyArtifactPath(
        epicId,
        sid,
        'manifest.json',
        tempPathsConfig,
      );
      const relMd = storyArtifactPath(
        epicId,
        sid,
        'manifest.md',
        tempPathsConfig,
      );
      jsonPath = path.isAbsolute(rel) ? rel : path.join(projectRoot, rel);
      mdPath = path.isAbsolute(relMd) ? relMd : path.join(projectRoot, relMd);
    } else {
      // Legacy flat layout — preserved as a safety net for multi-story
      // manifests where the per-story dirs would collide.
      const legacyDir = path.join(projectRoot, 'temp');
      jsonPath = path.join(legacyDir, `story-manifest-${key}.json`);
      mdPath = path.join(legacyDir, `story-manifest-${key}.md`);
    }
  } else if (manifest.epicId) {
    const epicId = manifest.epicId;
    // Sweep legacy flat dispatch-manifest-<id>.{md,json} orphans before
    // re-rendering so the per-Epic dir only ever shows the canonical
    // manifest.{md,json} pair (resolves #1126).
    deleteLegacyFlatManifest(epicId, {
      projectRoot,
      config: resolved,
    });
    const relJson = epicArtifactPath(epicId, 'manifest.json', tempPathsConfig);
    const relMd = epicArtifactPath(epicId, 'manifest.md', tempPathsConfig);
    jsonPath = path.isAbsolute(relJson)
      ? relJson
      : path.join(projectRoot, relJson);
    mdPath = path.isAbsolute(relMd) ? relMd : path.join(projectRoot, relMd);
  } else {
    return { persisted: false, path: null, error: null };
  }

  try {
    const jsonContent = JSON.stringify(manifest, null, 2);
    const mdContent =
      typeof opts.markdown === 'string'
        ? opts.markdown
        : manifest.type === 'story-execution'
          ? formatStoryManifestMarkdown(manifest, { config: resolved })
          : formatManifestMarkdown(manifest);

    // Ensure both parent directories exist (`temp/epic-<id>/` and
    // optionally the per-Story sub-tree). `recursive: true` is a no-op
    // when the dir already exists.
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.mkdirSync(path.dirname(mdPath), { recursive: true });
    atomicWrite(jsonPath, jsonContent);
    atomicWrite(mdPath, mdContent);
    return { persisted: true, path: jsonPath, error: null };
  } catch (err) {
    return { persisted: false, path: jsonPath, error: err.message };
  }
}

/**
 * `resolveConfig` throws when no `.agentrc.json` is loadable from `cwd`
 * (zero-config callers — unit tests). Persistence treats that as a
 * benign condition: the helpers fall back to the framework default
 * (`tempRoot=temp`) when the config bag is absent.
 */
function safeResolveConfig(projectRoot) {
  try {
    return resolveConfig({ cwd: projectRoot });
  } catch {
    return undefined;
  }
}

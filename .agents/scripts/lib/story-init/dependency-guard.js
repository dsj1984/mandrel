/**
 * dependency-guard.js — Launch-time dispatch-manifest dependency guard.
 *
 * Reads the Epic's dispatch manifest and refuses to initialise the target
 * Story when any of its cross-Story blockers are still unmerged. Footgun
 * prevention, not strict enforcement: a missing or unparseable manifest
 * emits `[warn]` and proceeds without blocking.
 *
 * The loader prefers the on-disk artifact at
 * `<projectRoot>/temp/epic-<epicId>/manifest.json` (per-Epic layout —
 * Epic #1030 Story #1040 / Task #1054, migrated from the legacy
 * `temp/dispatch-manifest-<epicId>.json` flat path) because it carries
 * the full `storyManifest` (task ids, task statuses, task-level deps).
 * It falls back to the `dispatch-manifest` structured comment on the
 * Epic issue, whose JSON block only carries a summary (`storyId`,
 * `wave`, `title`); in that degraded mode the guard switches to a
 * wave-based approximation — any Story at an earlier `earliestWave` is
 * treated as a potential blocker.
 */

import fs from 'node:fs';
import path from 'node:path';
import { epicArtifactPath } from '../config/temp-paths.js';
import { findStructuredComment } from '../orchestration/ticketing.js';

const DONE_LABEL = 'agent::done';

/**
 * Extract the first fenced ```json … ``` block from a comment body.
 *
 * @param {string} body
 * @returns {object | null}
 */
function extractJsonBlock(body) {
  if (typeof body !== 'string' || body.length === 0) return null;
  const match = body.match(/```json\s*\n([\s\S]*?)\n```/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

/**
 * Load the dispatch manifest for an Epic.
 *
 * @param {object}  opts
 * @param {number}  opts.epicId
 * @param {string}  opts.projectRoot   Absolute path to the repo root.
 * @param {object} [opts.provider]     Ticketing provider for the fallback fetch.
 * @param {string} [opts.repoSlug]     `owner/repo`. Enriches the manifest so
 *                                     `validateBlockersMerged` can build URLs.
 * @param {object} [opts.fsImpl]       Injectable fs for tests.
 * @returns {Promise<
 *   | { ok: true, manifest: object, source: 'disk' | 'comment' }
 *   | { ok: false, reason: string }>}
 */
export async function loadDispatchManifest({
  epicId,
  projectRoot,
  provider,
  repoSlug,
  fsImpl = fs,
} = {}) {
  if (!Number.isInteger(epicId) || epicId <= 0) {
    return { ok: false, reason: 'invalid-epic-id' };
  }
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    return { ok: false, reason: 'invalid-project-root' };
  }

  // Per-Epic layout (Epic #1030 Story #1040): manifest moved from
  // `temp/dispatch-manifest-<eid>.json` to `temp/epic-<eid>/manifest.json`.
  const rel = epicArtifactPath(epicId, 'manifest.json');
  const diskPath = path.isAbsolute(rel) ? rel : path.join(projectRoot, rel);

  if (fsImpl.existsSync(diskPath)) {
    try {
      const content = fsImpl.readFileSync(diskPath, 'utf8');
      const manifest = JSON.parse(content);
      if (repoSlug) manifest.repoSlug = repoSlug;
      return { ok: true, manifest, source: 'disk' };
    } catch (err) {
      return {
        ok: false,
        reason: `disk-parse-failed: ${err.message}`,
      };
    }
  }

  if (provider && typeof provider.getTicketComments === 'function') {
    try {
      const comment = await findStructuredComment(
        provider,
        epicId,
        'dispatch-manifest',
      );
      if (!comment) {
        return { ok: false, reason: 'no-dispatch-manifest-comment' };
      }
      const parsed = extractJsonBlock(comment.body);
      if (!parsed || !Array.isArray(parsed.stories)) {
        return { ok: false, reason: 'dispatch-manifest-comment-unparseable' };
      }
      const manifest = {
        epicId,
        storyManifest: parsed.stories.map((s) => ({
          storyId: s.storyId,
          storyTitle: s.title ?? '',
          earliestWave: typeof s.wave === 'number' ? s.wave : -1,
          tasks: [],
        })),
      };
      if (repoSlug) manifest.repoSlug = repoSlug;
      return { ok: true, manifest, source: 'comment' };
    } catch (err) {
      return {
        ok: false,
        reason: `comment-fetch-failed: ${err.message}`,
      };
    }
  }

  return { ok: false, reason: 'dispatch-manifest-not-found' };
}

function storyKey(id) {
  return typeof id === 'number' ? id : Number(id);
}

function summariseStoryState(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) return 'unknown';
  let done = 0;
  for (const t of tasks) {
    if (t.status === DONE_LABEL) done += 1;
  }
  return `${done}/${tasks.length} tasks done`;
}

/**
 * Determine which cross-Story blockers of `storyId` are not yet merged.
 *
 * A blocker Story is "merged" when every one of its tasks has
 * `status === 'agent::done'` in the manifest. Blocker Stories are
 * discovered by walking the target Story's tasks' `dependencies` arrays
 * and mapping each task-id back to its parent Story. When the manifest is
 * in summary-only form (no task arrays, e.g. loaded from the structured
 * comment fallback), the guard falls back to a wave-based heuristic: any
 * Story with a lower `earliestWave` than the target is treated as a
 * blocker.
 *
 * @param {object} manifest
 * @param {number | string} storyId
 * @returns {{ ok: boolean, blockers: Array<{id:number,title:string,state:string,url?:string}> }}
 */
export function validateBlockersMerged(manifest, storyId) {
  const storyManifest = manifest?.storyManifest ?? [];
  const targetId = storyKey(storyId);
  const target = storyManifest.find((s) => storyKey(s.storyId) === targetId);
  if (!target) return { ok: true, blockers: [] };

  const storyById = new Map();
  const taskParent = new Map();
  for (const s of storyManifest) {
    if (s.storyId === '__ungrouped__') continue;
    storyById.set(storyKey(s.storyId), s);
    for (const t of s.tasks ?? []) {
      taskParent.set(storyKey(t.taskId), storyKey(s.storyId));
    }
  }

  const blockerStoryIds = new Set();
  const targetTasks = target.tasks ?? [];
  const haveTaskGraph = taskParent.size > 0 && targetTasks.length > 0;

  if (haveTaskGraph) {
    for (const t of targetTasks) {
      for (const depId of t.dependencies ?? []) {
        const parentId = taskParent.get(storyKey(depId));
        if (parentId && parentId !== targetId) blockerStoryIds.add(parentId);
      }
    }
  } else if (
    typeof target.earliestWave === 'number' &&
    target.earliestWave >= 0
  ) {
    for (const s of storyManifest) {
      if (s.storyId === '__ungrouped__') continue;
      const sid = storyKey(s.storyId);
      if (sid === targetId) continue;
      if (
        typeof s.earliestWave === 'number' &&
        s.earliestWave >= 0 &&
        s.earliestWave < target.earliestWave
      ) {
        blockerStoryIds.add(sid);
      }
    }
  }

  const unmerged = [];
  for (const bid of blockerStoryIds) {
    const s = storyById.get(bid);
    if (!s) continue;
    const tasks = s.tasks ?? [];
    const allDone =
      tasks.length > 0 && tasks.every((t) => t.status === DONE_LABEL);
    if (allDone) continue;
    const entry = {
      id: bid,
      title: s.storyTitle ?? '',
      state: summariseStoryState(tasks),
    };
    if (manifest.repoSlug) {
      entry.url = `https://github.com/${manifest.repoSlug}/issues/${bid}`;
    }
    unmerged.push(entry);
  }

  unmerged.sort((a, b) => a.id - b.id);
  return { ok: unmerged.length === 0, blockers: unmerged };
}

/**
 * Run the launch-time dependency guard as a single pipeline stage. Wraps
 * `loadDispatchManifest` + `validateBlockersMerged` + `formatBlockerReport`
 * so `story-init` can fold the guard into a one-line call.
 *
 * @param {object} opts
 * @param {number} opts.epicId
 * @param {number} opts.storyId
 * @param {string} opts.cwd               Repo root for on-disk manifest lookup.
 * @param {object} [opts.provider]        Used for the comment-fallback path.
 * @param {object} [opts.orchestration]   Config slice; reads `github.{owner,repo}`.
 * @param {object} [opts.logger]          `{ progress, warn? }` shape.
 * @returns {Promise<{ blocked: false } | { blocked: true, openBlockers }>}
 */
export async function runDispatchManifestGuard({
  epicId,
  storyId,
  cwd,
  provider,
  orchestration,
  logger,
}) {
  const githubCfg = orchestration?.github;
  const repoSlug =
    githubCfg?.owner && githubCfg?.repo
      ? `${githubCfg.owner}/${githubCfg.repo}`
      : undefined;

  const load = await loadDispatchManifest({
    epicId,
    projectRoot: cwd,
    provider,
    repoSlug,
  });

  if (!load.ok) {
    const warn = logger?.warn ?? ((m) => console.error(m));
    warn(
      `[warn] dispatch-manifest dependency guard skipped: ${load.reason}. Proceeding without blocker verification — regenerate via /epic-plan to restore the guard.`,
    );
    return { blocked: false };
  }

  const check = validateBlockersMerged(load.manifest, storyId);
  if (!check.ok) {
    console.error(formatBlockerReport(storyId, check.blockers));
    return { blocked: true, openBlockers: check.blockers };
  }

  logger?.progress?.(
    'DEPENDENCY-GUARD',
    `✅ Dispatch manifest clean (source=${load.source})`,
  );
  return { blocked: false };
}

/**
 * Format the unmerged-blocker report for stderr. Exported so the unit test
 * can lock the wording and callers outside `story-init` stay in sync.
 *
 * @param {number} storyId
 * @param {Array<{id:number,title:string,state:string,url?:string}>} blockers
 * @returns {string}
 */
export function formatBlockerReport(storyId, blockers) {
  const lines = [''];
  lines.push(
    `🚧 Story #${storyId} cannot start — ${blockers.length} unmerged blocker(s) per dispatch manifest:`,
  );
  for (const b of blockers) {
    lines.push('');
    lines.push(`  #${b.id} "${b.title}"`);
    lines.push(`    state: ${b.state}`);
    if (b.url) lines.push(`    url:   ${b.url}`);
  }
  lines.push('');
  lines.push(
    'Merge the blocker Stories first, then re-run /epic-execute. ' +
      'Guard source: dispatch manifest (regenerate via /epic-plan).',
  );
  lines.push('');
  return lines.join('\n');
}

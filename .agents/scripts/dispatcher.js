#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * dispatcher.js — CLI Entry Point for the Dispatch Engine
 *
 * Thin wrapper around the dispatcher SDK. Parses CLI arguments,
 * delegates core logic to `lib/orchestration/dispatch-engine.js`, then
 * handles file I/O and console output.
 *
 * Usage:
 *   node dispatcher.js <ticketId> [--dry-run]
 *
 * The script auto-detects whether the ticket is an Epic or Story
 * and routes to the appropriate execution mode.
 *
 * Successor to the retired mandrel MCP tools. See ADR 20260424-702a in docs/decisions.md for the migration table.
 *
 * @see .agents/schemas/dispatch-manifest.json
 */

import { runAsCli } from './lib/cli-utils.js';
import {
  dispatch,
  resolveAndDispatch,
} from './lib/orchestration/dispatch-engine.js';

// Re-export SDK functions so that direct consumers of dispatcher.js
// (tests, CI scripts) continue to work without modification.
export { dispatch, resolveAndDispatch };

// ---------------------------------------------------------------------------
// Presentation helpers (CLI-only — not part of the SDK)
// ---------------------------------------------------------------------------

import { parseSprintArgs } from './lib/cli-args.js';
import { resolveConfig } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import {
  fromSpec,
  persistManifest,
  postManifestEpicComment,
  postParkedFollowOnsComment,
  printStoryDispatchTable,
} from './lib/presentation/manifest-renderer.js';
import { createProvider } from './lib/provider-factory.js';
import { loadSpec, loadState } from './lib/spec/index.js';

/**
 * Best-effort: load the structural spec + state for `epicId` and render
 * the dispatch manifest Markdown via `fromSpec`. Returns `null` when the
 * spec is absent or any loader step throws (parse/validation/io errors
 * downgrade to fallback so the pre-spec dispatcher path keeps working
 * untouched). Story #1501 — preserves `fromManifest` behaviour for
 * non-spec callers.
 *
 * The loaders are injectable so tests can drive the spec-present /
 * spec-absent branches without writing to the real `.agents/epics/`
 * directory.
 *
 * @param {object} manifest — the dispatch manifest already built by `resolveAndDispatch`.
 * @param {{
 *   loadSpec?: typeof loadSpec,
 *   loadState?: typeof loadState,
 *   fromSpec?: typeof fromSpec,
 *   loaderOpts?: object,
 * }} [deps]
 * @returns {string|null} pre-rendered Markdown, or null on any failure.
 */
/**
 * Overlay live Story `status` labels from the just-built manifest onto the
 * loaded state mapping. The spec-aware renderer (`buildManifestFromSpec`)
 * looks up each Story's status via `state.mapping[slug].lastObservedAgentState`;
 * that field is only refreshed by the structural reconciler, so during
 * `/deliver` execution it stays `null` and every Story renders as ⬜
 * pending even after the Story merges. The wave-runner replaced the
 * dispatcher-per-wave refresh loop and the local state.json never sees
 * the progress signal.
 *
 * Under the 2-tier hierarchy (Epic #3163) the runtime manifest's wave
 * records carry `stories[]` (each with the live `storyId` + `status` from
 * `fetchEpicContext`'s GH query), not the retired `tasks[]` shape. The
 * overlay walks `manifest.waves[].stories[]` and copies each Story's
 * status onto the slug that matches its `storyId` (issueNumber). Pure;
 * returns the mutated state. Safe on null/undefined.
 *
 * @param {object|null|undefined} state
 * @param {object|null|undefined} manifest
 * @returns {object|null|undefined}
 */
export function overlayLiveTaskStateFromManifest(state, manifest) {
  if (!state?.mapping || !manifest?.waves) return state;
  const issueNumberToSlug = new Map();
  for (const [slug, entry] of Object.entries(state.mapping)) {
    if (entry && typeof entry.issueNumber === 'number') {
      issueNumberToSlug.set(entry.issueNumber, slug);
    }
  }
  for (const wave of manifest.waves) {
    if (!Array.isArray(wave?.stories)) continue;
    for (const story of wave.stories) {
      const slug = issueNumberToSlug.get(story?.storyId);
      if (!slug) continue;
      if (
        typeof story.status === 'string' &&
        story.status.startsWith('agent::')
      ) {
        state.mapping[slug].lastObservedAgentState = story.status;
      }
    }
  }
  return state;
}

export function tryRenderFromSpec(manifest, deps = {}) {
  const epicId = manifest?.epicId;
  if (!epicId || manifest.type === 'story-execution') return null;
  const loadSpecFn = deps.loadSpec ?? loadSpec;
  const loadStateFn = deps.loadState ?? loadState;
  const fromSpecFn = deps.fromSpec ?? fromSpec;
  const overlayFn =
    deps.overlayLiveTaskState ?? overlayLiveTaskStateFromManifest;
  const loaderOpts = deps.loaderOpts ?? {};
  try {
    const spec = loadSpecFn(epicId, loaderOpts);
    const state = loadStateFn(epicId, loaderOpts);
    const overlayedState = overlayFn(state, manifest);
    return fromSpecFn(spec, {
      state: overlayedState,
      generatedAt: manifest.generatedAt,
      executor: manifest.executor,
      dryRun: manifest.dryRun,
      agentTelemetry: manifest.agentTelemetry,
    });
  } catch (err) {
    /* node:coverage ignore next */
    Logger.debug?.(
      `[Dispatcher] spec-aware render unavailable for Epic #${epicId} (${err?.name ?? 'Error'}: ${err?.message ?? 'unknown'}); falling back to fromManifest`,
    );
    return null;
  }
}
/**
 * High-level orchestrator that resolves the execution strategy, generates the manifest,
 * persists the files to temp, and outputs summaries.
 *
 * @param {number} ticketId
 * @param {boolean} [dryRun]
 * @param {{ provider?: object }} [opts] - Optional overrides. `provider`
 *   lets callers pass a provider whose per-instance ticket cache is already
 *   primed, so dashboard regeneration issues zero extra REST calls.
 */
/* node:coverage ignore next 8 */
function persistAndAnnounceMarkdown(manifest) {
  const specMarkdown = tryRenderFromSpec(manifest);
  if (specMarkdown !== null) {
    Logger.info(
      `[Dispatcher] 📐 Rendering Markdown via fromSpec (spec found for Epic #${manifest.epicId})`,
    );
  }
  persistManifest(manifest, specMarkdown ? { markdown: specMarkdown } : {});
}

/* node:coverage ignore next 13 */
async function postManifestCommentSafely(manifest, provider) {
  try {
    const result = await postManifestEpicComment(manifest, provider);
    if (result.posted) {
      Logger.info(
        `[Dispatcher] 💬 Dispatch manifest comment posted on Epic #${manifest.epicId}`,
      );
    }
  } catch (err) {
    /* node:coverage ignore next */
    Logger.warn(
      `[Dispatcher] Non-fatal: could not post manifest comment — ${err.message}`,
    );
  }
}

/* node:coverage ignore next 16 */
async function postParkedCommentSafely(manifest, provider) {
  try {
    const parkedResult = await postParkedFollowOnsComment(manifest, provider);
    if (!parkedResult.posted) return;
    const hasExtras = parkedResult.recuts > 0 || parkedResult.parked > 0;
    Logger.info(
      hasExtras
        ? `[Dispatcher] 🪝 Parked follow-ons comment posted on Epic #${manifest.epicId} (${parkedResult.recuts} recut, ${parkedResult.parked} parked)`
        : `[Dispatcher] 🪝 No out-of-manifest Stories detected on Epic #${manifest.epicId}`,
    );
  } catch (err) {
    /* node:coverage ignore next */
    Logger.warn(
      `[Dispatcher] Non-fatal: could not post parked-follow-ons comment — ${err.message}`,
    );
  }
}

/* node:coverage ignore next 6 */
async function maybePostEpicComments(manifest, resolveProvider) {
  if (manifest.type === 'story-execution' || !manifest.epicId) return;
  const provider = resolveProvider();
  await postManifestCommentSafely(manifest, provider);
  await postParkedCommentSafely(manifest, provider);
}

/* node:coverage ignore next 18 */
function logStoryManifestPaths(manifest) {
  const stories = manifest.stories ?? [];
  const eid = stories.find((s) => s?.epicId)?.epicId;
  if (eid && stories.length === 1) {
    const sid = stories[0].storyId;
    Logger.info(
      `\n[Dispatcher] ✅ Story manifest: temp/epic-${eid}/stories/story-${sid}/manifest.json`,
    );
    Logger.info(
      `[Dispatcher] 📄 Markdown: temp/epic-${eid}/stories/story-${sid}/manifest.md\n`,
    );
    return;
  }
  const key = stories.map((s) => s.storyId).join('-');
  Logger.info(
    `\n[Dispatcher] ✅ Story manifest: temp/story-manifest-${key}.json`,
  );
  Logger.info(`[Dispatcher] 📄 Markdown: temp/story-manifest-${key}.md\n`);
}

/* node:coverage ignore next 10 */
function logEpicManifestSummary(manifest) {
  const epicId = manifest.epicId;
  Logger.info(`\n[Dispatcher] ✅ Manifest: temp/epic-${epicId}/manifest.json`);
  Logger.info(`[Dispatcher] 📄 Markdown: temp/epic-${epicId}/manifest.md`);
  Logger.info(
    `[Dispatcher] Progress: ${manifest.summary.doneStories}/${manifest.summary.totalStories} stories done (${manifest.summary.progressPercent}%)`,
  );
  Logger.info(`[Dispatcher] Dispatched: ${manifest.summary.dispatched}`);
  printStoryDispatchTable(manifest.storyManifest);
}

/* node:coverage ignore next 7 */
function logManifestSummary(manifest) {
  if (manifest.type === 'story-execution') {
    logStoryManifestPaths(manifest);
    return;
  }
  logEpicManifestSummary(manifest);
}

export async function generateAndSaveManifest(
  ticketId,
  dryRun = false,
  opts = {},
) {
  const manifest = await resolveAndDispatch({
    ticketId,
    dryRun,
    provider: opts.provider,
  });
  persistAndAnnounceMarkdown(manifest);
  await maybePostEpicComments(
    manifest,
    () => opts.provider ?? createProvider(resolveConfig()),
  );
  logManifestSummary(manifest);
  return manifest;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

/* node:coverage ignore next */
/* node:coverage ignore next */
async function main() {
  const { ticketId, dryRun } = parseSprintArgs();

  if (!ticketId) {
    Logger.error(
      '[Dispatcher] Error: No valid Issue ID provided.\n' +
        'Usage: node dispatcher.js <ticketId> [--dry-run]',
    );
    process.exit(1);
  }

  await generateAndSaveManifest(ticketId, dryRun);
}

runAsCli(import.meta.url, main, {
  source: 'Dispatcher',
  onError: (err) => {
    Logger.error('[Dispatcher] Fatal error:', err.message);
    process.exit(1);
  },
});

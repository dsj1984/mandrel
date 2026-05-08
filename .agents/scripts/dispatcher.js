#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * dispatcher.js — CLI Entry Point for the Dispatch Engine
 *
 * Thin wrapper around the orchestration SDK. Parses CLI arguments,
 * delegates core logic to `lib/orchestration/dispatch-engine.js`, then
 * handles file I/O and console output.
 *
 * Usage:
 *   node dispatcher.js <ticketId> [--dry-run] [--executor <name>]
 *
 * The script auto-detects whether the ticket is an Epic or Story
 * and routes to the appropriate execution mode.
 *
 * Successor to the retired agent-protocols MCP tools. See ADR 20260424-702a in docs/decisions.md for the migration table.
 *
 * @see .agents/schemas/dispatch-manifest.json
 */

import { runAsCli } from './lib/cli-utils.js';
import {
  dispatch,
  resolveAndDispatch,
} from './lib/orchestration/dispatch-engine.js';
import { executeStory } from './lib/orchestration/story-executor.js';

// Re-export SDK functions so that direct consumers of dispatcher.js
// (tests, CI scripts) continue to work without modification.
export { dispatch, executeStory, resolveAndDispatch };

// ---------------------------------------------------------------------------
// Presentation helpers (CLI-only — not part of the SDK)
// ---------------------------------------------------------------------------

import { parseSprintArgs } from './lib/cli-args.js';
import { resolveConfig } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import {
  persistManifest,
  postManifestEpicComment,
  postParkedFollowOnsComment,
  printStoryDispatchTable,
} from './lib/presentation/manifest-renderer.js';
import { createProvider } from './lib/provider-factory.js';
/**
 * High-level orchestrator that resolves the execution strategy, generates the manifest,
 * persists the files to temp, and outputs summaries.
 *
 * @param {number} ticketId
 * @param {boolean} [dryRun]
 * @param {string|null} [executorOverride]
 * @param {{ provider?: object }} [opts] - Optional overrides. `provider`
 *   lets callers pass a provider whose per-instance ticket cache is already
 *   primed, so dashboard regeneration issues zero extra REST calls.
 */
export async function generateAndSaveManifest(
  ticketId,
  dryRun = false,
  executorOverride = null,
  opts = {},
) {
  // Delegate to the SDK's unified resolver
  const manifest = await resolveAndDispatch({
    ticketId,
    dryRun,
    executorOverride,
    provider: opts.provider,
  });

  // Write manifest files using the new presentation abstraction
  persistManifest(manifest);

  // Persist the Epic-level dispatch manifest as a structured comment on
  // the Epic so the wave-completeness gate can parse it back at close time.
  // Story-execution manifests are per-story and are not persisted upstream.
  if (manifest.type !== 'story-execution' && manifest.epicId) {
    const provider =
      opts.provider ?? createProvider(resolveConfig().orchestration);
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

    try {
      const parkedResult = await postParkedFollowOnsComment(manifest, provider);
      if (parkedResult.posted) {
        const hasExtras = parkedResult.recuts > 0 || parkedResult.parked > 0;
        Logger.info(
          hasExtras
            ? `[Dispatcher] 🪝 Parked follow-ons comment posted on Epic #${manifest.epicId} (${parkedResult.recuts} recut, ${parkedResult.parked} parked)`
            : `[Dispatcher] 🪝 No out-of-manifest Stories detected on Epic #${manifest.epicId}`,
        );
      }
    } catch (err) {
      /* node:coverage ignore next */
      Logger.warn(
        `[Dispatcher] Non-fatal: could not post parked-follow-ons comment — ${err.message}`,
      );
    }
  }

  if (manifest.type === 'story-execution') {
    // Per-Epic layout (Epic #1030 Story #1040): single-story manifests
    // land at `temp/epic-<eid>/story-<sid>/manifest.{md,json}`. Multi-
    // story cohorts fall back to the legacy flat path; surface that in
    // the log so operators tracking the cutover see the divergence.
    const stories = manifest.stories ?? [];
    const eid = stories.find((s) => s?.epicId)?.epicId;
    if (eid && stories.length === 1) {
      const sid = stories[0].storyId;
      Logger.info(
        `\n[Dispatcher] ✅ Story manifest: temp/epic-${eid}/story-${sid}/manifest.json`,
      );
      Logger.info(
        `[Dispatcher] 📄 Markdown: temp/epic-${eid}/story-${sid}/manifest.md\n`,
      );
    } else {
      const key = stories.map((s) => s.storyId).join('-');
      Logger.info(
        `\n[Dispatcher] ✅ Story manifest: temp/story-manifest-${key}.json`,
      );
      Logger.info(`[Dispatcher] 📄 Markdown: temp/story-manifest-${key}.md\n`);
    }
    // Omit console dump for brevity
  } else {
    const epicId = manifest.epicId;
    Logger.info(
      `\n[Dispatcher] ✅ Manifest: temp/epic-${epicId}/manifest.json`,
    );
    Logger.info(`[Dispatcher] 📄 Markdown: temp/epic-${epicId}/manifest.md`);
    Logger.info(
      `[Dispatcher] Progress: ${manifest.summary.doneTasks}/${manifest.summary.totalTasks} tasks done (${manifest.summary.progressPercent}%)`,
    );
    Logger.info(`[Dispatcher] Dispatched: ${manifest.summary.dispatched}`);
    printStoryDispatchTable(manifest.storyManifest);
  }
  return manifest;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

/* node:coverage ignore next */
/* node:coverage ignore next */
async function main() {
  const { ticketId, dryRun, executor } = parseSprintArgs();

  if (!ticketId) {
    Logger.error(
      '[Dispatcher] Error: No valid Issue ID provided.\n' +
        'Usage: node dispatcher.js <ticketId> [--dry-run]',
    );
    process.exit(1);
  }

  await generateAndSaveManifest(ticketId, dryRun, executor);
}

runAsCli(import.meta.url, main, {
  source: 'Dispatcher',
  onError: (err) => {
    Logger.error('[Dispatcher] Fatal error:', err.message);
    process.exit(1);
  },
});

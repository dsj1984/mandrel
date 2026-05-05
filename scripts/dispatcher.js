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
 * @see .agents/scripts/lib/orchestration/index.js (SDK barrel)
 * @see .agents/schemas/dispatch-manifest.json
 */

import { runAsCli } from './lib/cli-utils.js';
import { resolveAndDispatch } from './lib/orchestration/index.js';

// Re-export SDK functions so that direct consumers of dispatcher.js
// (tests, CI scripts) continue to work without modification.
export {
  dispatch,
  executeStory,
  resolveAndDispatch,
} from './lib/orchestration/index.js';

// ---------------------------------------------------------------------------
// Presentation helpers (CLI-only — not part of the SDK)
// ---------------------------------------------------------------------------

import { parseSprintArgs } from './lib/cli-args.js';
import { resolveConfig } from './lib/config-resolver.js';
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
        console.log(
          `[Dispatcher] 💬 Dispatch manifest comment posted on Epic #${manifest.epicId}`,
        );
      }
    } catch (err) {
      /* node:coverage ignore next */
      console.warn(
        `[Dispatcher] Non-fatal: could not post manifest comment — ${err.message}`,
      );
    }

    try {
      const parkedResult = await postParkedFollowOnsComment(manifest, provider);
      if (parkedResult.posted) {
        const hasExtras = parkedResult.recuts > 0 || parkedResult.parked > 0;
        console.log(
          hasExtras
            ? `[Dispatcher] 🪝 Parked follow-ons comment posted on Epic #${manifest.epicId} (${parkedResult.recuts} recut, ${parkedResult.parked} parked)`
            : `[Dispatcher] 🪝 No out-of-manifest Stories detected on Epic #${manifest.epicId}`,
        );
      }
    } catch (err) {
      /* node:coverage ignore next */
      console.warn(
        `[Dispatcher] Non-fatal: could not post parked-follow-ons comment — ${err.message}`,
      );
    }
  }

  if (manifest.type === 'story-execution') {
    const key = manifest.stories.map((s) => s.storyId).join('-');
    console.log(
      `\n[Dispatcher] ✅ Story manifest: temp/story-manifest-${key}.json`,
    );
    console.log(`[Dispatcher] 📄 Markdown: temp/story-manifest-${key}.md\n`);
    // Omit console dump for brevity
  } else {
    const epicId = manifest.epicId;
    console.log(
      `\n[Dispatcher] ✅ Manifest: temp/dispatch-manifest-${epicId}.json`,
    );
    console.log(
      `[Dispatcher] 📄 Markdown: temp/dispatch-manifest-${epicId}.md`,
    );
    console.log(
      `[Dispatcher] Progress: ${manifest.summary.doneTasks}/${manifest.summary.totalTasks} tasks done (${manifest.summary.progressPercent}%)`,
    );
    console.log(`[Dispatcher] Dispatched: ${manifest.summary.dispatched}`);
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
    console.error(
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
    console.error('[Dispatcher] Fatal error:', err.message);
    process.exit(1);
  },
});

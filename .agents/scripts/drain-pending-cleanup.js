#!/usr/bin/env node

/**
 * .agents/scripts/drain-pending-cleanup.js
 *
 * Force-drain helper: reads `.worktrees/.pending-cleanup.json`, retries
 * Stage 1 cleanup for every entry, and (on Windows, by default) escalates
 * any still-stuck entries by enumerating the processes holding handles
 * inside the worktree path and terminating them.
 *
 * Invoked by `/deliver` and `/plan`
 * (via `drainPendingCleanupAtBoot` → `worktree-sweep.js`), and
 * `story-close` so the pending-cleanup ledger drains automatically
 * across the sprint lifecycle. Operators can also run it standalone:
 *
 *   node .agents/scripts/drain-pending-cleanup.js              # full drain + escalate
 *   node .agents/scripts/drain-pending-cleanup.js --no-escalate  # passive drain only
 *   node .agents/scripts/drain-pending-cleanup.js --dry-run      # report only
 *
 * Exit code: 0 when manifest is empty after the drain, 0 with warnings
 * if entries remain (operator inspection useful), 1 only on hard error
 * (config load, fatal exception).
 */

import path from 'node:path';
import { parseArgs } from 'node:util';

import { runAsCli } from './lib/cli-utils.js';
import { PROJECT_ROOT, resolveConfig } from './lib/config-resolver.js';
import * as gitUtils from './lib/git-utils.js';
import { Logger } from './lib/Logger.js';
import {
  findHoldersInPath,
  forceDrainPendingCleanup,
} from './lib/worktree/lifecycle/force-drain.js';
import { readManifest } from './lib/worktree/lifecycle/pending-cleanup.js';

const progress = Logger.createProgress('drain-pending-cleanup', {
  stderr: false,
});

async function main() {
  const { values } = parseArgs({
    options: {
      escalate: { type: 'boolean', default: true },
      'dry-run': { type: 'boolean', default: false },
      'worktree-root': { type: 'string' },
    },
    strict: false,
  });

  const config = resolveConfig();
  const wtConfig = config.delivery?.worktreeIsolation;
  const worktreeRoot = path.resolve(
    PROJECT_ROOT,
    values['worktree-root'] ?? wtConfig?.root ?? '.worktrees',
  );

  const before = readManifest(worktreeRoot);
  if (before.length === 0) {
    progress('SCAN', 'pending-cleanup manifest is empty — nothing to drain.');
    return;
  }

  progress(
    'SCAN',
    `pending-cleanup manifest has ${before.length} entry(ies): ${before
      .map((e) => `story-${e.storyId}(attempts=${e.attempts ?? 0})`)
      .join(', ')}`,
  );

  if (values['dry-run']) {
    for (const entry of before) {
      const holders = findHoldersInPath(entry.path);
      progress(
        'DRY-RUN',
        `story-${entry.storyId} path=${entry.path} holders=${holders.length}` +
          (holders.length > 0
            ? ` (${holders.map((h) => `pid=${h.pid}/${h.name}`).join(', ')})`
            : ''),
      );
    }
    return;
  }

  const result = await forceDrainPendingCleanup({
    repoRoot: PROJECT_ROOT,
    worktreeRoot,
    git: gitUtils,
    escalate: values.escalate,
    logger: {
      info: (m) => progress('DRAIN', m),
      warn: (m) => progress('DRAIN', `⚠️ ${m}`),
      error: (m) => Logger.error(`[drain-pending-cleanup] ${m}`),
    },
  });

  if (result.drained.length > 0) {
    progress(
      'DRAIN',
      `✅ drained ${result.drained.length} entry(ies): ${result.drained
        .map((id) => `story-${id}`)
        .join(', ')}`,
    );
  }
  if (result.escalated.length > 0) {
    const summary = result.escalated
      .map((id) => `story-${id}=[${(result.killedPids[id] ?? []).join(',')}]`)
      .join(', ');
    progress('ESCALATE', `terminated holders: ${summary}`);
  }
  if (result.noHolders && result.noHolders.length > 0) {
    progress(
      'ESCALATE',
      `⚠️ no user-mode holders for: ${result.noHolders
        .map((id) => `story-${id}`)
        .join(
          ', ',
        )} — kernel-held lock (Search indexer / AV); will retry next sweep`,
    );
  }
  if (result.persistent.length > 0) {
    progress(
      'PERSIST',
      `⚠️ persistent-lock remains on: ${result.persistent
        .map((id) => `story-${id}`)
        .join(', ')} — entries retained in ledger for next sweep`,
    );
  }
  if (result.stillPending.length > 0) {
    progress(
      'STILL-PENDING',
      `⚠️ still-pending (below threshold): ${result.stillPending
        .map((id) => `story-${id}`)
        .join(', ')}`,
    );
  }

  const after = readManifest(worktreeRoot);
  progress(
    'DONE',
    `pending-cleanup manifest now has ${after.length} entry(ies). ` +
      `Drained=${result.drained.length}, escalated=${result.escalated.length}, persistent=${result.persistent.length}.`,
  );
}

runAsCli(import.meta.url, main, { source: 'drain-pending-cleanup' });

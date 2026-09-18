#!/usr/bin/env node

/**
 * .agents/scripts/drain-pending-cleanup.js
 *
 * Force-drain helper: reads `.worktrees/.pending-cleanup.json`, retries
 * Stage 1 cleanup for every entry, and (on Windows, by default) escalates
 * any still-stuck entries by enumerating the processes holding handles
 * inside the worktree path and terminating them.
 *
 * Invoked by `/mandrel-deliver` and `/mandrel-plan`
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

/**
 * The escalation posture, as a real boolean. `allowNegative` resolves
 * `--no-escalate` to boolean `false`, but under `strict: false` the other
 * documented spelling `--escalate=false` arrives as the *string* `'false'`,
 * which is truthy while `forceDrainPendingCleanup` gates on `!escalate`.
 * Both must reach the engine as a boolean or the flag is advertised and inert.
 *
 * @param {boolean|string|undefined} value
 * @returns {boolean}
 */
const escalateFrom = (value) => value !== false && value !== 'false';

/**
 * The drain core, extracted from the CLI shell so the whole decision table —
 * empty manifest, dry-run report, drain + escalate reporting — is reachable
 * without a real worktree ledger or a real process kill.
 *
 * Every seam on the optional final `deps` parameter defaults to the real
 * implementation (`docs/contributing/test-seams.md` rules 1-2, 4), so `main` and
 * every production caller are unchanged.
 *
 * @param {string[]} [argv]
 * @param {{
 *   resolveConfigImpl?: typeof resolveConfig,
 *   readManifestImpl?: typeof readManifest,
 *   findHoldersInPathImpl?: typeof findHoldersInPath,
 *   forceDrainImpl?: typeof forceDrainPendingCleanup,
 *   gitImpl?: typeof gitUtils,
 *   projectRoot?: string,
 *   progressImpl?: (phase: string, message: string) => void,
 *   logger?: { error: Function },
 * }} [deps]
 * @returns {Promise<{ drained: number[], remaining: number } | { remaining: number }>}
 */
export async function runDrainPendingCleanup(
  argv = process.argv.slice(2),
  deps = {},
) {
  const {
    resolveConfigImpl = resolveConfig,
    readManifestImpl = readManifest,
    findHoldersInPathImpl = findHoldersInPath,
    forceDrainImpl = forceDrainPendingCleanup,
    gitImpl = gitUtils,
    projectRoot = PROJECT_ROOT,
    progressImpl = progress,
    logger = Logger,
  } = deps;
  const { values } = parseArgs({
    args: argv,
    options: {
      escalate: { type: 'boolean', default: true },
      'dry-run': { type: 'boolean', default: false },
      'worktree-root': { type: 'string' },
    },
    strict: false,
    // `node:util.parseArgs` honours a `--no-<flag>` spelling ONLY when this is
    // set. Without it `--no-escalate` landed in `values['no-escalate']` and
    // left `values.escalate` at its `true` default, so the documented passive
    // drain performed the forced removal it promises to suppress.
    allowNegative: true,
  });

  const config = resolveConfigImpl();
  const wtConfig = config.delivery?.worktreeIsolation;
  const worktreeRoot = path.resolve(
    projectRoot,
    values['worktree-root'] ?? wtConfig?.root ?? '.worktrees',
  );

  const before = readManifestImpl(worktreeRoot);
  if (before.length === 0) {
    progressImpl(
      'SCAN',
      'pending-cleanup manifest is empty — nothing to drain.',
    );
    return { remaining: 0 };
  }

  progressImpl(
    'SCAN',
    `pending-cleanup manifest has ${before.length} entry(ies): ${before
      .map((e) => `story-${e.storyId}(attempts=${e.attempts ?? 0})`)
      .join(', ')}`,
  );

  if (values['dry-run']) {
    for (const entry of before) {
      const holders = findHoldersInPathImpl(entry.path);
      progressImpl(
        'DRY-RUN',
        `story-${entry.storyId} path=${entry.path} holders=${holders.length}` +
          (holders.length > 0
            ? ` (${holders.map((h) => `pid=${h.pid}/${h.name}`).join(', ')})`
            : ''),
      );
    }
    return { remaining: before.length };
  }

  const result = await forceDrainImpl({
    repoRoot: projectRoot,
    worktreeRoot,
    git: gitImpl,
    escalate: escalateFrom(values.escalate),
    logger: {
      info: (m) => progressImpl('DRAIN', m),
      warn: (m) => progressImpl('DRAIN', `⚠️ ${m}`),
      error: (m) => logger.error(`[drain-pending-cleanup] ${m}`),
    },
  });

  if (result.drained.length > 0) {
    progressImpl(
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
    progressImpl('ESCALATE', `terminated holders: ${summary}`);
  }
  if (result.noHolders && result.noHolders.length > 0) {
    progressImpl(
      'ESCALATE',
      `⚠️ no user-mode holders for: ${result.noHolders
        .map((id) => `story-${id}`)
        .join(
          ', ',
        )} — kernel-held lock (Search indexer / AV); will retry next sweep`,
    );
  }
  if (result.persistent.length > 0) {
    progressImpl(
      'PERSIST',
      `⚠️ persistent-lock remains on: ${result.persistent
        .map((id) => `story-${id}`)
        .join(', ')} — entries retained in ledger for next sweep`,
    );
  }
  if (result.stillPending.length > 0) {
    progressImpl(
      'STILL-PENDING',
      `⚠️ still-pending (below threshold): ${result.stillPending
        .map((id) => `story-${id}`)
        .join(', ')}`,
    );
  }

  const after = readManifestImpl(worktreeRoot);
  progressImpl(
    'DONE',
    `pending-cleanup manifest now has ${after.length} entry(ies). ` +
      `Drained=${result.drained.length}, escalated=${result.escalated.length}, persistent=${result.persistent.length}.`,
  );
  return { drained: result.drained, remaining: after.length };
}

async function main() {
  await runDrainPendingCleanup();
}

runAsCli(import.meta.url, main, {
  source: 'drain-pending-cleanup',
  usage: {
    invocation:
      'node .agents/scripts/drain-pending-cleanup.js [--dry-run] [--no-escalate] [--worktree-root <path>]',
    summary:
      'Drain the pending-worktree-cleanup manifest, removing trees whose holders have exited.',
    flags: [
      ['--dry-run', 'Report each entry and its holders; remove nothing.'],
      [
        '--no-escalate',
        'Do not escalate to a forced removal for stuck entries.',
      ],
      [
        '--worktree-root <path>',
        'Worktree root (default: delivery.worktreeIsolation.root).',
      ],
    ],
  },
});

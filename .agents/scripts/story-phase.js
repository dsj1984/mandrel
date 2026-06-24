#!/usr/bin/env node

/**
 * story-phase.js — phase snapshot + heartbeat writer (2-tier).
 *
 * Replaces the deleted per-Task progress writer from the 4-tier era
 * (removed under #3157). `/deliver` calls this CLI at each Story-
 * level phase transition (init → implementing → closing → done, or any
 * → blocked). Each call:
 *
 *   1. Renders the Story-phase snapshot for the requested phase (canonical
 *      init/implement/validate/close progression in the `phases[]` payload)
 *      and returns its markdown body for chat relay. Story #3909 — this no
 *      longer posts a `story-run-progress` comment (the redundant mid-flight
 *      progress surface was deleted); the snapshot is render-only.
 *   2. Appends one `story.heartbeat` lifecycle record to
 *      `temp/epic-<epicId>/lifecycle.ndjson` so `/deliver`'s
 *      §2e Idle Watchdog (`wave-tick.js --check-idle 30`) can confirm
 *      forward progress without polling the Story comment.
 *
 * The heartbeat emit is best-effort: a missing/unreachable ledger,
 * schema-validation hiccup, or absent `Epic: #N` body reference is
 * logged and swallowed — the labels remain the source of truth, the
 * ledger record is observability.
 *
 * CLI:
 *   --story <id>                        Story ID (required).
 *   --phase <init|implementing|closing|blocked|done>
 *                                       Phase the Story is entering (required).
 *   --epic <id>                         Parent Epic id from the Step 0 envelope.
 *                                       When supplied, skips the readEpicIdFromStory
 *                                       GitHub read.
 *   --branch <name>                     Story branch from the Step 0 envelope.
 *                                       When supplied, skips the resolveStoryBranch
 *                                       GitHub read.
 *   --no-heartbeat                      Suppress the lifecycle emit (tests).
 *
 * Stdout: a single JSON envelope
 *   { ok: true, storyId, phase, epicId, branch, heartbeatEmitted,
 *     ledgerPath, renderedBody }
 *
 * `renderedBody` is the markdown body upserted onto the Story so the
 * caller can relay it to chat verbatim (mirrors the contract the deleted
 * per-Task progress writer exposed and that `/deliver` Step 1 / 3
 * already documents).
 */

import { parseArgs } from 'node:util';

import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import {
  defaultStoryPhases,
  STORY_PHASE_ORDER,
  upsertStoryRunProgress,
} from './lib/orchestration/epic-runner/story-run-progress-writer.js';
import { emitStoryHeartbeat } from './lib/orchestration/lifecycle/emit-story-heartbeat.js';
import { parseFencedJsonComment } from './lib/orchestration/structured-comment-parser.js';
import { normalizeOperatorHandle } from './lib/orchestration/ticket-lease.js';
import { findStructuredComment } from './lib/orchestration/ticketing.js';
import { createProvider } from './lib/provider-factory.js';
import { resolveStoryHierarchy } from './lib/story-lifecycle.js';
import { notify } from './notify.js';

const VALID_PHASES = new Set([
  'init',
  'implementing',
  'closing',
  'blocked',
  'done',
]);

const HELP = `Usage: node .agents/scripts/story-phase.js \\
  --story <id> --phase <init|implementing|closing|blocked|done> \\
  [--epic <id>] [--branch <name>] [--no-heartbeat]

Renders the Story-phase snapshot for Story #<id> at the requested phase
(returned as renderedBody for chat relay; no comment is posted) and
(unless --no-heartbeat) appends one story.heartbeat record to the parent
Epic's lifecycle ledger so the Idle Watchdog can confirm the Story is alive.

--epic / --branch let the caller pass the parent Epic id and Story branch
from story-init.js's Step 0 envelope, skipping the GitHub reads
(readEpicIdFromStory / resolveStoryBranch) that would otherwise re-fetch
these immutable values on every phase call. Omit both for interactive use.
`;

/**
 * Map the workflow-level `--phase` value to the canonical phases[] row
 * progression carried in the snapshot payload (init/implement/validate/
 * close). The mapping is monotonic: each later phase marks every earlier
 * row `done`, the current row `in-progress` (or `done` when the workflow
 * phase itself is `done`), and any later rows `pending`. `blocked` leaves
 * the in-progress row marked in-progress (the blocker is reflected in the
 * header phase, not the row table).
 *
 * @param {string} workflowPhase
 * @returns {Array<{ name: string, status: string, startedAt: string|null, endedAt: string|null }>}
 */
export function phasesForWorkflowPhase(workflowPhase, now = new Date()) {
  const ts = now.toISOString();
  const phases = defaultStoryPhases();

  // Anchor row that should be "current" for each workflow phase.
  const currentByPhase = {
    init: 'init',
    implementing: 'implement',
    closing: 'validate',
    blocked: 'implement',
    done: 'close',
  };
  const current = currentByPhase[workflowPhase];
  const currentIdx = STORY_PHASE_ORDER.indexOf(current);

  for (let i = 0; i < phases.length; i++) {
    if (i < currentIdx) {
      phases[i].status = 'done';
      phases[i].startedAt = ts;
      phases[i].endedAt = ts;
    } else if (i === currentIdx) {
      if (workflowPhase === 'done') {
        phases[i].status = 'done';
        phases[i].startedAt = ts;
        phases[i].endedAt = ts;
      } else {
        phases[i].status = 'in-progress';
        phases[i].startedAt = ts;
      }
    }
  }
  return phases;
}

/**
 * Hydrate the parent Epic id off the Story ticket body. Returns null when
 * the Story has no `Epic: #N` reference (the heartbeat emit will be
 * skipped because there is no Epic-scoped ledger path to write to).
 *
 * @param {{ provider: object, storyId: number }} args
 * @returns {Promise<number|null>}
 */
export async function readEpicIdFromStory({ provider, storyId }) {
  const story = await provider.getTicket(storyId);
  const { epicId } = resolveStoryHierarchy(story?.body ?? '');
  return epicId ?? null;
}

/**
 * Hydrate the prior story-run-progress branch off the Story ticket so a
 * resumed run preserves the branch name rather than re-deriving it.
 * Falls back to `story-<id>` when no prior snapshot exists.
 */
async function resolveStoryBranch({ provider, storyId }) {
  const snapshot = await findStructuredComment(
    provider,
    storyId,
    'story-run-progress',
  );
  if (snapshot) {
    const parsed = parseFencedJsonComment(snapshot);
    if (parsed && typeof parsed.branch === 'string' && parsed.branch) {
      return parsed.branch;
    }
  }
  const initComment = await findStructuredComment(
    provider,
    storyId,
    'story-init',
  );
  if (initComment) {
    const parsed = parseFencedJsonComment(initComment);
    if (
      parsed &&
      typeof parsed.storyBranch === 'string' &&
      parsed.storyBranch
    ) {
      return parsed.storyBranch;
    }
  }
  return `story-${storyId}`;
}

/**
 * Best-effort `story.heartbeat` emit for one phase transition. Resolves the
 * lease-owner handle the SAME way the lease primitive does
 * (`normalizeOperatorHandle(github.operatorHandle)`) and stamps it as
 * `operator` so `latestHeartbeatForOwner({ epicId, owner })` resolves a real
 * heartbeat — without it `isClaimLive(null)` is false and /deliver
 * silently reclaims a live foreign claim (audit #3513). The field is attached
 * only when a handle resolves, preserving the "omit when absent" shape for
 * repos that have not configured `github.operatorHandle`. A failed append is
 * logged and swallowed: the heartbeat is observability, not state.
 *
 * @param {{ storyId: number, epicId: number, phase: string, config: object|null, ledgerPath?: string, timestamp: string }} args
 * @returns {{ heartbeatEmitted: boolean, ledgerPath: string|null }}
 */
function emitHeartbeatBestEffort({
  storyId,
  epicId,
  phase,
  config,
  ledgerPath,
  timestamp,
}) {
  const operator = normalizeOperatorHandle(config?.github?.operatorHandle);
  try {
    const res = emitStoryHeartbeat({
      storyId,
      epicId,
      phase,
      timestamp,
      ...(operator !== null ? { operator } : {}),
      config: config ?? undefined,
      ledgerPath,
    });
    return { heartbeatEmitted: true, ledgerPath: res.ledgerPath };
  } catch (err) {
    Logger.warn(
      `[story-phase] story.heartbeat emit failed (continuing): ${err.message}`,
    );
    return { heartbeatEmitted: false, ledgerPath: null };
  }
}

/**
 * End-to-end phase writer. DI-friendly: tests pass `provider`, override
 * the ledger path, and skip the heartbeat as needed.
 *
 * When `epicId` / `branch` are supplied (the `/deliver` worker passes them
 * from `story-init.js`'s Step 0 envelope), the corresponding GitHub read is
 * skipped entirely: `epicId` short-circuits `readEpicIdFromStory` and
 * `branch` short-circuits `resolveStoryBranch`. Omit both for interactive
 * use to restore the original GitHub-read resolution.
 *
 * @param {{
 *   storyId: number,
 *   phase: string,
 *   epicId?: number|null,
 *   branch?: string,
 *   noHeartbeat?: boolean,
 *   provider?: object,
 *   config?: object,
 *   ledgerPath?: string,
 *   now?: Date,
 * }} args
 */
export async function runStoryPhase(args) {
  const {
    storyId,
    phase,
    epicId: epicIdOverride,
    branch: branchOverride,
    noHeartbeat = false,
    provider: providerOverride,
    config: configOverride,
    ledgerPath: ledgerPathOverride,
    now = new Date(),
  } = args ?? {};

  if (!Number.isInteger(storyId) || storyId <= 0) {
    throw new Error('runStoryPhase: --story must be a positive integer');
  }
  if (!VALID_PHASES.has(phase)) {
    throw new Error(
      `runStoryPhase: --phase "${phase}" must be one of: ${[...VALID_PHASES].join(', ')}`,
    );
  }

  const config = configOverride ?? (providerOverride ? null : resolveConfig());
  const provider = providerOverride ?? createProvider(config);
  const notifyFn = providerOverride
    ? null
    : (ticketId, payload, opts = {}) =>
        notify(ticketId, payload, { config, provider, ...opts });

  // When the Step 0 envelope supplied the branch / epicId (the /deliver
  // worker passes them via --branch / --epic), skip the GitHub reads that
  // would otherwise re-fetch these immutable values on every phase call.
  const branch =
    typeof branchOverride === 'string' && branchOverride
      ? branchOverride
      : await resolveStoryBranch({ provider, storyId });
  const epicId =
    epicIdOverride !== undefined
      ? epicIdOverride
      : await readEpicIdFromStory({ provider, storyId });
  const phases = phasesForWorkflowPhase(phase, now);

  const { body: renderedBody, payload: snapshot } =
    await upsertStoryRunProgress({
      provider,
      storyId,
      branch,
      phase,
      phases,
      epicId: epicId ?? undefined,
      updatedAt: now.toISOString(),
      notify: notifyFn,
    });

  let heartbeatEmitted = false;
  let ledgerPath = null;
  if (!noHeartbeat && epicId) {
    ({ heartbeatEmitted, ledgerPath } = emitHeartbeatBestEffort({
      storyId,
      epicId,
      phase,
      config,
      ledgerPath: ledgerPathOverride,
      timestamp: now.toISOString(),
    }));
  }

  return {
    ok: true,
    storyId,
    phase,
    epicId,
    branch,
    heartbeatEmitted,
    ledgerPath,
    snapshot,
    renderedBody,
  };
}

export function parseArgv(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      story: { type: 'string' },
      phase: { type: 'string' },
      epic: { type: 'string' },
      branch: { type: 'string' },
      'no-heartbeat': { type: 'boolean' },
      help: { type: 'boolean' },
    },
    strict: false,
  });
  // `--epic` absent → leave `epicId` undefined so runStoryPhase falls back to
  // the readEpicIdFromStory GitHub read. `--branch` absent → leave `branch`
  // undefined so it falls back to resolveStoryBranch.
  const parsed = {
    help: Boolean(values.help),
    storyId: Number.parseInt(values.story ?? '', 10),
    phase: values.phase,
    noHeartbeat: Boolean(values['no-heartbeat']),
  };
  if (values.epic !== undefined) {
    parsed.epicId = Number.parseInt(values.epic, 10);
  }
  if (typeof values.branch === 'string' && values.branch) {
    parsed.branch = values.branch;
  }
  return parsed;
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgv(argv);
  if (parsed.help) {
    process.stdout.write(HELP);
    return;
  }
  const envelope = await runStoryPhase(parsed);
  process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
}

runAsCli(import.meta.url, main, { source: 'story-phase' });

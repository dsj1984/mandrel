#!/usr/bin/env node

/**
 * story-phase.js — phase snapshot + heartbeat writer (3-tier).
 *
 * Replaces the deleted per-Task progress writer from the 4-tier era
 * (removed under #3157). `/story-deliver` calls this CLI at each Story-
 * level phase transition (init → implementing → closing → done, or any
 * → blocked). Each call:
 *
 *   1. Flips the `story-run-progress` structured-comment snapshot on
 *      the Story ticket to the requested phase (canonical
 *      init/implement/validate/close progression preserved in the
 *      `phases[]` payload). Idempotent — repeated invocations for the
 *      same phase re-write the same body.
 *   2. Appends one `story.heartbeat` lifecycle record to
 *      `temp/epic-<epicId>/lifecycle.ndjson` so `/epic-deliver`'s
 *      §2e Idle Watchdog (`wave-tick.js --check-idle 10`) can confirm
 *      forward progress without polling the Story comment.
 *
 * The heartbeat emit is best-effort: a missing/unreachable ledger,
 * schema-validation hiccup, or absent `Epic: #N` body reference is
 * logged and swallowed — the snapshot upsert remains the source of
 * truth, the ledger record is observability.
 *
 * CLI:
 *   --story <id>                        Story ID (required).
 *   --phase <init|implementing|closing|blocked|done>
 *                                       Phase the Story is entering (required).
 *   --blocker-comment-id <id>           Friction comment id (only `blocked`).
 *   --no-heartbeat                      Suppress the lifecycle emit (tests).
 *
 * Stdout: a single JSON envelope
 *   { ok: true, storyId, phase, epicId, branch, heartbeatEmitted,
 *     ledgerPath, renderedBody }
 *
 * `renderedBody` is the markdown body upserted onto the Story so the
 * caller can relay it to chat verbatim (mirrors the contract the deleted
 * per-Task progress writer exposed and that `/story-deliver` Step 1 / 3
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
  [--blocker-comment-id <id>] [--no-heartbeat]

Flips the story-run-progress snapshot for Story #<id> to the requested
phase and (unless --no-heartbeat) appends one story.heartbeat record to
the parent Epic's lifecycle ledger so the Idle Watchdog can confirm the
Story is alive.
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
 * End-to-end phase writer. DI-friendly: tests pass `provider`, override
 * the ledger path, and skip the heartbeat as needed.
 *
 * @param {{
 *   storyId: number,
 *   phase: string,
 *   blockerCommentId?: string,
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
    blockerCommentId,
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

  const branch = await resolveStoryBranch({ provider, storyId });
  const epicId = await readEpicIdFromStory({ provider, storyId });
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
    try {
      const res = emitStoryHeartbeat({
        storyId,
        epicId,
        phase,
        timestamp: now.toISOString(),
        config: config ?? undefined,
        ledgerPath: ledgerPathOverride,
      });
      heartbeatEmitted = true;
      ledgerPath = res.ledgerPath;
    } catch (err) {
      Logger.warn(
        `[story-phase] story.heartbeat emit failed (continuing): ${err.message}`,
      );
    }
  }

  return {
    ok: true,
    storyId,
    phase,
    epicId,
    branch,
    blockerCommentId: blockerCommentId ?? null,
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
      'blocker-comment-id': { type: 'string' },
      'no-heartbeat': { type: 'boolean' },
      help: { type: 'boolean' },
    },
    strict: false,
  });
  return {
    help: Boolean(values.help),
    storyId: Number.parseInt(values.story ?? '', 10),
    phase: values.phase,
    blockerCommentId: values['blocker-comment-id'],
    noHeartbeat: Boolean(values['no-heartbeat']),
  };
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

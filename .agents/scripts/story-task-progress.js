#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * story-task-progress.js — per-Task transition writer.
 *
 * Each Task transition in `/story-deliver` was previously expressed as
 * "compose this object literal in your head, splice it into the in-memory
 * tasks list, then call `upsertStoryRunProgress`." That left the workflow
 * markdown carrying procedural JS the sub-agent had to inline-execute on
 * every state change. This CLI is the imperative form: one call per
 * transition.
 *
 * Snapshot persistence: the in-memory task list lives at
 * `.git/agents/story-<storyId>-progress.json` — local cache, never
 * committed (mirrors the lifecycle of `.git/MERGE_HEAD`-style ephemeral
 * state). The cache lets successive transitions update one row at a time
 * without re-reading the GitHub comment per call. On cache miss (first
 * transition of a fresh run, or a re-entry after manual cache wipe) the
 * script hydrates from the existing `story-run-progress` structured
 * comment via `findStructuredComment`.
 *
 * CLI:
 *   --story <id>                       Story ID (required).
 *   --task  <id>                       Task ID being transitioned (required).
 *   --state <executing|done|blocked>   New Task state (required).
 *   --commit-sha <sha>                 Commit SHA — only meaningful on `done`.
 *   --blocker-comment-id <id>          Friction comment id — only on `blocked`.
 *   --phase <implementing|closing|blocked|done>
 *                                      Story-level phase to upsert with the
 *                                      snapshot. Defaults derived from --state.
 *
 * Stdout: `{ ok: true, taskState, phase, payload, renderedBody }` JSON
 * envelope. `renderedBody` is the markdown body that was upserted onto the
 * Story ticket — `/story-deliver` relays it as a chat message after each
 * transition so operators see the same task-progress table the parent
 * `/epic-deliver` aggregator reads.
 *
 * Resume-skip envelope: when `--state executing` is requested for a Task
 * that is already `agent::done` AND whose recorded commit is reachable from
 * `HEAD`, the script returns `{ ok: true, skip: true, reason, taskState:
 * 'done', phase, payload: null, renderedBody: null }` without mutating the
 * cache or the GitHub comment. `/story-deliver`'s loop reads `skip` and
 * advances to the next Task — the workflow form of "pick up where the
 * prior run left off" after a kill mid-Story. See `story-deliver.md`
 * Step 1 for the consumer side.
 *
 * Per-Task close (state=done): the script also flips the Task ticket to
 * `agent::done` and closes the GitHub issue immediately — `cascade: false`
 * so the Story doesn't auto-close while the branch is still unmerged,
 * `notify: null` to avoid duplicating the consolidated story-close fan.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import { gitSpawn, gitSync } from './lib/git-utils.js';
import { Logger } from './lib/Logger.js';
import {
  STORY_RUN_PROGRESS_TYPE,
  upsertStoryRunProgress,
} from './lib/orchestration/epic-runner/story-run-progress-writer.js';
import { parseFencedJsonComment } from './lib/orchestration/structured-comment-parser.js';
import {
  findStructuredComment,
  STATE_LABELS,
  transitionTicketState,
} from './lib/orchestration/ticketing.js';
import { createProvider } from './lib/provider-factory.js';
import { notify } from './notify.js';

const VALID_TASK_STATES = new Set(['executing', 'done', 'blocked']);

const VALID_PHASES = new Set([
  'init',
  'implementing',
  'closing',
  'blocked',
  'done',
]);

/**
 * Default phase for each Task state when `--phase` isn't passed explicitly.
 * The wave aggregator only ever changes phase at coarse-grained transitions
 * so per-Task callers usually want the obvious mapping.
 */
const DEFAULT_PHASE_FOR_STATE = {
  executing: 'implementing',
  done: 'implementing',
  blocked: 'blocked',
};

const HELP = `Usage: node .agents/scripts/story-task-progress.js \\
  --story <id> --task <id> --state <executing|done|blocked> \\
  [--commit-sha <sha>] [--blocker-comment-id <id>] \\
  [--phase <implementing|closing|blocked|done>]

Snapshot cache: .git/agents/story-<storyId>-progress.json (local; not committed).
Hydrates from the GitHub story-run-progress structured comment on cache miss.
`;

/**
 * Resolve the local cache path for a given Story. Anchored at the repo's
 * `.git` so worktrees and the main checkout share the same cache (the writer
 * always upserts the same canonical comment regardless of which worktree the
 * commit happens in).
 *
 * @param {number} storyId
 * @param {string} cwd
 * @returns {string}
 */
export function resolveCachePath(storyId, cwd = process.cwd()) {
  // `git rev-parse --git-common-dir` returns the shared `.git` even from a
  // worktree subdir, where `--git-dir` would return the per-worktree dir.
  const gitCommonDir = gitSync(cwd, 'rev-parse', '--git-common-dir');
  // gitSync returns relative paths when git itself does — resolve to absolute.
  const absCommonDir = path.isAbsolute(gitCommonDir)
    ? gitCommonDir
    : path.resolve(cwd, gitCommonDir);
  return path.join(absCommonDir, 'agents', `story-${storyId}-progress.json`);
}

/**
 * Read the cache file, returning `null` on missing-file. Any other read error
 * (permission, malformed JSON) propagates so the caller can surface it.
 *
 * @param {string} cachePath
 * @returns {object | null}
 */
export function readCache(cachePath) {
  try {
    const raw = fs.readFileSync(cachePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Persist the cache. Creates the parent directory on first write.
 *
 * @param {string} cachePath
 * @param {object} payload
 */
export function writeCache(cachePath, payload) {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, `${JSON.stringify(payload, null, 2)}\n`);
}

/**
 * Apply the named transition to the cached task list. Pure helper —
 * doesn't touch disk or the network, so tests can pin its semantics
 * deterministically.
 *
 * @param {{ tasks: object[] } & object} snapshot
 * @param {{
 *   taskId: number,
 *   state: 'executing' | 'done' | 'blocked',
 *   commitSha?: string,
 *   blockerCommentId?: string,
 * }} transition
 * @returns {{ tasks: object[] } & object}
 */
export function applyTransition(snapshot, transition) {
  const { taskId, state, commitSha, blockerCommentId } = transition;
  if (!Number.isInteger(taskId) || taskId <= 0) {
    throw new TypeError('applyTransition: taskId must be a positive integer');
  }
  if (!VALID_TASK_STATES.has(state)) {
    throw new RangeError(
      `applyTransition: state "${state}" must be one of: ${[...VALID_TASK_STATES].join(', ')}`,
    );
  }
  const tasks = Array.isArray(snapshot?.tasks) ? snapshot.tasks : [];
  const idx = tasks.findIndex((t) => Number(t.id) === taskId);
  if (idx === -1) {
    throw new Error(
      `applyTransition: task #${taskId} not found in story snapshot ` +
        `(known: ${tasks.map((t) => `#${t.id}`).join(', ') || 'none'})`,
    );
  }
  const updated = { ...tasks[idx], state };
  // The renderer only carries commitSha on `done` and blockerCommentId on
  // `blocked` — clear stale fields on transition into a different state.
  if (state === 'done' && commitSha) updated.commitSha = commitSha;
  else delete updated.commitSha;
  if (state === 'blocked' && blockerCommentId) {
    updated.blockerCommentId = blockerCommentId;
  } else {
    delete updated.blockerCommentId;
  }
  const nextTasks = [...tasks];
  nextTasks[idx] = updated;
  return { ...snapshot, tasks: nextTasks };
}

/**
 * Hydrate the snapshot from the GitHub `story-run-progress` structured
 * comment. Used on cache miss — typically the first transition of a resumed
 * run.
 *
 * @param {{ provider: object, storyId: number }} args
 * @returns {Promise<{ storyId: number, branch: string, tasks: object[] } | null>}
 */
export async function hydrateFromComment({ provider, storyId }) {
  const comment = await findStructuredComment(
    provider,
    storyId,
    STORY_RUN_PROGRESS_TYPE,
  );
  if (!comment) return null;
  const payload = parseFencedJsonComment(comment);
  if (!payload || typeof payload !== 'object') return null;
  return {
    storyId,
    branch: payload.branch ?? `story-${storyId}`,
    tasks: Array.isArray(payload.tasks) ? payload.tasks : [],
  };
}

/**
 * Return true when `commitSha` is an ancestor of (or equals) `HEAD` in the
 * git checkout at `cwd` — i.e. the commit has already landed on the current
 * branch. Used to gate the resume-skip path: we only skip a Task that is
 * `agent::done` AND whose recorded commit is actually present on the Story
 * branch's tip, not merely labeled done.
 *
 * Returns `false` for any git error (missing object, malformed sha, repo
 * detached, etc.) — the caller treats that as "not reachable, do the work".
 *
 * @param {string} cwd
 * @param {string} commitSha
 * @returns {boolean}
 */
export function isCommitReachableFromHead(cwd, commitSha) {
  if (typeof commitSha !== 'string' || commitSha.length === 0) return false;
  const result = gitSpawn(
    cwd,
    'merge-base',
    '--is-ancestor',
    commitSha,
    'HEAD',
  );
  return result.status === 0;
}

/**
 * End-to-end: read cache (or hydrate), apply transition, write cache,
 * upsert the GitHub comment.
 *
 * @param {{
 *   storyId: number,
 *   taskId: number,
 *   state: 'executing' | 'done' | 'blocked',
 *   commitSha?: string,
 *   blockerCommentId?: string,
 *   phase?: string,
 *   cwd?: string,
 *   provider?: object,
 *   cachePath?: string,
 * }} args
 * @returns {Promise<{
 *   ok: true,
 *   taskState: string,
 *   phase: string,
 *   payload: object,
 *   renderedBody: string,
 * }>}
 */
export async function runStoryTaskProgress(args) {
  const {
    storyId,
    taskId,
    state,
    commitSha,
    blockerCommentId,
    phase: phaseOverride,
    cwd = process.cwd(),
    provider: providerOverride,
    cachePath: cachePathOverride,
  } = args ?? {};

  if (!Number.isInteger(storyId) || storyId <= 0) {
    throw new TypeError(
      'runStoryTaskProgress: --story must be a positive integer',
    );
  }
  if (!Number.isInteger(taskId) || taskId <= 0) {
    throw new TypeError(
      'runStoryTaskProgress: --task must be a positive integer',
    );
  }
  if (!VALID_TASK_STATES.has(state)) {
    throw new RangeError(
      `runStoryTaskProgress: --state "${state}" must be one of: ${[...VALID_TASK_STATES].join(', ')}`,
    );
  }
  const phase = phaseOverride ?? DEFAULT_PHASE_FOR_STATE[state];
  if (!VALID_PHASES.has(phase)) {
    throw new RangeError(
      `runStoryTaskProgress: --phase "${phase}" must be one of: ${[...VALID_PHASES].join(', ')}`,
    );
  }

  const config = providerOverride ? null : resolveConfig();
  const provider = providerOverride ?? createProvider(config.orchestration);
  const notifyFn = providerOverride
    ? null
    : (ticketId, payload, opts = {}) =>
        notify(ticketId, payload, {
          orchestration: config.orchestration,
          provider,
          ...opts,
        });

  const cachePath = cachePathOverride ?? resolveCachePath(storyId, cwd);

  // 1. Hydrate from cache, falling back to the GitHub comment.
  let snapshot = readCache(cachePath);
  if (!snapshot) {
    snapshot = await hydrateFromComment({ provider, storyId });
  }
  if (!snapshot) {
    throw new Error(
      `runStoryTaskProgress: no story-run-progress snapshot found for story #${storyId}; ` +
        `run \`story-deliver-prepare\` first to create the initial snapshot.`,
    );
  }
  const branch = snapshot.branch ?? `story-${storyId}`;

  // 1b. Resume-skip path: if `/story-deliver` is re-entering the loop on a
  // Task that already landed (commit on the Story branch HEAD) AND already
  // closed (`agent::done`) by a prior run's commit-time close, short-circuit
  // before mutating anything. The workflow caller reads `skip: true` and
  // moves to the next Task instead of re-running task-execute on top of an
  // empty diff (which would bounce off `task-commit.js`'s empty-diff guard
  // anyway, but loudly and with lost time).
  if (state === 'executing') {
    const cached = (snapshot.tasks ?? []).find((t) => Number(t.id) === taskId);
    if (
      cached?.state === 'done' &&
      cached.commitSha &&
      isCommitReachableFromHead(cwd, cached.commitSha)
    ) {
      Logger.info(
        `[story-task-progress] Skipping #${taskId} — already done at ${cached.commitSha.slice(0, 8)} (reachable from HEAD).`,
      );
      return {
        ok: true,
        skip: true,
        reason: 'task-already-complete-and-reachable',
        taskState: 'done',
        phase: snapshot.phase ?? phase,
        payload: null,
        renderedBody: null,
      };
    }
  }

  // 2. Apply the transition in memory.
  const next = applyTransition(snapshot, {
    taskId,
    state,
    commitSha,
    blockerCommentId,
  });

  // 2b. Per-Task close: when the Task transitions to `done` with a recorded
  // commit, flip the GitHub Task ticket to `agent::done` and close the
  // issue immediately rather than waiting for `story-close.js` to batch
  // the children. Suppressed inputs:
  //   - `notify: null` — `state-transition` events for Task-level closes
  //     are the same noise the batched closer also drops (see the comment
  //     in `post-merge-pipeline.js` :: `ticketClosurePhase`).
  //   - `cascade: false` — without this, closing the *last* Task would
  //     auto-cascade the Story → done while the branch is still unmerged.
  //     The Story flip is owned by story-close, post-merge.
  // The transition runs BEFORE the cache write so a network failure leaves
  // the cache untouched and a re-invocation re-attempts the close cleanly.
  // `batchTransitionTickets` in `ticketClosurePhase` skips already-done
  // Tasks naturally, so the post-merge path remains idempotent.
  if (state === 'done' && commitSha) {
    await transitionTicketState(provider, taskId, STATE_LABELS.DONE, {
      notify: null,
      cascade: false,
    });
  }

  // 3. Persist the cache.
  writeCache(cachePath, { ...next, storyId, branch });

  // 4. Upsert the canonical GitHub comment. The writer returns the
  //    rendered markdown body alongside the payload so callers can both
  //    pass the payload up the orchestration tree and surface the body
  //    to chat without re-rendering.
  const { body: renderedBody, payload } = await upsertStoryRunProgress({
    provider,
    storyId,
    branch,
    phase,
    tasks: next.tasks,
    notify: notifyFn,
  });

  return { ok: true, taskState: state, phase, payload, renderedBody };
}

export function parseArgv(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      story: { type: 'string' },
      task: { type: 'string' },
      state: { type: 'string' },
      'commit-sha': { type: 'string' },
      'blocker-comment-id': { type: 'string' },
      phase: { type: 'string' },
      help: { type: 'boolean' },
    },
    strict: false,
  });
  return {
    help: Boolean(values.help),
    storyId: Number.parseInt(values.story ?? '', 10),
    taskId: Number.parseInt(values.task ?? '', 10),
    state: values.state,
    commitSha: values['commit-sha'],
    blockerCommentId: values['blocker-comment-id'],
    phase: values.phase,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgv(argv);
  if (parsed.help) {
    process.stdout.write(HELP);
    return;
  }
  const envelope = await runStoryTaskProgress(parsed);
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

runAsCli(import.meta.url, main, { source: 'story-task-progress' });

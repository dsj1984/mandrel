#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * story-task-progress.js — per-Task transition writer.
 *
 * Each Task transition in `/story-execute` was previously expressed as
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
 * Stdout: `{ ok: true, taskState, phase, payload }` JSON envelope.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import { gitSync } from './lib/git-utils.js';
import {
  STORY_RUN_PROGRESS_TYPE,
  upsertStoryRunProgress,
} from './lib/orchestration/epic-runner/story-run-progress-writer.js';
import { parseFencedJsonComment } from './lib/orchestration/structured-comment-parser.js';
import { findStructuredComment } from './lib/orchestration/ticketing.js';
import { createProvider } from './lib/provider-factory.js';

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
 * @returns {Promise<{ ok: true, taskState: string, phase: string, payload: object }>}
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

  const provider =
    providerOverride ?? createProvider(resolveConfig().orchestration);

  const cachePath = cachePathOverride ?? resolveCachePath(storyId, cwd);

  // 1. Hydrate from cache, falling back to the GitHub comment.
  let snapshot = readCache(cachePath);
  if (!snapshot) {
    snapshot = await hydrateFromComment({ provider, storyId });
  }
  if (!snapshot) {
    throw new Error(
      `runStoryTaskProgress: no story-run-progress snapshot found for story #${storyId}; ` +
        `run \`story-execute-prepare\` first to create the initial snapshot.`,
    );
  }
  const branch = snapshot.branch ?? `story-${storyId}`;

  // 2. Apply the transition in memory.
  const next = applyTransition(snapshot, {
    taskId,
    state,
    commitSha,
    blockerCommentId,
  });

  // 3. Persist the cache.
  writeCache(cachePath, { ...next, storyId, branch });

  // 4. Upsert the canonical GitHub comment.
  const payload = await upsertStoryRunProgress({
    provider,
    storyId,
    branch,
    phase,
    tasks: next.tasks,
  });

  return { ok: true, taskState: state, phase, payload };
}

export function parseCliArgs(argv) {
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
  const parsed = parseCliArgs(argv);
  if (parsed.help) {
    process.stdout.write(HELP);
    return;
  }
  const envelope = await runStoryTaskProgress(parsed);
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

runAsCli(import.meta.url, main, { source: 'story-task-progress' });

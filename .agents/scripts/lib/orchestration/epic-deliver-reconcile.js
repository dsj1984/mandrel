/**
 * lib/orchestration/epic-deliver-reconcile.js — host-crash watchdog.
 *
 * Story #2506 (Epic #2501). When the host computer reboots mid-Epic, the
 * background agents driving each Story die without notifying the harness.
 * Their child Tickets stay pinned at `agent::executing` (or `agent::closing`)
 * and the next `/epic-deliver` invocation hangs waiting on PIDs that are
 * already gone.
 *
 * `reconcileEpicAgentLabels` is the inspection primitive: given an Epic ID,
 * a `ITicketingProvider`-shaped provider, and a repo root, it enumerates
 * the Epic's direct children (Stories) that still carry `agent::executing`
 * or `agent::closing`, reads each Story's recorded dispatch PID from
 * `temp/epic-<id>/<storyId>/story-init.state.json`, probes that PID's
 * liveness, and groups each Story into one of three buckets:
 *
 *   - `live`     — the recorded PID is alive (do not touch).
 *   - `dead`     — the PID was recorded but the process is gone (re-dispatch).
 *   - `unknown`  — no PID was recorded for this Story (operator decides).
 *
 * The function is pure with respect to the injected provider and the
 * injected `probePid` function so tests can drive a fixture Epic with
 * deterministic liveness results. The default `probePid` uses
 * `process.kill(pid, 0)` which works on both Windows (Node maps it to a
 * non-fatal handle check) and POSIX hosts. The function performs no
 * mutations — it is read-only and idempotent.
 */

import fs from 'node:fs';
import path from 'node:path';
import { AGENT_LABELS } from '../label-constants.js';

/**
 * Default PID liveness probe. Uses `process.kill(pid, 0)` which is a
 * cross-platform existence check (Node treats signal `0` as "is this PID
 * deliverable?" on Windows even though the underlying OS lacks POSIX
 * signals).
 *
 * @param {number} pid
 * @returns {boolean} `true` when the OS reports the PID is reachable.
 */
export function defaultProbePid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we lack signal rights — treat
    // as live. ESRCH means the process is gone.
    return err && err.code === 'EPERM';
  }
}

/**
 * Read the dispatch PID for a Story from
 * `temp/epic-<epicId>/<storyId>/story-init.state.json`. Returns `null` when
 * the file does not exist or carries no recognized PID field — the caller
 * will classify the Story as `unknown` in that case.
 *
 * Recognized field names (in order of precedence):
 *
 *   - `dispatchPid` — the canonical name written by Story #2535's writer
 *     in `lib/story-init/dispatch-state-writer.js`.
 *   - `pid`         — legacy name accepted for backward compatibility
 *     with state files written before the writer landed (and with the
 *     pre-existing test fixtures that seed `pid` directly).
 *
 * @param {string} repoRoot
 * @param {number|string} epicId
 * @param {number|string} storyId
 * @returns {number|null}
 */
export function readDispatchPid(repoRoot, epicId, storyId) {
  const statePath = path.join(
    repoRoot,
    'temp',
    `epic-${epicId}`,
    String(storyId),
    'story-init.state.json',
  );
  if (!fs.existsSync(statePath)) return null;
  let raw;
  try {
    raw = fs.readFileSync(statePath, 'utf8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const pid = parsed?.dispatchPid ?? parsed?.pid;
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return pid;
}

/**
 * Classify a single Story given its recorded PID and a liveness probe.
 *
 * @param {{ id: number, title?: string, labels?: Array<{name:string}|string> }} story
 * @param {number|null} pid
 * @param {(pid:number)=>boolean} probePid
 * @returns {{ id:number, title?:string, pid:number|null, classification:'live'|'dead'|'unknown' }}
 */
export function classifyStory(story, pid, probePid) {
  if (pid == null) {
    return {
      id: story.id,
      title: story.title,
      pid: null,
      classification: 'unknown',
    };
  }
  const alive = probePid(pid);
  return {
    id: story.id,
    title: story.title,
    pid,
    classification: alive ? 'live' : 'dead',
  };
}

const RECONCILE_LABELS = new Set([
  AGENT_LABELS.EXECUTING,
  AGENT_LABELS.CLOSING,
]);

function hasReconcileLabel(ticket) {
  const labels = ticket?.labels ?? [];
  for (const label of labels) {
    const name = typeof label === 'string' ? label : label?.name;
    if (RECONCILE_LABELS.has(name)) return true;
  }
  return false;
}

/**
 * Enumerate the Epic's direct children that carry `agent::executing` or
 * `agent::closing`, probe each one's recorded dispatch PID, and partition
 * the results into `{ live, dead, unknown }`.
 *
 * @param {object} params
 * @param {number} params.epicId
 * @param {object} params.provider              ITicketingProvider-shaped
 * @param {string} params.repoRoot              Absolute path to the repo root
 * @param {(pid:number)=>boolean} [params.probePid]  Override for tests
 * @returns {Promise<{
 *   epicId:number,
 *   live: Array<{id:number,title?:string,pid:number|null,classification:'live'}>,
 *   dead: Array<{id:number,title?:string,pid:number|null,classification:'dead'}>,
 *   unknown: Array<{id:number,title?:string,pid:number|null,classification:'unknown'}>,
 * }>}
 */
export async function reconcileEpicAgentLabels({
  epicId,
  provider,
  repoRoot,
  probePid = defaultProbePid,
} = {}) {
  if (!Number.isInteger(epicId) || epicId <= 0) {
    throw new Error(
      `[epic-deliver-reconcile] epicId must be a positive integer (got ${epicId}).`,
    );
  }
  if (!provider || typeof provider.getTickets !== 'function') {
    throw new Error(
      '[epic-deliver-reconcile] provider must implement getTickets(parentId).',
    );
  }
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    throw new Error(
      '[epic-deliver-reconcile] repoRoot must be a non-empty string.',
    );
  }

  const children = await provider.getTickets(epicId);
  const candidates = (children ?? []).filter(hasReconcileLabel);

  const live = [];
  const dead = [];
  const unknown = [];

  for (const story of candidates) {
    const pid = readDispatchPid(repoRoot, epicId, story.id);
    const classified = classifyStory(story, pid, probePid);
    if (classified.classification === 'live') live.push(classified);
    else if (classified.classification === 'dead') dead.push(classified);
    else unknown.push(classified);
  }

  return { epicId, live, dead, unknown };
}

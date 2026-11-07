/**
 * Report-only boot sweep: open `agent::executing` Stories whose `story-<id>`
 * origin head has not moved (neither committed nor pushed) past the threshold
 * and that have no open PR — a delivery session that died silently. Reads origin over REST (a checkout
 * may hold no ref for another Story's branch); writes nothing; never throws.
 */

import { gh as defaultGh, GhNotFoundError } from '../gh-exec.js';
import { getStoryBranch } from '../git-utils.js';
import { AGENT_LABELS, TYPE_LABELS } from '../label-constants.js';
import { NEXT_COMMANDS } from '../orchestration/story-deliver-terminal.js';

export const DEFAULT_STALLED_AFTER_HOURS = 6;

/** Stories probed per boot (up to three reads each); the rest are `unprobed`. */
export const DEFAULT_STALLED_PROBE_LIMIT = 20;

const HOUR_MS = 3_600_000;

/**
 * A positive number of hours, else the default.
 *
 * @param {unknown} value
 * @returns {number}
 */
export function resolveStalledAfterHours(value) {
  const hours = typeof value === 'string' ? Number(value) : value;
  return typeof hours === 'number' && Number.isFinite(hours) && hours > 0
    ? hours
    : DEFAULT_STALLED_AFTER_HOURS;
}

function isExecutingStory(ticket) {
  const labels = Array.isArray(ticket?.labels) ? ticket.labels : [];
  return (
    labels.includes(TYPE_LABELS.STORY) &&
    labels.includes(AGENT_LABELS.EXECUTING)
  );
}

function repoPath(config) {
  const owner = config?.github?.owner || '{owner}';
  const repo = config?.github?.repo || '{repo}';
  return `/repos/${owner}/${repo}`;
}

/** Epoch ms of an ISO timestamp, `NaN` when absent or unparseable. */
function parseMs(iso) {
  return Date.parse(iso ?? '');
}

/** `null` when the branch is absent on origin. */
async function readOriginHead({ gh, config, branch }) {
  const endpoint = `${repoPath(config)}/branches/${encodeURIComponent(branch)}`;
  try {
    const { stdout } = await gh.api({ method: 'GET', endpoint });
    const commit = JSON.parse(stdout)?.commit;
    return {
      sha: commit?.sha ?? null,
      // Committer date: a rebase or base-sync moves it, author date stays.
      committedAt: commit?.commit?.committer?.date ?? null,
    };
  } catch (err) {
    if (err instanceof GhNotFoundError) return null;
    throw err;
  }
}

/** Latest push or branch creation on origin; `null` on any read failure. */
async function readLastPushAt({ gh, config, branch }) {
  const ref = encodeURIComponent(`refs/heads/${branch}`);
  const endpoint = `${repoPath(config)}/activity?ref=${ref}&per_page=1`;
  try {
    const { stdout } = await gh.api({ method: 'GET', endpoint });
    const [latest] = JSON.parse(stdout);
    return typeof latest?.timestamp === 'string' ? latest.timestamp : null;
  } catch {
    return null;
  }
}

async function listBranchPrs(gh, branch) {
  const rows = await gh.pr.list(
    ['--head', branch, '--state', 'all'],
    ['number', 'state'],
  );
  return Array.isArray(rows) ? rows : [];
}

function hasOpenPr(prs) {
  return prs.some((pr) => pr?.state === 'OPEN');
}

/** Idle time since the later of the head commit and the last push. */
function idleSince(nowMs, committedMs, pushedAt) {
  const pushedMs = parseMs(pushedAt);
  return (
    nowMs - Math.max(committedMs, Number.isFinite(pushedMs) ? pushedMs : 0)
  );
}

function summarizePr(pr) {
  return pr ? { number: Number(pr.number) || null, state: pr.state } : null;
}

function stalledRow({ storyId, head, pushedAt, idleMs, prs }) {
  return {
    storyId,
    headSha: head.sha,
    headCommittedAt: head.committedAt,
    headPushedAt: pushedAt,
    idleHours: Math.round((idleMs / HOUR_MS) * 10) / 10,
    pr: summarizePr(prs[0]),
    command: NEXT_COMMANDS.recover(storyId),
  };
}

async function probeStory({ story, gh, config, nowMs, thresholdMs }) {
  const storyId = story.id;
  const branch = getStoryBranch(storyId);
  const head = await readOriginHead({ gh, config, branch });
  if (head === null) return null;
  const committedMs = parseMs(head.committedAt);
  if (!Number.isFinite(committedMs)) throw new Error('unreadable origin head');
  if (nowMs - committedMs <= thresholdMs) return null;
  const prs = await listBranchPrs(gh, branch);
  if (hasOpenPr(prs)) return null;
  const pushedAt = await readLastPushAt({ gh, config, branch });
  const idleMs = idleSince(nowMs, committedMs, pushedAt);
  if (idleMs <= thresholdMs) return null;
  return stalledRow({ storyId, head, pushedAt, idleMs, prs });
}

/**
 * @param {{
 *   provider: object,
 *   config?: object,
 *   gh?: object,
 *   logger?: { info?: Function, warn?: Function },
 *   now?: () => number,
 *   stalledAfterHours?: unknown,
 *   excludeStoryIds?: Array<number|null>,
 *   limit?: number,
 * }} args
 * @returns {Promise<{ ok: boolean, thresholdHours: number, stalled: object[], skipped: object[], unprobed: number, error?: string }>}
 */
export async function reportStalledExecuting({
  provider,
  config,
  gh = defaultGh,
  logger = {},
  now = Date.now,
  stalledAfterHours,
  excludeStoryIds = [],
  limit = DEFAULT_STALLED_PROBE_LIMIT,
}) {
  const thresholdHours = resolveStalledAfterHours(stalledAfterHours);
  const outcome = {
    ok: true,
    thresholdHours,
    stalled: [],
    skipped: [],
    unprobed: 0,
  };
  if (typeof provider?.listTicketsByLabel !== 'function') return outcome;
  let tickets;
  try {
    tickets = await provider.listTicketsByLabel({
      state: 'open',
      labels: `${TYPE_LABELS.STORY},${AGENT_LABELS.EXECUTING}`,
    });
  } catch (err) {
    const msg = err?.message ?? String(err);
    logger.warn?.(
      `open agent::executing listing failed (host continues): ${msg}`,
    );
    return { ...outcome, ok: false, error: msg };
  }
  const excluded = new Set(excludeStoryIds);
  const candidates = (Array.isArray(tickets) ? tickets : [])
    .filter((t) => isExecutingStory(t) && !excluded.has(t.id))
    .sort((a, b) => a.id - b.id);
  outcome.unprobed = Math.max(0, candidates.length - limit);
  const nowMs = now();
  const thresholdMs = thresholdHours * HOUR_MS;
  for (const story of candidates.slice(0, limit)) {
    try {
      const row = await probeStory({ story, gh, config, nowMs, thresholdMs });
      if (row === null) continue;
      outcome.stalled.push(row);
      logger.info?.(
        `⏸️  Story #${row.storyId} agent::executing idle ${row.idleHours}h with no open PR — run ${row.command}`,
      );
    } catch (err) {
      outcome.skipped.push({
        storyId: story.id,
        reason: err?.message ?? String(err),
      });
    }
  }
  return outcome;
}

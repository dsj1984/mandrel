/**
 * Report-only boot sweep: open `agent::executing` Stories whose `story-<id>`
 * origin head has not moved past the threshold and that have no open PR — a
 * delivery session that died silently. Reads origin over REST (a checkout
 * may hold no ref for another Story's branch); writes nothing; never throws.
 */

import { gh as defaultGh, GhNotFoundError } from '../gh-exec.js';
import { getStoryBranch } from '../git-utils.js';
import { AGENT_LABELS, TYPE_LABELS } from '../label-constants.js';
import { NEXT_COMMANDS } from '../orchestration/story-deliver-terminal.js';

export const DEFAULT_STALLED_AFTER_HOURS = 6;

/** Stories probed per boot (two reads each); the rest count as `unprobed`. */
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

/** `null` when the branch is absent on origin. */
async function readOriginHead({ gh, config, branch }) {
  const owner = config?.github?.owner || '{owner}';
  const repo = config?.github?.repo || '{repo}';
  const endpoint = `/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`;
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

async function probeStory({ story, gh, config, nowMs, thresholdMs }) {
  const storyId = story.id;
  const branch = getStoryBranch(storyId);
  const head = await readOriginHead({ gh, config, branch });
  if (head === null) return null;
  const committedMs = Date.parse(head.committedAt ?? '');
  if (!Number.isFinite(committedMs)) throw new Error('unreadable origin head');
  const idleMs = nowMs - committedMs;
  if (idleMs <= thresholdMs) return null;
  const rows = await gh.pr.list(
    ['--head', branch, '--state', 'all'],
    ['number', 'state'],
  );
  const prs = Array.isArray(rows) ? rows : [];
  if (prs.some((pr) => pr?.state === 'OPEN')) return null;
  const last = prs[0];
  return {
    storyId,
    headSha: head.sha,
    headCommittedAt: head.committedAt,
    idleHours: Math.round((idleMs / HOUR_MS) * 10) / 10,
    pr: last
      ? { number: Number(last.number) || null, state: last.state }
      : null,
    command: NEXT_COMMANDS.recover(storyId),
  };
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

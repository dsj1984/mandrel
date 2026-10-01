// .agents/scripts/lib/orchestration/cancelled-run-discount.js
/**
 * cancelled-run-discount.js — a red required check from a run that concluded
 * `cancelled` takes the verdict of the newest other run of its workflow on
 * the same head SHA. Every read fails closed: the red stands.
 */

import { gh } from '../gh-exec.js';
import { checkVerdict } from './check-state.js';
import { parseWorkflowRunId } from './merge-poll.js';

const REPO_PLACEHOLDER = '{owner}/{repo}';

async function defaultGhApi(endpoint) {
  const { stdout } = await gh.api({ endpoint });
  return JSON.parse(stdout);
}

function repoSegment(repo) {
  const trimmed = String(repo ?? '').trim();
  return trimmed.length > 0 ? trimmed : REPO_PLACEHOLDER;
}

async function readJson(ghApiFn, endpoint) {
  try {
    const body = await ghApiFn(endpoint);
    return body && typeof body === 'object' ? body : null;
  } catch {
    return null;
  }
}

function parseCancelledRun(body) {
  if (body?.conclusion !== 'cancelled') return null;
  const headSha = body.head_sha;
  const workflowId = body.workflow_id;
  if (typeof headSha !== 'string' || headSha.length === 0) return null;
  if (!Number.isInteger(workflowId) || workflowId < 1) return null;
  return { headSha, workflowId };
}

/** Newest sibling by run id, never start time (the cancelled job starts later). */
function pickLiveSibling(body, cancelledRunId) {
  const runs = Array.isArray(body?.workflow_runs) ? body.workflow_runs : [];
  let newest = null;
  for (const run of runs) {
    const id = run?.id;
    if (!Number.isInteger(id) || id === cancelledRunId) continue;
    if (newest === null || id > newest.id) {
      newest = {
        id,
        status: String(run.status ?? ''),
        conclusion: String(run.conclusion ?? ''),
      };
    }
  }
  return newest;
}

/** @returns {'pending'|'success'|'failure'} */
function siblingOutcome(sibling) {
  if (sibling.status !== 'completed') return 'pending';
  return sibling.conclusion === 'success' ? 'success' : 'failure';
}

function lastEntryByName(entries) {
  const byName = new Map();
  for (const e of entries) byName.set(e.name, e);
  return byName;
}

/**
 * One per watcher invocation: a `cancelled` read is final, so it is cached
 * per run id; the sibling list is re-read on every call.
 *
 * @returns {(entries: object[], outcomes: object) => Promise<object>}
 */
export function createCancelledRunDiscount({
  repo = null,
  ghApiFn = defaultGhApi,
  logger = {},
} = {}) {
  const base = `repos/${repoSegment(repo)}/actions`;
  const cancelledRuns = new Map();

  async function readCancelledRun(runId) {
    if (cancelledRuns.has(runId)) return cancelledRuns.get(runId);
    const run = parseCancelledRun(
      await readJson(ghApiFn, `${base}/runs/${runId}`),
    );
    if (run) cancelledRuns.set(runId, run);
    return run;
  }

  async function discountOne(name, entry) {
    const runId = parseWorkflowRunId(entry?.link);
    if (runId === null) return null;
    const run = await readCancelledRun(runId);
    if (!run) return null;
    const sibling = pickLiveSibling(
      await readJson(
        ghApiFn,
        `${base}/workflows/${run.workflowId}/runs?head_sha=${run.headSha}`,
      ),
      runId,
    );
    if (!sibling) return null;
    const outcome = siblingOutcome(sibling);
    logger.info?.(
      `[Watcher] required check "${name}" failed in concurrency-cancelled run ${runId}; ` +
        `reading live run ${sibling.id} instead (${outcome}).`,
    );
    return outcome;
  }

  return async function discount(entries, outcomes) {
    const red = Object.keys(outcomes).filter(
      (name) => checkVerdict(outcomes[name]) === 'fail',
    );
    if (red.length === 0) return outcomes;
    const byName = lastEntryByName(entries);
    const out = { ...outcomes };
    for (const name of red) {
      const outcome = await discountOne(name, byName.get(name));
      if (outcome !== null) out[name] = outcome;
    }
    return out;
  };
}

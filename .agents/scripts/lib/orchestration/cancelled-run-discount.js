// .agents/scripts/lib/orchestration/cancelled-run-discount.js
/**
 * cancelled-run-discount.js — re-read a red required check that came from a
 * concurrency-cancelled workflow run. The run's conclusion is the signal, not
 * the job's: an `if: always()` aggregate job concludes `failure` when its
 * `needs` were cancelled, but the run itself concludes `cancelled`. When a
 * newer run of the same workflow exists on the same head SHA, that live run's
 * verdict replaces the false red. Every read fails closed — the red stands.
 */

import { gh } from '../gh-exec.js';
import { checkVerdict } from './check-state.js';
import { parseWorkflowRunId } from './merge-poll.js';

/** gh resolves `{owner}/{repo}` from the cwd's remote when no repo is set. */
const REPO_PLACEHOLDER = '{owner}/{repo}';

/**
 * Default `gh api` port: GET `endpoint`, resolve the parsed JSON body.
 *
 * @param {string} endpoint
 * @returns {Promise<unknown>}
 */
async function defaultGhApi(endpoint) {
  const { stdout } = await gh.api({ endpoint });
  return JSON.parse(stdout);
}

function repoSegment(repo) {
  const trimmed = String(repo ?? '').trim();
  return trimmed.length > 0 ? trimmed : REPO_PLACEHOLDER;
}

/** Any throw or non-object body → `null` (fail-closed). */
async function readJson(ghApiFn, endpoint) {
  try {
    const body = await ghApiFn(endpoint);
    return body && typeof body === 'object' ? body : null;
  } catch {
    return null;
  }
}

/** `{ headSha, workflowId }` for a cancelled run, else `null`. */
function parseCancelledRun(body) {
  if (body?.conclusion !== 'cancelled') return null;
  const headSha = body.head_sha;
  const workflowId = body.workflow_id;
  if (typeof headSha !== 'string' || headSha.length === 0) return null;
  if (!Number.isInteger(workflowId) || workflowId < 1) return null;
  return { headSha, workflowId };
}

/**
 * Newest sibling by run id — never start time: a cancelled run's aggregate
 * job starts later than the live run's queued one.
 *
 * @param {unknown} body `GET …/workflows/<id>/runs` response.
 * @param {number} cancelledRunId
 * @returns {{ id: number, status: string, conclusion: string }|null}
 */
export function pickLiveSibling(body, cancelledRunId) {
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

/**
 * The live run's verdict as a classifier outcome.
 *
 * @param {{ status: string, conclusion: string }} sibling
 * @returns {'pending'|'success'|'failure'}
 */
export function siblingOutcome(sibling) {
  if (sibling.status !== 'completed') return 'pending';
  return sibling.conclusion === 'success' ? 'success' : 'failure';
}

/** The entry `reduceOutcomes` kept for each name — the last one. */
function lastEntryByName(entries) {
  const byName = new Map();
  for (const e of entries) byName.set(e.name, e);
  return byName;
}

/**
 * Build a discount for one watcher invocation. The cancelled-run read is
 * cached per run id (a `cancelled` conclusion is final); the sibling list is
 * re-read on every call while the entry stays discounted.
 *
 * @param {object} opts
 * @param {string|null} [opts.repo] `owner/repo`; nullish → gh's placeholder.
 * @param {(endpoint: string) => Promise<unknown>} [opts.ghApiFn]
 * @param {{ info?: Function }} [opts.logger]
 * @returns {(entries: Array<{name: string, link?: string}>, outcomes: object) => Promise<object>}
 *   Resolves a new outcomes map; the input map is never mutated.
 */
export function createCancelledRunDiscount({
  repo = null,
  ghApiFn = defaultGhApi,
  logger = {},
} = {}) {
  const base = `repos/${repoSegment(repo)}/actions`;
  /** run id → cancelled-run facts; only `cancelled` reads are cached. */
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

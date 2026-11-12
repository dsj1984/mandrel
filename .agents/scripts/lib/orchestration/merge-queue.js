/**
 * merge-queue.js — the one seam for a merge-queue-protected base: whether the
 * PR's base requires a queue, whether the PR sits in it, and the dequeue.
 * GraphQL keys on the PR node, so no owner/repo is needed; the REST transport
 * reads the base's rulesets and cannot see queue membership.
 */

import {
  gh as defaultGh,
  describeGhFailure,
  prTransportOf,
} from '../gh-exec.js';
import { parseApiJson, readBranchRules } from '../gh-pr-rest.js';

/** Bound on each merge-queue GraphQL call, so a wedged `gh` cannot stall close. */
const MERGE_QUEUE_GH_TIMEOUT_MS = 30_000;

const MERGE_QUEUE_STATE_QUERY =
  'query($id: ID!) { node(id: $id) { ... on PullRequest { isMergeQueueEnabled isInMergeQueue } } }';

const DEQUEUE_MUTATION =
  'mutation($id: ID!) { dequeuePullRequest(input: { id: $id }) { mergeQueueEntry { id } } }';

const EJECTION_QUERY =
  'query($id: ID!) { node(id: $id) { ... on PullRequest { baseRefName labels(first: 20) { nodes { name } } ' +
  'timelineItems(last: 1, itemTypes: [ADDED_TO_MERGE_QUEUE_EVENT, REMOVED_FROM_MERGE_QUEUE_EVENT]) { nodes { __typename ' +
  '... on RemovedFromMergeQueueEvent { createdAt reason beforeCommit { oid } } } } ' +
  'commits(last: 1) { nodes { commit { committedDate } } } } } }';

const QUEUE_RUNS = 'repos/{owner}/{repo}/actions/runs?event=merge_group';

/** Inherited ejections re-armed per head; the next one counts as own. */
export const MAX_INHERITED_REARMS = 3;

/** Block class: the merge queue ejected the PR on its own failure. */
export const QUEUE_EJECTED_BLOCK_CLASS = 'queue-ejected';

/** `gh` stderr when the base requires a merge queue and the arm spelling is wrong. */
export const MERGE_QUEUE_REFUSAL = /when merge queue enabled/i;

/** Block class: a merge-queue base reached over the REST transport. */
export const MERGE_QUEUE_REST_BLOCK_CLASS = 'merge-queue-rest-unsupported';

/** The remedy that block carries: the CCR route refused to arm the queue base. */
export const MERGE_QUEUE_REST_REMEDY =
  "The PR's base branch requires a merge queue, and this session reaches GitHub over " +
  'repo-scoped REST only (GraphQL answers 403). The CCR auto-merge route refused this PR, ' +
  'and a direct merge would bypass the queue, so close did not merge. Enqueue the PR from a ' +
  'session that can reach GraphQL (arm auto-merge there) or from the GitHub UI, then confirm ' +
  'with `node .agents/scripts/single-story-confirm-merge.js --story <id>`.';

/**
 * REST reading: the base's active rulesets name a `merge_queue` rule.
 * Whether the PR sits in the queue is unreadable, so `inQueue` is null.
 */
async function readMergeQueueStateRest({ prRef, prNodeId, facade, timeoutMs }) {
  if (!prRef)
    throw new Error('PR number unavailable for the REST merge-queue read');
  const view = await facade.pr.view(String(prRef), ['id', 'baseRefName']);
  const rules = await readBranchRules({
    api: facade.api,
    base: view?.baseRefName,
    timeoutMs,
  });
  return {
    queueRequired: rules.some((rule) => rule?.type === 'merge_queue'),
    inQueue: null,
    prNodeId: prNodeId ?? view?.id ?? null,
  };
}

/**
 * @param {{ stdout?: string }|string|undefined} result
 * @returns {object|null}
 */
export function parseGraphqlData(result) {
  const text = typeof result === 'string' ? result : result?.stdout;
  const parsed = JSON.parse(String(text ?? ''));
  if (Array.isArray(parsed?.errors) && parsed.errors.length > 0) {
    throw new Error(
      `graphql: ${parsed.errors.map((e) => e?.message).join('; ')}`,
    );
  }
  return parsed?.data ?? null;
}

async function resolvePrNodeId(facade, prNodeId, prRef) {
  if (prNodeId) return prNodeId;
  const view = await facade.pr.view(String(prRef), ['id']);
  if (typeof view?.id === 'string' && view.id) return view.id;
  throw new Error('PR node id unavailable');
}

async function queryPrNode(facade, query, id, timeoutMs) {
  const data = parseGraphqlData(
    await facade.api({
      method: 'POST',
      endpoint: 'graphql',
      body: { query, variables: { id } },
      execOpts: { timeoutMs },
    }),
  );
  return data?.node;
}

/**
 * Whether the PR's base requires a merge queue, and whether the PR sits in
 * it now. Keyed on the PR node, so it needs no owner/repo. Never throws: any
 * failure returns `queueRequired: null` and the caller keeps the non-queue
 * behaviour.
 *
 * @param {{ prNumber?: number|string, prRef?: string, prNodeId?: string,
 *   gh?: object, timeoutMs?: number }} args `prNodeId` skips the id lookup.
 * @returns {Promise<{ queueRequired: boolean|null, inQueue: boolean|null,
 *   prNodeId: string|null, error?: string }>}
 */
export async function readMergeQueueState({
  prNumber,
  prRef,
  prNodeId,
  gh,
  timeoutMs = MERGE_QUEUE_GH_TIMEOUT_MS,
}) {
  const facade = gh ?? defaultGh;
  let id = prNodeId ?? null;
  try {
    if ((await prTransportOf(facade)) === 'rest') {
      return await readMergeQueueStateRest({
        prRef: prRef ?? prNumber,
        prNodeId: id,
        facade,
        timeoutMs,
      });
    }
    id = await resolvePrNodeId(facade, id, prRef ?? prNumber);
    const node = await queryPrNode(
      facade,
      MERGE_QUEUE_STATE_QUERY,
      id,
      timeoutMs,
    );
    if (typeof node?.isMergeQueueEnabled !== 'boolean') {
      throw new Error('merge-queue fields absent from the GraphQL response');
    }
    return {
      queueRequired: node.isMergeQueueEnabled,
      inQueue: node.isInMergeQueue === true,
      prNodeId: id,
    };
  } catch (err) {
    return {
      queueRequired: null,
      inQueue: null,
      prNodeId: id,
      error: describeGhFailure(err),
    };
  }
}

const RED_RUN = new Set(['failure', 'cancelled']);
const byNewest = (a, b) =>
  String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''));

/** The last queue event removed this head without merging it. */
function ejectedHead(pr, headSha) {
  const event = pr?.timelineItems?.nodes?.at(-1);
  if (event?.__typename !== 'RemovedFromMergeQueueEvent') return false;
  if (/merged/i.test(event.reason ?? '')) return false;
  const removed = event.beforeCommit?.oid;
  if (removed) return removed === headSha;
  const pushedAt = pr.commits?.nodes?.[0]?.commit?.committedDate;
  return !(Date.parse(event.createdAt) < Date.parse(pushedAt));
}

/** The newest entry's completed run, a red one first. */
function ejectingRunOf(runs) {
  const latest = runs[0]?.head_sha;
  const done = runs.filter(
    (r) => r.head_sha === latest && r.status === 'completed',
  );
  return (
    done.find((r) => r.conclusion === 'failure') ??
    done.find((r) => r.conclusion === 'cancelled') ??
    done[0] ??
    null
  );
}

/** First rule wins: inherited (capped), own, unknown. */
function classifyEjection({ ejecting, parentRuns, entries }) {
  const inherited =
    ejecting.conclusion === 'cancelled' ||
    parentRuns.some((r) => RED_RUN.has(r.conclusion));
  if (inherited) return entries > MAX_INHERITED_REARMS ? 'own' : 'inherited';
  return ejecting.conclusion === 'failure' ? 'own' : 'unknown';
}

/**
 * Why the merge queue ejected `headSha`, read from the `merge_group` run on
 * its `gh-readonly-queue/<base>/pr-<n>-<parentSha>` ref and the run of the
 * entry it was built on. GraphQL only; never throws (a failed read is
 * `unknown`). `verdict: null` means the last queue event is no ejection.
 *
 * @returns {Promise<{ verdict: 'inherited'|'own'|'unknown'|null,
 *   labels: string[], run?: object, failedJobs?: string[], detail?: string }>}
 */
export async function readQueueEjection({
  prNodeId,
  prNumber,
  headSha,
  gh,
  timeoutMs = MERGE_QUEUE_GH_TIMEOUT_MS,
}) {
  const facade = gh ?? defaultGh;
  const get = async (endpoint) =>
    parseApiJson(
      await facade.api({ method: 'GET', endpoint, execOpts: { timeoutMs } }),
    );
  let labels = [];
  try {
    const id = await resolvePrNodeId(facade, prNodeId, prNumber);
    const pr = await queryPrNode(facade, EJECTION_QUERY, id, timeoutMs);
    labels = (pr?.labels?.nodes ?? []).map((l) => l.name);
    if (!ejectedHead(pr, headSha)) return { verdict: null, labels };
    const prefix = `gh-readonly-queue/${pr.baseRefName}/pr-${prNumber}-`;
    const pushedAt = Date.parse(pr.commits?.nodes?.[0]?.commit?.committedDate);
    // shortcut: the newest 100 queue runs; page further if a queue outgrows it.
    const runs = (
      (await get(`${QUEUE_RUNS}&per_page=100`))?.workflow_runs ?? []
    )
      .filter((r) => String(r.head_branch ?? '').startsWith(prefix))
      .filter((r) => !(Date.parse(r.created_at) < pushedAt))
      .sort(byNewest);
    const ejecting = ejectingRunOf(runs);
    if (!ejecting) {
      return { verdict: 'unknown', labels, detail: 'no completed queue run' };
    }
    const parentSha = ejecting.head_branch.slice(prefix.length);
    const parentRuns = (
      (await get(`${QUEUE_RUNS}&head_sha=${parentSha}`))?.workflow_runs ?? []
    ).filter((r) => r.head_sha === parentSha);
    const verdict = classifyEjection({
      ejecting,
      parentRuns,
      entries: new Set(runs.map((r) => r.head_sha)).size,
    });
    const run = {
      id: ejecting.id,
      name: ejecting.name ?? null,
      url: ejecting.html_url ?? null,
      conclusion: ejecting.conclusion,
    };
    const failedJobs =
      verdict === 'own' ? await readFailedJobs(get, ejecting.id) : [];
    return { verdict, labels, run, failedJobs };
  } catch (err) {
    return { verdict: 'unknown', labels, detail: describeGhFailure(err) };
  }
}

/** Failed job names of a run; `[]` when unreadable. */
async function readFailedJobs(get, runId) {
  try {
    const body = await get(
      `repos/{owner}/{repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100`,
    );
    return (body?.jobs ?? [])
      .filter((j) => j.conclusion === 'failure')
      .map((j) => j.name);
  } catch {
    return [];
  }
}

/**
 * Take an enqueued PR out of the merge queue. `--disable-auto` cannot: GitHub
 * clears the auto-merge request on enqueue, so it reads as never armed.
 *
 * @returns {Promise<{ ok: boolean, detail: string }>}
 */
async function dequeuePullRequest({ prNodeId, gh }) {
  try {
    parseGraphqlData(
      await (gh ?? defaultGh).api({
        method: 'POST',
        endpoint: 'graphql',
        body: { query: DEQUEUE_MUTATION, variables: { id: prNodeId } },
        execOpts: { timeoutMs: MERGE_QUEUE_GH_TIMEOUT_MS },
      }),
    );
    return { ok: true, detail: 'dequeued' };
  } catch (err) {
    return { ok: false, detail: describeGhFailure(err) };
  }
}

function queueArmOutcome(result) {
  return result.mergeOnGreen
    ? { enabled: false, mergeQueue: true, reason: MERGE_QUEUE_REST_BLOCK_CLASS }
    : { enabled: true, mergeQueue: true };
}

/**
 * Arm on a merge-queue base: a bare `--auto`, and never the direct-merge
 * fallback — a merge that bypassed the queue would defeat the protection it
 * exists for. Over REST a CCR refusal resolves with `mergeOnGreen`, which on
 * a queue base is the REST block, never an arm.
 *
 * @returns {Promise<{ enabled: boolean, mergeQueue: true, reason?: string }>}
 */
export async function armForMergeQueue({ exec, prNumber, armCwd }) {
  try {
    const result = await exec(['pr', 'merge', String(prNumber), '--auto'], {
      cwd: armCwd,
    });
    if (result.status === 0) return queueArmOutcome(result);
    return {
      enabled: false,
      mergeQueue: true,
      reason: `merge-queue arm failed; gh-exit-${result.status}: ${(result.stderr ?? '').trim().slice(0, 200)}`,
    };
  } catch (err) {
    return {
      enabled: false,
      mergeQueue: true,
      reason: `gh-spawn-error: ${err?.message ?? err}`,
    };
  }
}

/**
 * Disarm an enqueued PR by dequeueing it. The caller owns the still-armed
 * warning, so both disarm paths share it.
 *
 * @returns {Promise<{ disarmed: boolean, alreadyUnarmed: false, detail: string }>}
 */
export async function disarmByDequeue({ prNodeId, ref, gh, progress }) {
  const dequeued = await dequeuePullRequest({ prNodeId, gh });
  if (!dequeued.ok) {
    return {
      disarmed: false,
      alreadyUnarmed: false,
      detail: `merge-queue dequeue failed: ${dequeued.detail}`.slice(0, 200),
    };
  }
  progress?.(
    'CONFIRM',
    `🔓 PR #${ref} removed from the merge queue — the PR stays open and hand-mergeable.`,
  );
  return { disarmed: true, alreadyUnarmed: false, detail: 'dequeued' };
}

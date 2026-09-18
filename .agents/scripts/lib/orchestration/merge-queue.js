/**
 * merge-queue.js — the one GraphQL seam for a merge-queue-protected base:
 * whether the PR's base requires a queue, whether the PR sits in it, and the
 * dequeue. Keyed on the PR node, so no owner/repo is needed.
 */

import { gh as defaultGh, describeGhFailure } from '../gh-exec.js';

/** Bound on each merge-queue GraphQL call, so a wedged `gh` cannot stall close. */
const MERGE_QUEUE_GH_TIMEOUT_MS = 30_000;

const MERGE_QUEUE_STATE_QUERY =
  'query($id: ID!) { node(id: $id) { ... on PullRequest { isMergeQueueEnabled isInMergeQueue } } }';

const DEQUEUE_MUTATION =
  'mutation($id: ID!) { dequeuePullRequest(input: { id: $id }) { mergeQueueEntry { id } } }';

/** `gh` stderr when the base requires a merge queue and the arm spelling is wrong. */
export const MERGE_QUEUE_REFUSAL = /when merge queue enabled/i;

/**
 * @param {{ stdout?: string }|string|undefined} result
 * @returns {object|null}
 */
function parseGraphqlData(result) {
  const text = typeof result === 'string' ? result : result?.stdout;
  const parsed = JSON.parse(String(text ?? ''));
  if (Array.isArray(parsed?.errors) && parsed.errors.length > 0) {
    throw new Error(
      `graphql: ${parsed.errors.map((e) => e?.message).join('; ')}`,
    );
  }
  return parsed?.data ?? null;
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
    if (!id) {
      const view = await facade.pr.view(String(prRef ?? prNumber), ['id']);
      id = typeof view?.id === 'string' && view.id ? view.id : null;
    }
    if (!id) throw new Error('PR node id unavailable');
    const data = parseGraphqlData(
      await facade.api({
        method: 'POST',
        endpoint: 'graphql',
        body: { query: MERGE_QUEUE_STATE_QUERY, variables: { id } },
        execOpts: { timeoutMs },
      }),
    );
    const node = data?.node;
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

/**
 * Arm on a merge-queue base: a bare `--auto`, and never the direct-merge
 * fallback — a merge that bypassed the queue would defeat the protection it
 * exists for.
 *
 * @returns {Promise<{ enabled: boolean, mergeQueue: true, reason?: string }>}
 */
export async function armForMergeQueue({ exec, prNumber, armCwd }) {
  try {
    const result = await exec(['pr', 'merge', String(prNumber), '--auto'], {
      cwd: armCwd,
    });
    if (result.status === 0) return { enabled: true, mergeQueue: true };
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

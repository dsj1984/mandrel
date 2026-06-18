/**
 * bootstrap/workflow-audit — audit the GitHub Projects v2 built-in
 * workflows for the project board, classifying each enabled workflow
 * against an allowlist (Story #2845).
 *
 * Motivation:
 *   The orchestrator's `ColumnSync` writes the Status column at every
 *   `transitionTicketState` call and documents "I own Status" at
 *   [`column-sync.js:21-27`]. GitHub Projects v2 ships several built-in
 *   workflows that *also* write the Status column as side-effects of
 *   issue / PR events. When both are enabled, the bot frequently gets
 *   the last write on `agent::done` transitions (PR merged ~2 minutes
 *   after the orchestrator's flip), leaving closed Stories stuck at
 *   `In Progress` on the board even though the issue is closed and
 *   labeled `agent::done`. Reproduced on Story #2813.
 *
 * Surface:
 *   - {@link CONFLICTING_WORKFLOWS} / {@link COMPATIBLE_WORKFLOWS} —
 *     frozen allowlists keyed by GitHub's built-in workflow `name`
 *     field.
 *   - {@link auditProjectWorkflows} — pure-ish (one GraphQL read) that
 *     classifies the project's currently-enabled workflows and returns
 *     a structured envelope.
 *   - {@link reapConflictingWorkflows} — opt-in destructive helper
 *     that issues `deleteProjectV2Workflow` for every entry in the
 *     audit's `conflicting` set. Fails fast on the first mutation
 *     error (no partial-reap state).
 *
 * GraphQL surface note:
 *   `ProjectV2Workflow` exposes `enabled` as `NON_NULL` but **read-only**
 *   — GraphQL ships no `updateProjectV2Workflow` mutation at the time
 *   of this Story. The only programmatic action is
 *   `deleteProjectV2Workflow`, which is irreversible from the API
 *   (the operator must re-create deleted built-ins from the GitHub UI).
 *   If GitHub later adds a toggle mutation, swap delete for toggle in
 *   {@link reapConflictingWorkflows}.
 */

import { resolveProjectMeta } from '../orchestration/project-meta-resolver.js';

/**
 * Workflows that **must not** be enabled when the orchestrator owns
 * the Status column. Each entry writes Status as a side-effect of an
 * event the orchestrator already handles (close, PR merge, PR link),
 * and the bot's write typically arrives *after* the orchestrator's
 * — clobbering the intended terminal state.
 *
 * Names match GitHub's built-in `ProjectV2Workflow.name` literals.
 */
export const CONFLICTING_WORKFLOWS = Object.freeze([
  'Pull request merged',
  'Pull request linked to issue',
]);

/**
 * Workflows that are safe to leave on. Either they don't touch the
 * Status column, or they touch it in a way the orchestrator's writes
 * agree with (`Item closed` sets Status to `Done`, which matches
 * `agent::done`).
 *
 * Surfaced informationally in the audit envelope so operators can see
 * what was inspected without re-querying.
 */
export const COMPATIBLE_WORKFLOWS = Object.freeze([
  'Item closed',
  'Item added to project',
  'Auto-add to project',
  'Auto-add sub-issues to project',
  'Auto-close issue',
]);

const CONFLICTING_SET = new Set(CONFLICTING_WORKFLOWS);
const COMPATIBLE_SET = new Set(COMPATIBLE_WORKFLOWS);

const LIST_WORKFLOWS_QUERY = `
  query($projectId: ID!) {
    node(id: $projectId) {
      ... on ProjectV2 {
        workflows(first: 50) {
          nodes { id name number enabled }
        }
      }
    }
  }`;

const DELETE_WORKFLOW_MUTATION = `
  mutation($workflowId: ID!) {
    deleteProjectV2Workflow(input: { workflowId: $workflowId }) {
      projectV2 { id }
    }
  }`;

/**
 * Classify a single workflow row against the allowlists.
 *
 * Pure helper — exported for test pinning.
 *
 * @param {{ name: string, enabled: boolean }} workflow
 * @returns {'conflicting'|'compatible'|'unknown'|'disabled-conflicting'|'disabled-other'}
 */
export function classifyWorkflow(workflow) {
  const name = workflow?.name ?? '';
  const enabled = workflow?.enabled === true;
  if (CONFLICTING_SET.has(name)) {
    return enabled ? 'conflicting' : 'disabled-conflicting';
  }
  if (COMPATIBLE_SET.has(name)) {
    return 'compatible';
  }
  return enabled ? 'unknown' : 'disabled-other';
}

/**
 * Query the project's built-in workflows and classify each one. Returns
 * a structured envelope the bootstrap step can render and the reap
 * helper can act on.
 *
 * @param {{
 *   provider: { graphql: Function },
 *   projectId: string,
 * }} args
 * @returns {Promise<{
 *   projectId: string,
 *   total: number,
 *   conflicting: Array<{ id: string, name: string, number: number }>,
 *   compatible: Array<{ id: string, name: string, number: number }>,
 *   unknown: Array<{ id: string, name: string, number: number }>,
 *   disabled: Array<{ id: string, name: string, number: number }>,
 * }>}
 */
export async function auditProjectWorkflows(args) {
  const { provider, projectId } = args ?? {};
  if (!provider || typeof provider.graphql !== 'function') {
    throw new TypeError(
      'auditProjectWorkflows requires a provider with graphql',
    );
  }
  if (typeof projectId !== 'string' || projectId.length === 0) {
    throw new TypeError('auditProjectWorkflows requires a non-empty projectId');
  }
  const data = await provider.graphql(LIST_WORKFLOWS_QUERY, { projectId });
  const nodes = data?.node?.workflows?.nodes ?? [];
  const conflicting = [];
  const compatible = [];
  const unknown = [];
  const disabled = [];
  for (const node of nodes) {
    const row = { id: node.id, name: node.name, number: node.number };
    const klass = classifyWorkflow(node);
    if (klass === 'conflicting') conflicting.push(row);
    else if (klass === 'compatible') compatible.push(row);
    else if (klass === 'unknown') unknown.push(row);
    else disabled.push(row);
  }
  return {
    projectId,
    total: nodes.length,
    conflicting,
    compatible,
    unknown,
    disabled,
  };
}

/**
 * Delete every workflow in the audit's `conflicting` set. Fails fast on
 * the first mutation error — leaves the remaining workflows untouched
 * rather than producing a partially-reaped board, because the operator
 * cannot easily tell which workflows were deleted versus which were
 * preserved when looking at the post-failure board state.
 *
 * Returns the per-workflow outcome so callers can log a deterministic
 * summary even on partial success (the failure path will throw, but the
 * happy path returns the full ordered list for printing).
 *
 * @param {{
 *   provider: { graphql: Function },
 *   audit: ReturnType<typeof auditProjectWorkflows> extends Promise<infer R> ? R : never,
 * }} args
 * @returns {Promise<{ reaped: Array<{ id: string, name: string }> }>}
 */
export async function reapConflictingWorkflows(args) {
  const { provider, audit } = args ?? {};
  if (!provider || typeof provider.graphql !== 'function') {
    throw new TypeError(
      'reapConflictingWorkflows requires a provider with graphql',
    );
  }
  if (!audit || !Array.isArray(audit.conflicting)) {
    throw new TypeError(
      'reapConflictingWorkflows requires an audit envelope with .conflicting[]',
    );
  }
  const reaped = [];
  for (const wf of audit.conflicting) {
    try {
      await provider.graphql(DELETE_WORKFLOW_MUTATION, { workflowId: wf.id });
      reaped.push({ id: wf.id, name: wf.name });
    } catch (err) {
      throw new Error(
        `[workflow-audit] Failed to delete workflow "${wf.name}" (id=${wf.id}): ${err?.message ?? err}. ` +
          `${reaped.length} workflow(s) were already deleted before this failure: ${
            reaped.map((r) => r.name).join(', ') || '(none)'
          }.`,
      );
    }
  }
  return { reaped };
}

/**
 * Resolve a Project v2 node id from a project number. Used by the
 * bootstrap CLI to convert the resolver's `projectNumber` into the node
 * id required by {@link auditProjectWorkflows}.
 *
 * Walks the shared owner-type ladder — `organization(login:$owner)` →
 * `user(login:$owner)` → `viewer` — via {@link resolveProjectMeta}, so an
 * **org-owned** board resolves here the same way it does for `ColumnSync`
 * (Story #4237). The owner login is read from `provider.projectOwner`
 * (explicit board owner) and falls back to `provider.owner` (the repo
 * owner) so org boards resolve even when no separate `projectOwner` is
 * configured. Returns `null` when no owner scope can see the project
 * (e.g. missing scope) so the caller can degrade gracefully.
 *
 * @param {{
 *   provider: { graphql: Function, owner?: string|null, projectOwner?: string|null },
 *   projectNumber: number,
 * }} args
 * @returns {Promise<string|null>}
 */
export async function resolveProjectIdByNumber(args) {
  const { provider, projectNumber } = args ?? {};
  if (!provider || typeof provider.graphql !== 'function') {
    throw new TypeError(
      'resolveProjectIdByNumber requires a provider with graphql',
    );
  }
  if (!Number.isInteger(projectNumber) || projectNumber <= 0) {
    throw new TypeError(
      'resolveProjectIdByNumber requires a positive integer projectNumber',
    );
  }
  try {
    const project = await resolveProjectMeta({
      provider,
      owner: provider.projectOwner ?? provider.owner ?? null,
      projectNumber,
      projectFields: 'id',
    });
    return project?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Render a human-readable summary line for the audit. Pure — exported
 * so the bootstrap CLI and tests share the same formatting.
 *
 * @param {Awaited<ReturnType<typeof auditProjectWorkflows>>} audit
 * @returns {string}
 */
export function formatAuditSummary(audit) {
  const c = audit.conflicting.length;
  const ok = audit.compatible.length;
  const u = audit.unknown.length;
  const d = audit.disabled.length;
  return `workflows: ${audit.total} scanned — ${c} conflicting, ${ok} compatible, ${u} unknown, ${d} disabled`;
}

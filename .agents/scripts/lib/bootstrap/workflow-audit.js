/**
 * Audit the board's Projects v2 built-in workflows. `ColumnSync` owns the
 * Status column; built-ins that also write it land after the orchestrator
 * and leave closed Stories stuck `In Progress`.
 *
 * GraphQL exposes `enabled` read-only, so the only remedy is the irreversible
 * `deleteProjectV2Workflow`; swap to a toggle if GitHub ever adds one.
 */

import { resolveProjectMeta } from '../orchestration/project-meta-resolver.js';

/** Built-ins whose Status writes clobber the orchestrator's; `ProjectV2Workflow.name` literals. */
export const CONFLICTING_WORKFLOWS = Object.freeze([
  'Pull request merged',
  'Pull request linked to issue',
]);

/** Built-ins that leave Status alone or agree with the orchestrator. */
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
 * Delete every conflicting workflow; fails fast, naming what was already
 * deleted, since the board alone cannot tell the operator.
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
 * Walks the shared org → user → viewer ladder so org-owned boards resolve as
 * they do for `ColumnSync`. `null` when no owner scope sees the project.
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

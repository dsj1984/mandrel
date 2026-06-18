/**
 * bootstrap/summary — Bootstrap result formatting + summary printing
 *
 * Pure formatting helpers (`format*Summary`) and the `printSummary`
 * presenter extracted from `agents-bootstrap-github.js` (Story #3349).
 * These render the `runBootstrap` result envelope into operator-facing
 * lines; they hold no provider coupling and no orchestration logic.
 */

import { Logger } from '../Logger.js';

export function formatProjectSummary(project) {
  if (project.scopesMissing) return 'skipped (missing project scope)';
  if (project.created) return `created #${project.projectNumber}`;
  if (project.projectNumber) return `adopted #${project.projectNumber}`;
  return 'skipped';
}

export function formatBranchProtectionSummary(bp) {
  if (!bp) return 'not-run';
  if (bp.status === 'created') return `created (added: ${bp.added.join(', ')})`;
  if (bp.status === 'merged') {
    return bp.added.length
      ? `merged (added: ${bp.added.join(', ')})`
      : 'merged (no changes)';
  }
  if (bp.status === 'skipped') return `skipped (${bp.reason})`;
  if (bp.status === 'failed') return `failed (${bp.reason})`;
  return bp.status;
}

export function formatWorkflowAuditSummary(wa) {
  if (!wa) return 'not-run';
  if (wa.skipped) return `skipped (${wa.reason})`;
  if (wa.action === 'no-conflicts') return 'no conflicting workflows';
  if (wa.action === 'warn-only')
    return `warned (${wa.audit.conflicting.length} conflicting; pass --reap-conflicting-workflows to delete)`;
  if (wa.action === 'reaped') return `reaped ${wa.reaped.length} workflow(s)`;
  return wa.action ?? 'unknown';
}

export function formatMergeMethodsSummary(mm) {
  if (!mm) return 'not-run';
  if (mm.status === 'unchanged') return 'unchanged (already at target stance)';
  if (mm.status === 'patched')
    return `patched (${(mm.patched ?? []).join(', ') || '—'})`;
  if (mm.status === 'skipped') return `skipped (${mm.reason})`;
  if (mm.status === 'failed') return `failed (${mm.reason})`;
  return mm.status;
}

export function printSummary(result) {
  Logger.info('\n=== Bootstrap Summary ===');
  Logger.info(`Labels created: ${result.labels.created.length}`);
  Logger.info(`Labels skipped: ${result.labels.skipped.length}`);
  Logger.info(`Fields created: ${result.fields.created.length}`);
  Logger.info(`Fields skipped: ${result.fields.skipped.length}`);
  Logger.info(`Project: ${formatProjectSummary(result.project)}`);
  Logger.info(`Status field: ${result.statusField.status}`);
  Logger.info(
    `Workflow audit: ${formatWorkflowAuditSummary(result.workflowAudit)}`,
  );
  Logger.info(
    `Branch protection: ${formatBranchProtectionSummary(result.branchProtection)}`,
  );
  Logger.info(
    `Merge methods: ${formatMergeMethodsSummary(result.mergeMethods)}`,
  );
}

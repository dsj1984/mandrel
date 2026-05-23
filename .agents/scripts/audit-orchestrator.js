#!/usr/bin/env node
/* node:coverage ignore file -- top-level CLI orchestrator; logic delegated to tested helpers under lib/audit-suite/ */

import { parseArgs } from 'node:util';
import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import { isDegraded } from './lib/degraded-mode.js';
import { Logger } from './lib/Logger.js';
import { createProvider } from './lib/provider-factory.js';
import { runAuditSuite } from './run-audit-suite.js';
import { selectAudits } from './select-audits.js';

/** Pure: severity → glyph used in the audit findings table. */
export function severityIcon(severity) {
  if (severity === 'critical') return '🔴';
  if (severity === 'high') return '🟠';
  if (severity === 'medium') return '🟡';
  return '⚪';
}

/** Pure: render the findings table block; returns '' when no findings. */
export function renderFindingsBlock(findings) {
  if (!findings || findings.length === 0) return '';
  const rows = findings.map((finding) => {
    const msg = finding.message
      ? finding.message.replace(/\n/g, '<br>')
      : 'No details provided';
    return `| ${finding.audit} | ${severityIcon(finding.severity)} ${finding.severity.toUpperCase()} | ${msg} |`;
  });
  return [
    '### ⚠️ Audit Configuration Issues',
    '',
    '| Audit | Severity | Message |',
    '|-------|----------|---------|',
    ...rows,
    '',
    '',
  ].join('\n');
}

const SEVERITY_RENDER = [
  ['critical', '🔴', 'Critical'],
  ['high', '🟠', 'High'],
  ['medium', '🟡', 'Medium'],
  ['low', '⚪', 'Low'],
];

export function renderSummaryLine(summary) {
  if (!summary) return '';
  const parts = SEVERITY_RENDER.filter(([key]) => (summary[key] ?? 0) > 0).map(
    ([key, icon, label]) => `${icon} ${summary[key]} ${label}`,
  );
  if (parts.length === 0) return '';
  return `**Summary:** ${parts.join(' | ')}`;
}

/** Pure: render the workflows block; returns '' when no workflows. */
export function renderWorkflowsBlock(workflows, summary, auditsRun) {
  if (!workflows || workflows.length === 0) return '';
  const headLines = [`**Audit Workflows Dispatched:** ${auditsRun.join(', ')}`];
  const summaryLine = renderSummaryLine(summary);
  if (summaryLine) headLines.push(summaryLine);
  headLines.push(
    '',
    '> [!NOTE]',
    '> Each entry below links to the audit workflow source. Full prompt bodies are written to `<auditOutputDir>/audit-<gate>-<audit>.md` (defaults to `temp/audits/`) as local-only artifacts when downstream agents need to execute them.',
    '',
  );
  const head = headLines.join('\n');
  const body = workflows
    .map((wf) => {
      const lines = ['---', '', `### Audit: \`${wf.audit}\``, ''];
      if (wf.path) lines.push(`- **Workflow:** \`${wf.path}\``);
      if (typeof wf.byteSize === 'number') {
        lines.push(`- **Source size:** ${wf.byteSize} bytes`);
      }
      if (wf.artifactPath) {
        lines.push(
          `- **Full prompt artifact:** \`${wf.artifactPath}\` _(local-only)_`,
        );
      }
      lines.push('', wf.summary || '_No summary available._', '');
      return `${lines.join('\n')}\n`;
    })
    .join('');
  return `${head}\n${body}`;
}

export function formatAuditReport(results) {
  const { metadata, findings, workflows } = results;
  const { summary, auditsRun } = metadata;
  const header = '## 🛡️ Audit Orchestrator Report\n\n';

  if (auditsRun.length === 0 && findings.length === 0) {
    return `${header}No audits were run during this gate.\n`;
  }

  return (
    header +
    renderFindingsBlock(findings) +
    renderWorkflowsBlock(workflows, summary, auditsRun)
  );
}

export async function runAuditOrchestrator(
  ticketId,
  gate,
  baseBranch = 'main',
) {
  Logger.info(
    `Starting Audit Orchestrator for Ticket #${ticketId} at gate '${gate}'`,
  );

  const config = resolveConfig();
  const provider = createProvider(config);

  Logger.info(`Selecting audits...`);
  const selection = await selectAudits({
    ticketId,
    gate,
    provider,
    baseBranch,
  });

  // Soft-fail propagation (Tech Spec #819): when selectAudits hits its
  // diff-timeout fallback in default (non-gate) mode it returns a degraded
  // envelope rather than the success shape. Surface that to the caller and
  // abort instead of crashing on `selection.selectedAudits` being undefined.
  if (isDegraded(selection)) {
    Logger.warn(
      `Audit selection degraded (${selection.reason}): ${selection.detail}`,
    );
    process.stdout.write(`${JSON.stringify(selection)}\n`);
    return selection;
  }

  if (selection.selectedAudits.length === 0) {
    Logger.info(`No audits selected for this gate/ticket combination.`);
    const report =
      '## 🛡️ Audit Orchestrator\n\nNo audits triggered natively for this lifecycle gate based on file changes or issue metadata.';
    await provider.postComment(ticketId, {
      body: report,
      type: 'notification',
    });
    return;
  }

  Logger.info(`Selected audits: ${selection.selectedAudits.join(', ')}`);
  Logger.info(`Running audits...`);

  const results = await runAuditSuite({
    auditWorkflows: selection.selectedAudits,
    artifactPrefix: `${gate}-${ticketId}`,
  });

  Logger.info(`Formatting report...`);
  const reportMarkdown = formatAuditReport(results);

  Logger.info(`Posting report to Ticket #${ticketId}...`);
  await provider.postComment(ticketId, {
    body: reportMarkdown,
    type: 'progress', // notification or progress both valid, progress implies a step in pipeline
  });

  Logger.info(`Audit Orchestrator finished successfully.`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      ticket: { type: 'string' },
      gate: { type: 'string' },
      'base-branch': { type: 'string', default: 'main' },
    },
  });

  if (!values.ticket || !values.gate) {
    throw new Error(
      'Usage: node audit-orchestrator.js --ticket <ID> --gate <gateName> [--base-branch <branch>]',
    );
  }

  const ticketId = Number.parseInt(values.ticket, 10);
  const result = await runAuditOrchestrator(
    ticketId,
    values.gate,
    values['base-branch'],
  );
  if (isDegraded(result)) process.exit(1);
}

runAsCli(import.meta.url, main, { source: 'AuditOrchestrator' });

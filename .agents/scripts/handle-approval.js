#!/usr/bin/env node

/**
 * .agents/scripts/handle-approval.js
 *
 * Parses /approve commands from issue comments. If an approval is detected,
 * transitions the target ticket to agent::executing and dispatches an agent
 * to implement the required fixes.
 */

import { parseArgs } from 'node:util';
import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import { AGENT_LABELS } from './lib/label-constants.js';
import { createProvider } from './lib/provider-factory.js';

/* exported for tests — Story-level reuse runner reserved for future test coverage */
export async function handleApproval(ticketId, commentBody) {
  const isApproveAll = commentBody?.trim().startsWith('/approve');
  const isApproveAudit = commentBody?.trim().startsWith('/approve-audit-fixes');

  if (!isApproveAll && !isApproveAudit) {
    Logger.info(
      `Comment on #${ticketId} does not start with a recognized approval command. Ignoring.`,
    );
    return;
  }

  Logger.info(`Approval command detected for Ticket #${ticketId}.`);
  const config = resolveConfig();
  const provider = createProvider(config.orchestration);

  const ticket = await provider.getTicket(ticketId);
  if (!ticket) {
    Logger.fatal(`Ticket #${ticketId} not found.`);
  }

  Logger.info(`Transitioning #${ticketId} to ${AGENT_LABELS.EXECUTING}...`);
  const ALL_AGENT_STATES = [
    AGENT_LABELS.READY,
    AGENT_LABELS.EXECUTING,
    AGENT_LABELS.DONE,
  ];

  await provider.updateTicket(ticketId, {
    labels: {
      add: [AGENT_LABELS.EXECUTING],
      remove: ALL_AGENT_STATES.filter((s) => s !== AGENT_LABELS.EXECUTING),
    },
  });

  Logger.info(`Posting feedback to Ticket #${ticketId}...`);
  const responseComment = `🚀 **Fixes Approved!**\n\nAn agent has been dispatched to implement the required changes. Once the agent completes its work, verification audits will re-run automatically.`;
  await provider.postComment(ticketId, {
    body: responseComment,
    type: 'notification',
  });

  Logger.info(`Successfully dispatched agent for Ticket #${ticketId}.`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      ticket: { type: 'string' },
      comment: { type: 'string' },
    },
  });

  if (!values.ticket || !values.comment) {
    Logger.fatal(
      'Usage: node handle-approval.js --ticket <ID> --comment "<body text>"',
    );
  }

  const ticketId = Number.parseInt(values.ticket, 10);
  await handleApproval(ticketId, values.comment);
}

runAsCli(import.meta.url, main, { source: 'HandleApproval' });

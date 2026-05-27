#!/usr/bin/env node

/**
 * .agents/scripts/hierarchy-gate.js — Hierarchy Completeness Gate
 *
 * Walks the Epic's full sub-issue graph (Features → Stories → Tasks) and
 * verifies every descendant is closed. Where the wave gate asks "did the
 * sprint complete what it committed to?" (manifest view), this gate asks
 * "is anything still open under this Epic?" (live GitHub graph view).
 *
 * The two gates catch different problems and are intentionally distinct:
 *   - The wave gate misses descendants that exist on GitHub but were never
 *     in the manifest — context::prd / context::tech-spec tickets, mid-sprint
 *     additions, recuts that bypassed the dispatcher, or tasks closed without
 *     `agent::done`.
 *   - The hierarchy gate misses parked follow-ons that live as separate
 *     top-level Stories outside the Epic's sub-issue graph.
 *
 * Per ticket type the rule is:
 *   - Features  — must be closed.
 *   - Stories   — must be closed.
 *   - Tasks     — must be closed AND carry `agent::done`.
 *   - Auxiliary (context::prd, context::tech-spec) — ignored.
 *     These are closed by the operator after the Epic PR merges, so
 *     requiring them closed here would block every Epic.
 *
 * **3-tier (Storyless) tree shape (Story #3127).** Under the 3-tier
 * hierarchy a Story has no child Tasks — `getSubTickets(<storyId>)`
 * returns `[]`. The walk terminates at the Story; with both the
 * Feature and Story closed, the gate passes. No type-specific branch
 * is required because the rule "every descendant must be complete" is
 * already vacuously true for the empty Task layer.
 *
 * Usage:
 *   node .agents/scripts/hierarchy-gate.js --epic <EPIC_ID>
 *
 * Exit codes:
 *   0 — every descendant ticket is closed (and Tasks carry agent::done).
 *   1 — one or more descendants are still open.
 *   2 — configuration or provider error.
 */

import { parseArgs } from 'node:util';
import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import {
  AGENT_LABELS,
  CONTEXT_LABELS,
  TYPE_LABELS,
} from './lib/label-constants.js';
import { createProvider } from './lib/provider-factory.js';

function classify(ticket) {
  const labels = ticket.labels ?? [];
  if (labels.includes(TYPE_LABELS.TASK)) return 'task';
  if (labels.includes(TYPE_LABELS.STORY)) return 'story';
  if (labels.includes(TYPE_LABELS.FEATURE)) return 'feature';
  if (
    labels.includes(CONTEXT_LABELS.PRD) ||
    labels.includes(CONTEXT_LABELS.TECH_SPEC)
  ) {
    return 'auxiliary';
  }
  return 'other';
}

function ticketIsComplete(ticket) {
  if (ticket.state !== 'closed') {
    return { ok: false, reason: 'open' };
  }
  if (
    classify(ticket) === 'task' &&
    !(ticket.labels ?? []).includes(AGENT_LABELS.DONE)
  ) {
    return { ok: false, reason: 'closed without agent::done' };
  }
  return { ok: true };
}

/**
 * BFS the sub-issue graph from the Epic. Returns one entry per descendant
 * ticket with full metadata — the caller checks completeness and formats
 * the failure list.
 */
async function collectDescendants(provider, epicId) {
  const visited = new Set([epicId]);
  const queue = [epicId];
  const out = [];
  while (queue.length > 0) {
    const parentId = queue.shift();
    let children;
    try {
      children = await provider.getSubTickets(parentId);
    } catch (err) {
      throw new Error(`getSubTickets(#${parentId}) failed: ${err.message}`);
    }
    for (const child of children) {
      if (visited.has(child.id)) continue;
      visited.add(child.id);
      out.push(child);
      queue.push(child.id);
    }
  }
  return out;
}

export async function runHierarchyGate({ epicId, injectedProvider } = {}) {
  if (!epicId || Number.isNaN(epicId) || epicId <= 0) {
    throw new Error('Usage: node hierarchy-gate.js --epic <EPIC_ID>');
  }

  const config = resolveConfig();
  const provider = injectedProvider || createProvider(config);

  let descendants;
  try {
    descendants = await collectDescendants(provider, epicId);
  } catch (err) {
    Logger.error(`[hierarchy-gate] ${err.message}`);
    process.exit(2);
  }

  const failures = { feature: [], story: [], task: [], other: [] };
  let auxiliaryDeferred = 0;
  for (const ticket of descendants) {
    const kind = classify(ticket);
    if (kind === 'auxiliary') {
      auxiliaryDeferred += 1;
      continue;
    }
    const verdict = ticketIsComplete(ticket);
    if (!verdict.ok) {
      failures[kind].push({
        id: ticket.id,
        title: ticket.title,
        reason: verdict.reason,
      });
    }
  }

  const totalOpen =
    failures.feature.length +
    failures.story.length +
    failures.task.length +
    failures.other.length;

  if (totalOpen > 0) {
    Logger.error(
      `[hierarchy-gate] ❌ Hierarchy-completeness gate FAILED for Epic #${epicId}: ${totalOpen} descendant(s) incomplete.`,
    );
    const sections = [
      ['feature', 'Features'],
      ['story', 'Stories'],
      ['task', 'Tasks'],
      ['other', 'Untyped descendants'],
    ];
    for (const [key, label] of sections) {
      if (failures[key].length === 0) continue;
      Logger.error(`\n  ${label}:`);
      for (const item of failures[key]) {
        Logger.error(`    - #${item.id} (${item.reason}) — ${item.title}`);
      }
    }
    Logger.error(
      '\nClose the open descendants — Tasks must carry `agent::done` — ' +
        'and re-run `/epic-deliver`.',
    );
    process.exit(1);
  }

  const auxNote =
    auxiliaryDeferred > 0
      ? ` (${auxiliaryDeferred} auxiliary ticket${auxiliaryDeferred === 1 ? '' : 's'} deferred to Phase 7)`
      : '';
  Logger.info(
    `[hierarchy-gate] ✅ All ${descendants.length - auxiliaryDeferred} planned descendant(s) under Epic #${epicId} are closed${auxNote}.`,
  );
  return {
    success: true,
    total: descendants.length,
    checked: descendants.length - auxiliaryDeferred,
    auxiliaryDeferred,
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      epic: { type: 'string' },
    },
    strict: false,
  });
  const epicId = Number.parseInt(values.epic ?? '', 10);
  await runHierarchyGate({ epicId });
}

runAsCli(import.meta.url, main, { source: 'hierarchy-gate' });

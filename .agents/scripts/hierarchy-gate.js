#!/usr/bin/env node

/**
 * .agents/scripts/hierarchy-gate.js — Hierarchy Completeness Gate
 *
 * Walks the Epic's full sub-issue graph (Stories) and verifies
 * every descendant is closed. Where the wave gate asks "did the sprint
 * complete what it committed to?" (manifest view), this gate asks "is
 * anything still open under this Epic?" (live GitHub graph view).
 *
 * The two gates catch different problems and are intentionally distinct:
 *   - The wave gate misses descendants that exist on GitHub but were never
 *     in the manifest — mid-sprint additions, recuts that bypassed the
 *     dispatcher, or legacy `context::*` artifacts on historical Epics.
 *   - The hierarchy gate misses parked follow-ons that live as separate
 *     top-level Stories outside the Epic's sub-issue graph.
 *
 * Per ticket type the rule is:
 *   - Stories   — must be closed.
 *   - Auxiliary (legacy `context::*` artifacts) — ignored. Story #4324
 *     folded planning content into the Epic body; historical Epics keep
 *     their old context tickets, which are reference-only here.
 *
 * **2-tier hierarchy (Story #4041).** Mandrel ships only Epic / Story
 * tickets. `getSubTickets(<storyId>)` returns `[]`; the walk
 * terminates at the Story. Acceptance criteria live inline on the
 * Story body.
 *
 * Usage:
 *   node .agents/scripts/hierarchy-gate.js --epic <EPIC_ID>
 *
 * Exit codes:
 *   0 — every descendant ticket is closed.
 *   1 — one or more descendants are still open.
 *   2 — configuration or provider error.
 */

import { parseArgs } from 'node:util';
import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import { TYPE_LABELS } from './lib/label-constants.js';
import { createProvider } from './lib/provider-factory.js';
import { concurrentMap } from './lib/util/concurrent-map.js';

/**
 * Bounded fan-out for per-level `getSubTickets` calls. Matches the
 * wave-record-io.js precedent (Story #3024).
 */
const SUB_TICKET_FETCH_CONCURRENCY = 4;

function classify(ticket) {
  const labels = ticket.labels ?? [];
  if (labels.includes(TYPE_LABELS.STORY)) return 'story';
  // Legacy planning artifacts (pre-#4324 `context::*` tickets on
  // historical Epics) are ignored — they are reference artifacts, not
  // deliverables. New Epics carry planning content on the body itself.
  if (labels.some((l) => typeof l === 'string' && l.startsWith('context::'))) {
    return 'auxiliary';
  }
  return 'other';
}

function ticketIsComplete(ticket) {
  if (ticket.state !== 'closed') {
    return { ok: false, reason: 'open' };
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
  const out = [];
  // Level-order BFS: each round fetches the whole frontier's children with a
  // bounded-parallel map instead of one awaited round-trip per node. Stories
  // are leaves (no sub-issues by contract), so they are never expanded
  // — that skip alone removes the largest class of wasted GraphQL calls.
  let frontier = [epicId];
  while (frontier.length > 0) {
    const levels = await concurrentMap(
      frontier,
      async (parentId) => {
        try {
          return await provider.getSubTickets(parentId);
        } catch (err) {
          throw new Error(`getSubTickets(#${parentId}) failed: ${err.message}`);
        }
      },
      { concurrency: SUB_TICKET_FETCH_CONCURRENCY },
    );
    const next = [];
    for (const children of levels) {
      for (const child of children) {
        if (visited.has(child.id)) continue;
        visited.add(child.id);
        out.push(child);
        const labels = child.labels ?? [];
        if (!labels.includes(TYPE_LABELS.STORY)) next.push(child.id);
      }
    }
    frontier = next;
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

  const failures = { story: [], other: [] };
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

  const totalOpen = failures.story.length + failures.other.length;

  if (totalOpen > 0) {
    Logger.error(
      `[hierarchy-gate] ❌ Hierarchy-completeness gate FAILED for Epic #${epicId}: ${totalOpen} descendant(s) incomplete.`,
    );
    const sections = [
      ['story', 'Stories'],
      ['other', 'Untyped descendants'],
    ];
    for (const [key, label] of sections) {
      if (failures[key].length === 0) continue;
      Logger.error(`\n  ${label}:`);
      for (const item of failures[key]) {
        Logger.error(`    - #${item.id} (${item.reason}) — ${item.title}`);
      }
    }
    Logger.error('\nClose the open descendants and re-run `/deliver`.');
    process.exit(1);
  }

  const auxNote =
    auxiliaryDeferred > 0
      ? ` (${auxiliaryDeferred} legacy auxiliary ticket${auxiliaryDeferred === 1 ? '' : 's'} ignored)`
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

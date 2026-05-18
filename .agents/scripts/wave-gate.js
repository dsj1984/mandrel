#!/usr/bin/env node

/**
 * .agents/scripts/wave-gate.js — Wave Completeness Gate
 *
 * Reads the latest `dispatch-manifest` structured comment on an Epic — the
 * single source of truth for which Stories the sprint committed to — and
 * verifies every Story in the manifest is closed. Exits non-zero if any
 * remain open so `/epic-deliver` can halt before any merge-to-main work
 * begins.
 *
 * The gate never reads `temp/dispatch-manifest-<epicId>.{md,json}`: those
 * files are derived views (regenerated on demand by `render-manifest.js`)
 * and can legitimately be stale or absent. Pinning the gate to the
 * structured comment keeps its decision reproducible across workstations,
 * CI runners, and fresh worktrees.
 *
 * Also reads the `parked-follow-ons` structured comment (if present) so
 * the operator sees recuts and parked Stories as part of the same gate
 * checkpoint. Open parked follow-ons halt the gate by default — the
 * operator must adopt (re-dispatch) or explicitly defer (close with
 * `not_planned`) before closure can proceed. Pass `--allow-parked` to
 * waive. Open recuts likewise halt unless `--allow-open-recuts` is set.
 *
 * Usage:
 *   node .agents/scripts/wave-gate.js --epic <EPIC_ID>
 *                                           [--allow-parked]
 *                                           [--allow-open-recuts]
 *
 * Exit codes:
 *   0 — all manifest stories are closed (and no blocking follow-ons).
 *   1 — one or more manifest stories / follow-ons are still open.
 *   2 — configuration or manifest-parse error.
 */

import { parseArgs } from 'node:util';
import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import { resolveConcurrency } from './lib/orchestration/concurrency.js';
import { parseFencedJsonComment } from './lib/orchestration/structured-comment-parser.js';
import { findStructuredComment } from './lib/orchestration/ticketing.js';
import { createProvider } from './lib/provider-factory.js';
import { concurrentMap } from './lib/util/concurrent-map.js';

async function readParkedFollowOns(provider, epicId) {
  const comment = await findStructuredComment(
    provider,
    epicId,
    'parked-follow-ons',
  );
  if (!comment) return { recuts: [], parked: [], present: false };
  const parsed = parseFencedJsonComment(comment);
  if (!parsed) return { recuts: [], parked: [], present: true };
  return {
    present: true,
    recuts: Array.isArray(parsed.recuts) ? parsed.recuts : [],
    parked: Array.isArray(parsed.parked) ? parsed.parked : [],
  };
}

/**
 * Fan out async reads either uncapped (Promise.all — preserves v5.21.0
 * behaviour when `orchestration.runners.concurrency.waveGate` is omitted) or
 * capped via `concurrentMap` when the operator set a positive cap.
 */
function fanOut(items, mapper, cap) {
  if (!Number.isInteger(cap) || cap <= 0) {
    return Promise.all(items.map((item, idx) => mapper(item, idx)));
  }
  return concurrentMap(items, mapper, { concurrency: cap });
}

export async function runWaveGate({
  epicId,
  allowParked = false,
  allowOpenRecuts = false,
  injectedProvider,
  injectedConcurrency,
} = {}) {
  if (!epicId || Number.isNaN(epicId) || epicId <= 0) {
    throw new Error('Usage: node wave-gate.js --epic <EPIC_ID>');
  }

  const { orchestration } = resolveConfig();
  const provider = injectedProvider || createProvider(orchestration);
  const concurrency = injectedConcurrency ?? resolveConcurrency(orchestration);

  // Story #2465 — prime the provider's ticket cache once with every child
  // ticket of the Epic, so the per-Story `getTicket` reads in the three
  // `Promise.all` blocks below resolve from the inline cache instead of
  // paying a wire round-trip each. `primeTicketCache` is a no-op on
  // providers without a cache (manual adapter, test stubs), so the call
  // is unconditional.
  try {
    const allTickets = await provider.getTickets(epicId);
    if (Array.isArray(allTickets)) {
      provider.primeTicketCache(allTickets);
    }
  } catch (err) {
    // Best-effort prime — if the bulk fetch fails we fall back to the
    // legacy per-Story `getTicket` path. Surface a warn so operators
    // notice the warm-cache miss without halting the gate.
    Logger.warn(
      `[wave-gate] Ticket-cache prime failed for Epic #${epicId}: ${err?.message ?? err}. Falling back to per-Story fetches.`,
    );
  }

  const comment = await findStructuredComment(
    provider,
    epicId,
    'dispatch-manifest',
  );
  if (!comment) {
    Logger.error(
      `[wave-gate] No dispatch-manifest comment on Epic #${epicId}. ` +
        `Run \`node .agents/scripts/dispatcher.js <epicId>\` to produce one.`,
    );
    process.exit(2);
  }

  const parsed = parseFencedJsonComment(comment);
  if (!parsed || !Array.isArray(parsed.stories)) {
    Logger.error(
      `[wave-gate] dispatch-manifest comment #${comment.id} on Epic #${epicId} did not contain a parseable story list.`,
    );
    process.exit(2);
  }

  // Read parked follow-ons + recuts structured comment (non-fatal if absent).
  const followOns = await readParkedFollowOns(provider, epicId);

  // Fan out all three getTicket batches concurrently. Each inner mapper
  // preserves the original "fetch failure → treat as still-open" contract so
  // we halt rather than silently skip a story we could not confirm.
  const manifestEntries = parsed.stories
    .map((entry) => ({ entry, id: Number(entry.storyId) }))
    .filter(({ id }) => Number.isFinite(id));
  const recutEntries = followOns.recuts
    .map((r) => ({ r, id: Number(r.storyId) }))
    .filter(({ id }) => Number.isFinite(id));
  const parkedEntries = followOns.parked
    .map((p) => ({ p, id: Number(p.storyId) }))
    .filter(({ id }) => Number.isFinite(id));

  const [manifestResults, recutResults, parkedResults] = await Promise.all([
    fanOut(
      manifestEntries,
      async ({ entry, id }) => {
        try {
          const ticket = await provider.getTicket(id);
          if (ticket.state !== 'closed') {
            return { id, title: entry.title, wave: entry.wave };
          }
          return null;
        } catch (err) {
          return {
            id,
            title: entry.title,
            wave: entry.wave,
            error: err.message,
          };
        }
      },
      concurrency.waveGate,
    ),
    fanOut(
      recutEntries,
      async ({ r, id }) => {
        try {
          const ticket = await provider.getTicket(id);
          if (ticket.state !== 'closed') {
            return { id, parentId: r.parentId };
          }
          return null;
        } catch (err) {
          return { id, parentId: r.parentId, error: err.message };
        }
      },
      concurrency.waveGate,
    ),
    fanOut(
      parkedEntries,
      async ({ id }) => {
        try {
          const ticket = await provider.getTicket(id);
          if (ticket.state !== 'closed') {
            return { id };
          }
          return null;
        } catch (err) {
          return { id, error: err.message };
        }
      },
      concurrency.waveGate,
    ),
  ]);

  const open = manifestResults.filter(Boolean);
  const openRecuts = recutResults.filter(Boolean);
  const openParked = parkedResults.filter(Boolean);

  const problems = [];
  if (open.length > 0) {
    problems.push(
      `${open.length} manifest story(ies) still open:` +
        '\n' +
        open
          .map((s) => {
            const tag = s.error ? ` (${s.error})` : '';
            return `  - #${s.id} (wave ${s.wave}) — ${s.title}${tag}`;
          })
          .join('\n'),
    );
  }
  if (openRecuts.length > 0 && !allowOpenRecuts) {
    problems.push(
      `${openRecuts.length} recut story(ies) still open:` +
        '\n' +
        openRecuts
          .map((r) => {
            const tag = r.error ? ` (${r.error})` : '';
            return `  - #${r.id} (recut-of #${r.parentId})${tag}`;
          })
          .join('\n'),
    );
  }
  if (openParked.length > 0 && !allowParked) {
    problems.push(
      `${openParked.length} parked follow-on(s) still open — adopt (re-dispatch) or close with \`not_planned\`:` +
        '\n' +
        openParked
          .map((p) => {
            const tag = p.error ? ` (${p.error})` : '';
            return `  - #${p.id}${tag}`;
          })
          .join('\n'),
    );
  }

  if (problems.length > 0) {
    Logger.error(
      `[wave-gate] ❌ Wave-completeness gate FAILED for Epic #${epicId}:`,
    );
    for (const p of problems) Logger.error(p);
    Logger.error('');
    Logger.error(
      'Resolve the open items with `/epic-deliver <storyId>` or close them manually, then re-run `/epic-deliver`.',
    );
    process.exit(1);
  }

  const followOnNote =
    followOns.recuts.length > 0 || followOns.parked.length > 0
      ? ` · ${followOns.recuts.length} recut + ${followOns.parked.length} parked (all closed)`
      : '';
  Logger.info(
    `[wave-gate] ✅ All ${parsed.stories.length} manifest story(ies) for Epic #${epicId} are closed${followOnNote}.`,
  );
  return {
    success: true,
    total: parsed.stories.length,
    recuts: followOns.recuts.length,
    parked: followOns.parked.length,
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      epic: { type: 'string' },
      'allow-parked': { type: 'boolean', default: false },
      'allow-open-recuts': { type: 'boolean', default: false },
    },
    strict: false,
  });
  const epicId = Number.parseInt(values.epic ?? '', 10);
  await runWaveGate({
    epicId,
    allowParked: values['allow-parked'] === true,
    allowOpenRecuts: values['allow-open-recuts'] === true,
  });
}

runAsCli(import.meta.url, main, { source: 'wave-gate' });

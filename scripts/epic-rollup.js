#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * epic-rollup.js — fold every per-wave `wave-run-progress` snapshot into
 * the single `epic-run-progress` comment on the Epic ticket.
 *
 * The slash-command runs this CLI between waves (Step 5 of `/epic-execute`)
 * so a single operator-facing summary always reflects the latest cross-wave
 * state. Pure aggregation — no ticket labels are mutated and no waves are
 * dispatched.
 *
 *   1. `provider.getTicketComments(epicId)` returns every comment on the Epic.
 *   2. Each comment is parsed via `parseWaveRunProgressComment`. Anything that
 *      doesn't match the `wave-run-progress` discriminator is silently
 *      skipped (the same comment thread carries dispatch-manifest, retro,
 *      checkpoint, and friction comments).
 *   3. Parsed entries are deduplicated by `wave` index — the latest snapshot
 *      for each wave wins. Sorted by `wave` ascending so the rolled-up table
 *      reads top-to-bottom.
 *   4. `upsertEpicRunProgress` renders the markdown header + per-wave table
 *      and persists it as a fenced-JSON `epic-run-progress` comment.
 *
 * Stdout: `{ epicId, currentWave, totalWaves, wavesAggregated, renderedBody }`.
 * `renderedBody` is the markdown body that was upserted onto the Epic ticket —
 * `/epic-execute` relays it as a chat message after each wave so the operator
 * sees the cross-wave rollup table without re-rendering.
 *
 * Usage:
 *   node .agents/scripts/epic-rollup.js \
 *     --epic <id> --current-wave <N> --total-waves <M> [--started-at <iso>]
 */

import { parseArgs } from 'node:util';

import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import {
  parseWaveRunProgressComment,
  upsertEpicRunProgress,
} from './lib/orchestration/epic-runner/progress-reporter.js';
import { createProvider } from './lib/provider-factory.js';

const HELP = `Usage: node .agents/scripts/epic-rollup.js \\
  --epic <epicId> --current-wave <N> --total-waves <M> [--started-at <iso>]

Aggregates every wave-run-progress comment on the Epic into a single
epic-run-progress comment. Returns { epicId, currentWave, totalWaves,
wavesAggregated } as JSON on stdout.
`;

/**
 * End-to-end rollup. DI-friendly: tests pass `injectedProvider` and skip
 * the real GitHub round-trips.
 *
 * @param {{
 *   epicId: number,
 *   currentWave: number,
 *   totalWaves: number,
 *   startedAt?: string,
 *   cwd?: string,
 *   injectedProvider?: object,
 *   injectedConfig?: object,
 *   now?: () => Date,
 * }} args
 * @returns {Promise<{
 *   epicId: number,
 *   currentWave: number,
 *   totalWaves: number,
 *   wavesAggregated: number,
 *   renderedBody: string,
 * }>}
 */
export async function runEpicRollup({
  epicId,
  currentWave,
  totalWaves,
  startedAt,
  cwd,
  injectedProvider,
  injectedConfig,
  now,
} = {}) {
  if (!Number.isInteger(epicId) || epicId <= 0) {
    throw new TypeError('runEpicRollup: --epic must be a positive integer');
  }
  if (!Number.isInteger(currentWave) || currentWave < 0) {
    throw new TypeError(
      'runEpicRollup: --current-wave must be a non-negative integer',
    );
  }
  if (!Number.isInteger(totalWaves) || totalWaves < 0) {
    throw new TypeError(
      'runEpicRollup: --total-waves must be a non-negative integer',
    );
  }

  const provider =
    injectedProvider ??
    createProvider((injectedConfig ?? resolveConfig({ cwd })).orchestration);

  const comments = (await provider.getTicketComments(epicId)) ?? [];
  const parsed = [];
  const seenWaves = new Map(); // wave index → latest parsed
  for (const c of comments) {
    const p = parseWaveRunProgressComment(c);
    if (!p) continue;
    seenWaves.set(p.wave, p); // later comments win — Map preserves insertion order
  }
  for (const v of seenWaves.values()) parsed.push(v);
  parsed.sort((a, b) => a.wave - b.wave);

  const { body: renderedBody } = await upsertEpicRunProgress({
    provider,
    epicId,
    waves: parsed,
    currentWave,
    totalWaves,
    startedAt,
    ...(now ? { now } : {}),
  });

  return {
    epicId,
    currentWave,
    totalWaves,
    wavesAggregated: parsed.length,
    renderedBody,
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      epic: { type: 'string' },
      'current-wave': { type: 'string' },
      'total-waves': { type: 'string' },
      'started-at': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: false,
  });
  if (values.help) {
    console.log(HELP);
    return;
  }
  const epicId = Number.parseInt(values.epic ?? '', 10);
  const currentWave = Number.parseInt(values['current-wave'] ?? '', 10);
  const totalWaves = Number.parseInt(values['total-waves'] ?? '', 10);
  if (Number.isNaN(epicId) || epicId <= 0) {
    console.error('[epic-rollup] ERROR: --epic <epicId> is required.');
    console.error(HELP);
    process.exit(2);
  }
  if (Number.isNaN(currentWave) || currentWave < 0) {
    console.error('[epic-rollup] ERROR: --current-wave <N> is required.');
    process.exit(2);
  }
  if (Number.isNaN(totalWaves) || totalWaves < 0) {
    console.error('[epic-rollup] ERROR: --total-waves <M> is required.');
    process.exit(2);
  }

  const out = await runEpicRollup({
    epicId,
    currentWave,
    totalWaves,
    startedAt: values['started-at'],
  });
  console.log(JSON.stringify(out, null, 2));
}

runAsCli(import.meta.url, main, { source: 'epic-rollup' });

#!/usr/bin/env node
/* node:coverage ignore file */

/**
 * plan-context.js — step 1 of the collapsed `/plan` pipeline.
 *
 * Emits one stdout-pure JSON envelope for the `/plan` authoring middle.
 *
 * Two operator modes (exactly one is required):
 *
 *   --seed "<text>"           Chat/text ideation. Dup search runs off the
 *                             raw seed; envelope carries `seed`.
 *
 *   --seed-file <path>        Same as --seed, but the corpus is read from
 *                             disk (audit-to-stories handoff, notes).
 *
 *   --tickets 123[,456…]      Analyze existing issue(s) into proper
 *                             Stories. Envelope carries `sourceTickets[]`.
 *
 * Flags:
 *   --out <path>     Also write the envelope to <path> (parent dirs created).
 *                    `/plan` points this at `<plan-dir>/plan-context.json`,
 *                    which is where `plan-persist.js` auto-discovers the
 *                    `--tickets` source ids from (Story #4554). Without a
 *                    captured envelope persist cannot know a `--tickets` run
 *                    happened, and superseding degrades to the
 *                    `--source-tickets` flag.
 *   --pretty         Pretty-print the JSON envelope.
 *
 * stdout is reserved for the JSON envelope (Story #2278 discipline):
 * `routeAllOutputToStderr()` runs before any pipeline code so a captured
 * file is unconditionally parseable by `JSON.parse`.
 *
 * Exit codes:
 *   0 — envelope emitted.
 *   1 — fatal error (see stderr).
 */

// Fail-fast if the framework's runtime deps are not installed — must be the
// first import so the check runs before any third-party-importing sibling
// module is evaluated (Story #3432).
import './lib/runtime-deps/ensure-installed.js';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { runAsCli } from './lib/cli-utils.js';
import {
  resolveConfig,
  validateOrchestrationConfig,
} from './lib/config-resolver.js';
import { Logger, routeAllOutputToStderr } from './lib/Logger.js';
import { buildPlanContext } from './lib/orchestration/plan-context.js';
import { recordPlanInvocation } from './lib/orchestration/plan-metrics.js';
import { createProvider } from './lib/provider-factory.js';

/**
 * Parse a comma-/space-separated ticket id list into positive integers.
 *
 * @param {string} raw
 * @returns {number[]}
 */
export function parseTicketIds(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error('--tickets requires one or more positive issue ids.');
  }
  const ids = raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s));
  if (ids.some((n) => !Number.isInteger(n) || n <= 0)) {
    throw new Error(
      `--tickets expects positive integer ids; got ${JSON.stringify(raw)}`,
    );
  }
  return [...new Set(ids)];
}

/**
 * Build the envelope and write it to `stdout` as a single JSON line
 * (or pretty-printed with --pretty). Exported for tests.
 *
 * @param {object} args
 * @returns {Promise<object>} the emitted envelope.
 */
export async function emitPlanContext({
  mode,
  seedFilePath,
  seedFileContent,
  seedText,
  ticketIds,
  provider,
  config,
  settings,
  pretty = false,
  outPath = null,
  cwd,
  stdout = process.stdout,
}) {
  const envelope = await buildPlanContext({
    mode,
    seedFilePath,
    seedFileContent,
    seedText,
    ticketIds,
    provider,
    config,
    settings,
    cwd,
  });
  const json = pretty
    ? JSON.stringify(envelope, null, 2)
    : JSON.stringify(envelope);
  stdout.write(`${json}\n`);
  if (outPath) await writeEnvelopeFile(outPath, json);
  return envelope;
}

/**
 * Persist the envelope to `--out` so `plan-persist.js` can derive the
 * `--tickets` source ids from it without an operator re-typing them.
 *
 * Writing is part of emitting, not a best-effort extra: a failed write means
 * persist will silently see no source tickets, so it throws rather than
 * warning past the problem.
 *
 * @param {string} outPath
 * @param {string} json
 */
async function writeEnvelopeFile(outPath, json) {
  const resolved = path.resolve(outPath);
  try {
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(resolved, `${json}\n`, 'utf8');
  } catch (err) {
    throw new Error(
      `[plan-context] cannot write envelope to ${resolved}: ${err.message}`,
    );
  }
  Logger.info(`[plan-context] wrote envelope to ${resolved}`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      seed: { type: 'string' },
      'seed-file': { type: 'string' },
      tickets: { type: 'string' },
      out: { type: 'string' },
      pretty: { type: 'boolean', default: false },
    },
    strict: true,
  });

  const seedText = values.seed || null;
  const seedFilePath = values['seed-file'] || null;
  const hasSeed = typeof seedText === 'string' && seedText.length > 0;
  const hasSeedFile =
    typeof seedFilePath === 'string' && seedFilePath.length > 0;
  const hasTickets =
    typeof values.tickets === 'string' && values.tickets.trim().length > 0;
  const entryForms = [hasSeed, hasSeedFile, hasTickets].filter(Boolean).length;
  if (entryForms !== 1) {
    throw new Error(
      'Pass exactly one of --seed "<text>", --seed-file <path>, or --tickets <ids>.',
    );
  }

  let mode;
  let ticketIds;
  if (hasTickets) {
    mode = 'tickets';
    ticketIds = parseTicketIds(values.tickets);
  } else if (hasSeedFile) {
    mode = 'seed-file';
  } else {
    mode = 'seed';
  }

  // stdout is reserved for the JSON envelope: flip every Logger sink that
  // could land on stdout to stderr BEFORE any pipeline code runs
  // (Story #2278 — the same stdout-purity guarantee the retired pipeline
  // gives; this CLI is emit-only so the flip is unconditional).
  routeAllOutputToStderr();

  let config;
  let settings;
  try {
    config = resolveConfig();
    // `settings` retains the legacy bag shape `buildAuthoringContext` and
    // friends consume: `{ baseBranch, paths, planning, docsContextFiles }`.
    settings = {
      baseBranch: config.project?.baseBranch,
      paths: config.project?.paths,
      planning: config.planning,
      docsContextFiles: config.project?.docsContextFiles,
    };
    validateOrchestrationConfig(config);
  } catch (err) {
    throw new Error(`Config schema validation failed:\n${err.message}`);
  }
  const provider = createProvider(config);

  await recordPlanInvocation(
    {
      cli: 'plan-context',
      mode,
      config,
    },
    () =>
      emitPlanContext({
        mode,
        seedFilePath: hasSeedFile ? seedFilePath : undefined,
        seedText: hasSeed ? seedText : undefined,
        ticketIds,
        provider,
        config,
        settings,
        pretty: values.pretty,
        outPath: values.out || null,
      }),
  );
}

runAsCli(import.meta.url, main, { source: 'plan-context' });

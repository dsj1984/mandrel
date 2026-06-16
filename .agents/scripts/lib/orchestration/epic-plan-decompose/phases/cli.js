/**
 * cli.js — Phase 6 (CLI entry orchestration) of the epic-plan-decompose
 * pipeline (Story #2466).
 *
 * Owns CLI flag parsing, the `--emit-context` JSON envelope path, and
 * the tickets-file load → `runDecomposePhase` persist path. The
 * partial-failure diagnostics emitter lives in the sibling
 * `diagnostics.js` module.
 *
 * @module lib/orchestration/epic-plan-decompose/phases/cli
 */

import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { drainPendingCleanupAtBoot } from '../../../../epic-plan-spec.js';
import {
  PROJECT_ROOT,
  resolveConfig,
  validateOrchestrationConfig,
} from '../../../config-resolver.js';
import {
  Logger,
  routeAllOutputToStderr,
  STDERR_LOGGER,
} from '../../../Logger.js';
import { createProvider } from '../../../provider-factory.js';
import { buildDecompositionContext } from './context.js';
import { reportPartialFailure } from './diagnostics.js';
import { runDecomposePhase } from './persist.js';

const CLI_OPTIONS = {
  epic: { type: 'string' },
  tickets: { type: 'string' },
  force: { type: 'boolean', default: false },
  resume: { type: 'boolean', default: false },
  'allow-over-budget': { type: 'boolean', default: false },
  'allow-large-fan-out': { type: 'boolean', default: false },
  'emit-context': { type: 'boolean', default: false },
  pretty: { type: 'boolean', default: false },
  'full-context': { type: 'boolean', default: false },
};

const USAGE =
  'Usage: epic-plan-decompose.js --epic <EpicId> (--emit-context [--pretty] [--full-context] | --tickets <file>) [--force | --resume] [--allow-over-budget] [--allow-large-fan-out]';

function parseEpicId(rawEpic) {
  if (!rawEpic) throw new Error(USAGE);
  const epicId = Number.parseInt(rawEpic, 10);
  if (Number.isNaN(epicId)) {
    throw new Error(`Invalid epic ID: "${rawEpic}" — must be a number.`);
  }
  return epicId;
}

function loadResolvedConfig() {
  let config;
  try {
    config = resolveConfig();
    // Epic #2880 / F14B: pass the canonical resolved config directly.
    // The legacy `config.orchestration` pointer is gone; the validator
    // reads `config.github` and `config.delivery.worktreeIsolation`.
    validateOrchestrationConfig(config);
  } catch (err) {
    throw new Error(
      `Orchestration config schema validation failed:\n${err.message}`,
    );
  }
  return config;
}

async function driveDrainPendingCleanup({ config, provider, emitContext }) {
  try {
    await drainPendingCleanupAtBoot({
      repoRoot: PROJECT_ROOT,
      // Epic #2880 / F14B: drainPendingCleanupAtBoot now reads opts.config
      // (canonical) and resolves the worktree root from
      // config.delivery.worktreeIsolation.root.
      config,
      provider,
      logger: emitContext ? STDERR_LOGGER : undefined,
    });
  } catch (err) {
    Logger.warn(`[epic-plan-decompose] worktree sweep skipped: ${err.message}`);
  }
}

async function runEmitContextPath({ epicId, provider, config, values }) {
  const ctx = await buildDecompositionContext(epicId, provider, config, {
    fullContext: values['full-context'],
  });
  // Surface the resolved reviewability budget on stderr so the operator
  // sees the same value the decomposer prompt embeds. `maxTickets` is a
  // framework constant (LIMITS_DEFAULTS.maxTickets), no longer an
  // operator-configurable key. Story #2798 — language is "reviewability
  // budget", not "prompt cap".
  Logger.error(
    `[epic-plan-decompose] Resolved maxTickets reviewability budget = ${ctx.maxTickets} (framework constant).`,
  );
  const json = values.pretty
    ? JSON.stringify(ctx, null, 2)
    : JSON.stringify(ctx);
  process.stdout.write(`${json}\n`);
}

async function loadTicketsFile(ticketsPath) {
  if (!ticketsPath) {
    throw new Error(
      'Missing --tickets <file>. (Use --emit-context first to gather authoring context.)',
    );
  }
  const raw = await readFile(ticketsPath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse tickets file "${ticketsPath}" as JSON: ${err.message}`,
    );
  }
}

async function runPersistPath({ epicId, provider, config, values }) {
  const tickets = await loadTicketsFile(values.tickets);
  let result;
  try {
    result = await runDecomposePhase(epicId, provider, { tickets }, config, {
      force: values.force,
      resume: values.resume,
      allowOverBudget: values['allow-over-budget'],
      allowLargeFanOut: values['allow-large-fan-out'],
    });
  } catch (err) {
    await reportPartialFailure({ epicId, provider, err });
    throw err;
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

/* node:coverage ignore next */
export async function main() {
  const { values } = parseArgs({ options: CLI_OPTIONS });
  const epicId = parseEpicId(values.epic);
  if (values.force && values.resume) {
    throw new Error('--force and --resume are mutually exclusive.');
  }

  const config = loadResolvedConfig();
  // Epic #2880 / F14B: createProvider takes the canonical resolved config
  // (it reads config.github). The legacy config.orchestration pointer is
  // gone; passing it yields undefined and crashes the provider factory's
  // hard guard.
  const provider = createProvider(config);
  const emitContext = values['emit-context'];

  // Story #2278 — in --emit-context mode stdout is reserved for the JSON
  // envelope. Flip every Logger sink that could land on stdout to stderr
  // before any orchestration code runs.
  if (emitContext) routeAllOutputToStderr();

  await driveDrainPendingCleanup({ config, provider, emitContext });

  if (emitContext) {
    await runEmitContextPath({ epicId, provider, config, values });
    return;
  }
  await runPersistPath({ epicId, provider, config, values });
}

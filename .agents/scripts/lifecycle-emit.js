#!/usr/bin/env node
/* node:coverage ignore file */
/**
 * lifecycle-emit.js — generic argv-driven emit helper (Story #2425 /
 * Task #2434, Epic #2307).
 *
 * Replaces the three single-purpose emit shims
 * (`epic-deliver-finalize.js`, `epic-deliver-automerge.js`,
 * `epic-deliver-cleanup.js`) that the `/epic-deliver` workflow markdown
 * invoked in Phase 6, 7.5, and 8. Those shims each did exactly one
 * thing: construct a bus and emit one event. Collapsing them into a
 * single argv-driven CLI lets the workflow stay declarative ("fire
 * <event> with <payload>") while keeping the lifecycle-bus contract
 * untouched.
 *
 * Usage:
 *   node .agents/scripts/lifecycle-emit.js --epic <id> --event <name> \
 *     [--<field> <value>]*
 *
 * Examples:
 *   # Phase 6 — close-tail entry event
 *   node .agents/scripts/lifecycle-emit.js --epic 2307 \
 *     --event epic.close.end
 *
 *   # Phase 7.5 — automerge wrapper start
 *   node .agents/scripts/lifecycle-emit.js --epic 2307 \
 *     --event epic.automerge.start \
 *     --pr-url https://github.com/dsj1984/mandrel/pull/123
 *
 *   # Phase 8 — cleanup (epic.merge.armed)
 *   node .agents/scripts/lifecycle-emit.js --epic 2307 \
 *     --event epic.merge.armed \
 *     --pr-url https://github.com/dsj1984/mandrel/pull/123
 *
 * Argv → payload mapping:
 *   - `--event <name>` selects the lifecycle event. The CLI validates
 *     that `.agents/schemas/lifecycle/<event>.schema.json` exists
 *     before invoking the bus; an unknown event exits non-zero with a
 *     message pointing at the missing schema file.
 *   - `--epic <id>` is mapped to `epicId` (integer) for events whose
 *     schema requires it.
 *   - Any other `--<kebab-case> <value>` flag is mapped to a
 *     camelCase payload key. Values that look like integers are
 *     parsed; everything else is forwarded as a string. Schema
 *     validation in the bus catches type mismatches.
 *
 * Missing required payload fields surface via the bus's schema
 * validator with `code: 'BUS_SCHEMA_VALIDATION'` and a non-zero exit.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runAsCli } from './lib/cli-utils.js';
import { epicLedgerPath } from './lib/config/temp-paths.js';
import { resolveConfig } from './lib/config-resolver.js';
import * as epicRunStateStoreModule from './lib/orchestration/epic-run-state-store.js';
import { createBus } from './lib/orchestration/lifecycle/bus.js';
import { buildDefaultListenerChain } from './lib/orchestration/lifecycle/listeners/index.js';
import { createProvider } from './lib/provider-factory.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCHEMA_DIR = path.resolve(
  __dirname,
  '..',
  'schemas',
  'lifecycle',
);

/**
 * Convert a kebab-case argv key (`pr-url`) to its camelCase payload
 * counterpart (`prUrl`). Leading dashes have already been stripped by
 * the argv parser.
 */
function toCamelCase(kebab) {
  return kebab.replace(/-([a-z0-9])/g, (_, ch) => ch.toUpperCase());
}

/**
 * Best-effort coercion: argv strings that look like positive integers
 * are parsed; everything else is forwarded as-is. Schema validation in
 * the bus catches genuine type mismatches.
 */
function coerceValue(raw) {
  if (typeof raw !== 'string') return raw;
  if (/^-?\d+$/.test(raw)) {
    const n = Number.parseInt(raw, 10);
    if (Number.isInteger(n)) return n;
  }
  return raw;
}

/**
 * Parse a flat argv array (`['--event', 'foo', '--epic', '42']`) into
 * an object map of flag → value. Boolean flags are not supported — the
 * helper is intentionally minimal and every value lands in the payload.
 */
export function parseArgv(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (typeof tok !== 'string' || !tok.startsWith('--')) {
      throw new Error(
        `lifecycle-emit: unexpected positional argument: ${String(tok)}`,
      );
    }
    const key = tok.slice(2);
    const value = argv[i + 1];
    if (
      value === undefined ||
      (typeof value === 'string' && value.startsWith('--'))
    ) {
      throw new Error(`lifecycle-emit: --${key} requires a value`);
    }
    out[key] = value;
    i += 1;
  }
  return out;
}

/**
 * Build the bus emit payload from parsed argv. `event` is consumed.
 * `--epic` is mapped to `epicId` (integer). All other flags are
 * mapped from kebab-case to camelCase with light value coercion.
 */
export function buildPayload(parsed) {
  const payload = {};
  for (const [key, raw] of Object.entries(parsed)) {
    if (key === 'event') continue;
    if (key === 'epic') {
      const n = Number.parseInt(raw, 10);
      if (!Number.isInteger(n) || n < 1) {
        throw new Error(
          `lifecycle-emit: --epic must be a positive integer (got ${raw})`,
        );
      }
      payload.epicId = n;
      continue;
    }
    payload[toCamelCase(key)] = coerceValue(raw);
  }
  return payload;
}

/**
 * Programmatic entry point. Tests inject `bus` to assert payload
 * shape without triggering real schema validation.
 *
 * When the caller does NOT supply a `bus`, the helper constructs a
 * default bus AND subscribes the canonical listener chain via
 * `buildDefaultListenerChain` so the standalone CLI surface fires every
 * documented downstream side effect (acceptance reconcile, finalize,
 * automerge, cleanup). Callers that inject a bus retain full control —
 * they are responsible for wiring whatever listeners they want.
 *
 * The listener chain requires `epicId` (decoded from the payload) and a
 * `repoRoot` (defaulted from `process.cwd()`). Story #2531 (Epic #2527)
 * additionally resolves the canonical orchestration `provider`, the
 * full agent `config`, and a per-Epic `checkpointer` bound to the
 * `epic-run-state` structured comment so the FULL listener roster
 * (including AutomergePredicate and BranchCleaner) subscribes — the
 * skip path that previously dropped those two listeners is reserved
 * for callers that inject overrides via `opts`.
 *
 * @param {object} opts
 * @param {string} opts.event lifecycle event name (matches schema file)
 * @param {object} opts.payload assembled emit payload
 * @param {object} [opts.bus] override bus (defaults to `createBus()`)
 * @param {string} [opts.schemaDir] override schema dir for existence check
 * @param {string} [opts.repoRoot] override repo root for shell-out
 *   listeners (defaults to `process.cwd()`)
 * @param {object} [opts.logger] optional logger forwarded to the chain
 * @param {object} [opts.provider] override provider (defaults to
 *   `createProvider(config.orchestration)` from the resolved config).
 *   Pass `null` to explicitly skip provider-dependent listeners.
 * @param {object} [opts.checkpointer] override checkpointer (defaults
 *   to a provider/epicId-bound `epic-run-state-store` facade). Pass
 *   `null` to explicitly skip BranchCleaner.
 * @param {object} [opts.config] override resolved config (defaults to
 *   `resolveConfig()`).
 */
export async function runLifecycleEmit({
  event,
  payload,
  bus,
  schemaDir = DEFAULT_SCHEMA_DIR,
  repoRoot,
  logger,
  provider,
  checkpointer,
  config,
} = {}) {
  if (typeof event !== 'string' || event.length === 0) {
    throw new Error('lifecycle-emit: --event is required');
  }
  const schemaPath = path.join(schemaDir, `${event}.schema.json`);
  if (!existsSync(schemaPath)) {
    throw new Error(
      `lifecycle-emit: unknown event "${event}" — no schema at ${schemaPath}`,
    );
  }
  const callerSuppliedBus = Boolean(bus);
  const targetBus = bus ?? createBus({ schemaDir });
  // Wire the default listener chain only when we constructed the bus
  // ourselves. Callers that inject a bus own its listener wiring.
  if (!callerSuppliedBus) {
    const epicId = Number(payload?.epicId);
    if (Number.isInteger(epicId) && epicId > 0) {
      const ledgerPath = epicLedgerPath(epicId);
      // Resolve config + provider + checkpointer so the full canonical
      // listener roster subscribes (Story #2531). The CLI swallows
      // resolution errors (missing/invalid .agentrc.json or
      // unconfigured provider) and falls back to the skip-cleanly
      // behaviour — the standalone CLI MUST remain usable in repos
      // that have not configured the orchestration block yet, just
      // with a reduced listener roster.
      let resolvedConfig = config;
      let resolvedProvider = provider;
      let resolvedCheckpointer = checkpointer;
      if (resolvedConfig === undefined) {
        try {
          resolvedConfig = resolveConfig();
        } catch (err) {
          (logger ?? console)?.debug?.(
            `[lifecycle-emit] resolveConfig failed (continuing with skipped collaborators): ${err?.message ?? err}`,
          );
          resolvedConfig = null;
        }
      }
      if (resolvedProvider === undefined) {
        try {
          resolvedProvider = createProvider(resolvedConfig?.orchestration);
        } catch (err) {
          (logger ?? console)?.debug?.(
            `[lifecycle-emit] createProvider skipped (no orchestration provider configured): ${err?.message ?? err}`,
          );
          resolvedProvider = null;
        }
      }
      if (resolvedCheckpointer === undefined) {
        resolvedCheckpointer = resolvedProvider
          ? buildEpicCheckpointer({ provider: resolvedProvider, epicId })
          : null;
      }
      await buildDefaultListenerChain({
        bus: targetBus,
        ledgerPath,
        repoRoot: repoRoot ?? process.cwd(),
        provider: resolvedProvider,
        checkpointer: resolvedCheckpointer,
        config: resolvedConfig,
        logger,
      });
    }
  }
  const { seqId } = await targetBus.emit(event, payload ?? {});
  return { event, payload: payload ?? {}, seqId };
}

/**
 * Build a thin per-Epic checkpointer facade over `epic-run-state-store`.
 * Mirrors the shape that `epic-runner/factory.js` constructs for the
 * production runner so BranchCleaner sees the same `read()`/`write()`
 * surface in both paths.
 */
function buildEpicCheckpointer({ provider, epicId }) {
  return {
    read: () => epicRunStateStoreModule.read({ provider, epicId }),
    write: (state) =>
      epicRunStateStoreModule.write({ provider, epicId, state }),
    setPhase: (nextPhase) =>
      epicRunStateStoreModule.setPhase({ provider, epicId, nextPhase }),
    appendIntervention: (entry) =>
      epicRunStateStoreModule.appendIntervention({ provider, epicId, entry }),
  };
}

async function main() {
  const parsed = parseArgv(process.argv.slice(2));
  if (!parsed.event) {
    throw new Error(
      'lifecycle-emit: --event <name> is required. Example: --event epic.close.end',
    );
  }
  const event = parsed.event;
  const payload = buildPayload(parsed);
  const out = await runLifecycleEmit({ event, payload });
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

runAsCli(import.meta.url, main, { source: 'lifecycle-emit' });

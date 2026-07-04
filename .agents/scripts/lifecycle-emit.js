#!/usr/bin/env node
/* node:coverage ignore file */
/**
 * lifecycle-emit.js — generic argv-driven emit helper (Story #2425 /
 * Task #2434, Epic #2307).
 *
 * Replaces the three single-purpose emit shims
 * (`epic-deliver-finalize.js`, `epic-deliver-automerge.js`,
 * `epic-deliver-cleanup.js`) that the `/deliver` workflow markdown
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
import { appendEpicSignal } from './lib/observability/signals-writer.js';
import * as epicRunStateStoreModule from './lib/orchestration/epic-run-state-store.js';
import { createBus } from './lib/orchestration/lifecycle/bus.js';
import { buildDefaultListenerChain } from './lib/orchestration/lifecycle/listeners/index.js';
import {
  STATE_LABELS,
  transitionTicketState,
} from './lib/orchestration/ticketing.js';
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
 * are parsed; the literals `true` / `false` coerce to booleans (so
 * boolean-typed payload fields like `epic.automerge.end`'s `merged` flag
 * pass schema validation from the workflow's `--merged true` invocation,
 * Story #3901); everything else is forwarded as-is. Schema validation in
 * the bus catches genuine type mismatches.
 */
function coerceValue(raw) {
  if (typeof raw !== 'string') return raw;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
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
 * The listener-chain keys (as returned by `buildDefaultListenerChain`)
 * whose listener instances carry a `classifications` array. Each listener
 * records one `{ event, seqId, outcome, reason? }` entry per invocation
 * (the "no silent skip" contract). We flatten every listener's
 * classifications into a single `outcomes[]` array so the CLI can surface
 * them and decide its exit code.
 */
const CLASSIFYING_LISTENER_KEYS = Object.freeze([
  'acceptanceReconciler',
  'finalizer',
  'automergeArmer',
  'automergePredicate',
  'branchCleaner',
  'mergeWatcher',
  'cleaner',
]);

/**
 * Flatten the listener-chain's per-listener `classifications` arrays into
 * a single ordered `outcomes[]` list. Each entry is tagged with the
 * `listener` key it came from so an operator (or the retro substrate) can
 * see WHICH listener classified WHAT.
 *
 * A `null`/`undefined` chain (caller-supplied bus, or no chain wired)
 * yields an empty array — the CLI then has nothing to fail on, preserving
 * the injected-bus test contract.
 *
 * @param {object|null} chain result of `buildDefaultListenerChain`
 * @returns {Array<{ listener: string, event?: string, seqId?: number,
 *   outcome: string, reason?: string }>}
 */
export function collectOutcomes(chain) {
  if (!chain || typeof chain !== 'object') return [];
  const outcomes = [];
  for (const key of CLASSIFYING_LISTENER_KEYS) {
    const listener = chain[key];
    const classifications = listener?.classifications;
    if (!Array.isArray(classifications)) continue;
    for (const c of classifications) {
      if (!c || typeof c !== 'object') continue;
      outcomes.push({ listener: key, ...c });
    }
  }
  return outcomes;
}

/**
 * Default operator-visible blocker signal. Fired by `runLifecycleEmit`
 * when one or more listener classifications came back `failed` and an
 * `epicId` is resolvable. It does two things, each best-effort:
 *
 *   1. Flips the Epic ticket to `agent::blocked` (the authoritative HITL
 *      runtime pause point per `instructions.md` § 1.J) via the canonical
 *      `transitionTicketState` API — but only when a `provider` is wired
 *      in. The standalone CLI is usable in repos with no `github` block,
 *      so a missing provider degrades to "signal-only".
 *   2. Appends a `friction` signal to the per-Epic `signals.ndjson` stream
 *      so the failure is recorded out-of-band even when no provider is
 *      configured (the no-ticket fallback from § 1.H).
 *
 * Neither step throws: the CLI must still print its `outcomes[]` envelope
 * and exit non-zero on the underlying failure regardless of whether the
 * side-effect plumbing succeeded.
 *
 * @param {object} args
 * @param {number} args.epicId resolved Epic id
 * @param {string} args.event the lifecycle event that produced the failure
 * @param {Array<object>} args.failedOutcomes the `outcome: 'failed'` entries
 * @param {object|null} [args.provider] ticketing provider (label flip)
 * @param {object} [args.config] resolved agent config (signal path)
 * @param {object} [args.logger] logger surface
 * @returns {Promise<{ labelFlipped: boolean, signalAppended: boolean }>}
 */
export async function emitBlockedSignal({
  epicId,
  event,
  failedOutcomes,
  provider,
  config,
  logger,
} = {}) {
  const log = logger ?? console;
  const reasons = (failedOutcomes ?? [])
    .map((o) => `${o.listener}:${o.reason ?? o.outcome}`)
    .join('; ');
  let labelFlipped = false;
  if (provider) {
    try {
      await transitionTicketState(provider, epicId, STATE_LABELS.BLOCKED);
      labelFlipped = true;
    } catch (err) {
      log?.warn?.(
        `[lifecycle-emit] failed to flip Epic #${epicId} to agent::blocked: ${err?.message ?? err}`,
      );
    }
  } else {
    log?.debug?.(
      `[lifecycle-emit] no provider wired — skipping agent::blocked flip for Epic #${epicId} (signal-only)`,
    );
  }
  let signalAppended = false;
  try {
    signalAppended = await appendEpicSignal({
      epicId,
      config,
      signal: {
        kind: 'friction',
        severity: 'high',
        event,
        message: `lifecycle-emit: ${event} produced failed listener classification(s): ${reasons}`,
        outcomes: failedOutcomes,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (err) {
    log?.warn?.(
      `[lifecycle-emit] failed to append friction signal for Epic #${epicId}: ${err?.message ?? err}`,
    );
  }
  return { labelFlipped, signalAppended };
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
 * additionally resolves the canonical provider, the
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
 *   `createProvider(config)` from the resolved config).
 *   Pass `null` to explicitly skip provider-dependent listeners.
 * @param {object} [opts.checkpointer] override checkpointer (defaults
 *   to a provider/epicId-bound `epic-run-state-store` facade). Pass
 *   `null` to explicitly skip BranchCleaner.
 * @param {object} [opts.config] override resolved config (defaults to
 *   `resolveConfig()`).
 * @param {(args: object) => Promise<unknown>} [opts.emitBlockedSignalFn]
 *   override the operator-visible blocker signal (defaults to
 *   `emitBlockedSignal`). Tests inject a spy to assert it fires on a
 *   `failed` classification without touching GitHub or the filesystem.
 * @param {object} [opts.chain] override the listener chain whose
 *   `classifications` arrays are collected into `outcomes[]`. Only honoured
 *   alongside an injected `bus` (when the caller owns listener wiring) —
 *   lets a test inject a bus + a chain carrying a `failed`-classifying
 *   listener to exercise the non-zero-exit path without the real roster.
 *
 * @returns {Promise<{ event: string, payload: object, seqId: number,
 *   outcomes: Array<object>, failed: boolean }>} The `outcomes[]` array
 *   carries every listener classification (tagged with its listener key);
 *   `failed` is `true` when any classification's `outcome` is `'failed'`.
 *   The CLI maps `failed` to a non-zero exit code.
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
  emitBlockedSignalFn = emitBlockedSignal,
  chain: injectedChain,
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
  const epicId = Number(payload?.epicId);
  const hasEpicId = Number.isInteger(epicId) && epicId > 0;
  // An injected chain is only meaningful when the caller also injected the
  // bus (otherwise we build the chain ourselves below).
  let chain = callerSuppliedBus ? (injectedChain ?? null) : null;
  let resolvedConfig = config;
  let resolvedProvider = provider;
  // Wire the default listener chain only when we constructed the bus
  // ourselves. Callers that inject a bus own its listener wiring.
  if (!callerSuppliedBus && hasEpicId) {
    const ledgerPath = epicLedgerPath(epicId);
    // Resolve config + provider + checkpointer so the full canonical
    // listener roster subscribes (Story #2531). The CLI swallows
    // resolution errors (missing/invalid .agentrc.json or
    // unconfigured provider) and falls back to the skip-cleanly
    // behaviour — the standalone CLI MUST remain usable in repos
    // that have not configured the github block yet, just
    // with a reduced listener roster.
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
        resolvedProvider = createProvider(resolvedConfig);
      } catch (err) {
        (logger ?? console)?.debug?.(
          `[lifecycle-emit] createProvider skipped (no provider configured): ${err?.message ?? err}`,
        );
        resolvedProvider = null;
      }
    }
    if (resolvedCheckpointer === undefined) {
      resolvedCheckpointer = resolvedProvider
        ? buildEpicCheckpointer({ provider: resolvedProvider, epicId })
        : null;
    }
    chain = await buildDefaultListenerChain({
      bus: targetBus,
      ledgerPath,
      repoRoot: repoRoot ?? process.cwd(),
      provider: resolvedProvider,
      checkpointer: resolvedCheckpointer,
      config: resolvedConfig,
      logger,
    });
  }
  const { seqId } = await targetBus.emit(event, payload ?? {});

  // Collect every listener classification the chain recorded. Listeners
  // record `failed` classifications instead of throwing (the bus's
  // `onFailed` boundary already persists the originating event), so the
  // bus emit resolves cleanly even when a downstream side effect — e.g.
  // an acceptance-reconcile gap or an `openOrLocatePr` throw inside
  // the Finalizer — failed. Without surfacing these, the CLI would exit 0
  // with success-shaped JSON despite a partial finalize (Story #3904).
  const outcomes = collectOutcomes(chain);
  const failedOutcomes = outcomes.filter((o) => o.outcome === 'failed');
  const failed = failedOutcomes.length > 0;

  // Operator-visible signal: a failed classification surfaces an
  // `agent::blocked` flip + friction signal rather than a silent exit 0.
  // Fired only when we own the chain AND have a target Epic to flag.
  if (failed && hasEpicId) {
    await emitBlockedSignalFn({
      epicId,
      event,
      failedOutcomes,
      provider: resolvedProvider ?? null,
      config: resolvedConfig ?? undefined,
      logger,
    });
  }

  return { event, payload: payload ?? {}, seqId, outcomes, failed };
}

/**
 * Build a thin per-Epic checkpointer facade over `epic-run-state-store`.
 * Exposes the `read()`/`write()`/`setPhase()`/`appendIntervention()`
 * surface BranchCleaner expects. (This was previously also constructed by
 * the in-process `epic-runner/factory.js`, deleted with the dead runner
 * stratum in Story #3908; this CLI is now the only builder of the facade.)
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
  // Exit non-zero when any listener classification came back `failed` so
  // the workflow's "re-run on non-zero" loop closes the partial-finalize
  // gap (Story #3904). `runAsCli`'s `propagateExitCode` maps this return
  // value to `process.exit`.
  return out.failed ? 1 : 0;
}

runAsCli(import.meta.url, main, {
  source: 'lifecycle-emit',
  propagateExitCode: true,
});

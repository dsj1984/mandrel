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
import { createBus } from './lib/orchestration/lifecycle/bus.js';

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
 * @param {object} opts
 * @param {string} opts.event lifecycle event name (matches schema file)
 * @param {object} opts.payload assembled emit payload
 * @param {object} [opts.bus] override bus (defaults to `createBus()`)
 * @param {string} [opts.schemaDir] override schema dir for existence check
 */
export async function runLifecycleEmit({
  event,
  payload,
  bus,
  schemaDir = DEFAULT_SCHEMA_DIR,
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
  const targetBus = bus ?? createBus({ schemaDir });
  const { seqId } = await targetBus.emit(event, payload ?? {});
  return { event, payload: payload ?? {}, seqId };
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

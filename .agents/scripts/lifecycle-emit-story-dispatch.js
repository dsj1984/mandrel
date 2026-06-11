#!/usr/bin/env node
/* node:coverage ignore file */
/**
 * lifecycle-emit-story-dispatch.js — Story #2891 Task #2906.
 *
 * Thin host-loop CLI that appends a single `story.dispatch.start`
 * NDJSON record to `temp/epic-<id>/lifecycle.ndjson`. Invoked by
 * `/deliver` Phase 2 immediately BEFORE each per-Story Agent
 * tool call so the lifecycle ledger durably records every dispatch
 * attempt. The `wave-tick.js` reconciler (Story #2891 Task #2901)
 * then derives `nextAction['in-flight']` from this ledger to surface
 * Stories that were dispatched but whose Agent return has not yet
 * landed.
 *
 * Why not the generic `lifecycle-emit.js`?
 *   - That CLI runs the FULL listener chain (acceptance reconciler,
 *     finalize, branch cleaner, …) which is wrong for a per-Story
 *     dispatch tick — those listeners are end-of-Epic concerns.
 *   - The bus emits TWO records per call (`emitted` + `completed`).
 *     The host loop wants exactly ONE `emitted`-shaped record per
 *     dispatch attempt so wave-tick's start/end pairing math stays
 *     straight.
 *   - The host loop fires once per Story per attempt; a thin direct
 *     append keeps that path observably cheap.
 *
 * Usage:
 *   node .agents/scripts/lifecycle-emit-story-dispatch.js \
 *     --epic <epicId> --story <storyId> --wave <waveIndex> \
 *     --attempt <attempt> [--dispatched-at <iso8601>]
 *
 * `--dispatched-at` is optional; when omitted the current wall-clock
 * is stamped. The flag exists for tests that need a deterministic
 * timestamp.
 *
 * Output: one JSON object on stdout describing the record that was
 * appended (`{ ledgerPath, record }`). Exit code 0 on success.
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import {
  parseRequiredNonNegativeInt,
  parseRequiredPositiveInt,
} from './lib/cli/parse-numeric.js';
import { runAsCli } from './lib/cli-utils.js';
import { epicLedgerPath } from './lib/config/temp-paths.js';
import { resolveConfig } from './lib/config-resolver.js';

const TOOL = 'lifecycle-emit-story-dispatch';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(
  __dirname,
  '..',
  'schemas',
  'lifecycle',
  'story.dispatch.start.schema.json',
);

const HELP = `Usage: node .agents/scripts/lifecycle-emit-story-dispatch.js \\
  --epic <epicId> --story <storyId> --wave <waveIndex> \\
  --attempt <attempt> [--dispatched-at <iso8601>]

Appends a single \`story.dispatch.start\` NDJSON record to
\`temp/epic-<epicId>/lifecycle.ndjson\`. Schema-validated against
\`.agents/schemas/lifecycle/story.dispatch.start.schema.json\`.
`;

/**
 * Parse and validate the four required positive integers (or the
 * sentinel allowing waveIndex >= 0). Throws with a CLI-friendly
 * message on any failure so `runAsCli` surfaces a clean error line.
 *
 * @param {object} parsed Raw argv values from parseArgs.
 * @returns {{epicId:number, storyId:number, waveIndex:number, attempt:number, dispatchedAt?:string}}
 */
export function buildPayloadFromArgs(parsed) {
  const epicId = parseRequiredPositiveInt(parsed.epic, '--epic', TOOL);
  const storyId = parseRequiredPositiveInt(parsed.story, '--story', TOOL);
  const waveIndex = parseRequiredNonNegativeInt(parsed.wave, '--wave', TOOL);
  const attempt = parseRequiredPositiveInt(parsed.attempt, '--attempt', TOOL);
  const dispatchedAt =
    typeof parsed['dispatched-at'] === 'string' &&
    parsed['dispatched-at'].length > 0
      ? parsed['dispatched-at']
      : new Date().toISOString();
  return { epicId, storyId, waveIndex, attempt, dispatchedAt };
}

/**
 * Programmatic entry point. Returns `{ ledgerPath, record }` after
 * appending exactly one NDJSON line. Tests use this surface to assert
 * payload shape without spawning a subprocess.
 *
 * @param {{epicId:number, storyId:number, waveIndex:number, attempt:number, dispatchedAt?:string, config?:object, ledgerPath?:string}} opts
 * @returns {{ledgerPath:string, record:object}}
 */
export function emitStoryDispatchStart(opts) {
  const {
    epicId,
    storyId,
    waveIndex,
    attempt,
    dispatchedAt = new Date().toISOString(),
    config,
    ledgerPath: ledgerPathOverride,
  } = opts ?? {};
  if (!Number.isInteger(epicId) || epicId < 1) {
    throw new Error(
      'lifecycle-emit-story-dispatch: epicId must be a positive integer',
    );
  }
  const payload = { storyId, waveIndex, dispatchedAt, attempt };
  validateAgainstSchema(payload);

  const ledgerPath = ledgerPathOverride ?? epicLedgerPath(epicId, config);
  mkdirSync(path.dirname(ledgerPath), { recursive: true });
  const record = {
    kind: 'emitted',
    ts: dispatchedAt,
    event: 'story.dispatch.start',
    payload,
  };
  appendFileSync(ledgerPath, `${JSON.stringify(record)}\n`, 'utf8');
  return { ledgerPath, record };
}

let _validator;
function validateAgainstSchema(payload) {
  if (!_validator) {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    _validator = ajv.compile(schema);
  }
  if (!_validator(payload)) {
    const detail = (_validator.errors ?? [])
      .map((e) => `${e.instancePath || '/'} ${e.message}`)
      .join('; ');
    throw new Error(
      `lifecycle-emit-story-dispatch: payload failed schema validation: ${detail}`,
    );
  }
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      epic: { type: 'string' },
      story: { type: 'string' },
      wave: { type: 'string' },
      attempt: { type: 'string' },
      'dispatched-at': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: false,
    allowPositionals: true,
  });
  if (values.help) {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  const { epicId, storyId, waveIndex, attempt, dispatchedAt } =
    buildPayloadFromArgs(values);

  let config;
  try {
    config = resolveConfig();
  } catch {
    // Standalone callers (e.g. fresh worktrees with no `.agentrc.json`
    // yet) fall back to the default tempRoot. The path resolver
    // handles the missing-config case gracefully.
    config = undefined;
  }

  const out = emitStoryDispatchStart({
    epicId,
    storyId,
    waveIndex,
    attempt,
    dispatchedAt,
    config,
  });
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

runAsCli(import.meta.url, main, { source: 'lifecycle-emit-story-dispatch' });

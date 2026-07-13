#!/usr/bin/env node

/**
 * acceptance-eval.js — bounded per-Story acceptance self-eval gate (Story #3819).
 *
 * The Story-implementation phase runs an independent (fresh-context)
 * critic pass that scores the working diff against each inline
 * `acceptance[]` item, emitting one verdict file per round
 * (`.agents/schemas/acceptance-eval-verdict.schema.json`). This CLI is the
 * deterministic substrate that turns that verdict into the loop's next
 * action:
 *
 *   1. Validate the verdict file against the verdict JSON Schema (a
 *      malformed verdict is a hard error — the loop refuses to guess).
 *   2. Decide `proceed | redraft | block` from the per-criterion verdicts
 *      and the resolved, undisableable round cap
 *      (`delivery.acceptanceEval.maxRounds`, clamped to `[1, ceiling]`).
 *   3. Emit one per-criterion `acceptance-eval` signal into the retro /
 *      feedback substrate so the retro and `/plan` Phase 0 feedback
 *      fetch can see which acceptance items needed rework and the round
 *      count.
 *   4. Print a single JSON envelope and exit:
 *        - `proceed` → exit 0; the workflow flips the Story to `closing`.
 *        - `redraft` → exit 0; the workflow reworks the flagged criteria
 *          and re-runs the critic pass for the next round.
 *        - `block`   → exit non-zero; the workflow transitions the Story
 *          to `agent::blocked`, posts a `friction` comment naming the
 *          unmet criteria, and stops. It never silently proceeds to close.
 *
 * The ticket transition / friction-comment authoring stays the workflow
 * agent's job (via `story-phase.js --phase blocked` + `diagnose-friction.js`)
 * — this CLI is the decision + signal boundary, mirroring how the existing
 * gates separate decision from ticket mutation.
 *
 * Two invocation shapes (Epic #4475, M4-B):
 *   - Per-Story (fan-out): the diff is one Story's; round scoping is per
 *     Story off the Story's `signals.ndjson`.
 *   - Per-AC-cluster (single delivery): `--epic <id> --cluster <clusterId>`
 *     with NO `--story`. The verdict scores one AC cluster of the Epic's
 *     `## Acceptance Table` against the cumulative `main..epic/<id>` diff;
 *     round scoping is per cluster off the Epic's `signals.ndjson`. This is
 *     the acceptance-dilution guard — `ceil(totalACs / clusterCeiling)`
 *     independent maker-blind critic passes, one per cluster.
 *
 * CLI:
 *   --story <id>           Story ID (required unless --cluster is given).
 *   --epic <id>            Parent Epic ID (required with --cluster).
 *   --cluster <id>         AC-cluster id for the single-delivery critic.
 *   --verdict <path>       Path to the round's verdict JSON (required).
 *   --no-signal            Suppress the signal emit (tests).
 *
 * Stdout: a single JSON envelope
 *   { storyId, epicId, decision, round, cap, capReached, totalCriteria,
 *     metCount, unmetCriteria[], signalEmitted }
 *
 * @see .agents/scripts/lib/orchestration/acceptance-eval-decision.js
 * @see .agents/schemas/acceptance-eval-verdict.schema.json
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { runAsCli } from './lib/cli-utils.js';
import { getAcceptanceEval, resolveConfig } from './lib/config-resolver.js';
import { Logger } from './lib/Logger.js';
import {
  appendEpicSignal,
  appendSignal,
} from './lib/observability/signals-writer.js';
import {
  buildAcceptanceEvalSignal,
  decideAcceptanceEval,
  deriveAcceptanceEvalRound,
} from './lib/orchestration/acceptance-eval-decision.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const VERDICT_SCHEMA_PATH = path.resolve(
  __dirname,
  '..',
  'schemas',
  'acceptance-eval-verdict.schema.json',
);

let cachedValidator = null;

/**
 * Compile (and cache) the Ajv2020 validator for the verdict schema.
 *
 * @param {string} [schemaPath]
 * @param {{ readFileSync: typeof readFileSync }} [io]
 * @returns {import('ajv').ValidateFunction}
 */
function getVerdictValidator(
  schemaPath = VERDICT_SCHEMA_PATH,
  io = { readFileSync },
) {
  if (cachedValidator) return cachedValidator;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const schema = JSON.parse(io.readFileSync(schemaPath, 'utf8'));
  cachedValidator = ajv.compile(schema);
  return cachedValidator;
}

/**
 * Validate a parsed verdict object against the verdict schema. Throws on
 * any violation so the loop never acts on a malformed verdict.
 *
 * Exported for tests.
 *
 * @param {unknown} verdict
 * @param {{ schemaPath?: string, io?: { readFileSync: typeof readFileSync } }} [opts]
 * @returns {object} The validated verdict (same reference).
 */
export function validateVerdict(verdict, opts = {}) {
  const validate = getVerdictValidator(
    opts.schemaPath ?? VERDICT_SCHEMA_PATH,
    opts.io ?? { readFileSync },
  );
  if (!validate(verdict)) {
    const detail = (validate.errors ?? [])
      .map((e) => `${e.instancePath || '/'} ${e.message}`)
      .join('; ');
    throw new Error(
      `acceptance-eval: verdict failed schema validation: ${detail}`,
    );
  }
  return /** @type {object} */ (verdict);
}

function parseCliArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      story: { type: 'string' },
      epic: { type: 'string' },
      cluster: { type: 'string' },
      verdict: { type: 'string' },
      'no-signal': { type: 'boolean', default: false },
    },
    strict: false,
  });
  const storyId = Number.parseInt(values.story ?? '', 10);
  const epicRaw = Number.parseInt(values.epic ?? '', 10);
  return {
    storyId: Number.isInteger(storyId) && storyId > 0 ? storyId : null,
    epicId: Number.isInteger(epicRaw) && epicRaw > 0 ? epicRaw : null,
    clusterId:
      typeof values.cluster === 'string' && values.cluster.length > 0
        ? values.cluster
        : null,
    verdictPath: values.verdict ?? null,
    emitSignal: values['no-signal'] !== true,
  };
}

/**
 * Compose the operator-facing envelope and emit the per-criterion signal.
 *
 * Exported for tests so the decision + signal path can be exercised
 * without spawning the CLI.
 *
 * @param {object} args
 * @param {number} args.storyId
 * @param {number | null} args.epicId
 * @param {object} args.verdict — validated verdict object.
 * @param {object} args.config — resolved `.agentrc.json`.
 * @param {boolean} args.emitSignal
 * @param {number} [args.round] — explicit round override (tests). When
 *   absent, the round is derived by counting prior `acceptance-eval`
 *   signals in the Story's `signals.ndjson` (Story #4019); the verdict's
 *   self-reported `round` is never load-bearing for the cap.
 * @param {object} [deps]
 * @param {Function} [deps.appendSignalFn]
 * @param {Function} [deps.deriveRoundFn]
 * @returns {Promise<{ envelope: object, exitCode: number }>}
 */
export async function runAcceptanceEval(
  { storyId, epicId, clusterId = null, verdict, config, emitSignal, round },
  deps = {},
) {
  const {
    appendSignalFn = appendSignal,
    appendEpicSignalFn = appendEpicSignal,
    deriveRoundFn = deriveAcceptanceEvalRound,
  } = deps;
  const clusterMode =
    typeof clusterId === 'string' &&
    clusterId.length > 0 &&
    Number.isInteger(epicId);
  const { maxRounds } = getAcceptanceEval(config);
  const resolvedRound =
    Number.isInteger(round) && round >= 1
      ? round
      : deriveRoundFn({ epicId: epicId ?? null, storyId, clusterId, config });
  const outcome = decideAcceptanceEval({
    verdict,
    maxRounds,
    round: resolvedRound,
  });

  let signalEmitted = false;
  if (emitSignal) {
    const signal = {
      ...buildAcceptanceEvalSignal({ storyId, epicId, outcome, clusterId }),
      ts: new Date().toISOString(),
    };
    try {
      // Cluster mode (single delivery) writes to the epic-level signals
      // stream so per-cluster round counts survive resume; the per-Story
      // path writes to the Story stream (unchanged).
      signalEmitted = clusterMode
        ? await appendEpicSignalFn({ epicId, signal, config })
        : await appendSignalFn({
            epicId,
            storyId,
            signal,
            config,
          });
    } catch (err) {
      // Observability is best-effort — a failed signal write must never
      // take down the gate. The decision still stands.
      Logger.warn(
        `acceptance-eval: failed to append signal: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  const envelope = {
    storyId: storyId ?? null,
    epicId: epicId ?? null,
    ...(clusterMode ? { clusterId } : {}),
    decision: outcome.decision,
    round: outcome.round,
    cap: outcome.cap,
    capReached: outcome.capReached,
    totalCriteria: outcome.totalCriteria,
    metCount: outcome.metCount,
    unmetCriteria: outcome.notMet.map((c) => ({
      index: c.index,
      criterion: c.criterion,
      verdict: c.verdict,
      evidence: c.evidence,
    })),
    signalEmitted,
  };

  // `block` is the only non-zero exit: the loop has exhausted its bounded
  // budget with criteria still unmet, and the workflow must escalate to
  // `agent::blocked` rather than proceed to close.
  const exitCode = outcome.decision === 'block' ? 1 : 0;
  return { envelope, exitCode };
}

export async function main(argv = process.argv.slice(2)) {
  const { storyId, epicId, clusterId, verdictPath, emitSignal } =
    parseCliArgs(argv);

  // Epic #4475 (M4-B): two invocation shapes.
  //   - Per-Story (fan-out): --story <id> [--epic <id>].
  //   - Per-AC-cluster (single delivery): --epic <id> --cluster <id> (no
  //     --story); the verdict scores one AC cluster of the Epic's Acceptance
  //     Table against the cumulative main..epic/<id> diff.
  const clusterMode = Boolean(clusterId) && Number.isInteger(epicId);
  if (!storyId && !clusterMode) {
    throw new Error(
      'Usage: node acceptance-eval.js --story <id> [--epic <id>] --verdict <path> [--no-signal]\n' +
        '   or: node acceptance-eval.js --epic <id> --cluster <clusterId> --verdict <path> [--no-signal]',
    );
  }
  if (!verdictPath) {
    throw new Error('acceptance-eval: --verdict <path> is required.');
  }

  let raw;
  try {
    raw = readFileSync(path.resolve(verdictPath), 'utf8');
  } catch (err) {
    throw new Error(
      `acceptance-eval: cannot read verdict file at ${verdictPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `acceptance-eval: verdict file is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const verdict = validateVerdict(parsed);

  // A verdict whose embedded storyId disagrees with the CLI flag is a
  // wiring error worth failing on, not a silent mismatch. Skipped in cluster
  // mode (no --story; the verdict scores an AC cluster, not a Story).
  if (
    !clusterMode &&
    Number.isInteger(verdict.storyId) &&
    verdict.storyId !== storyId
  ) {
    throw new Error(
      `acceptance-eval: verdict storyId (${verdict.storyId}) does not match --story ${storyId}.`,
    );
  }

  const config = resolveConfig();
  const { envelope, exitCode } = await runAcceptanceEval({
    storyId,
    epicId,
    clusterId,
    verdict,
    config,
    emitSignal,
  });

  Logger.info(JSON.stringify(envelope, null, 2));

  if (exitCode !== 0) {
    const names = envelope.unmetCriteria
      .map((c) => `#${c.index} (${c.verdict})`)
      .join(', ');
    throw new Error(
      `acceptance-eval: round cap (${envelope.cap}) reached with criteria still unmet: ${names}. ` +
        'Transition the Story to agent::blocked and post a friction comment.',
    );
  }

  return envelope;
}

runAsCli(import.meta.url, main, { source: 'acceptance-eval' });

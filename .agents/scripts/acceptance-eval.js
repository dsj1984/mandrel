#!/usr/bin/env node

/**
 * acceptance-eval.js — bounded per-Story acceptance gate. The deterministic
 * scorer of the round's single authored verdict: validate it against the
 * schema (malformed is a hard error), decide `proceed | redraft | block` under
 * `delivery.acceptanceEval.maxRounds`, emit an `acceptance-eval` signal, and
 * print one JSON envelope. Only `block` exits non-zero; the ticket transition
 * stays the workflow's job.
 *
 * One verdict, one gate call per round, covering every `acceptance[]` item in
 * order — the count is read off the Story body and a mismatch is rejected
 * before scoring, so it costs no round. Re-scoring an already-scored verdict
 * replays its round (`replay: true`) and never escalates. `epicId` is an
 * always-null envelope field kept for stability.
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
import { appendSignal } from './lib/observability/signals-writer.js';
import {
  buildAcceptanceEvalSignal,
  computeVerdictFingerprint,
  decideAcceptanceEval,
  resolveAcceptanceEvalRound,
} from './lib/orchestration/acceptance-eval-decision.js';
import {
  FULL_SUITE_SHAPE_WARNING,
  isFullSuiteCommand,
} from './lib/orchestration/verify-credit.js';
import { createProvider } from './lib/provider-factory.js';
import { parse as parseStoryBody } from './lib/story-body/story-body.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const VERDICT_SCHEMA_PATH = path.resolve(
  __dirname,
  '..',
  'schemas',
  'acceptance-eval-verdict.schema.json',
);

/**
 * Deliberately not memoised: a module-level cache would bypass the `io` seam
 * for every later caller. One compile per CLI run.
 *
 * @param {string} [schemaPath]
 * @param {{ readFileSync: typeof readFileSync }} [io]
 * @returns {import('ajv').ValidateFunction}
 */
function getVerdictValidator(
  schemaPath = VERDICT_SCHEMA_PATH,
  io = { readFileSync },
) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const schema = JSON.parse(io.readFileSync(schemaPath, 'utf8'));
  return ajv.compile(schema);
}

/**
 * Throws on any schema violation.
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
      verdict: { type: 'string' },
      'expected-criteria': { type: 'string' },
      'no-signal': { type: 'boolean', default: false },
    },
    strict: false,
  });
  const storyId = Number.parseInt(values.story ?? '', 10);
  return {
    storyId: Number.isInteger(storyId) && storyId > 0 ? storyId : null,
    verdictPath: values.verdict ?? null,
    expectedCriteria: values['expected-criteria'] ?? null,
    emitSignal: values['no-signal'] !== true,
  };
}

const MERGE_CONTRACT =
  'One round = ONE verdict -> ONE gate call: the verdict must carry one ' +
  'criteria[] record per acceptance[] item, in acceptance-array order, ' +
  'before scoring.';

/**
 * The Story body's `acceptance[]` count; any failure yields `null`, never a
 * manufactured count.
 *
 * @param {{ storyId: number, config: object }} args
 * @param {{ createProviderFn?: typeof createProvider, parseBodyFn?: typeof parseStoryBody }} [deps]
 * @returns {Promise<number|null>}
 */
export async function readStoryAcceptanceCount(
  { storyId, config },
  { createProviderFn = createProvider, parseBodyFn = parseStoryBody } = {},
) {
  try {
    const ticket = await createProviderFn(config).getTicket(storyId);
    const body = typeof ticket?.body === 'string' ? ticket.body : null;
    if (body === null) return null;
    const acceptance = parseBodyFn(body)?.body?.acceptance;
    return Array.isArray(acceptance) && acceptance.length > 0
      ? acceptance.length
      : null;
  } catch {
    return null;
  }
}

/**
 * The derived count wins; a disagreeing flag is a wiring error and throws.
 *
 * @param {{ derived: number|null, flagged: number|null }} args
 * @returns {number|null}
 */
export function reconcileExpectedCriteria({ derived, flagged }) {
  if (derived === null) return flagged;
  if (flagged !== null && flagged !== derived) {
    throw new Error(
      `acceptance-eval: --expected-criteria ${flagged} disagrees with the Story's acceptance[] count (${derived}); drop the flag — the gate reads the count itself.`,
    );
  }
  return derived;
}

/**
 * The coverage count, with a logged skip when neither source is readable.
 *
 * @param {{ storyId: number, config: object, flagged: number|null, readAcceptanceCountImpl: typeof readStoryAcceptanceCount, logger: { warn?: Function } }} args
 * @returns {Promise<number|null>}
 */
async function resolveExpectedCriteriaCount({
  storyId,
  config,
  flagged,
  readAcceptanceCountImpl,
  logger,
}) {
  const derived = await readAcceptanceCountImpl({ storyId, config });
  const expected = reconcileExpectedCriteria({ derived, flagged });
  if (expected === null) {
    logger.warn?.(
      '[acceptance-eval] ⚠ the Story acceptance[] count could not be read and no --expected-criteria was passed — the coverage assertion is skipped for this round.',
    );
  }
  return expected;
}

/**
 * `--expected-criteria` as a positive integer, or `null` when absent.
 *
 * @param {string|null|undefined} raw
 * @returns {number|null}
 */
export function resolveExpectedCriteria(raw) {
  if (raw === null || raw === undefined) return null;
  // Digits only — `parseInt('4abc')` is 4, which would wave a typo through.
  const text = String(raw).trim();
  const expected = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isInteger(expected) || expected < 1) {
    throw new Error(
      `acceptance-eval: --expected-criteria must be a positive integer (the Story's acceptance[] count). ${MERGE_CONTRACT}`,
    );
  }
  return expected;
}

/**
 * Reject a verdict not covering exactly `expectedCriteria` criteria — before
 * the round ledger is touched, so the mistake costs no round.
 *
 * @param {object} verdict — schema-validated verdict.
 * @param {number|null} expectedCriteria — `null` disables the assertion.
 * @returns {void}
 */
export function assertCriteriaCoverage(verdict, expectedCriteria) {
  if (expectedCriteria === null) return;
  const actual = Array.isArray(verdict?.criteria) ? verdict.criteria.length : 0;
  if (actual === expectedCriteria) return;
  throw new Error(
    `acceptance-eval: verdict covers ${actual} criteria but the Story's acceptance[] count is ${expectedCriteria}. ` +
      `${MERGE_CONTRACT} No round was consumed.`,
  );
}

/**
 * Distinct full-suite commands in the verdict's `verify[]` evidence — a
 * misshapen `verify[]` that re-pays (or silently skips) the one credited
 * full-suite run.
 *
 * @param {object} verdict — schema-validated verdict.
 * @returns {string[]} distinct offending commands, in first-seen order.
 */
export function collectFullSuiteVerifyCommands(verdict) {
  const seen = new Set();
  for (const criterion of verdict?.criteria ?? []) {
    for (const evidence of criterion?.verifyEvidence ?? []) {
      const command = evidence?.command;
      if (typeof command === 'string' && isFullSuiteCommand(command)) {
        seen.add(command.trim());
      }
    }
  }
  return [...seen];
}

/**
 * @param {object} verdict — schema-validated verdict.
 * @param {{ warn?: Function }} logger
 * @returns {string[]} the offending commands (empty when the shape is fine).
 */
function warnOnFullSuiteVerify(verdict, logger) {
  const commands = collectFullSuiteVerifyCommands(verdict);
  if (commands.length > 0) {
    logger?.warn?.(
      `acceptance-eval: verify[] carries full-suite command(s) ${commands.join(', ')}. ` +
        FULL_SUITE_SHAPE_WARNING,
    );
  }
  return commands;
}

/**
 * Decide, emit the signal, and compose the envelope.
 *
 * @param {object} args
 * @param {number} args.storyId
 * @param {object} args.verdict — validated verdict object.
 * @param {object} args.config — resolved `.agentrc.json`.
 * @param {boolean} args.emitSignal
 * @param {number} [args.round] — override (tests); otherwise derived from the
 *   signals ledger, never from the verdict's self-reported round.
 * @param {object} [deps]
 * @param {Function} [deps.appendSignalFn]
 * @param {Function} [deps.resolveRoundFn]
 * @param {Function} [deps.fingerprintFn]
 * @returns {Promise<{ envelope: object, exitCode: number }>}
 */
export async function runAcceptanceEval(
  { storyId, verdict, config, emitSignal, round },
  deps = {},
) {
  const {
    appendSignalFn = appendSignal,
    resolveRoundFn = resolveAcceptanceEvalRound,
    fingerprintFn = computeVerdictFingerprint,
  } = deps;
  const { maxRounds } = getAcceptanceEval(config);
  const verdictFingerprint = fingerprintFn(verdict);
  // An already-scored verdict replays its round and appends nothing.
  const resolved = resolveRoundFn({
    epicId: null,
    storyId,
    config,
    verdictFingerprint,
  });
  const replay = resolved.replay === true;
  const resolvedRound =
    Number.isInteger(round) && round >= 1 ? round : resolved.round;
  const outcome = decideAcceptanceEval({
    verdict,
    maxRounds,
    round: resolvedRound,
  });

  let signalEmitted = false;
  if (emitSignal && !replay) {
    const signal = {
      ...buildAcceptanceEvalSignal({
        storyId,
        epicId: null,
        outcome,
        verdictFingerprint,
      }),
      ts: new Date().toISOString(),
    };
    try {
      signalEmitted = await appendSignalFn({
        epicId: null,
        storyId,
        signal,
        config,
      });
    } catch (err) {
      // Best-effort: a failed signal write never takes down the gate.
      Logger.warn(
        `acceptance-eval: failed to append signal: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  const fullSuiteVerifyCommands = collectFullSuiteVerifyCommands(verdict);

  const envelope = {
    storyId: storyId ?? null,
    epicId: null,
    fullSuiteVerifyCommands,
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
    replay,
    verdictFingerprint,
  };

  const exitCode = outcome.decision === 'block' ? 1 : 0;
  return { envelope, exitCode };
}

/**
 * CLI core: argv → verdict → validation → coverage → decision → envelope.
 *
 * @param {string[]} [argv]
 * @param {{
 *   readFileSyncImpl?: typeof readFileSync,
 *   resolveConfigImpl?: typeof resolveConfig,
 *   validateVerdictImpl?: typeof validateVerdict,
 *   runAcceptanceEvalImpl?: typeof runAcceptanceEval,
 *   readAcceptanceCountImpl?: typeof readStoryAcceptanceCount,
 *   logger?: { info: Function, warn?: Function },
 * }} [deps]
 * @returns {Promise<object>} the emitted envelope.
 */
export async function runAcceptanceEvalCli(
  argv = process.argv.slice(2),
  deps = {},
) {
  const {
    readFileSyncImpl = readFileSync,
    resolveConfigImpl = resolveConfig,
    validateVerdictImpl = validateVerdict,
    runAcceptanceEvalImpl = runAcceptanceEval,
    readAcceptanceCountImpl = readStoryAcceptanceCount,
    logger = Logger,
  } = deps;
  const { storyId, verdictPath, expectedCriteria, emitSignal } =
    parseCliArgs(argv);
  const flagged = resolveExpectedCriteria(expectedCriteria);

  if (!storyId) {
    throw new Error(
      'Usage: node acceptance-eval.js --story <id> --verdict <path> [--expected-criteria <n>] [--no-signal]',
    );
  }
  if (!verdictPath) {
    throw new Error('acceptance-eval: --verdict <path> is required.');
  }

  let raw;
  try {
    raw = readFileSyncImpl(path.resolve(verdictPath), 'utf8');
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

  const verdict = validateVerdictImpl(parsed);

  const config = resolveConfigImpl();
  const expected = await resolveExpectedCriteriaCount({
    storyId,
    config,
    flagged,
    readAcceptanceCountImpl,
    logger,
  });
  assertCriteriaCoverage(verdict, expected);

  if (Number.isInteger(verdict.storyId) && verdict.storyId !== storyId) {
    throw new Error(
      `acceptance-eval: verdict storyId (${verdict.storyId}) does not match --story ${storyId}.`,
    );
  }

  // From the validated verdict, so it fires even with an injected scorer.
  warnOnFullSuiteVerify(verdict, logger);

  const { envelope, exitCode } = await runAcceptanceEvalImpl({
    storyId,
    verdict,
    config,
    emitSignal,
  });

  logger.info(JSON.stringify(envelope));

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

/**
 * @param {string[]} [argv]
 * @returns {Promise<object>}
 */
export async function main(argv = process.argv.slice(2)) {
  return runAcceptanceEvalCli(argv);
}

runAsCli(import.meta.url, main, {
  source: 'acceptance-eval',
  usage: {
    invocation:
      'node .agents/scripts/acceptance-eval.js --story <id> --verdict <path> [--expected-criteria <n>] [--no-signal]',
    summary:
      "Score an authored acceptance verdict against the Story's acceptance[] criteria and emit the bounded loop's proceed / redraft / block decision.",
    flags: [
      ['--story <id>', 'GitHub issue number of the Story (required).'],
      ['--verdict <path>', 'Path to the authored verdict JSON (required).'],
      [
        '--expected-criteria <n>',
        "Optional and redundant since Story #5313: the gate reads the Story's " +
          'acceptance[] count itself and rejects a shorter verdict before ' +
          'scoring. When passed it must agree with that count.',
      ],
      [
        '--no-signal',
        "Skip appending the per-criterion signal to the Story's signals ledger.",
      ],
    ],
    notes: ['Exit codes:\n  0  proceed or redraft\n  1  block'],
  },
});

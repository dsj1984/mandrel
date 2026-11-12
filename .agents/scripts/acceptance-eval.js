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

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { deriveCeremony, resolveDefaultBaseRef } from './ceremony-derive.js';
import { runAsCli } from './lib/cli-utils.js';
import { getDeliveryRouting } from './lib/config/delivery-routing.js';
import { resolvedTempRoot } from './lib/config/temp-paths.js';
import { getAcceptanceEval, resolveConfig } from './lib/config-resolver.js';
import { gitSpawn } from './lib/git-utils.js';
import { Logger } from './lib/Logger.js';
import { appendSignal } from './lib/observability/signals-writer.js';
import {
  buildAcceptanceEvalSignal,
  computeVerdictFingerprint,
  decideAcceptanceEval,
  resolveAcceptanceEvalRound,
  scoreVerifyRuns,
} from './lib/orchestration/acceptance-eval-decision.js';
import {
  classifyVerifyEntries,
  FULL_SUITE_SHAPE_WARNING,
  isFullSuiteCommand,
  normalizeVerifyCommand,
  runScopedVerifyEntry,
} from './lib/orchestration/verify-credit.js';
import { createProvider } from './lib/provider-factory.js';
import { parse as parseStoryBody } from './lib/story-body/story-body.js';
import { createAjv2020 } from './lib/util/ajv.js';

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
  const ajv = createAjv2020({ allErrors: true, strict: false });
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
      init: { type: 'boolean', default: false },
      cwd: { type: 'string' },
    },
    strict: false,
  });
  const storyId = Number.parseInt(values.story ?? '', 10);
  return {
    storyId: Number.isInteger(storyId) && storyId > 0 ? storyId : null,
    init: values.init === true,
    cwd: values.cwd ?? null,
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
 * One parsed Story body list (`acceptance`, `verify`); `null` when the body
 * cannot be read, `[]` when the list is absent.
 *
 * @param {'acceptance'|'verify'} field
 * @param {{ storyId: number, config: object }} args
 * @param {{ createProviderFn?: typeof createProvider, parseBodyFn?: typeof parseStoryBody }} [deps]
 * @returns {Promise<string[]|null>}
 */
async function readStoryBodyList(
  field,
  { storyId, config },
  { createProviderFn = createProvider, parseBodyFn = parseStoryBody } = {},
) {
  try {
    const ticket = await createProviderFn(config).getTicket(storyId);
    if (typeof ticket?.body !== 'string') return null;
    const list = parseBodyFn(ticket.body)?.body?.[field];
    return Array.isArray(list) ? list : [];
  } catch {
    return null;
  }
}

/**
 * The Story body's `acceptance[]` items, in order; any failure yields `null`.
 *
 * @param {{ storyId: number, config: object }} args
 * @param {Parameters<typeof readStoryBodyList>[2]} [deps]
 * @returns {Promise<string[]|null>}
 */
export async function readStoryAcceptance(args, deps) {
  const acceptance = await readStoryBodyList('acceptance', args, deps);
  return acceptance?.length > 0 ? acceptance : null;
}

/**
 * The Story body's `verify[]` entries; `null` when the body is unreadable.
 *
 * @param {{ storyId: number, config: object }} args
 * @param {Parameters<typeof readStoryBodyList>[2]} [deps]
 * @returns {Promise<string[]|null>}
 */
export function readStoryVerify(args, deps) {
  return readStoryBodyList('verify', args, deps);
}

/**
 * The Story body's `acceptance[]` count; any failure yields `null`, never a
 * manufactured count.
 *
 * @param {{ storyId: number, config: object }} args
 * @param {Parameters<typeof readStoryAcceptance>[1]} [deps]
 * @returns {Promise<number|null>}
 */
export async function readStoryAcceptanceCount(args, deps) {
  const acceptance = await readStoryAcceptance(args, deps);
  return acceptance ? acceptance.length : null;
}

/**
 * The `--init` skeleton: one record per `acceptance[]` item, in order, with
 * `index` and `criterion` filled and `verdict` / `evidence` left empty for
 * the verdict owner. Deliberately schema-invalid until filled.
 *
 * @param {{ storyId: number, acceptance: string[], round: number, commitSha: string|null }} args
 * @returns {object}
 */
export function buildVerdictSkeleton({
  storyId,
  acceptance,
  round,
  commitSha,
}) {
  return {
    storyId,
    schemaVersion: 1,
    round,
    commitSha,
    criteria: acceptance.map((criterion, index) => ({
      index,
      criterion,
      verdict: '',
      evidence: '',
    })),
  };
}

/**
 * Indices of records still carrying the skeleton's empty `verdict` or
 * `evidence`.
 *
 * @param {unknown} verdict
 * @returns {number[]}
 */
export function findUnfilledCriteria(verdict) {
  const criteria = Array.isArray(verdict?.criteria) ? verdict.criteria : [];
  const blank = (v) => typeof v !== 'string' || v.trim().length === 0;
  return criteria
    .map((c, i) =>
      blank(c?.verdict) || blank(c?.evidence) ? (c?.index ?? i) : null,
    )
    .filter((i) => i !== null);
}

/**
 * Refuse a verdict with unfilled records before schema validation or
 * scoring, so the mistake costs no round.
 *
 * @param {unknown} verdict
 * @returns {void}
 */
export function assertVerdictFilled(verdict) {
  const unfilled = findUnfilledCriteria(verdict);
  if (unfilled.length === 0) return;
  throw new Error(
    `acceptance-eval: verdict record(s) at index ${unfilled.join(', ')} are unfilled — ` +
      'every record needs a verdict (met|partial|unmet) and evidence before scoring. No round was consumed.',
  );
}

/** @param {string} cwd @returns {string|null} */
function readHeadSha(cwd) {
  const res = gitSpawn(cwd, 'rev-parse', 'HEAD');
  const sha = res.status === 0 ? `${res.stdout ?? ''}`.trim() : '';
  return /^[0-9a-f]{7,64}$/.test(sha) ? sha : null;
}

/**
 * `--init`: derive the change set and verdict owner with ceremony-derive's
 * own function, write the skeleton under `<tempRoot>/scratch/story-<id>/`,
 * and return what the owner needs to fill it.
 *
 * @param {{ storyId: number, cwd: string, config: object }} input
 * @param {{
 *   readAcceptanceImpl?: typeof readStoryAcceptance,
 *   deriveCeremonyImpl?: typeof deriveCeremony,
 *   resolveRoundImpl?: typeof resolveAcceptanceEvalRound,
 *   readHeadImpl?: typeof readHeadSha,
 *   writeFileImpl?: (file: string, text: string) => void,
 * }} [deps]
 * @returns {Promise<{ verdictPath: string, files: string[]|null, verdictOwner: string, round: number, criteria: number }>}
 */
export async function initVerdictSkeleton({ storyId, cwd, config }, deps = {}) {
  const {
    readAcceptanceImpl = readStoryAcceptance,
    deriveCeremonyImpl = deriveCeremony,
    resolveRoundImpl = resolveAcceptanceEvalRound,
    readHeadImpl = readHeadSha,
    writeFileImpl = (file, text) => {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text, 'utf8');
    },
  } = deps;
  const acceptance = await readAcceptanceImpl({ storyId, config });
  if (!acceptance) {
    throw new Error(
      `acceptance-eval --init: Story #${storyId}'s acceptance[] could not be read — no skeleton written.`,
    );
  }
  const ceremony = deriveCeremonyImpl({
    storyId,
    baseRef: resolveDefaultBaseRef({ config, cwd }),
    cwd,
    ceremonyProfile: getDeliveryRouting(config).ceremonyProfile,
  });
  const { round } = resolveRoundImpl({ epicId: null, storyId, config });
  const skeleton = buildVerdictSkeleton({
    storyId,
    acceptance,
    round,
    commitSha: readHeadImpl(cwd),
  });
  const verdictPath = path.join(
    resolvedTempRoot(config),
    'scratch',
    `story-${storyId}`,
    `acceptance-verdict-round-${round}.json`,
  );
  writeFileImpl(verdictPath, `${JSON.stringify(skeleton, null, 2)}\n`);
  return {
    verdictPath,
    files: ceremony.files,
    verdictOwner: ceremony.verdictOwner,
    round,
    criteria: acceptance.length,
  };
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
 * Reject, before scoring and consuming no round, a verdict that leaves a
 * required Story `verify[]` entry uncited, or a `met` criterion standing on
 * non-pass evidence without a `waiver`.
 *
 * @param {object} verdict — schema-validated verdict.
 * @param {string[]} required — normalised entries from `classifyVerifyEntries`.
 * @returns {void}
 */
export function assertVerifyEvidence(verdict, required) {
  const criteria = verdict?.criteria ?? [];
  const cited = new Set(
    criteria.flatMap((c) =>
      (c?.verifyEvidence ?? []).map((e) => normalizeVerifyCommand(e?.command)),
    ),
  );
  const uncited = required.filter((command) => !cited.has(command));
  const unwaived = criteria
    .filter(
      (c) =>
        c?.verdict === 'met' &&
        (c.verifyEvidence ?? []).some((e) => e.outcome !== 'pass' && !e.waiver),
    )
    .map((c) => c.index);
  const problems = [
    ...(uncited.length > 0
      ? [
          `verify[] entr(ies) no criterion's verifyEvidence cites: ${uncited.map((c) => `\`${c}\``).join(', ')}`,
        ]
      : []),
    ...(unwaived.length > 0
      ? [
          `met criteria at index ${unwaived.join(', ')} carry non-pass verifyEvidence with no waiver`,
        ]
      : []),
  ];
  if (problems.length === 0) return;
  throw new Error(
    `acceptance-eval: ${problems.join('; ')}. No round was consumed.`,
  );
}

/**
 * A Story with scoped entries is scored only with the worktree to run them in.
 *
 * @param {string[]} scoped
 * @param {string|null} cwd
 * @returns {void}
 */
export function assertScoringCwd(scoped, cwd) {
  if (scoped.length === 0 || cwd) return;
  throw new Error(
    `Usage: acceptance-eval: the Story has ${scoped.length} scoped verify[] entr(ies) the gate must run — pass --cwd <workCwd>. No round was consumed.`,
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
 * @param {Array<object>} [args.verifyRuns] — the gate's own scoped runs.
 * @param {string|null} [args.headSha] — HEAD of `--cwd`.
 * @param {object} [deps]
 * @param {Function} [deps.appendSignalFn]
 * @param {Function} [deps.resolveRoundFn]
 * @param {Function} [deps.fingerprintFn]
 * @returns {Promise<{ envelope: object, exitCode: number }>}
 */
export async function runAcceptanceEval(
  { storyId, verdict, config, emitSignal, round, verifyRuns = [], headSha },
  deps = {},
) {
  const {
    appendSignalFn = appendSignal,
    resolveRoundFn = resolveAcceptanceEvalRound,
    fingerprintFn = computeVerdictFingerprint,
  } = deps;
  const { maxRounds } = getAcceptanceEval(config);
  const verdictFingerprint = fingerprintFn(verdict, { verifyRuns, headSha });
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
    verifyRuns,
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
    verifyRuns: scoreVerifyRuns(verdict, verifyRuns).verifyRuns,
    signalEmitted,
    replay,
    verdictFingerprint,
  };

  const exitCode = outcome.decision === 'block' ? 1 : 0;
  return { envelope, exitCode };
}

/**
 * Read the Story's `verify[]`, refuse a mis-evidenced verdict, then run the
 * scoped entries. An unreadable body skips the gate with a warning, as the
 * criteria count does.
 *
 * @returns {Promise<{ verifyRuns: object[], headSha: string|null }>}
 */
async function resolveVerifyGate({
  storyId,
  config,
  cwd,
  verdict,
  readVerifyImpl,
  readHeadImpl,
  logger,
  deps,
}) {
  const entries = await readVerifyImpl({ storyId, config });
  if (entries === null) {
    logger.warn?.(
      '[acceptance-eval] ⚠ the Story verify[] could not be read — the verify evidence check and gate runs are skipped for this round.',
    );
    return { verifyRuns: [], headSha: null };
  }
  const { required, scoped } = classifyVerifyEntries(entries);
  const workCwd = cwd ? path.resolve(cwd) : null;
  assertScoringCwd(scoped, workCwd);
  assertVerifyEvidence(verdict, required);
  const runEntry = deps.runEntryImpl ?? runScopedVerifyEntry;
  return {
    verifyRuns: scoped.map((command) => runEntry(command, { cwd: workCwd })),
    headSha: workCwd ? readHeadImpl(workCwd) : null,
  };
}

/** @param {number|null} storyId */
function requireStoryId(storyId) {
  if (storyId) return;
  throw new Error(
    'Usage: node acceptance-eval.js --story <id> --verdict <path> --cwd <workCwd> [--expected-criteria <n>] [--no-signal]',
  );
}

/**
 * `--init`: write the skeleton and print its summary; scores nothing.
 *
 * @param {{ storyId: number, cwd: string|null, resolveConfigImpl: typeof resolveConfig, logger: { info: Function }, deps: { initSkeletonImpl?: typeof initVerdictSkeleton } }} args
 * @returns {Promise<object>}
 */
async function runInitCli({ storyId, cwd, resolveConfigImpl, logger, deps }) {
  const workCwd = path.resolve(cwd ?? process.cwd());
  const skeleton = await (deps.initSkeletonImpl ?? initVerdictSkeleton)({
    storyId,
    cwd: workCwd,
    config: resolveConfigImpl({ cwd: workCwd }),
  });
  logger.info(JSON.stringify(skeleton));
  return skeleton;
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
 *   readVerifyImpl?: typeof readStoryVerify,
 *   runEntryImpl?: typeof runScopedVerifyEntry,
 *   readHeadImpl?: typeof readHeadSha,
 *   initSkeletonImpl?: typeof initVerdictSkeleton,
 *   logger?: { info: Function, warn?: Function },
 * }} [deps]
 * @returns {Promise<object>} the emitted envelope (the skeleton summary under `--init`).
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
    readVerifyImpl = readStoryVerify,
    readHeadImpl = readHeadSha,
    logger = Logger,
  } = deps;
  const { storyId, init, cwd, verdictPath, expectedCriteria, emitSignal } =
    parseCliArgs(argv);
  const flagged = resolveExpectedCriteria(expectedCriteria);

  requireStoryId(storyId);
  if (init)
    return runInitCli({ storyId, cwd, resolveConfigImpl, logger, deps });
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

  assertVerdictFilled(parsed);
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

  const gate = await resolveVerifyGate({
    storyId,
    config,
    cwd,
    verdict,
    readVerifyImpl,
    readHeadImpl,
    logger,
    deps,
  });
  const { envelope, exitCode } = await runAcceptanceEvalImpl({
    storyId,
    verdict,
    config,
    emitSignal,
    ...gate,
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
      'node .agents/scripts/acceptance-eval.js --story <id> (--init [--cwd <workCwd>] | --verdict <path> --cwd <workCwd> [--expected-criteria <n>] [--no-signal])',
    summary:
      "Score an authored acceptance verdict against the Story's acceptance[] criteria and emit the bounded loop's proceed / redraft / block decision; --init writes the verdict skeleton to fill first.",
    flags: [
      ['--story <id>', 'GitHub issue number of the Story (required).'],
      [
        '--init',
        'Write the verdict skeleton (one empty record per acceptance[] item, the next round, HEAD) under <tempRoot>/scratch/story-<id>/ and print its path, the derived change set `files` and the `verdictOwner`. Scoring a skeleton with an unfilled record is refused without consuming a round.',
      ],
      [
        '--cwd <workCwd>',
        'Worktree the --init change set is derived in, and the one the scoring call runs each scoped Story verify[] entry in (required when the Story has any). A criterion citing a failing run is scored unmet unless its verifyEvidence item carries a `waiver`.',
      ],
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

/**
 * Acceptance-eval decision core: verdict + cap → `proceed`, `redraft`, or
 * `block` (unmet at cap; never a silent close). The round comes from the
 * signals ledger, never the critic's own `round`, so a critic cannot defeat
 * the cap; re-scoring an identical verdict replays its round.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { runArtifactPath, signalsFile } from '../config/temp-paths.js';

const EPIC_SIGNALS_BASENAME = 'signals.ndjson';

/** @type {ReadonlySet<string>} */
const MET_VERDICTS = Object.freeze(new Set(['met']));

/**
 * Integer ≥ 1 — the last guard against an unbounded redraft loop.
 *
 * @param {unknown} value
 * @returns {number}
 */
function effectiveCap(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    return 1;
  }
  return value;
}

/**
 * @param {Array<{ index?: number, criterion?: string, verdict?: string, evidence?: string }>} criteria
 * @returns {{
 *   metCount: number,
 *   notMet: Array<{ index: number, criterion: string, verdict: string, evidence: string }>,
 * }}
 */
function partitionCriteria(criteria) {
  const list = Array.isArray(criteria) ? criteria : [];
  const notMet = [];
  let metCount = 0;
  list.forEach((c, i) => {
    const verdict = typeof c?.verdict === 'string' ? c.verdict : 'unmet';
    if (MET_VERDICTS.has(verdict)) {
      metCount += 1;
      return;
    }
    notMet.push({
      index: Number.isInteger(c?.index) ? c.index : i,
      criterion: typeof c?.criterion === 'string' ? c.criterion : '',
      verdict,
      evidence: typeof c?.evidence === 'string' ? c.evidence : '',
    });
  });
  return { metCount, notMet };
}

/**
 * @param {object} args
 * @param {{ criteria?: Array<object> }} args.verdict Its own `round` is ignored.
 * @param {number} args.maxRounds
 * @param {number} [args.round] From `resolveAcceptanceEvalRound`.
 * @returns {{
 *   decision: 'proceed' | 'redraft' | 'block',
 *   round: number,
 *   cap: number,
 *   totalCriteria: number,
 *   metCount: number,
 *   notMet: Array<{ index: number, criterion: string, verdict: string, evidence: string }>,
 *   capReached: boolean,
 * }}
 */
export function decideAcceptanceEval({ verdict, maxRounds, round: roundIn }) {
  const cap = effectiveCap(maxRounds);
  const round = Number.isInteger(roundIn) && roundIn >= 1 ? roundIn : 1;
  const { metCount, notMet } = partitionCriteria(verdict?.criteria);
  const totalCriteria = metCount + notMet.length;
  const allMet = notMet.length === 0;
  const capReached = round >= cap;

  let decision;
  if (allMet) {
    decision = 'proceed';
  } else if (capReached) {
    decision = 'block';
  } else {
    decision = 'redraft';
  }

  return {
    decision,
    round,
    cap,
    totalCriteria,
    metCount,
    notMet,
    capReached,
  };
}

/**
 * PII-free by construction: indices, verdicts and the decision only.
 *
 * @param {object} args
 * @param {number} args.storyId
 * @param {number | null} args.epicId
 * @param {ReturnType<typeof decideAcceptanceEval>} args.outcome
 * @param {string} [args.phase]
 * @returns {object} The record without `ts` (the caller stamps it).
 */
export function buildAcceptanceEvalSignal({
  storyId,
  epicId,
  outcome,
  phase = 'implement',
  clusterId = null,
  verdictFingerprint = null,
}) {
  return {
    kind: 'acceptance-eval',
    epicId: epicId ?? null,
    storyId: storyId ?? null,
    ...(typeof clusterId === 'string' && clusterId.length > 0
      ? { clusterId }
      : {}),
    phase,
    emitter: { tool: 'acceptance-eval.js' },
    details: {
      ...(typeof verdictFingerprint === 'string' &&
      verdictFingerprint.length > 0
        ? { verdictFingerprint }
        : {}),
      decision: outcome.decision,
      round: outcome.round,
      cap: outcome.cap,
      totalCriteria: outcome.totalCriteria,
      metCount: outcome.metCount,
      reworkedCount: outcome.notMet.length,
      reworkedCriteria: outcome.notMet.map((c) => ({
        index: c.index,
        verdict: c.verdict,
      })),
    },
  };
}

/**
 * Prior rounds' records, oldest first. A missing ledger or malformed line
 * never wedges the gate. `clusterId` counts per AC cluster on the epic-level
 * stream.
 *
 * @param {object} args
 * @param {number|null} args.epicId
 * @param {number} args.storyId
 * @param {string|null} [args.clusterId]
 * @param {object} [args.config]
 * @param {(p: string) => string} [args.readFile]
 * @param {(eid: number|null, sid: number, config?: object) => string} [args.signalsPathResolver]
 * @param {(eid: number, config?: object) => string} [args.epicSignalsPathResolver]
 * @returns {object[]}
 */
function readPriorAcceptanceEvalRecords({
  epicId,
  storyId,
  clusterId = null,
  config,
  readFile = (p) => readFileSync(p, 'utf8'),
  signalsPathResolver = signalsFile,
  epicSignalsPathResolver = (eid, cfg) =>
    runArtifactPath(eid, EPIC_SIGNALS_BASENAME, cfg),
}) {
  const clusterMode =
    typeof clusterId === 'string' &&
    clusterId.length > 0 &&
    Number.isInteger(epicId);

  let text;
  try {
    text = clusterMode
      ? readFile(epicSignalsPathResolver(epicId, config))
      : readFile(signalsPathResolver(epicId ?? null, storyId, config));
  } catch (_err) {
    return [];
  }

  const records = [];
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let record;
    try {
      record = JSON.parse(trimmed);
    } catch (_err) {
      continue;
    }
    if (!record || typeof record !== 'object') continue;
    if (record.kind !== 'acceptance-eval') continue;
    if (clusterMode) {
      if (record.clusterId !== clusterId) continue;
    } else if (record.storyId !== storyId) {
      continue;
    }
    records.push(record);
  }
  return records;
}

/**
 * Hashes only what the decision depends on, so an unchanged evaluation
 * fingerprints the same and real rework does not.
 *
 * @param {{ criteria?: Array<object> }} verdict
 * @returns {string}
 */
export function computeVerdictFingerprint(verdict) {
  const criteria = Array.isArray(verdict?.criteria) ? verdict.criteria : [];
  const canonical = criteria.map((c) => [
    Number.isInteger(c?.index) ? c.index : null,
    typeof c?.criterion === 'string' ? c.criterion : '',
    typeof c?.verdict === 'string' ? c.verdict : '',
    typeof c?.evidence === 'string' ? c.evidence : '',
  ]);
  return createHash('sha256')
    .update(JSON.stringify(canonical))
    .digest('hex')
    .slice(0, 16);
}

/**
 * A matching recorded fingerprint is a replay of that round (the caller must
 * not append); otherwise `prior count + 1`.
 *
 * @param {object} args — {@link readPriorAcceptanceEvalRecords}'s args, plus:
 * @param {string} args.verdictFingerprint
 * @returns {{ round: number, replay: boolean }}
 */
export function resolveAcceptanceEvalRound(args) {
  const { verdictFingerprint } = args;
  const records = readPriorAcceptanceEvalRecords(args);
  const priorIndex =
    typeof verdictFingerprint === 'string' && verdictFingerprint.length > 0
      ? records.findIndex(
          (r) => r?.details?.verdictFingerprint === verdictFingerprint,
        )
      : -1;
  if (priorIndex === -1) {
    return { round: records.length + 1, replay: false };
  }
  const recorded = records[priorIndex]?.details?.round;
  return {
    round:
      Number.isInteger(recorded) && recorded >= 1 ? recorded : priorIndex + 1,
    replay: true,
  };
}

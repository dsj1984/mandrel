/**
 * The per-Story outcome record: one `story-outcome` structured comment on
 * the Story issue, upserted on every close and confirm-merge terminal when
 * `delivery.feedbackLoop.outcomeRecord` is on. Best-effort: a failure logs
 * one warning and never touches the envelope, result or exit code.
 *
 * @module lib/observability/story-outcome
 */

import fs from 'node:fs';
import path from 'node:path';

import { resolveConfig } from '../config-resolver.js';
import { Logger } from '../Logger.js';
import { findStructuredComment } from '../orchestration/ticketing/reads.js';
import { upsertStructuredComment } from '../orchestration/ticketing/state.js';
import { PROJECT_ROOT } from '../project-root.js';
import { createProvider } from '../provider-factory.js';
import {
  emitCloseTerminalSignals,
  retryCauseForTerminal,
  tallyStoryTelemetry,
} from './close-telemetry.js';
import {
  emitTerminalFriction,
  RUNTIME_FRICTION_CATEGORIES,
} from './runtime-friction.js';
import { forEachLine } from './signals-writer.js';

export const OUTCOME_COMMENT_TYPE = 'story-outcome';
const OUTCOME_SCHEMA_VERSION = 1;
const MAX_ATTEMPTS = 100;
const STATUSES = Object.freeze(['landed', 'pending', 'blocked', 'failed']);
/** Results that found the Story already closed or done: nothing happened. */
const NOOP_REASONS = new Set([
  'already-closed',
  'closed-not-planned',
  'already-done',
]);
const JSON_BLOCK = /```json\n([\s\S]*?)\n```/;

/** @param {object|null|undefined} config */
function outcomeRecordEnabled(config) {
  return config?.delivery?.feedbackLoop?.outcomeRecord === true;
}

function readJsonOrNull(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * @param {string} [root]
 * @returns {string|null}
 */
function resolveMandrelVersion(root = PROJECT_ROOT) {
  const own = readJsonOrNull(path.join(root, 'package.json'));
  const pkg =
    own?.name === 'mandrel'
      ? own
      : readJsonOrNull(
          path.join(root, 'node_modules', 'mandrel', 'package.json'),
        );
  return typeof pkg?.version === 'string' ? pkg.version : null;
}

/** @param {Record<string, string>|null|undefined} gates */
function failedGateNames(gates) {
  return Object.entries(gates ?? {})
    .filter(([, outcome]) => outcome === 'failed')
    .map(([name]) => name)
    .sort();
}

function intOrNull(value) {
  return Number.isInteger(value) ? value : null;
}

function nonNegInt(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

/** Friction from this invocation only, so a re-close never re-counts. */
function windowedReviewCounts(rows, sinceMs) {
  const counts = { reviewHalts: 0, reviewOverrides: 0 };
  for (const row of rows) {
    if (row?.kind !== 'friction' || row.details?.recovered === true) continue;
    if (!(Date.parse(row.ts) >= sinceMs)) continue;
    if (row.category === RUNTIME_FRICTION_CATEGORIES.REVIEW_BLOCKED) {
      counts.reviewHalts += 1;
    } else if (
      row.category === RUNTIME_FRICTION_CATEGORIES.REVIEW_BLOCK_OVERRIDDEN
    ) {
      counts.reviewOverrides += 1;
    }
  }
  return counts;
}

/**
 * @param {{ envelope: object, tool: string, worker?: object, rows?: object[],
 *   nowMs?: number, mandrelVersion?: string|null }} args
 * @returns {object}
 */
function buildAttempt({
  envelope,
  tool,
  worker = {},
  rows = [],
  nowMs = Date.now(),
  mandrelVersion = null,
}) {
  const elapsedMs = nonNegInt(envelope.elapsedSeconds) * 1000;
  return {
    ts: new Date(nowMs).toISOString(),
    tool,
    status: envelope.status,
    phase: envelope.phase ?? null,
    cause: retryCauseForTerminal(envelope),
    blockClass: envelope.blocked?.blockClass ?? null,
    failedGates: failedGateNames(envelope.gates),
    prNumber: intOrNull(envelope.pr?.number),
    mandrelVersion,
    workerModel: worker.workerModel ?? null,
    workerEffort: worker.workerEffort ?? null,
    workerTokens: intOrNull(worker.workerTokens),
    ...windowedReviewCounts(rows, nowMs - elapsedMs),
  };
}

function countMap(raw) {
  const out = {};
  for (const [key, count] of Object.entries(raw ?? {})) {
    if (Number.isInteger(count) && count > 0) out[key] = count;
  }
  return out;
}

/** Coerces a prior (possibly foreign or hand-edited) summary to the contract. */
function normalizeSummary(raw = {}) {
  const byStatus = {};
  for (const status of STATUSES)
    byStatus[status] = nonNegInt(raw.byStatus?.[status]);
  return {
    attempts: nonNegInt(raw.attempts),
    byStatus,
    failedGates: countMap(raw.failedGates),
    acceptanceRounds: nonNegInt(raw.acceptanceRounds),
    mandrelVersions: Array.isArray(raw.mandrelVersions)
      ? raw.mandrelVersions.filter((v) => typeof v === 'string')
      : [],
    landedAt: typeof raw.landedAt === 'string' ? raw.landedAt : null,
    landedOnAttempt: intOrNull(raw.landedOnAttempt),
  };
}

/**
 * Counters carry forward from `prior`, so trimming old attempts never lowers
 * a count; `acceptanceRounds` is max-shaped.
 *
 * @param {object|null} prior
 * @param {object} attempt
 * @param {{ storyId: number, acceptanceRounds?: number }} ctx
 * @returns {object}
 */
function mergeOutcomeRecord(prior, attempt, { storyId, acceptanceRounds = 0 }) {
  const base = normalizeSummary(prior?.summary);
  const attempts = base.attempts + 1;
  const landedNow = attempt.status === 'landed' && base.landedAt === null;
  const failedGates = { ...base.failedGates };
  for (const gate of attempt.failedGates)
    failedGates[gate] = (failedGates[gate] ?? 0) + 1;
  const summary = {
    attempts,
    byStatus: {
      ...base.byStatus,
      [attempt.status]: base.byStatus[attempt.status] + 1,
    },
    failedGates,
    acceptanceRounds: Math.max(
      base.acceptanceRounds,
      nonNegInt(acceptanceRounds),
    ),
    mandrelVersions: [
      ...new Set(
        [...base.mandrelVersions, attempt.mandrelVersion].filter(Boolean),
      ),
    ],
    landedAt: landedNow ? attempt.ts : base.landedAt,
    landedOnAttempt: landedNow ? attempts : base.landedOnAttempt,
  };
  summary.firstPass =
    summary.landedAt !== null &&
    summary.byStatus.blocked === 0 &&
    summary.byStatus.failed === 0;
  const priorAttempts = Array.isArray(prior?.attempts) ? prior.attempts : [];
  return {
    schemaVersion: OUTCOME_SCHEMA_VERSION,
    storyId,
    attempts: [...priorAttempts, attempt].slice(-MAX_ATTEMPTS),
    summary,
  };
}

/** @param {object} record */
function renderOutcomeBody(record) {
  const { summary } = record;
  const last = record.attempts.at(-1);
  const gates = last?.failedGates?.length
    ? last.failedGates.join(', ')
    : 'none';
  return [
    `**Story outcome** · attempts: ${summary.attempts} · status: ${last?.status ?? 'unknown'} · last failed gates: ${gates}`,
    '',
    '```json',
    JSON.stringify(record, null, 2),
    '```',
  ].join('\n');
}

/**
 * @param {string} body
 * @returns {object|null} the record, or null when the JSON block is unusable.
 */
export function parseOutcomeBody(body) {
  const match = JSON_BLOCK.exec(String(body ?? ''));
  if (!match) return null;
  try {
    const record = JSON.parse(match[1]);
    const usable =
      record?.schemaVersion === OUTCOME_SCHEMA_VERSION &&
      Array.isArray(record.attempts) &&
      record.summary !== null &&
      typeof record.summary === 'object';
    return usable ? record : null;
  } catch {
    return null;
  }
}

function shouldRecord(envelope, result) {
  const storyId = envelope?.storyId;
  return (
    Number.isInteger(storyId) &&
    storyId > 0 &&
    STATUSES.includes(envelope.status) &&
    !NOOP_REASONS.has(result?.reason)
  );
}

async function readLocalRows(storyId, config, readFn) {
  const rows = [];
  try {
    await readFn(null, storyId, (parsed) => rows.push(parsed), config);
  } catch {
    // A missing local stream is the cross-machine case, not an error.
  }
  return rows;
}

async function writeRecord({
  envelope,
  config,
  provider,
  tool,
  worker,
  readFn,
  mandrelVersion,
}) {
  const storyId = envelope.storyId;
  const prior = await findStructuredComment(
    provider,
    storyId,
    OUTCOME_COMMENT_TYPE,
  );
  const priorRecord = prior ? parseOutcomeBody(prior.body) : null;
  if (prior && !priorRecord) {
    Logger.warn(
      `[story-outcome] Story #${storyId}: prior outcome record did not parse; replaced with a fresh record.`,
    );
  }
  if (envelope.status === 'landed' && priorRecord?.summary?.landedAt)
    return false;
  const rows = await readLocalRows(storyId, config, readFn);
  const attempt = buildAttempt({
    envelope,
    tool,
    worker,
    rows,
    mandrelVersion,
  });
  const record = mergeOutcomeRecord(priorRecord, attempt, {
    storyId,
    acceptanceRounds: tallyStoryTelemetry(rows).acceptanceRounds,
  });
  await upsertStructuredComment(
    provider,
    storyId,
    OUTCOME_COMMENT_TYPE,
    renderOutcomeBody(record),
  );
  return true;
}

/**
 * Call after the envelope is emitted. Never throws.
 *
 * @param {{ envelope: object, result?: object|null, config?: object,
 *   cwd?: string, tool: string, worker?: object, provider?: object,
 *   providerFactory?: typeof createProvider,
 *   resolveConfigImpl?: typeof resolveConfig, readFn?: typeof forEachLine,
 *   mandrelVersion?: string|null }} args
 * @returns {Promise<boolean>} true when a record was written.
 */
export async function recordStoryOutcome({
  envelope,
  result = null,
  config,
  cwd,
  tool,
  worker,
  provider,
  providerFactory = createProvider,
  resolveConfigImpl = resolveConfig,
  readFn = forEachLine,
  mandrelVersion,
}) {
  try {
    if (!shouldRecord(envelope, result)) return false;
    const root = cwd || undefined;
    const resolved = config ?? resolveConfigImpl({ cwd: root });
    if (!outcomeRecordEnabled(resolved)) return false;
    return await writeRecord({
      envelope,
      config: resolved,
      provider: provider ?? providerFactory(resolved),
      tool,
      worker,
      readFn,
      mandrelVersion:
        mandrelVersion === undefined
          ? resolveMandrelVersion(root)
          : mandrelVersion,
    });
  } catch (err) {
    Logger.warn(
      `[story-outcome] Story #${envelope?.storyId}: outcome record not written: ${err?.message ?? err}`,
    );
    return false;
  }
}

const CLOSE_TOOL = 'single-story-close';

/**
 * The tail of the close terminal writer, after the envelope is out.
 *
 * @param {{ terminal: object, result?: object|null, config?: object,
 *   worker?: object, provider?: object }} args
 */
export async function finishCloseTerminal({ terminal, ...rest }) {
  await emitTerminalFriction({ envelope: terminal, config: rest.config });
  await recordStoryOutcome({ envelope: terminal, tool: CLOSE_TOOL, ...rest });
}

/** The close CLI crash catch: no config in scope, so it is resolved here. */
export async function emitCloseCrashSignals(envelope) {
  await emitCloseTerminalSignals({ envelope });
  await recordStoryOutcome({ envelope, tool: CLOSE_TOOL });
}

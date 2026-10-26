/**
 * review-history.js — every Story-scope review run of a Story and the
 * CRITICAL ids an operator overrode, beside the held-review deposit. A re-review
 * reads it to mark a finding it already raised as a repeat; the Story temp
 * purge reaps it with the deposit.
 *
 * @typedef {import('./review-providers/types.js').Finding} Finding
 * @typedef {{ id: string, severity: string, provider: string|null,
 *   class: string|null, instances: { file: string, line?: number }[],
 *   ungrounded?: string, unverified?: string }} HistoryFinding
 * @typedef {{ runs: { headSha: string, findings: HistoryFinding[] }[],
 *   overridden: string[], overrideReason?: string }} ReviewHistory
 */

import nodeFs from 'node:fs';
import path from 'node:path';

import { storyReviewDepositPath } from '../config/temp-paths.js';
import { redactErrorMessage } from '../error-redactor.js';
import { writeFileAtomic } from '../util/atomic-write.js';
import {
  findingId,
  findingInstances,
} from './review-providers/finding-identity.js';

const KIND = 'story-review-history';
/** An instance this many lines from an earlier one is the same location. */
const LINE_WINDOW = 10;
/** Same bound as the `review-block-overridden` friction signal. */
const OVERRIDE_REASON_LIMIT = 500;

/**
 * @param {number} storyId
 * @param {object} [config]
 * @returns {string}
 */
function historyPath(storyId, config) {
  return path.join(
    path.dirname(storyReviewDepositPath(storyId, config)),
    `story-review-history-${storyId}.json`,
  );
}

/** @param {string} reason */
const redactReason = (reason) =>
  redactErrorMessage(reason.slice(0, OVERRIDE_REASON_LIMIT));

/** @param {unknown} reason @param {(r: string) => string} [map] */
const reasonField = (reason, map = (r) => r) =>
  typeof reason === 'string' ? { overrideReason: map(reason) } : {};

/**
 * @param {number} storyId
 * @param {{ config?: object, fsImpl?: typeof nodeFs }} [deps]
 * @returns {ReviewHistory} empty when absent or malformed.
 */
export function readReviewHistory(storyId, { config, fsImpl = nodeFs } = {}) {
  try {
    const record = JSON.parse(
      fsImpl.readFileSync(historyPath(storyId, config), 'utf8'),
    );
    if (record?.kind === KIND && Array.isArray(record.runs)) {
      return {
        runs: record.runs,
        overridden: Array.isArray(record.overridden) ? record.overridden : [],
        ...reasonField(record.overrideReason),
      };
    }
  } catch {
    // Absent or unreadable: no earlier runs.
  }
  return { runs: [], overridden: [] };
}

/**
 * @param {number} storyId
 * @param {(history: ReviewHistory) => ReviewHistory} update
 * @param {{ config?: object, fsImpl?: typeof nodeFs }} [deps]
 */
function updateReviewHistory(storyId, update, deps = {}) {
  const next = update(readReviewHistory(storyId, deps));
  writeFileAtomic(
    historyPath(storyId, deps.config),
    `${JSON.stringify({ kind: KIND, storyId, ...next }, null, 2)}\n`,
    { fsImpl: deps.fsImpl ?? nodeFs },
  );
}

/** @param {Finding} f @returns {HistoryFinding} */
function toHistoryFinding(f) {
  return {
    id: findingId(f),
    severity: f.severity,
    provider: f.provider ?? null,
    class: f.class ?? null,
    instances: findingInstances(f),
    ...(f.ungrounded ? { ungrounded: f.ungrounded } : {}),
    ...(f.unverified ? { unverified: f.unverified } : {}),
  };
}

/**
 * @param {number} storyId
 * @param {{ headSha: string, findings: Finding[] }} run
 * @param {{ config?: object, fsImpl?: typeof nodeFs }} [deps]
 */
export function appendReviewRun(storyId, { headSha, findings }, deps) {
  updateReviewHistory(
    storyId,
    (h) => ({
      ...h,
      runs: [...h.runs, { headSha, findings: findings.map(toHistoryFinding) }],
    }),
    deps,
  );
}

/**
 * @param {number} storyId
 * @param {string[]} ids - the overridden CRITICALs.
 * @param {{ config?: object, fsImpl?: typeof nodeFs, reason?: string }} [deps]
 *   `reason` is stored redacted and clipped.
 */
export function recordOverriddenIds(storyId, ids, deps) {
  updateReviewHistory(
    storyId,
    (h) => ({
      ...h,
      overridden: [...new Set([...h.overridden, ...ids])],
      ...reasonField(deps?.reason, redactReason),
    }),
    deps,
  );
}

/** Same file and within the line window, or both lineless. */
function sameLocation(a, b) {
  if (a.file !== b.file) return false;
  if (!Number.isInteger(a.line) || !Number.isInteger(b.line)) {
    return !Number.isInteger(a.line) && !Number.isInteger(b.line);
  }
  return Math.abs(a.line - b.line) <= LINE_WINDOW;
}

/** @param {{ file: string, line?: number }[]} now @param {object[]} before */
function overlaps(now, before) {
  if (now.length === 0 && before.length === 0) return true;
  return now.some((a) => before.some((b) => sameLocation(a, b)));
}

/**
 * Mark each finding an earlier run raised (same id, overlapping location) as
 * a `repeat`. A repeat of an overridden CRITICAL is downgraded so it does not
 * halt again; any other repeat keeps its severity.
 *
 * @param {Finding[]} findings
 * @param {ReviewHistory} history
 * @returns {Finding[]}
 */
export function markRepeats(findings, history) {
  const earlier = history.runs.flatMap((r) =>
    Array.isArray(r?.findings) ? r.findings : [],
  );
  const overridden = new Set(history.overridden);
  return findings.map((f) => {
    const id = findingId(f);
    const instances = findingInstances(f);
    const seen = earlier.some(
      (e) => e?.id === id && overlaps(instances, e.instances ?? []),
    );
    if (!seen) return f;
    if (f.severity === 'critical' && overridden.has(id)) {
      return {
        ...f,
        severity: 'suggestion',
        ungrounded: 'overridden earlier',
        repeat: true,
      };
    }
    return { ...f, repeat: true };
  });
}

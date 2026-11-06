/**
 * review-history.js — every Story-scope review run of a Story and the
 * CRITICAL ids an operator overrode, beside the held-review deposit. A re-review
 * reads it to mark a finding it already raised as a repeat; the Story temp
 * purge reaps it with the deposit.
 *
 * @typedef {import('./review-providers/types.js').Finding} Finding
 * @typedef {{ id: string, severity: string, provider: string|null,
 *   class: string|null, instances: { file: string, line?: number }[],
 *   ungrounded?: string, unverified?: string, carried?: string,
 *   title?: string, body?: string, file?: string, line?: number,
 *   claim?: object }} HistoryFinding
 * @typedef {{ id: string, status: 'still-open'|'fixed'|'refuted',
 *   reason?: string }} EarlierOutcome
 * @typedef {{ runs: { headSha: string, findings: HistoryFinding[],
 *   earlierCriticals?: EarlierOutcome[] }[],
 *   overridden: string[], overrideReason?: string }} ReviewHistory
 * @typedef {{ id: string, finding: HistoryFinding, headSha: string,
 *   status: 'open'|'fixed'|'refuted'|'overridden', reason?: string }} EarlierCritical
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
/** A stored CRITICAL body is clipped to this many characters. */
const BODY_LIMIT = 4000;

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

/** Keep the set entries of `fields`; an empty string is unset. */
const present = (fields) =>
  Object.fromEntries(
    Object.entries(fields).filter(([, v]) => v != null && v !== ''),
  );

const flags = (f) =>
  present({
    ungrounded: f.ungrounded,
    unverified: f.unverified,
    carried: f.carried,
  });

/** What the verifier needs to re-check a CRITICAL without its original run. */
const criticalContent = (f) =>
  f.severity === 'critical'
    ? present({
        title: f.title,
        body: typeof f.body === 'string' ? f.body.slice(0, BODY_LIMIT) : null,
        file: f.file,
        line: f.line,
        claim: f.claim,
      })
    : {};

/** @param {Finding} f @returns {HistoryFinding} */
function toHistoryFinding(f) {
  return {
    id: findingId(f),
    severity: f.severity,
    provider: f.provider ?? null,
    class: f.class ?? null,
    instances: findingInstances(f),
    ...flags(f),
    ...criticalContent(f),
  };
}

/**
 * @param {number} storyId
 * @param {{ headSha: string, findings: Finding[],
 *   earlierCriticals?: EarlierOutcome[] }} run
 * @param {{ config?: object, fsImpl?: typeof nodeFs }} [deps]
 */
export function appendReviewRun(
  storyId,
  { headSha, findings, earlierCriticals },
  deps,
) {
  const run = { headSha, findings: findings.map(toHistoryFinding) };
  if (Array.isArray(earlierCriticals)) run.earlierCriticals = earlierCriticals;
  updateReviewHistory(storyId, (h) => ({ ...h, runs: [...h.runs, run] }), deps);
}

const list = (v) => (Array.isArray(v) ? v : []);
const RESOLVED = new Set(['fixed', 'refuted']);

/** Raised as `critical` and survived grounding and verification. */
const survived = (f) =>
  f?.severity === 'critical' && !f.unverified && !f.ungrounded;

/**
 * Every CRITICAL that survived grounding and verification in some run, in
 * first-raised order, with its current status. A run's `fixed`/`refuted`
 * outcome closes it; surviving again re-opens it; overridden ids end
 * `overridden`. A carried record keeps the head it was first raised at.
 *
 * @param {ReviewHistory} history
 * @returns {EarlierCritical[]}
 */
export function earlierCriticals(history) {
  const byId = new Map();
  for (const run of list(history?.runs)) {
    list(run?.earlierCriticals).forEach((o) => {
      resolveEntry(byId, o);
    });
    list(run?.findings)
      .filter(survived)
      .forEach((f) => {
        openEntry(byId, f, run.headSha);
      });
  }
  return markOverridden([...byId.values()], list(history?.overridden));
}

/** Overridden ids end `overridden`. */
function markOverridden(entries, ids) {
  const overridden = new Set(ids);
  return entries.map((e) =>
    overridden.has(e.id) ? { ...e, status: 'overridden' } : e,
  );
}

/** A run's `fixed`/`refuted` outcome closes an entry. */
function resolveEntry(byId, outcome) {
  const entry = byId.get(outcome?.id);
  if (!entry || !RESOLVED.has(outcome.status)) return;
  Object.assign(entry, { status: outcome.status, reason: outcome.reason });
}

/** A surviving CRITICAL (re-)opens its entry; carried keeps the first head. */
function openEntry(byId, finding, headSha) {
  const prev = byId.get(finding.id);
  byId.set(finding.id, {
    id: finding.id,
    finding,
    headSha: finding.carried && prev ? prev.headSha : headSha,
    status: 'open',
  });
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
 * Whether `finding` is `earlier` raised again: same id, overlapping location.
 *
 * @param {Finding} finding
 * @param {HistoryFinding} earlier
 */
export function raisedAgain(finding, earlier) {
  return (
    findingId(finding) === earlier?.id &&
    overlaps(findingInstances(finding), earlier.instances ?? [])
  );
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
    if (!earlier.some((e) => raisedAgain(f, e))) return f;
    if (f.severity === 'critical' && overridden.has(findingId(f))) {
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

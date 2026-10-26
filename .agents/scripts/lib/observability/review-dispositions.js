/**
 * review-dispositions.js — at land, what became of every finding the
 * Story-scope review raised, appended to a local NDJSON ledger so a review
 * prompt, provider or model change can be judged on fix and override rates.
 * Records carry ids, provider, severity, class and disposition only: never a
 * title, body, path or excerpt.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { anchorTempRoot, tempRootFrom } from '../config/temp-paths.js';
import { readReviewHistory } from '../orchestration/review-history.js';
import { MAX_LEDGER_BYTES, rotateIfNeeded } from './metrics-ledger.js';

export const DISPOSITIONS = [
  'fixed-on-branch',
  'open-at-merge',
  'overridden',
  'refuted-by-verifier',
  'downgraded-ungrounded',
];

const LEDGER_BASENAME = 'review-dispositions.ndjson';

/** @param {object} [config] @returns {string} */
function ledgerPath(config) {
  return path.join(anchorTempRoot(tempRootFrom(config)), LEDGER_BASENAME);
}

/** Precedence: overridden, then the final run's flags, then presence. */
function dispositionOf(id, final, overridden) {
  if (overridden.has(id)) return 'overridden';
  if (!final) return 'fixed-on-branch';
  if (final.ungrounded) return 'downgraded-ungrounded';
  if (final.unverified) return 'refuted-by-verifier';
  return 'open-at-merge';
}

/** @param {object} run @returns {object[]} */
const runFindings = (run) => (Array.isArray(run?.findings) ? run.findings : []);

/**
 * First occurrence and appearance count of every finding id.
 *
 * @param {object[][]} runs
 * @returns {Map<string, { first: object, runs: number }>}
 */
function firstSeen(runs) {
  const byId = new Map();
  for (const findings of runs) {
    const seenHere = new Set();
    for (const f of findings) {
      if (!f?.id || seenHere.has(f.id)) continue;
      seenHere.add(f.id);
      const entry = byId.get(f.id) ?? { first: f, runs: 0 };
      entry.runs += 1;
      byId.set(f.id, entry);
    }
  }
  return byId;
}

/**
 * One entry per finding id ever raised; provider and severity as first raised.
 *
 * @param {import('../orchestration/review-history.js').ReviewHistory} history
 */
function deriveDispositions(history) {
  const runs = history.runs.map(runFindings);
  const finalRun = new Map((runs.at(-1) ?? []).map((f) => [f.id, f]));
  const overridden = new Set(history.overridden);
  return [...firstSeen(runs)].map(([id, entry]) => ({
    findingId: id,
    provider: entry.first.provider ?? null,
    severity: entry.first.severity ?? null,
    class: entry.first.class ?? null,
    disposition: dispositionOf(id, finalRun.get(id), overridden),
    runs: entry.runs,
  }));
}

/** @param {string} filePath @returns {Promise<object[]>} */
async function readLedgerFile(filePath) {
  let text;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').flatMap((line) => {
    try {
      return line ? [JSON.parse(line)] : [];
    } catch {
      return [];
    }
  });
}

/**
 * Every record in the ledger and its rotated generation.
 *
 * @param {{ config?: object, since?: string|null }} [opts] - `since` keeps
 *   records whose `ts` is on or after that ISO date.
 * @returns {Promise<object[]>}
 */
export async function readDispositions({ config, since = null } = {}) {
  const file = ledgerPath(config);
  const records = [
    ...(await readLedgerFile(`${file}.1`)),
    ...(await readLedgerFile(file)),
  ];
  return since ? records.filter((r) => String(r.ts) >= since) : records;
}

/**
 * Append one record per finding the Story's reviews raised. Idempotent per
 * Story; throws on an fs failure (the post-land step owns best-effort).
 *
 * @param {{ storyId: number, config?: object, now?: () => string,
 *   progress?: (tag: string, msg: string) => void }} args
 * @returns {Promise<{ ok: true, appended: number, detail: string|null }>}
 */
export async function recordStoryDispositions({
  storyId,
  config,
  now = () => new Date().toISOString(),
  progress,
}) {
  const history = readReviewHistory(storyId, { config });
  if (history.runs.length === 0) {
    return { ok: true, appended: 0, detail: null };
  }
  const existing = await readDispositions({ config });
  if (existing.some((r) => r.storyId === storyId)) {
    return { ok: true, appended: 0, detail: 'already recorded' };
  }
  const ts = now();
  const lines = deriveDispositions(history)
    .map((d) => {
      const reason =
        d.disposition === 'overridden' && history.overrideReason
          ? { reason: history.overrideReason }
          : {};
      return JSON.stringify({ v: 1, ts, storyId, ...d, ...reason });
    })
    .join('\n');
  const chunk = `${lines}\n`;
  const file = ledgerPath(config);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await rotateIfNeeded(file, Buffer.byteLength(chunk), MAX_LEDGER_BYTES);
  await fs.appendFile(file, chunk, 'utf8');
  const appended = lines.split('\n').length;
  progress?.('POST-LAND', `📒 Recorded ${appended} review disposition(s).`);
  return { ok: true, appended, detail: null };
}

/** @param {object[]} records */
function tally(records) {
  const counts = Object.fromEntries(DISPOSITIONS.map((d) => [d, 0]));
  for (const r of records) {
    if (r.disposition in counts) counts[r.disposition] += 1;
  }
  const total = records.length;
  const rate = (n, of) => (of === 0 ? null : n / of);
  const criticals = records.filter((r) => r.severity === 'critical');
  const falseBlockers = criticals.filter((r) =>
    ['overridden', 'refuted-by-verifier', 'downgraded-ungrounded'].includes(
      r.disposition,
    ),
  ).length;
  return {
    total,
    counts,
    rates: Object.fromEntries(
      DISPOSITIONS.map((d) => [d, rate(counts[d], total)]),
    ),
    precision: rate(counts['fixed-on-branch'] + counts['open-at-merge'], total),
    falseBlocker: rate(falseBlockers, criticals.length),
  };
}

/** @param {object[]} records @param {string} key */
function groupTally(records, key) {
  const groups = new Map();
  for (const r of records) {
    const k = String(r[key] ?? 'unknown');
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return Object.fromEntries(
    [...groups]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, rs]) => [k, tally(rs)]),
  );
}

/**
 * Counts and rates of each disposition, overall, per provider and per severity.
 *
 * @param {object[]} records
 */
export function summarizeDispositions(records) {
  return {
    overall: tally(records),
    byProvider: groupTally(records, 'provider'),
    bySeverity: groupTally(records, 'severity'),
  };
}

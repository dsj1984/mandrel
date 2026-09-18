/**
 * plan-metrics.js — append-only NDJSON ledger of plan CLI invocations
 * (`{ v, cli, mode, epicId, startedAt, endedAt, durationMs, ok }`) plus
 * `kind: 'critic-skip'` records. Readers key on `kind`, never on absent
 * fields. Counts CLI invocations from the parent session, not turns.
 *
 * Writes are best-effort (a failed append is a missing metric, never a failed
 * phase) via the shared `metrics-ledger.js` tail; reads skip and count
 * malformed lines. The file deliberately survives phase cleanup so a whole
 * plan run is one stream.
 */

import fs from 'node:fs/promises';

import { Logger } from '../Logger.js';
import {
  appendLedgerRecord,
  PLAN_METRICS_SCHEMA_VERSION,
  planMetricsPath,
} from '../observability/metrics-ledger.js';

export const PLAN_METRICS_KIND_CRITIC_SKIP = 'critic-skip';

/**
 * Append one invocation record. Best-effort: warns and returns `false`.
 *
 * @param {{
 *   cli: string,
 *   mode: string,
 *   epicId?: number|null,
 *   startedAt: string,
 *   endedAt: string,
 *   ok: boolean,
 * }} entry
 * @param {object} [config]
 * @param {{ maxBytes?: number }} [opts] Test seam for the rotation threshold.
 * @returns {Promise<boolean>} true when the line was written.
 */
export async function appendPlanMetric(entry, config, opts = {}) {
  try {
    if (!entry || typeof entry !== 'object') {
      throw new TypeError('appendPlanMetric requires an entry object');
    }
    if (typeof entry.cli !== 'string' || entry.cli.length === 0) {
      throw new TypeError('appendPlanMetric requires a non-empty entry.cli');
    }
    if (typeof entry.mode !== 'string' || entry.mode.length === 0) {
      throw new TypeError('appendPlanMetric requires a non-empty entry.mode');
    }
    const epicId = entry.epicId ?? null;
    const record = {
      v: PLAN_METRICS_SCHEMA_VERSION,
      cli: entry.cli,
      mode: entry.mode,
      epicId,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      durationMs:
        typeof entry.durationMs === 'number'
          ? entry.durationMs
          : Math.max(
              0,
              Date.parse(entry.endedAt) - Date.parse(entry.startedAt),
            ) || 0,
      ok: entry.ok === true,
    };
    await appendLedgerRecord(record, {
      epicId,
      config,
      maxBytes: opts.maxBytes,
    });
    return true;
  } catch (err) {
    Logger.warn(
      `[plan-metrics] append failed (non-fatal): ${err?.message ?? err}`,
    );
    return false;
  }
}

/**
 * Append a critic-skip record with its reasons, so an under-firing critic
 * layer is auditable. Best-effort like `appendPlanMetric`.
 *
 * @param {{
 *   critic: string,
 *   reasons: string[],
 *   cli: string,
 *   epicId?: number|null,
 * }} entry
 * @param {object} [config]
 * @param {{ maxBytes?: number }} [opts] Test seam for the rotation threshold.
 * @returns {Promise<boolean>} true when the line was written.
 */
export async function appendCriticSkip(entry, config, opts = {}) {
  try {
    if (!entry || typeof entry !== 'object') {
      throw new TypeError('appendCriticSkip requires an entry object');
    }
    if (typeof entry.critic !== 'string' || entry.critic.length === 0) {
      throw new TypeError('appendCriticSkip requires a non-empty entry.critic');
    }
    if (typeof entry.cli !== 'string' || entry.cli.length === 0) {
      throw new TypeError('appendCriticSkip requires a non-empty entry.cli');
    }
    const epicId = entry.epicId ?? null;
    const record = {
      v: PLAN_METRICS_SCHEMA_VERSION,
      kind: PLAN_METRICS_KIND_CRITIC_SKIP,
      cli: entry.cli,
      critic: entry.critic,
      reasons: Array.isArray(entry.reasons)
        ? entry.reasons.filter((r) => typeof r === 'string')
        : [],
      epicId,
      at: new Date().toISOString(),
    };
    await appendLedgerRecord(record, {
      epicId,
      config,
      maxBytes: opts.maxBytes,
    });
    return true;
  } catch (err) {
    Logger.warn(
      `[plan-metrics] critic-skip append failed (non-fatal): ${err?.message ?? err}`,
    );
    return false;
  }
}

/**
 * Run `fn` and record the invocation; the metric write never masks `fn`'s
 * outcome.
 *
 * @template T
 * @param {{ cli: string, mode: string, epicId?: number|null, config?: object }} meta
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function recordPlanInvocation(meta, fn) {
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  let ok = false;
  try {
    const result = await fn();
    ok = true;
    return result;
  } finally {
    await appendPlanMetric(
      {
        cli: meta.cli,
        mode: meta.mode,
        epicId: meta.epicId ?? null,
        startedAt,
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - startMs,
        ok,
      },
      meta.config,
    );
  }
}

/**
 * Read the active ledger generation; malformed lines are counted, not thrown.
 *
 * @param {number|null} epicId
 * @param {object} [config]
 * @returns {Promise<{ entries: object[], malformedLines: number, missing: boolean }>}
 */
export async function readPlanMetrics(epicId, config) {
  const filePath = planMetricsPath(epicId, config);
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch {
    return { entries: [], malformedLines: 0, missing: true };
  }
  const entries = [];
  let malformedLines = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof parsed.cli === 'string'
      ) {
        entries.push(parsed);
      } else {
        malformedLines += 1;
      }
    } catch {
      malformedLines += 1;
    }
  }
  return { entries, malformedLines, missing: false };
}

/**
 * @param {object} entry
 * @returns {string|null}
 */
function recordTimestamp(entry) {
  const stamp = typeof entry?.kind === 'string' ? entry.at : entry?.startedAt;
  return typeof stamp === 'string' ? stamp : null;
}

/**
 * Roll a ledger up for the persist summary; `null` when empty. Critic skips
 * are tallied apart from invocations. `opts.since` (ISO-8601) scopes to one
 * run — the standalone ledger is shared by every plan ever run.
 *
 * @param {{ entries: object[], malformedLines?: number }} ledger
 * @param {{ since?: string|null }} [opts]
 * @returns {{
 *   invocations: number,
 *   failures: number,
 *   byCli: Record<string, number>,
 *   byMode: Record<string, number>,
 *   criticSkips: number,
 *   criticSkipsByCritic: Record<string, number>,
 *   firstStartedAt: string|null,
 *   lastEndedAt: string|null,
 *   spanMs: number|null,
 *   totalDurationMs: number,
 *   malformedLines: number,
 * }|null}
 */
export function summarizePlanMetrics(ledger, opts = {}) {
  const all = ledger?.entries ?? [];
  const since = typeof opts.since === 'string' ? opts.since : null;
  // ISO-8601 UTC strings compare correctly as strings.
  const entries =
    since === null
      ? all
      : all.filter((e) => {
          const stamp = recordTimestamp(e);
          return stamp !== null && stamp >= since;
        });
  if (entries.length === 0) return null;
  const byCli = {};
  const byMode = {};
  const criticSkipsByCritic = {};
  let criticSkips = 0;
  let failures = 0;
  let totalDurationMs = 0;
  let firstStartedAt = null;
  let lastEndedAt = null;
  const invocationEntries = [];
  for (const e of entries) {
    if (e.kind === PLAN_METRICS_KIND_CRITIC_SKIP) {
      criticSkips += 1;
      if (typeof e.critic === 'string') {
        criticSkipsByCritic[e.critic] =
          (criticSkipsByCritic[e.critic] ?? 0) + 1;
      }
      continue;
    }
    if (typeof e.kind === 'string') {
      // Other kinded records (e.g. `findings-yield`) are not invocations.
      continue;
    }
    invocationEntries.push(e);
    byCli[e.cli] = (byCli[e.cli] ?? 0) + 1;
    if (typeof e.mode === 'string') byMode[e.mode] = (byMode[e.mode] ?? 0) + 1;
    if (e.ok !== true) failures += 1;
    if (typeof e.durationMs === 'number') totalDurationMs += e.durationMs;
    if (typeof e.startedAt === 'string') {
      if (firstStartedAt === null || e.startedAt < firstStartedAt) {
        firstStartedAt = e.startedAt;
      }
    }
    if (typeof e.endedAt === 'string') {
      if (lastEndedAt === null || e.endedAt > lastEndedAt) {
        lastEndedAt = e.endedAt;
      }
    }
  }
  let spanMs = null;
  if (firstStartedAt !== null && lastEndedAt !== null) {
    const span = Date.parse(lastEndedAt) - Date.parse(firstStartedAt);
    if (Number.isFinite(span)) spanMs = Math.max(0, span);
  }
  return {
    invocations: invocationEntries.length,
    failures,
    byCli,
    byMode,
    criticSkips,
    criticSkipsByCritic,
    firstStartedAt,
    lastEndedAt,
    spanMs,
    totalDurationMs,
    malformedLines: ledger?.malformedLines ?? 0,
  };
}

/**
 * @param {ReturnType<typeof summarizePlanMetrics>} summary
 * @returns {string}
 */
export function renderPlanMetricsSummaryLine(summary) {
  if (!summary) return 'plan-metrics: no invocations recorded';
  const cliParts = Object.entries(summary.byCli)
    .map(([cli, count]) => `${cli} ×${count}`)
    .join(', ');
  const failed = summary.failures > 0 ? ` (${summary.failures} failed)` : '';
  const span = summary.spanMs === null ? 'n/a' : formatSpan(summary.spanMs);
  const malformed =
    summary.malformedLines > 0
      ? `; ${summary.malformedLines} malformed line(s) skipped`
      : '';
  const skips =
    (summary.criticSkips ?? 0) > 0
      ? `; ${summary.criticSkips} critic skip(s) logged (${Object.entries(
          summary.criticSkipsByCritic ?? {},
        )
          .map(([critic, count]) => `${critic} ×${count}`)
          .join(', ')})`
      : '';
  return (
    `plan-metrics: ${summary.invocations} invocation(s)${failed} across ` +
    `${cliParts || 'no plan CLIs'} — span ${span}${skips}${malformed}`
  );
}

/**
 * `45s`, `12m 3s`, `2h 5m`.
 *
 * @param {number} ms
 * @returns {string}
 */
function formatSpan(ms) {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) return `${totalMinutes}m ${seconds}s`;
  const hours = Math.floor(totalMinutes / 60);
  return `${hours}h ${totalMinutes % 60}m`;
}

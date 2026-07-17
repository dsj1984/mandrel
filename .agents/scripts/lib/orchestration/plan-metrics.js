/**
 * plan-metrics.js — append-only plan-invocation ledger (Epic #4474, PR1).
 *
 * The `/plan` collapse (#4474) is measured, not asserted: before any pipeline
 * phase is removed, every plan CLI invocation stamps an entry/exit record so
 * the current 12-phase baseline is captured on disk. Each record is one
 * newline-terminated JSON line appended to
 * `temp/run-<id>/plan-metrics.json` (per-Epic plan CLIs) or
 * `temp/standalone/plan-metrics.json` (the standalone `story-plan.js` path
 * and Epic-less healthcheck runs — same standalone routing the friction
 * ledger uses).
 *
 * Record shape (v1):
 *
 * ```json
 * { "v": 1, "cli": "plan-context", "mode": "emit",
 *   "epicId": 4474, "startedAt": "...", "endedAt": "...",
 *   "durationMs": 1234, "ok": true }
 * ```
 *
 * Critic-skip records (Epic #4474 PR6 — additive `kind` extension): the
 * conditional-critic layer logs every skip decision so under-firing is
 * auditable from the same stream:
 *
 * ```json
 * { "v": 1, "kind": "critic-skip", "cli": "plan-critics",
 *   "critic": "pre-mortem", "reasons": ["..."], "epicId": 4474,
 *   "at": "..." }
 * ```
 *
 * Records without a `kind` field are invocation records (the PR1 shape);
 * readers key on `kind`, never on the absence of other fields.
 *
 * Attribution note (#4474 PR1 risk register): these records count **CLI
 * invocations from the parent session's perspective**. Sub-agent sessions
 * spawned by the workflow do not write here; they are attributed separately
 * by the host's session accounting. Do not read `invocations` as "turns".
 *
 * Robustness contract (mirrors `lib/observability/signals-writer.js`):
 *   - **Best-effort writes.** A failed append is a missing metric, not a
 *     failed plan phase — fs errors are swallowed after a `Logger.warn`.
 *   - **No buffering.** Each append opens, writes one line, closes.
 *   - **Malformed-line tolerance on read.** The reader skips unparseable
 *     lines (counting them) instead of throwing, so a torn write can never
 *     wedge the analyzer.
 *   - **Rotation.** When an append would push the ledger past
 *     `MAX_LEDGER_BYTES`, the current file is renamed to
 *     `plan-metrics.json.1` (replacing any prior rollover) and the append
 *     starts a fresh ledger, so a long-lived Epic cannot grow the file
 *     unboundedly. Readers only consume the active generation — the
 *     rollover exists for manual archaeology.
 *
 * `plan-metrics.json` is intentionally NOT in
 * `lib/plan-phase-cleanup.js#PHASE_TEMP_BASENAMES`: the ledger must survive
 * phase cleanup so the whole plan run (spec → decompose → healthcheck) is
 * visible in one stream.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import {
  anchorTempRoot,
  runArtifactPath,
  tempRootFrom,
} from '../config/temp-paths.js';
import { Logger } from '../Logger.js';

export const PLAN_METRICS_BASENAME = 'plan-metrics.json';
export const PLAN_METRICS_SCHEMA_VERSION = 1;

/** Record kind for a logged critic skip decision (Epic #4474 PR6). */
export const PLAN_METRICS_KIND_CRITIC_SKIP = 'critic-skip';

/**
 * Rotation threshold. At ~200 bytes per record this is ~5000 invocations —
 * far beyond any real plan run, so rotation only fires on pathological
 * accumulation.
 */
export const MAX_LEDGER_BYTES = 1024 * 1024;

/**
 * Resolve the ledger path for an Epic (or the standalone stream when
 * `epicId` is `null` — the `story-plan.js` / Epic-less healthcheck case).
 *
 * @param {number|null} epicId
 * @param {object} [config] Resolved config (threads `project.paths.tempRoot`).
 * @returns {string}
 */
export function planMetricsPath(epicId, config) {
  if (epicId === null || epicId === undefined) {
    return path.join(
      anchorTempRoot(tempRootFrom(config)),
      'standalone',
      PLAN_METRICS_BASENAME,
    );
  }
  return runArtifactPath(epicId, PLAN_METRICS_BASENAME, config);
}

/**
 * Rotate the ledger when appending `incomingBytes` would exceed
 * `maxBytes`. Single-generation rollover: `plan-metrics.json` →
 * `plan-metrics.json.1` (any prior `.1` is replaced).
 *
 * @param {string} filePath
 * @param {number} incomingBytes
 * @param {number} [maxBytes]
 * @returns {Promise<boolean>} true when a rotation happened.
 */
async function rotateIfNeeded(filePath, incomingBytes, maxBytes) {
  let size = 0;
  try {
    size = (await fs.stat(filePath)).size;
  } catch {
    return false; // No existing ledger — nothing to rotate.
  }
  if (size + incomingBytes <= maxBytes) return false;
  await fs.rename(filePath, `${filePath}.1`);
  return true;
}

/**
 * Append one invocation record to the ledger. Best-effort: returns `false`
 * (after a `Logger.warn`) instead of throwing on any fs failure, so metric
 * capture can never fail a plan phase.
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
    const filePath = planMetricsPath(epicId, config);
    const line = `${JSON.stringify(record)}\n`;
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await rotateIfNeeded(
      filePath,
      Buffer.byteLength(line),
      opts.maxBytes ?? MAX_LEDGER_BYTES,
    );
    await fs.appendFile(filePath, line, 'utf8');
    return true;
  } catch (err) {
    Logger.warn(
      `[plan-metrics] append failed (non-fatal): ${err?.message ?? err}`,
    );
    return false;
  }
}

/**
 * Append one critic-skip audit record (Epic #4474 PR6). Every conditional
 * critic that decides NOT to dispatch logs the decision here — with the
 * deterministic reasons — so an under-firing critic layer (a distorted
 * plan sailing through) is auditable after the fact. Best-effort with the
 * same contract as `appendPlanMetric`: a failed append can never fail the
 * plan step.
 *
 * @param {{
 *   critic: string,
 *   reasons: string[],
 *   cli: string,
 *   epicId?: number|null,
 * }} entry
 * @param {object} [config]
 * @returns {Promise<boolean>} true when the line was written.
 */
export async function appendCriticSkip(entry, config) {
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
    const filePath = planMetricsPath(epicId, config);
    const line = `${JSON.stringify(record)}\n`;
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await rotateIfNeeded(filePath, Buffer.byteLength(line), MAX_LEDGER_BYTES);
    await fs.appendFile(filePath, line, 'utf8');
    return true;
  } catch (err) {
    Logger.warn(
      `[plan-metrics] critic-skip append failed (non-fatal): ${err?.message ?? err}`,
    );
    return false;
  }
}

/**
 * Wrap one plan CLI invocation: stamp `startedAt`, run `fn`, stamp
 * `endedAt` + `ok`, append the record, and re-throw the original error on
 * failure. The metric write itself is best-effort and can never mask or
 * replace the wrapped function's outcome.
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
 * Read the active ledger generation. Missing file → `{ entries: [],
 * malformedLines: 0, missing: true }`. Malformed lines are skipped and
 * counted, never thrown.
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
 * Roll a read ledger up into the compact summary surfaced by the persist
 * summary. (Story #4545 deleted its second consumer, `analyze-execution.js`,
 * with the execution-analysis surface.) Returns `null` when there is nothing
 * to summarize (missing ledger or zero parseable entries).
 *
 * Critic-skip records (kind: 'critic-skip') are counted separately from
 * invocations — `criticSkips` totals them and `criticSkipsByCritic` breaks
 * them down, so the skip-audit trail is visible in the persist summary
 * without inflating the turns-per-plan proxy.
 *
 * Pass `opts.since` (an ISO-8601 instant) to scope the roll-up to one plan
 * run (Story #4541). The Epic-less ledger at `temp/standalone/` is shared by
 * every plan the repo has ever run, so an unfiltered summary reported
 * lifetime totals under a line the reader takes to describe the invocation
 * in front of them. Records are timestamped `startedAt` (invocations) or
 * `at` (critic skips); either at-or-after `since` is in scope.
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
/**
 * Timestamp a ledger record is ordered by: `startedAt` for invocation
 * records, `at` for critic-skip records.
 *
 * @param {object} entry
 * @returns {string|null}
 */
function recordTimestamp(entry) {
  const stamp =
    entry?.kind === PLAN_METRICS_KIND_CRITIC_SKIP ? entry.at : entry.startedAt;
  return typeof stamp === 'string' ? stamp : null;
}

export function summarizePlanMetrics(ledger, opts = {}) {
  const all = ledger?.entries ?? [];
  const since = typeof opts.since === 'string' ? opts.since : null;
  // ISO-8601 UTC strings sort lexicographically in time order, so a string
  // compare is a correct (and allocation-free) instant compare here.
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
 * Render the one-line human summary (snapshot-tested). Example:
 *
 *   `plan-metrics: 3 invocation(s) (1 failed) across plan-context ×1,
 *    plan-critics ×1, plan-persist ×1 — span 12m 3s`
 *
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
 * Compact duration formatter: `45s`, `12m 3s`, `2h 5m`.
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

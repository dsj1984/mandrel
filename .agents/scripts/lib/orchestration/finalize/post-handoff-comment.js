// .agents/scripts/lib/orchestration/finalize/post-handoff-comment.js
/**
 * post-handoff-comment.js — finalize helper that upserts the
 * `epic-handoff` structured comment on the Epic at the end of the
 * bus-owned finalize flow.
 *
 * The Phase 7.1 prose previously asked operators to leave a free-form
 * "PR opened, see #N" comment after `gh pr create`. Lifting that
 * into a structured-marker upsert means the comment is:
 *
 *   - addressable by the `epic-handoff` marker (operators and tooling
 *     can find the canonical PR pointer without scrolling);
 *   - idempotent under finalize replay (re-invoking the helper edits
 *     the existing comment rather than fanning out duplicates).
 *
 * Story #2894 / Task #2909 (Epic #2880).
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  epicLedgerPath,
  epicPerfReportJsonPath,
} from '../../config/temp-paths.js';
import { Logger } from '../../Logger.js';
import { render as renderLifecycleTrace } from '../lifecycle/trace-logger.js';
import { upsertStructuredComment as defaultUpsertStructuredComment } from '../ticketing.js';

export const EPIC_HANDOFF_MARKER = 'epic-handoff';

/**
 * Byte budget for the embedded run-trace digest. The digest is the
 * `TraceLogger` Summary block only (phase list + per-phase durations +
 * event/completed/failed counts), so it is small by construction — but we
 * cap it well under GitHub's ~64KB comment limit so a pathological ledger
 * with a huge phase list still degrades to a truncated note + the
 * relative-path link rather than blowing the comment budget. Story #3669.
 */
export const RUN_TRACE_MAX_BYTES = 8000;

/**
 * Format a millisecond duration as a compact wall-clock string for the
 * per-wave perf summary lines. Sub-second values render as `<n>ms`;
 * second-scale values as `<n.n>s`; minute-scale values as `<m>m<ss>s`.
 * Story #3029 / Task #3041.
 *
 * @param {number} ms
 * @returns {string}
 */
function formatDurationMs(ms) {
  const n = Number.isFinite(ms) ? Math.max(0, Math.floor(ms)) : 0;
  if (n < 1000) return `${n}ms`;
  if (n < 60000) return `${(n / 1000).toFixed(1)}s`;
  const minutes = Math.floor(n / 60000);
  const seconds = Math.floor((n % 60000) / 1000);
  return `${minutes}m${seconds.toString().padStart(2, '0')}s`;
}

/**
 * Render the Performance Report section appended to the `epic-handoff`
 * comment body. Returns an empty string when `perfReport` is null /
 * undefined (no JSON on disk → section omitted) so callers can splice
 * the result in unconditionally.
 *
 * Output contract (Story #3029 / Task #3041):
 *   - `## Performance Report` heading
 *   - One relative link line to `temp/epic-<id>/epic-perf-report.json`
 *   - One bullet per wave: `Wave N: <wall> wall / <story> story / util <pct>% [cap binding]`
 *
 * @param {{
 *   relativePath: string,
 *   waveParallelism: Array<{ waveIndex: number, wallClockMs: number, summedStoryMs: number, utilisation: number, capBinding: boolean, verifyConcurrencyCap?: number }>,
 * } | null | undefined} perfReport
 * @returns {string}
 */
export function renderPerfReportSection(perfReport) {
  if (!perfReport || typeof perfReport.relativePath !== 'string') return '';
  const waves = Array.isArray(perfReport.waveParallelism)
    ? perfReport.waveParallelism
    : [];
  const lines = [];
  lines.push('');
  lines.push('## Performance Report');
  lines.push('');
  lines.push(
    `Persisted to [\`${perfReport.relativePath}\`](${perfReport.relativePath}).`,
  );
  lines.push('');
  if (waves.length === 0) {
    lines.push('No wave-parallelism rows recorded.');
  } else {
    for (const wave of waves) {
      const wall = formatDurationMs(wave.wallClockMs);
      const story = formatDurationMs(wave.summedStoryMs);
      const util = Number.isFinite(wave.utilisation)
        ? (wave.utilisation * 100).toFixed(0)
        : '0';
      const capLabel = wave.capBinding ? 'cap binding' : 'cap not binding';
      lines.push(
        `- Wave ${wave.waveIndex}: ${wall} wall / ${story} story / util ${util}% [${capLabel}]`,
      );
    }
  }
  return lines.join('\n');
}

/**
 * Slice the `## Summary` block out of the full `lifecycle.md` projection.
 * The TraceLogger `render()` output ends with a `## Summary` section (phase
 * list, per-phase durations, event/completed/failed counts); everything
 * before it is the per-event trace, which the Story explicitly excludes
 * from the embedded digest. Returns the Summary body (the lines *after* the
 * `## Summary` heading, trimmed) or `''` when no Summary heading is present.
 *
 * @param {string} fullMarkdown
 * @returns {string}
 */
function summaryBlockFrom(fullMarkdown) {
  const marker = '## Summary';
  const idx = fullMarkdown.indexOf(marker);
  if (idx < 0) return '';
  return fullMarkdown.slice(idx + marker.length).trim();
}

/**
 * Project the canonical lifecycle ledger NDJSON into the compact run-trace
 * digest embedded in the handoff comment. Reuses the pure `TraceLogger`
 * `render()` projection and keeps only its Summary rollup — never the full
 * per-event trace (Story #3669 acceptance).
 *
 * Pure + read-only: it parses the supplied ledger text and never touches
 * the filesystem or mutates the ledger. Returns `null` on:
 *   - a missing / empty ledger (no emitted records → empty Summary), or
 *   - a malformed ledger (the underlying `render` throws on bad JSON; we
 *     swallow it so the section degrades gracefully instead of blocking
 *     the PR open).
 *
 * When the projected Summary exceeds `maxBytes`, the digest is truncated on
 * a UTF-8-safe boundary and `truncated: true` is set so the renderer can
 * append a note and keep the relative-path link to the full `lifecycle.md`.
 *
 * @param {{
 *   ledgerText: string,
 *   epicId: number,
 *   relativePath: string,
 *   maxBytes?: number,
 * }} args
 * @returns {{ digest: string, relativePath: string, truncated: boolean } | null}
 */
export function extractRunTraceDigest({
  ledgerText,
  epicId,
  relativePath,
  maxBytes = RUN_TRACE_MAX_BYTES,
} = {}) {
  if (typeof ledgerText !== 'string' || ledgerText.trim().length === 0) {
    return null;
  }
  let fullMarkdown;
  try {
    fullMarkdown = renderLifecycleTrace(ledgerText, { epicId });
  } catch {
    // Malformed ledger (parseLedger throws on bad JSON). Degrade to no
    // section rather than propagating and blocking the handoff comment.
    return null;
  }
  const summary = summaryBlockFrom(fullMarkdown);
  if (summary.length === 0) return null;

  const budget =
    Number.isInteger(maxBytes) && maxBytes > 0 ? maxBytes : RUN_TRACE_MAX_BYTES;
  if (Buffer.byteLength(summary, 'utf8') <= budget) {
    return { digest: summary, relativePath, truncated: false };
  }
  // Truncate on a UTF-8-safe boundary: take a byte slice, then drop any
  // trailing partial multibyte sequence by decoding with replacement and
  // stripping the U+FFFD tail.
  const sliced = Buffer.from(summary, 'utf8')
    .subarray(0, budget)
    .toString('utf8')
    .replace(/�+$/u, '');
  return { digest: sliced, relativePath, truncated: true };
}

/**
 * Render the "Run trace" digest section appended to the `epic-handoff`
 * comment. Returns `''` when `runTrace` is null / malformed so callers can
 * splice the result in unconditionally — mirrors `renderPerfReportSection`.
 *
 * Output contract (Story #3669):
 *   - `## Run trace` heading
 *   - One relative link line to `temp/epic-<id>/lifecycle.md`
 *   - The TraceLogger Summary rollup (phase durations + counts)
 *   - A truncation note when the projection overflowed the byte budget
 *
 * @param {{ digest: string, relativePath: string, truncated?: boolean } | null | undefined} runTrace
 * @returns {string}
 */
export function renderRunTraceSection(runTrace) {
  if (
    !runTrace ||
    typeof runTrace.digest !== 'string' ||
    runTrace.digest.length === 0 ||
    typeof runTrace.relativePath !== 'string'
  ) {
    return '';
  }
  const lines = [];
  lines.push('');
  lines.push('## Run trace');
  lines.push('');
  lines.push(
    `Full lifecycle companion: [\`${runTrace.relativePath}\`](${runTrace.relativePath}).`,
  );
  lines.push('');
  lines.push(runTrace.digest);
  if (runTrace.truncated) {
    lines.push('');
    lines.push(
      `_Digest truncated to fit the comment budget — see [\`${runTrace.relativePath}\`](${runTrace.relativePath}) for the full trace._`,
    );
  }
  return lines.join('\n');
}

/**
 * Default loader: read the canonical `temp/epic-<id>/lifecycle.ndjson`
 * ledger from disk and project it into the run-trace digest envelope
 * `renderRunTraceSection` expects. Returns `null` on any failure (missing
 * file, malformed JSON, empty ledger) so the handoff comment degrades
 * gracefully — mirrors `loadPerfReportFromDisk`.
 *
 * `relativePath` points at the rendered `lifecycle.md` companion (the same
 * directory as the ledger), computed relative to `cwd` so consumers can
 * follow the link from the rendered comment. Falls back to the absolute
 * path when the companion resolves outside `cwd`.
 *
 * @param {{ epicId: number, config?: object, cwd?: string }} args
 * @returns {Promise<{ digest: string, relativePath: string, truncated: boolean } | null>}
 */
export async function loadRunTraceFromDisk({
  epicId,
  config,
  cwd = process.cwd(),
} = {}) {
  if (!Number.isInteger(epicId) || epicId < 1) return null;
  let ledgerAbsPath;
  try {
    ledgerAbsPath = epicLedgerPath(epicId, config);
  } catch {
    return null;
  }
  let ledgerText;
  try {
    ledgerText = await fs.readFile(ledgerAbsPath, 'utf8');
  } catch {
    return null;
  }
  const companionAbsPath = path.join(
    path.dirname(ledgerAbsPath),
    'lifecycle.md',
  );
  let relativePath;
  try {
    const rel = path.relative(cwd, companionAbsPath);
    relativePath =
      rel && !rel.startsWith('..') && !path.isAbsolute(rel)
        ? rel
        : companionAbsPath;
    relativePath = relativePath.split(path.sep).join('/');
  } catch {
    relativePath = companionAbsPath;
  }
  return extractRunTraceDigest({ ledgerText, epicId, relativePath });
}

/**
 * Render the `epic-handoff` comment body. Pure helper — exported so the
 * contract tests can assert the rendered shape without standing up a
 * provider.
 *
 * @param {{ epicId: number, prNumber: number, prUrl?: string|null }} input
 * @returns {string} markdown body (without the structured-comment marker
 *   prefix — the marker is prepended by `upsertStructuredComment`).
 */
export function renderHandoffBody({
  epicId,
  prNumber,
  prUrl = null,
  perfReport = null,
  runTrace = null,
} = {}) {
  const lines = [];
  lines.push('### 🤝 Epic handoff — PR opened');
  lines.push('');
  lines.push(`Epic: #${epicId}`);
  if (typeof prUrl === 'string' && prUrl.length > 0) {
    lines.push(`Pull request: [#${prNumber}](${prUrl})`);
  } else {
    lines.push(`Pull request: #${prNumber}`);
  }
  lines.push('');
  lines.push(
    'Auto-merge will arm once the watch-and-iterate gate (Phase 8) confirms required checks are green.',
  );
  // Story #3029 / Task #3041 — Performance Report section. Empty string
  // is returned when no perf report is available, so the existing body
  // shape is preserved for handoffs that fire before the close tail has
  // emitted a report (e.g. legacy replays).
  const perfSection = renderPerfReportSection(perfReport);
  if (perfSection.length > 0) {
    lines.push(perfSection);
  }
  // Story #3669 — Run trace digest section. Empty string is returned when
  // no ledger digest is available (missing/malformed ledger → section
  // omitted), so the body shape is preserved for handoffs that fire before
  // a ledger exists.
  const runTraceSection = renderRunTraceSection(runTrace);
  if (runTraceSection.length > 0) {
    lines.push(runTraceSection);
  }
  lines.push('');
  lines.push('```json');
  lines.push(
    JSON.stringify(
      { kind: 'epic-handoff', epicId, prNumber, prUrl: prUrl ?? null },
      null,
      2,
    ),
  );
  lines.push('```');
  return lines.join('\n');
}

/**
 * Default loader: read the canonical `epic-perf-report.json` snapshot
 * from disk (when present) and shape it into the
 * `{ relativePath, waveParallelism }` envelope `renderPerfReportSection`
 * expects. Returns `null` on any failure (missing file, malformed JSON,
 * unreadable directory) so the handoff comment degrades gracefully to
 * the pre-Story-#3029 body shape rather than blocking the PR open.
 *
 * `relativePath` is computed relative to `cwd` so consumers cloning the
 * repo can follow the link from the rendered comment. When the report
 * path resolves outside `cwd`, falls back to the absolute path (rare —
 * happens only for callers that point `tempRoot` outside the repo).
 *
 * @param {{ epicId: number, config?: object, cwd?: string }} args
 * @returns {Promise<{ relativePath: string, waveParallelism: Array<object> } | null>}
 */
export async function loadPerfReportFromDisk({
  epicId,
  config,
  cwd = process.cwd(),
} = {}) {
  if (!Number.isInteger(epicId) || epicId < 1) return null;
  let absPath;
  try {
    absPath = epicPerfReportJsonPath(epicId, config);
  } catch {
    return null;
  }
  let raw;
  try {
    raw = await fs.readFile(absPath, 'utf8');
  } catch {
    return null;
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  let relativePath;
  try {
    const rel = path.relative(cwd, absPath);
    relativePath =
      rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : absPath;
    // Normalize Windows backslashes so the rendered Markdown link works
    // on both POSIX consumers and Windows operators.
    relativePath = relativePath.split(path.sep).join('/');
  } catch {
    relativePath = absPath;
  }
  return {
    relativePath,
    waveParallelism: Array.isArray(payload.waveParallelism)
      ? payload.waveParallelism
      : [],
  };
}

/**
 * Upsert the `epic-handoff` structured comment on the Epic ticket.
 *
 * @param {object} args
 * @param {number} args.epicId
 * @param {number} args.prNumber
 * @param {string} [args.prUrl]
 * @param {object} args.provider — ITicketingProvider used by
 *   `upsertStructuredComment`.
 * @param {Function} [args.upsertStructuredCommentFn] — override for
 *   tests.
 * @param {object} [args.logger]
 * @returns {Promise<{ marker: string, commentId: number|null }>}
 */
export async function postHandoffComment({
  epicId,
  prNumber,
  prUrl,
  provider,
  config,
  cwd,
  perfReport,
  runTrace,
  loadPerfReportFn = loadPerfReportFromDisk,
  loadRunTraceFn = loadRunTraceFromDisk,
  upsertStructuredCommentFn = defaultUpsertStructuredComment,
  logger = Logger,
} = {}) {
  if (!Number.isInteger(epicId) || epicId < 1) {
    throw new TypeError(
      'postHandoffComment: epicId must be a positive integer',
    );
  }
  if (!Number.isInteger(prNumber) || prNumber < 1) {
    throw new TypeError(
      'postHandoffComment: prNumber must be a positive integer',
    );
  }
  if (!provider) {
    throw new TypeError('postHandoffComment: provider is required');
  }
  // Story #3029 / Task #3041 — if an explicit `perfReport` envelope is
  // not supplied, fall back to reading the persisted JSON written by
  // the close-tail. Any loader failure resolves to `null` and the
  // Performance Report section is silently omitted.
  let resolvedPerfReport = perfReport;
  if (resolvedPerfReport === undefined) {
    try {
      resolvedPerfReport = await loadPerfReportFn({ epicId, config, cwd });
    } catch (err) {
      logger.warn?.(
        `[finalize/post-handoff-comment] perf-report load failed for Epic #${epicId} (non-fatal): ${err?.message ?? err}`,
      );
      resolvedPerfReport = null;
    }
  }
  // Story #3669 — if an explicit `runTrace` envelope is not supplied, fall
  // back to projecting the canonical lifecycle ledger from disk. Any loader
  // failure resolves to `null` and the Run trace section is silently
  // omitted, never blocking the handoff comment / PR open.
  let resolvedRunTrace = runTrace;
  if (resolvedRunTrace === undefined) {
    try {
      resolvedRunTrace = await loadRunTraceFn({ epicId, config, cwd });
    } catch (err) {
      logger.warn?.(
        `[finalize/post-handoff-comment] run-trace load failed for Epic #${epicId} (non-fatal): ${err?.message ?? err}`,
      );
      resolvedRunTrace = null;
    }
  }
  const body = renderHandoffBody({
    epicId,
    prNumber,
    prUrl: prUrl ?? null,
    perfReport: resolvedPerfReport,
    runTrace: resolvedRunTrace,
  });
  try {
    const result = await upsertStructuredCommentFn(
      provider,
      epicId,
      EPIC_HANDOFF_MARKER,
      body,
    );
    const commentId =
      typeof result?.commentId === 'number' ? result.commentId : null;
    return { marker: EPIC_HANDOFF_MARKER, commentId };
  } catch (err) {
    logger.warn?.(
      `[finalize/post-handoff-comment] upsert failed for Epic #${epicId}: ${err?.message ?? err}`,
    );
    throw err;
  }
}

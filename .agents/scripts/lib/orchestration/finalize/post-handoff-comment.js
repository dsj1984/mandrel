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
import { epicPerfReportJsonPath } from '../../config/temp-paths.js';
import { Logger } from '../../Logger.js';
import { upsertStructuredComment as defaultUpsertStructuredComment } from '../ticketing.js';

export const EPIC_HANDOFF_MARKER = 'epic-handoff';

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
 * Default loader: read the canonical `epic-perf-report.json` written by
 * the close-tail (`emitEpicPerfReport`) from disk and shape it into the
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
  loadPerfReportFn = loadPerfReportFromDisk,
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
  const body = renderHandoffBody({
    epicId,
    prNumber,
    prUrl: prUrl ?? null,
    perfReport: resolvedPerfReport,
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

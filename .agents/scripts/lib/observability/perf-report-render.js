/**
 * perf-report-render.js — pure renderers + summary extraction for the
 * structured perf-summary comments (Epic #1030 / Story #1123, split out
 * under Story #3350).
 *
 * Every export here is a pure function: it depends only on its inputs and
 * performs no I/O. The Story-/Epic-mode orchestrators in
 * `analyze-execution.js` read NDJSON, phase-timings, and git-log records
 * via the sibling `perf-report-readers.js`, then hand the resulting plain
 * objects to these renderers. Keeping the render surface free of I/O makes
 * the report formatting unit-testable without fixtures.
 *
 * `extractStoryPerfSummaryFromComment` is the one mixed read/parse helper —
 * it parses a comment body that originated from `renderStoryBody`, so it
 * lives next to the renderer it mirrors. It delegates the fenced-JSON
 * extraction to `parseFencedJsonComment` (the shared structured-comment
 * parser) rather than open-coding the fence regex.
 *
 * @see docs/data-dictionary.md §StoryPerfSummary, §EpicPerfReport
 */

import { parseFencedJsonComment } from '../orchestration/structured-comment-parser.js';

export const STORY_PERF_TYPE = 'story-perf-summary';
export const EPIC_PERF_TYPE = 'epic-perf-report';
// Marker emitted by `upsertStructuredComment` for the story-perf-summary
// type. Mirrors `structuredCommentMarker(STORY_PERF_TYPE)` so the Epic
// rollup can detect summary comments without importing the renderer.
export const STORY_PERF_MARKER = `<!-- ap:structured-comment type="${STORY_PERF_TYPE}" -->`;

/**
 * Render a small operator-facing summary block that doubles as the
 * comment body. The fenced JSON payload is the canonical machine-
 * readable surface; the prose lines above it give a human a reason to
 * skim. The retro composer reads the fenced JSON, not the prose.
 */
export function renderStoryBody(payload) {
  const friction = Object.entries(payload.frictionByCategory ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  const phaseRows = Object.entries(payload.phaseTimingsMs ?? {})
    .map(([k, v]) => `- \`${k}\`: ${v}ms`)
    .join('\n');
  const lines = [
    `### Story Perf Summary — Story #${payload.storyId} (Epic #${payload.epicId})`,
    '',
    `Closed at: \`${payload.closedAt}\``,
    '',
    friction.length > 0
      ? `**Friction:** ${friction}`
      : '**Friction:** none recorded',
    '',
    phaseRows.length > 0
      ? `**Phase timings:**\n${phaseRows}`
      : '**Phase timings:** none recorded',
    '',
    `**Rework:** ${payload.reworkScore.filesEditedBeyondThreshold} files beyond threshold`,
    `**Retries:** ${payload.retryDensity.retries} across ${payload.retryDensity.uniqueCommands} unique command(s)`,
    '',
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
  ];
  return lines.join('\n');
}

/**
 * Render the optional Quality-gate friction summary block (Story #1400 /
 * Task #1429). Aggregates `baseline-refresh-regression` friction records
 * from the Stories' signals.ndjson streams over the trailing window,
 * counts them, and lists the top offenders by file/method.
 *
 * Output contract:
 *   - `friction == null` → empty string (caller injected nothing).
 *   - `friction.totalRecords === 0` → `**Quality gate friction:** none`
 *   - otherwise → count line + bulleted top-offenders list
 *
 * The block reads the existing `signals.ndjson` stream — no new file
 * format. Aggregation is provided by `aggregateBaselineFrictionFromSignals`
 * which the unit test can stub via `runEpicMode({ aggregateFrictionFn })`.
 */
export function renderQualityGateFrictionBlock(friction) {
  if (!friction) return '';
  const total = friction.totalRecords ?? 0;
  if (total === 0) {
    return ['', '**Quality gate friction:** none', ''].join('\n');
  }
  const offenders = (friction.topOffenders ?? [])
    .map((o) => {
      const where = o.method ? `${o.file} → ${o.method}` : o.file;
      return `- \`${where}\` — ${o.occurrences} occurrence(s)`;
    })
    .join('\n');
  return [
    '',
    `**Quality gate friction:** ${total} \`baseline-refresh-regression\` record(s) across ${friction.storiesAffected ?? 0} Story/Stories`,
    offenders.length > 0 ? `\nTop offenders:\n${offenders}` : '',
    '',
  ].join('\n');
}

/**
 * Render the per-Epic baseline-refresh-rate row (Story #1400 / Task #1427).
 * Returns an empty string when `refresh` is null so the caller can
 * concatenate unconditionally.
 */
export function renderBaselineRefreshRateRow(refresh) {
  if (!refresh) return '';
  const row = (refresh.perEpic ?? [])[0];
  if (!row) {
    return [
      '',
      `**Baseline refresh discipline (trailing ${refresh.windowDays}d):** no Story merges in window`,
      '',
    ].join('\n');
  }
  const pct = (row.cleanMergeRate * 100).toFixed(1);
  const target = row.cleanMergeRate >= 0.9 ? '✅' : '⚠️';
  return [
    '',
    `**Baseline refresh discipline (trailing ${refresh.windowDays}d):** ${target} ${pct}% clean-merge rate (${row.storyMerges - row.baselineRefreshes}/${row.storyMerges} Stories landed without follow-up refresh; ${row.baselineRefreshes} \`baseline-refresh:\` commit(s))`,
    '',
  ].join('\n');
}

export function renderEpicBody(payload, extras = {}) {
  const counts = payload.signalCounts ?? {};
  const countLine = Object.entries(counts)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  const hotspots = (payload.topHotspots ?? [])
    .map(
      (h) =>
        `- \`${h.phase}\` — ${h.occurrences} occurrence(s), avg ratio ${h.avgRatio.toFixed(2)}`,
    )
    .join('\n');
  const friction = (payload.mostFrictionStories ?? [])
    .map((s) => `- Story #${s.storyId}: ${s.frictionCount} friction signal(s)`)
    .join('\n');
  const lines = [
    `### Epic Perf Report — Epic #${payload.epicId}`,
    '',
    `Generated at: \`${payload.generatedAt}\``,
    '',
    `**Signal counts:** ${countLine.length > 0 ? countLine : 'none'}`,
    '',
    hotspots.length > 0
      ? `**Top hotspots:**\n${hotspots}`
      : '**Top hotspots:** none recorded',
    '',
    friction.length > 0
      ? `**Most-friction Stories:**\n${friction}`
      : '**Most-friction Stories:** none recorded',
    renderBaselineRefreshRateRow(extras.baselineRefreshRate),
    renderQualityGateFrictionBlock(extras.qualityGateFriction),
    '',
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
  ];
  return lines.join('\n');
}

/**
 * Extract a story-perf-summary payload from a comment body. The body
 * begins with the structured marker line, followed by markdown prose,
 * followed by a fenced ```json``` block carrying the canonical payload.
 * We delegate the fence extraction to `parseFencedJsonComment` so the
 * fenced-JSON regex lives in exactly one place.
 *
 * Returns `null` when the marker is missing, no fence is found, or the
 * fence does not parse — the caller treats absence as "no signal" and
 * keeps walking.
 */
export function extractStoryPerfSummaryFromComment(body) {
  if (typeof body !== 'string' || !body.includes(STORY_PERF_MARKER)) {
    return null;
  }
  const parsed = parseFencedJsonComment({ body });
  if (parsed && parsed.kind === 'story-perf-summary') return parsed;
  return null;
}

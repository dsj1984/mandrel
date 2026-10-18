/**
 * Filter agent-cost rows and summarise them by agentType × effort × model
 * (Story #5607). Pure functions over the rows `read-transcripts.js` builds.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse a `--since` / `--until` bound. A date-only `--until` covers that whole
 * day, so `--until 2026-10-01` keeps rows started on October 1st.
 *
 * @param {string|undefined} value
 * @param {'since'|'until'} kind
 * @returns {number|null} epoch ms, or null when unset
 */
export function parseBound(value, kind) {
  if (value == null) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new Error(`--${kind} is not an ISO date: ${value}`);
  }
  return kind === 'until' && DATE_ONLY.test(value) ? ms + DAY_MS - 1 : ms;
}

/**
 * @param {import('./read-transcripts.js').CostRow[]} rows
 * @param {{ sinceMs?: number|null, untilMs?: number|null,
 *   agentType?: string|null, skill?: string|null }} filters
 */
export function filterRows(rows, filters = {}) {
  const { sinceMs = null, untilMs = null, agentType, skill } = filters;
  return rows.filter((row) => {
    if (agentType && row.agentType !== agentType) return false;
    if (skill && row.skill !== skill) return false;
    if (sinceMs == null && untilMs == null) return true;
    const started = Date.parse(row.startedAt ?? '');
    if (Number.isNaN(started)) return false;
    if (sinceMs != null && started < sinceMs) return false;
    if (untilMs != null && started > untilMs) return false;
    return true;
  });
}

/**
 * @param {number[]} values
 * @returns {number|null}
 */
function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Nearest-rank p90.
 *
 * @param {number[]} values
 * @returns {number|null}
 */
function p90(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(0.9 * sorted.length) - 1)];
}

/**
 * @param {number[]} values
 */
function stats(values) {
  return { median: median(values), p90: p90(values) };
}

/**
 * Group rows by `(agentType, primary effort, primary model)`.
 *
 * @param {import('./read-transcripts.js').CostRow[]} rows
 */
export function summarize(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = JSON.stringify([
      row.agentType,
      row.primaryEffort,
      row.primaryModel,
    ]);
    if (!groups.has(key)) {
      groups.set(key, {
        agentType: row.agentType,
        effort: row.primaryEffort,
        model: row.primaryModel,
        rows: [],
      });
    }
    groups.get(key).rows.push(row);
  }
  const summarized = [...groups.values()].map((g) => {
    const tokens = g.rows.map((r) => r.totalTokens);
    const walls = g.rows.map((r) => r.wallMs).filter((w) => w != null);
    return {
      agentType: g.agentType,
      effort: g.effort,
      model: g.model,
      count: g.rows.length,
      totalTokens: { sum: sum(tokens), ...stats(tokens) },
      wallMs: { sum: sum(walls), ...stats(walls) },
      rowsWithEffortChange: g.rows.filter((r) => r.effortChanges > 0).length,
      cacheCreationAfterFirstEffortChange: sum(
        g.rows.map((r) => r.cacheCreationAfterFirstEffortChange),
      ),
    };
  });
  summarized.sort(
    (a, b) =>
      b.totalTokens.sum - a.totalTokens.sum ||
      String(a.agentType).localeCompare(String(b.agentType)),
  );
  return {
    groups: summarized,
    perStory: summarizePerStory(rows),
    totals: {
      rows: rows.length,
      messages: sum(rows.map((r) => r.messages)),
      totalTokens: sum(rows.map((r) => r.totalTokens)),
      wallMs: sum(rows.map((r) => r.wallMs ?? 0)),
      rowsWithEffortChange: rows.filter((r) => r.effortChanges > 0).length,
      cacheCreationAfterFirstEffortChange: sum(
        rows.map((r) => r.cacheCreationAfterFirstEffortChange),
      ),
    },
  };
}

/**
 * One entry per non-null storyId: row count, token and wall sums, the landed
 * diff (Story #5766) and tokens per changed line. Sorted by storyId
 * descending.
 *
 * @param {Array<import('./read-transcripts.js').CostRow & {
 *   delivered?: import('./delivered-diff.js').DeliveredDiff|null }>} rows
 */
function summarizePerStory(rows) {
  const byStory = new Map();
  for (const row of rows) {
    if (row.storyId == null) continue;
    if (!byStory.has(row.storyId)) byStory.set(row.storyId, []);
    byStory.get(row.storyId).push(row);
  }
  return [...byStory.entries()]
    .sort(([a], [b]) => b - a)
    .map(([storyId, storyRows]) => perStoryEntry(storyId, storyRows));
}

/**
 * @param {number} storyId
 * @param {Parameters<typeof summarizePerStory>[0]} storyRows
 */
function perStoryEntry(storyId, storyRows) {
  const totalTokens = sum(storyRows.map((r) => r.totalTokens));
  const delivered = storyRows[0].delivered ?? null;
  return {
    storyId,
    rows: storyRows.length,
    totalTokens,
    wallMs: sum(storyRows.map((r) => r.wallMs ?? 0)),
    delivered,
    tokensPerChangedLine: perChangedLine(totalTokens, delivered),
  };
}

/**
 * @param {number} totalTokens
 * @param {import('./delivered-diff.js').DeliveredDiff|null} delivered
 * @returns {number|null}
 */
function perChangedLine(totalTokens, delivered) {
  const changed = delivered ? delivered.insertions + delivered.deletions : 0;
  return changed > 0 ? totalTokens / changed : null;
}

/**
 * @param {number[]} values
 */
function sum(values) {
  return values.reduce((acc, v) => acc + v, 0);
}

/**
 * @param {number|null} n
 */
function fmt(n) {
  return n == null ? '—' : Math.round(n).toLocaleString('en-US');
}

/**
 * @param {number|null} ms
 */
function fmtSeconds(ms) {
  return ms == null ? '—' : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Render the summary as Markdown.
 *
 * @param {ReturnType<typeof summarize>} summary
 * @param {{ projectDirs: string[], filters: object, skippedLines: number,
 *   base?: string }} context
 * @returns {string}
 */
export function renderSummaryMarkdown(summary, context) {
  const { totals } = summary;
  const activeFilters = Object.entries(context.filters).filter(
    ([, v]) => v != null && v !== '',
  );
  const lines = [
    '# Agent cost summary',
    '',
    `- Project dirs: ${context.projectDirs.join(', ')}`,
    `- Filters: ${
      activeFilters.length === 0
        ? 'none'
        : activeFilters.map(([k, v]) => `${k}=${v}`).join(', ')
    }`,
    `- Rows: ${totals.rows} · messages: ${fmt(totals.messages)} · total tokens: ${fmt(totals.totalTokens)}`,
    `- Rows with a mid-session effort change: ${totals.rowsWithEffortChange} · cache creation after first change: ${fmt(totals.cacheCreationAfterFirstEffortChange)}`,
    `- Skipped unparseable lines: ${context.skippedLines}`,
    ...(context.base ? [`- Delivered diffs from: ${context.base}`] : []),
    '',
    '| agentType | effort | model | count | tokens median | tokens p90 | tokens sum | wall median | wall p90 | effort-changed rows | cache after change |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const g of summary.groups) {
    lines.push(
      `| ${g.agentType} | ${g.effort ?? '—'} | ${g.model ?? '—'} | ${g.count} | ${fmt(g.totalTokens.median)} | ${fmt(g.totalTokens.p90)} | ${fmt(g.totalTokens.sum)} | ${fmtSeconds(g.wallMs.median)} | ${fmtSeconds(g.wallMs.p90)} | ${g.rowsWithEffortChange} | ${fmt(g.cacheCreationAfterFirstEffortChange)} |`,
    );
  }
  lines.push('', ...renderPerStoryTable(summary.perStory ?? []));
  return lines.join('\n');
}

/**
 * The `## Per Story` table; `—` where the Story has no landed commit.
 *
 * @param {ReturnType<typeof summarizePerStory>} perStory
 * @returns {string[]}
 */
function renderPerStoryTable(perStory) {
  const lines = [
    '## Per Story',
    '',
    '| story | agent rows | tokens sum | wall sum | +/- lines | files | tokens per changed line |',
    '| ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  lines.push(...perStory.map(perStoryLine));
  lines.push('');
  return lines;
}

/**
 * @param {ReturnType<typeof perStoryEntry>} s
 * @returns {string}
 */
function perStoryLine(s) {
  const d = s.delivered;
  const diff = d ? `+${d.insertions}/-${d.deletions} | ${d.files}` : '— | —';
  return `| #${s.storyId} | ${s.rows} | ${fmt(s.totalTokens)} | ${fmtSeconds(s.wallMs)} | ${diff} | ${fmt(s.tokensPerChangedLine)} |`;
}

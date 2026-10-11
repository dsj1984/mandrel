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
 * @param {{ projectDirs: string[], filters: object, skippedLines: number }} context
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
    '',
    '| agentType | effort | model | count | tokens median | tokens p90 | tokens sum | wall median | wall p90 | effort-changed rows | cache after change |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const g of summary.groups) {
    lines.push(
      `| ${g.agentType} | ${g.effort ?? '—'} | ${g.model ?? '—'} | ${g.count} | ${fmt(g.totalTokens.median)} | ${fmt(g.totalTokens.p90)} | ${fmt(g.totalTokens.sum)} | ${fmtSeconds(g.wallMs.median)} | ${fmtSeconds(g.wallMs.p90)} | ${g.rowsWithEffortChange} | ${fmt(g.cacheCreationAfterFirstEffortChange)} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

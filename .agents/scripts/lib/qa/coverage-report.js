// .agents/scripts/lib/qa/coverage-report.js
//
// Render an AC × test-tier coverage matrix to a human-readable markdown
// report and persist it under `<tempRoot>/qa/`.
//
// The matrix shape is produced by `lib/qa/coverage-verdict.js#acceptanceMatrix`
// — one row per acceptance criterion, each row carrying the per-tier
// `coverageVerdict` (`{unit, contract, acceptance}` with `present`/`absent`
// statuses + notes). This module is the presentation + persistence seam:
//   - {@link renderCoverageReport}  — pure: matrix → markdown string.
//   - {@link reportPathFor}         — the report path under `<tempRoot>/qa/`.
//   - {@link writeCoverageReport}   — render + write the markdown to disk.
//
// `renderCoverageReport` does no I/O so it stays trivially unit-testable;
// `writeCoverageReport` accepts an injectable `fsImpl` (default `node:fs`)
// for the same reason, mirroring `lib/qa/qa-session.js`.

import fs from 'node:fs';
import path from 'node:path';

import { tempRootFrom } from '../config/temp-paths.js';
import { acceptanceMatrix, TIERS } from './coverage-verdict.js';

/** Directory segment (under `tempRoot`) that holds QA coverage reports. */
export const QA_REPORT_DIRNAME = 'qa';

/** Cell glyph for each verdict status, used in the markdown matrix table. */
const STATUS_GLYPH = Object.freeze({
  present: '✅ present',
  absent: '❌ absent',
});

/** Title-case a tier name for the table header (`unit` → `Unit`). */
function tierHeader(tier) {
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

/**
 * Escape the pipe character so a label never breaks the markdown table, and
 * collapse newlines to spaces so a multi-line criterion stays on one row.
 */
function cell(value) {
  return String(value ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
}

/**
 * Resolve the matrix input. Accepts either a pre-built matrix
 * (`{tiers, rows}` from {@link acceptanceMatrix}) or raw criteria (array or
 * keyed object), in which case it is run through {@link acceptanceMatrix}.
 *
 * @param {object|Array} input
 * @returns {{tiers: ReadonlyArray<string>, rows: Array}}
 */
function resolveMatrix(input) {
  if (
    input &&
    typeof input === 'object' &&
    !Array.isArray(input) &&
    Array.isArray(input.rows)
  ) {
    return { tiers: input.tiers ?? TIERS, rows: input.rows };
  }
  return acceptanceMatrix(input);
}

/**
 * Render an AC × test-tier coverage matrix to a markdown report string.
 *
 * The report has a title, a one-line summary of how many criteria are fully
 * covered, the matrix table (one row per AC, one column per tier), and a
 * per-criterion notes section explaining each absent tier.
 *
 * @param {{tiers?:ReadonlyArray<string>,rows:Array}|Array|object} input
 *   Either a built matrix (`{tiers, rows}`) or raw criteria to build one from.
 * @param {{ title?: string, generatedAt?: string }} [opts]
 * @returns {string} The markdown report.
 */
export function renderCoverageReport(input, opts = {}) {
  const { tiers, rows } = resolveMatrix(input);
  const title =
    typeof opts.title === 'string' && opts.title.trim() !== ''
      ? opts.title.trim()
      : 'QA Coverage — AC × Test-Tier Matrix';

  const fullyCovered = rows.filter((row) =>
    tiers.every((tier) => row.verdict[tier]?.status === 'present'),
  ).length;

  const lines = [];
  lines.push(`# ${title}`);
  lines.push('');
  if (typeof opts.generatedAt === 'string' && opts.generatedAt.trim() !== '') {
    lines.push(`_Generated: ${opts.generatedAt.trim()}_`);
    lines.push('');
  }
  lines.push(
    `${rows.length} acceptance criteri${rows.length === 1 ? 'on' : 'a'}, ` +
      `${fullyCovered} fully covered across all ${tiers.length} tiers.`,
  );
  lines.push('');

  // Matrix table.
  const headerCells = ['Acceptance Criterion', ...tiers.map(tierHeader)];
  lines.push(`| ${headerCells.join(' | ')} |`);
  lines.push(`| ${headerCells.map(() => '---').join(' | ')} |`);
  for (const row of rows) {
    const acCell = cell(row.label ? `${row.id}: ${row.label}` : row.id);
    const tierCells = tiers.map((tier) => {
      const status = row.verdict[tier]?.status ?? 'absent';
      return STATUS_GLYPH[status] ?? cell(status);
    });
    lines.push(`| ${[acCell, ...tierCells].join(' | ')} |`);
  }
  lines.push('');

  // Per-criterion notes.
  lines.push('## Notes');
  lines.push('');
  for (const row of rows) {
    lines.push(
      `### ${cell(row.id)}${row.label ? ` — ${cell(row.label)}` : ''}`,
    );
    for (const tier of tiers) {
      const v = row.verdict[tier];
      const status = v?.status ?? 'absent';
      const note = v?.note ?? '';
      lines.push(`- **${tierHeader(tier)}** (${status}): ${cell(note)}`);
    }
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * The report path under `<tempRoot>/qa/`.
 *
 * @param {string} [fileName] Report file name (default `coverage-report.md`).
 *   Path separators are rejected so a caller cannot escape the `qa/` dir.
 * @param {object} [config] Resolved config bag (for `project.paths.tempRoot`).
 * @returns {string}
 */
export function reportPathFor(fileName = 'coverage-report.md', config) {
  const name = String(fileName);
  if (name.includes('/') || name.includes('\\') || name === '..') {
    throw new Error(
      `[coverage-report] file name must not contain path separators; got ${JSON.stringify(name)}`,
    );
  }
  return path.join(tempRootFrom(config), QA_REPORT_DIRNAME, name);
}

/**
 * Render the matrix to markdown and write it under `<tempRoot>/qa/`, creating
 * the directory if needed. Returns the resolved path and the rendered body.
 *
 * @param {{tiers?:ReadonlyArray<string>,rows:Array}|Array|object} input
 *   Either a built matrix or raw criteria.
 * @param {{
 *   fileName?: string,
 *   config?: object,
 *   title?: string,
 *   generatedAt?: string,
 *   fsImpl?: typeof fs,
 * }} [opts]
 * @returns {{ path: string, markdown: string }}
 */
export function writeCoverageReport(input, opts = {}) {
  const fsImpl = opts.fsImpl ?? fs;
  const markdown = renderCoverageReport(input, {
    title: opts.title,
    generatedAt: opts.generatedAt,
  });
  const reportPath = reportPathFor(opts.fileName, opts.config);
  fsImpl.mkdirSync(path.dirname(reportPath), { recursive: true });
  fsImpl.writeFileSync(reportPath, markdown, 'utf8');
  return { path: reportPath, markdown };
}

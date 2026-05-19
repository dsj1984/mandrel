/**
 * lib/audit-to-stories/parse-audit-md.js — Parse `audit-*-results.md` reports.
 *
 * Extracts the `## Detailed Findings` section of an audit report and turns
 * every `### <title>` block into a normalised finding record. The 12 audit
 * workflows use slightly different field names — `Severity` vs `Impact`,
 * `Dimension` vs `Category` — so the parser captures every key/value pair
 * the block carries and normalises the two axes the downstream pipeline
 * relies on (severity + dimension).
 *
 * Pure: no filesystem I/O. The caller supplies the report text and source
 * path; the parser returns plain objects.
 */

import path from 'node:path';

const SEVERITY_ALIASES = Object.freeze({
  critical: 'critical',
  high: 'high',
  medium: 'medium',
  mod: 'medium',
  moderate: 'medium',
  low: 'low',
});

const KEY_LINE = /^\s*-\s*\*\*([^:*]+):\*\*\s*(.*)$/;
const HEADING_FINDING = /^###\s+(.+?)\s*$/;
const HEADING_SECTION = /^##\s+(.+?)\s*$/;
const PATH_HINT =
  /(?<![\w/])([A-Za-z0-9_./\\@-]+\.(?:js|ts|tsx|jsx|mjs|cjs|md|json|yaml|yml|css|scss|html|py|go|rs|java|kt|rb|sh|ps1|tf|env))(?![\w])/g;

function unwrapInlineCode(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (trimmed.startsWith('`') && trimmed.endsWith('`') && trimmed.length >= 2) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function normaliseSeverity(token) {
  if (typeof token !== 'string') return null;
  const cleaned = token
    .toLowerCase()
    .replace(/\[|\]|\(|\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  for (const word of cleaned.split(/[\s|/,]+/)) {
    const hit = SEVERITY_ALIASES[word];
    if (hit) return hit;
  }
  return null;
}

function deriveDimension(fields, fallbackDimension) {
  for (const key of ['dimension', 'category', 'area']) {
    const raw = fields[key];
    if (typeof raw === 'string' && raw.trim().length > 0) {
      return raw
        .replace(/\[|\]/g, '')
        .trim()
        .split(/\s*\|\s*/)[0];
    }
  }
  return fallbackDimension;
}

function deriveSeverity(fields) {
  for (const key of ['severity', 'impact', 'risk']) {
    const sev = normaliseSeverity(fields[key]);
    if (sev) return sev;
  }
  return null;
}

function normaliseTitle(title) {
  return title
    .toLowerCase()
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 -]/g, '')
    .trim();
}

function extractFilePaths(text) {
  if (typeof text !== 'string') return [];
  const seen = new Set();
  for (const match of text.matchAll(PATH_HINT)) {
    const candidate = match[1].replace(/^[`'"]+|[`'"]+$/g, '');
    if (candidate.includes('/') || candidate.includes('\\')) {
      seen.add(candidate);
    }
  }
  return [...seen];
}

function inferDimensionFromReportName(sourceReport) {
  if (typeof sourceReport !== 'string' || sourceReport.length === 0)
    return 'unknown';
  const base = path.basename(sourceReport, path.extname(sourceReport));
  const match = base.match(/^audit-(.+?)(?:-results)?$/);
  return match ? match[1] : base;
}

function splitFindingBlocks(reportText) {
  const lines = reportText.split(/\r?\n/);
  let inDetailed = false;
  const blocks = [];
  let current = null;

  for (const line of lines) {
    const sectionMatch = HEADING_SECTION.exec(line);
    if (sectionMatch) {
      if (current) {
        blocks.push(current);
        current = null;
      }
      const sectionTitle = sectionMatch[1].toLowerCase();
      inDetailed = sectionTitle.includes('detailed findings');
      continue;
    }

    if (!inDetailed) continue;

    const findingMatch = HEADING_FINDING.exec(line);
    if (findingMatch) {
      if (current) blocks.push(current);
      current = { title: findingMatch[1].trim(), bodyLines: [] };
      continue;
    }

    if (current) current.bodyLines.push(line);
  }

  if (current) blocks.push(current);
  return blocks;
}

function parseBlockFields(bodyLines) {
  const fields = {};
  let activeKey = null;
  for (const line of bodyLines) {
    const m = KEY_LINE.exec(line);
    if (m) {
      activeKey = m[1].trim().toLowerCase();
      fields[activeKey] = unwrapInlineCode(m[2]);
      continue;
    }
    if (activeKey && line.trim().length > 0) {
      const continuation = unwrapInlineCode(line.replace(/^\s+/, ''));
      if (continuation) {
        fields[activeKey] = fields[activeKey]
          ? `${fields[activeKey]} ${continuation}`
          : continuation;
      }
    }
  }
  return fields;
}

/**
 * Parse a single audit report's markdown text into a list of normalised
 * findings.
 *
 * @param {object} params
 * @param {string} params.markdown — full report text.
 * @param {string} params.sourceReport — path used for `sourceReport` field
 *   and dimension inference when the report omits a `Dimension:` line.
 * @returns {Array<{
 *   dimension: string,
 *   severity: 'critical'|'high'|'medium'|'low'|null,
 *   title: string,
 *   normalisedTitle: string,
 *   files: string[],
 *   currentState: string,
 *   recommendation: string,
 *   agentPrompt: string,
 *   rawFields: Record<string,string>,
 *   sourceReport: string,
 * }>}
 */
export function parseAuditReport({ markdown, sourceReport }) {
  if (typeof markdown !== 'string') {
    throw new Error('parseAuditReport: markdown must be a string');
  }
  if (typeof sourceReport !== 'string' || sourceReport.length === 0) {
    throw new Error('parseAuditReport: sourceReport path is required');
  }

  const fallbackDimension = inferDimensionFromReportName(sourceReport);
  const blocks = splitFindingBlocks(markdown);

  return blocks.map((block) => {
    const fields = parseBlockFields(block.bodyLines);
    const dimension = deriveDimension(fields, fallbackDimension);
    const severity = deriveSeverity(fields);
    const currentState = fields['current state'] ?? '';
    const recommendation =
      fields['recommendation & rationale'] ?? fields.recommendation ?? '';
    const agentPrompt = fields['agent prompt'] ?? '';
    const fileSet = new Set([
      ...extractFilePaths(currentState),
      ...extractFilePaths(recommendation),
      ...extractFilePaths(agentPrompt),
    ]);

    return {
      dimension: dimension.toLowerCase(),
      severity,
      title: block.title,
      normalisedTitle: normaliseTitle(block.title),
      files: [...fileSet],
      currentState,
      recommendation,
      agentPrompt,
      rawFields: fields,
      sourceReport,
    };
  });
}

/**
 * Parse N audit reports and return a flat findings array. Reports without a
 * `## Detailed Findings` section yield zero entries rather than throwing —
 * an audit can legitimately come back empty.
 *
 * @param {Array<{ markdown: string, sourceReport: string }>} reports
 * @returns {Array<ReturnType<typeof parseAuditReport>[number]>}
 */
export function parseAuditReports(reports) {
  if (!Array.isArray(reports)) {
    throw new Error('parseAuditReports: reports must be an array');
  }
  const out = [];
  for (const report of reports) {
    out.push(...parseAuditReport(report));
  }
  return out;
}

export const __testing = {
  normaliseSeverity,
  extractFilePaths,
  normaliseTitle,
};

/**
 * Parse `## Detailed Findings` of audit reports into normalised findings.
 * Pure.
 */

import path from 'node:path';

import { normalizeSeverity } from '../findings/severity.js';

// Accept the colon inside or outside the bold run (`**Severity:**` and
// `**Severity**:`); missing either drops the axis and misreads the finding as a
// grouping header.
const KEY_LINE = /^\s*-\s*\*\*([^:*]+?)\s*(?::\*\*|\*\*\s*:)\s*(.*)$/;
const HEADING_FINDING = /^(#{3,4})\s+(.+?)\s*$/;
const SEVERITY_KEY_LINE =
  /^\s*-\s*\*\*(?:severity|impact)\s*(?::\*\*|\*\*\s*:)/i;
const TALLY_LINE =
  /severity\s+tally\s*:?\**\s*critical\s+(\d+)\s*\/\s*high\s+(\d+)\s*\/\s*medium\s+(\d+)\s*\/\s*low\s+(\d+)/i;
const TALLY_LINE_GLOBAL = new RegExp(TALLY_LINE.source, 'gi');
const HEADING_SECTION = /^##\s+(.+?)\s*$/;
const PATH_HINT =
  /(?<![\w/])([A-Za-z0-9_./\\@-]+\.(?:js|ts|tsx|jsx|mjs|cjs|md|json|yaml|yml|css|scss|html|py|go|rs|java|kt|rb|sh|ps1|tf|env))(?![\w])/g;
const FILE_EXT =
  /\.(?:js|ts|tsx|jsx|mjs|cjs|md|json|yaml|yml|css|scss|html|py|go|rs|java|kt|rb|sh|ps1|tf|env)$/;
const TITLE_ANCHOR = /^\s*`([^`]+)`/;

function unwrapInlineCode(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (trimmed.startsWith('`') && trimmed.endsWith('`') && trimmed.length >= 2) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/**
 * Delegates to the canonical normaliser so this parser never knows a narrower
 * vocabulary than the pipeline. Returns `null` (not `info`) for no severity,
 * so {@link deriveSeverity} can tell "no severity" from "said `info`".
 *
 * @param {unknown} token
 * @returns {string|null}
 */
function normaliseSeverity(token) {
  if (typeof token !== 'string') return null;
  const cleaned = token
    .toLowerCase()
    .replace(/\[|\]|\(|\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  for (const word of cleaned.split(/[\s|/,]+/)) {
    const hit = normalizeSeverity(word, null);
    if (hit) return hit;
  }
  return null;
}

function deriveDimension(fields, fallbackDimension) {
  for (const key of ['dimension', 'category', 'area', 'type']) {
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

/**
 * Repo-relative path, or `null` for an absolute (outside `repoRoot`) or
 * degenerate token. A bare root-level file (`AGENTS.md`) is accepted in
 * structured fields; `requireSeparator` rejects it in prose, where it is more
 * likely a word.
 *
 * @param {string} raw
 * @param {string} [repoRoot] Absolute tokens beneath it are relativised.
 * @param {{ requireSeparator?: boolean }} [options]
 * @returns {string|null}
 */
function normalisePathToken(raw, repoRoot, { requireSeparator = false } = {}) {
  if (typeof raw !== 'string') return null;
  const stripped = raw
    .replace(/^[`'"([]+/, '')
    .replace(/[`'")\].,;]+$/, '')
    .trim();
  // `Location:` anchors appear as `:line`, `:line:col`, and `:start-end`.
  const cleaned = stripped.replace(/:\d+(?:-\d+)?(?::\d+)?$/, '');
  if (!cleaned || cleaned === '.' || cleaned === '..') return null;

  let out = cleaned;
  if (typeof repoRoot === 'string' && repoRoot.length > 0) {
    for (const sep of ['/', '\\']) {
      const root = repoRoot.endsWith(sep) ? repoRoot : `${repoRoot}${sep}`;
      if (out.startsWith(root)) {
        out = out.slice(root.length);
        break;
      }
    }
  }
  // Still absolute ⇒ outside the repo; never a valid group key.
  if (out.startsWith('/') || out.startsWith('\\') || /^[A-Za-z]:/.test(out)) {
    return null;
  }
  const hasSeparator = out.includes('/') || out.includes('\\');
  if (requireSeparator && !hasSeparator) return null;
  if (!hasSeparator && !FILE_EXT.test(out)) return null;
  return out;
}

/**
 * The mandated title anchor (``### `path` — title``) is the strongest
 * primary-file signal, so it seeds `files[0]` ahead of `Location:` and prose.
 */
function deriveTitleFile(title, repoRoot) {
  const match = TITLE_ANCHOR.exec(typeof title === 'string' ? title : '');
  if (!match) return [];
  const normalised = normalisePathToken(match[1], repoRoot);
  return normalised ? [normalised] : [];
}

/**
 * `Location:` paths with `:line` suffixes and backticks stripped.
 *
 * @param {Record<string, string>} fields
 * @returns {string[]}
 */
function deriveLocationFiles(fields, repoRoot) {
  const raw = fields.location;
  if (typeof raw !== 'string' || raw.trim().length === 0) return [];
  const cleaned = raw.replace(/[`[\]]/g, ' ');
  const out = [];
  for (const token of cleaned.split(/[\s,]+/)) {
    if (!token) continue;
    const normalised = normalisePathToken(token, repoRoot);
    if (normalised) out.push(normalised);
  }
  return out;
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

function extractFilePaths(text, repoRoot) {
  if (typeof text !== 'string') return [];
  const seen = new Set();
  for (const match of text.matchAll(PATH_HINT)) {
    // Prose: a bare `description.md` is more likely a word than a path.
    const normalised = normalisePathToken(match[1], repoRoot, {
      requireSeparator: true,
    });
    if (normalised) seen.add(normalised);
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
      current = {
        level: findingMatch[1].length,
        title: findingMatch[2].trim(),
        bodyLines: [],
      };
      continue;
    }

    if (current) current.bodyLines.push(line);
  }

  if (current) blocks.push(current);
  return blocks;
}

/**
 * @param {{ bodyLines: string[] }} block
 * @returns {boolean}
 */
function carriesSeverity(block) {
  return block.bodyLines.some((line) => SEVERITY_KEY_LINE.test(line));
}

/**
 * @param {{ bodyLines: string[] }} block
 * @returns {boolean}
 */
function carriesFieldBullet(block) {
  return block.bodyLines.some((line) => KEY_LINE.test(line));
}

/**
 * No severity and no field bullets (e.g. a header over `_No findings._`) —
 * never a finding, or an unattended sweep files an empty Story.
 *
 * @param {{ bodyLines: string[] }} block
 * @returns {boolean}
 */
function isEmptyBlock(block) {
  return !carriesSeverity(block) && !carriesFieldBullet(block);
}

/**
 * Is a `###` block a grouping header over `####` findings? Not if it declares
 * fields or leads with a path anchor (its `#### Evidence` children fold in).
 * Otherwise yes when it has no children, any anchored child, or more than one
 * severity-bearing child; a single such child is the Evidence shape and folds.
 *
 * @param {{ title: string, bodyLines: string[] }} parent
 * @param {Array<{ title: string, bodyLines: string[] }>} children
 * @returns {boolean}
 */
function isGroupingHeader(parent, children) {
  if (!isEmptyBlock(parent)) return false;
  if (TITLE_ANCHOR.test(parent.title)) return false;
  if (children.length === 0) return true;
  if (children.some((child) => TITLE_ANCHOR.test(child.title))) return true;
  return children.filter((child) => carriesSeverity(child)).length > 1;
}

/**
 * @param {Array<{ level: number, title: string, bodyLines: string[] }>} blocks
 * @returns {Array<{ level: number, title: string, bodyLines: string[] }>}
 */
function foldGroupingHeaders(blocks) {
  const out = [];
  const keep = (block) => {
    if (!isEmptyBlock(block)) out.push(block);
  };

  let i = 0;
  while (i < blocks.length) {
    const block = blocks[i];
    if (block.level > 3) {
      // A `####` with no `###` parent above it — read it on its own terms.
      keep(block);
      i += 1;
      continue;
    }
    const children = [];
    let j = i + 1;
    while (j < blocks.length && blocks[j].level > 3) {
      children.push(blocks[j]);
      j += 1;
    }
    if (isGroupingHeader(block, children)) {
      for (const child of children) keep(child);
    } else {
      for (const child of children) {
        block.bodyLines.push(`#### ${child.title}`, ...child.bodyLines);
      }
      keep(block);
    }
    i = j;
  }
  return out;
}

/**
 * @param {string} markdown
 * @returns {{ start: number, end: number }|null} character offsets.
 */
function executiveSummaryRange(markdown) {
  const heading = /^##\s+executive\s+summary\s*$/gim;
  const opened = heading.exec(markdown);
  if (!opened) return null;
  const start = opened.index + opened[0].length;
  const next = /^##\s+/gm;
  next.lastIndex = start;
  const closed = next.exec(markdown);
  return { start, end: closed ? closed.index : markdown.length };
}

/**
 * The declared severity tally, for cross-checking the parse against what the
 * lens says it found. Fails closed (`duplicate`) on more than one tally line,
 * since adopting either would make the cross-check arbitrary. `Info` is never
 * counted.
 *
 * @param {string} markdown
 * @returns {{ tally: {critical:number,high:number,medium:number,low:number}|null,
 *   matches: string[], duplicate: boolean }}
 */
export function readSeverityTally(markdown) {
  if (typeof markdown !== 'string') {
    return { tally: null, matches: [], duplicate: false };
  }
  const range = executiveSummaryRange(markdown);
  const matches = [];
  TALLY_LINE_GLOBAL.lastIndex = 0;
  for (const hit of markdown.matchAll(TALLY_LINE_GLOBAL)) {
    matches.push({ text: hit[0].trim(), groups: hit, index: hit.index });
  }
  const scoped = range
    ? matches.filter((m) => m.index >= range.start && m.index < range.end)
    : matches;
  if (matches.length === 0) {
    return { tally: null, matches: [], duplicate: false };
  }
  if (matches.length > 1) {
    return {
      tally: null,
      matches: matches.map((m) => m.text),
      duplicate: true,
    };
  }
  const [only] = scoped.length > 0 ? scoped : matches;
  return {
    tally: {
      critical: Number(only.groups[1]),
      high: Number(only.groups[2]),
      medium: Number(only.groups[3]),
      low: Number(only.groups[4]),
    },
    matches: [only.text],
    duplicate: false,
  };
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
 * @param {object} params
 * @param {string} params.markdown
 * @param {string} params.sourceReport Also the fallback dimension source.
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
export function parseAuditReport({ markdown, sourceReport, repoRoot }) {
  if (typeof markdown !== 'string') {
    throw new Error('parseAuditReport: markdown must be a string');
  }
  if (typeof sourceReport !== 'string' || sourceReport.length === 0) {
    throw new Error('parseAuditReport: sourceReport path is required');
  }

  const fallbackDimension = inferDimensionFromReportName(sourceReport);
  const blocks = foldGroupingHeaders(splitFindingBlocks(markdown));

  return blocks.map((block) => {
    const fields = parseBlockFields(block.bodyLines);
    const dimension = deriveDimension(fields, fallbackDimension);
    const severity = deriveSeverity(fields);
    const currentState = fields['current state'] ?? '';
    const recommendation =
      fields['recommendation & rationale'] ?? fields.recommendation ?? '';
    const agentPrompt = fields['agent prompt'] ?? '';
    const fileSet = new Set([
      ...deriveTitleFile(block.title, repoRoot),
      ...deriveLocationFiles(fields, repoRoot),
      ...extractFilePaths(currentState, repoRoot),
      ...extractFilePaths(recommendation, repoRoot),
      ...extractFilePaths(agentPrompt, repoRoot),
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
 * A report without `## Detailed Findings` yields no entries (legitimately empty).
 *
 * @param {Array<{ markdown: string, sourceReport: string }>} reports
 * @param {{ repoRoot?: string }} [options]
 * @returns {Array<ReturnType<typeof parseAuditReport>[number]>}
 */
export function parseAuditReports(reports, { repoRoot } = {}) {
  if (!Array.isArray(reports)) {
    throw new Error('parseAuditReports: reports must be an array');
  }
  const out = [];
  for (const report of reports) {
    out.push(...parseAuditReport({ ...report, repoRoot }));
  }
  return out;
}

export const __testing = {
  carriesFieldBullet,
  carriesSeverity,
  isEmptyBlock,
  isGroupingHeader,
  foldGroupingHeaders,
  normaliseSeverity,
  extractFilePaths,
  normaliseTitle,
  deriveDimension,
  deriveLocationFiles,
};

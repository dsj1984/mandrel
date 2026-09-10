/**
 * lib/audit-to-stories/parse-audit-md.js — Parse `audit-*-results.md` reports.
 *
 * Extracts the `## Detailed Findings` section of an audit report and turns
 * every `### <title>` block into a normalised finding record. Every audit lens
 * report now shares one findings contract (Story #4625): a `Critical | High |
 * Medium | Low` severity scale, a mandated `Location:` path anchor, and a
 * dimension axis. Lenses still label the axes slightly differently — `Severity`
 * vs `Impact`, `Dimension` vs `Category` vs `Type` — so the parser captures
 * every key/value pair the block carries and normalises the two axes the
 * downstream pipeline relies on (severity + dimension), harvesting the
 * `Location:` field into `files[]` ahead of prose scraping.
 *
 * Pure: no filesystem I/O. The caller supplies the report text and source
 * path; the parser returns plain objects.
 */

import path from 'node:path';

import { normalizeSeverity } from '../findings/severity.js';

// A lens writes its field bullets either way round — `- **Severity:** High`
// (colon inside the bold run) or `- **Severity**: High` (colon outside it).
// Accepting only the first silently dropped the axis of every finding written
// the second way: it parsed as prose, so the block carried no severity, and the
// grouping-header rule below then read the whole finding as an organisational
// heading. Both spellings are the same field.
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
 * Resolve a raw severity/impact token to a canonical level, or `null` when the
 * token carries no recognisable severity at all.
 *
 * The vocabulary itself is NOT written down here (Story #4877). This module used
 * to carry its own alias table covering `critical|high|medium|mod|moderate|low`
 * — four of the canonical five levels, missing `info`. A lens that graded a
 * finding `Info` or `Informational` (which the shared severity scale now
 * sanctions) therefore parsed to `null`, tallied as `unknown`, and was dropped
 * by every severity-filtered run, `--severity low` included. Delegating to the
 * canonical normaliser in `lib/findings/severity.js` means this parser cannot
 * know a narrower vocabulary than the rest of the pipeline.
 *
 * `null` — rather than the normaliser's `info` fallback — remains the
 * no-severity answer, because {@link deriveSeverity} walks several candidate
 * keys and needs to distinguish "this key had no severity" from "this key said
 * `info`".
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
 * Harvest the mandated `Location:` field into concrete file paths. Every
 * non-retired lens template now carries a `- **Location:** <path>:<line>`
 * bullet (Story #4625); extracting it here — ahead of the heuristic prose
 * scrape — gives a finding a deterministic identity anchor instead of relying
 * on whatever path text happens to appear in the prose. The value may wrap the
 * path in backticks and/or append a `:line` (or `:line:col`) suffix; both are
 * stripped. Only tokens that look like paths (containing a separator) survive.
 *
 * @param {Record<string, string>} fields
 * @returns {string[]}
 */
/**
 * Normalise a raw path token to a repo-relative path, or `null` when the
 * token is not a usable file reference.
 *
 * Three shapes historically leaked through and poisoned grouping downstream:
 * an **absolute** path (which can never match a repo-relative group key), a
 * **degenerate** token such as a bare `/`, and — most damagingly — a
 * **root-level** file such as `AGENTS.md`, which the old slash-only guard
 * discarded outright even when it was the finding's explicit `Location:`.
 *
 * `requireSeparator` is what keeps that third fix from over-reaching. In the
 * **structured** fields — the title anchor and `Location:` — a bare
 * `AGENTS.md` is unambiguously a file, so the separator is not required. In
 * free **prose**, a bare `description.md` is far more likely to be a word than
 * a path, so the separator stays mandatory there.
 *
 * @param {string} raw — the token as it appeared in the report.
 * @param {string} [repoRoot] — absolute repo root; absolute tokens beneath it
 *   are relativised. Omitted (the pure default) leaves absolutes to be dropped.
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
  // A path that is still absolute lives outside the repo — it can never be a
  // valid group key, so drop it rather than let it become one.
  if (out.startsWith('/') || out.startsWith('\\') || /^[A-Za-z]:/.test(out)) {
    return null;
  }
  const hasSeparator = out.includes('/') || out.includes('\\');
  if (requireSeparator && !hasSeparator) return null;
  if (!hasSeparator && !FILE_EXT.test(out)) return null;
  return out;
}

/**
 * The finding-block skeleton mandates that a title lead with the primary file
 * the finding lives in (``### `path/to/file.ext` — title``). That anchor is
 * the most reliable primary-file signal a block carries, so it seeds `files[]`
 * ahead of `Location:` and prose scraping — `pickPrimaryFile` takes `files[0]`.
 */
function deriveTitleFile(title, repoRoot) {
  const match = TITLE_ANCHOR.exec(typeof title === 'string' ? title : '');
  if (!match) return [];
  const normalised = normalisePathToken(match[1], repoRoot);
  return normalised ? [normalised] : [];
}

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
 * Does this block carry the axis line that makes it a finding rather than a
 * section header? The skeleton mandates `Severity` (or its `Impact` alias), so
 * its absence is the signal that a heading is organisational.
 *
 * @param {{ bodyLines: string[] }} block
 * @returns {boolean}
 */
function carriesSeverity(block) {
  return block.bodyLines.some((line) => SEVERITY_KEY_LINE.test(line));
}

/**
 * Does this block carry any `- **Key:** value` field bullet at all? A finding
 * block is a field record; a grouping header is a heading with prose (or
 * nothing) under it. Read together with {@link carriesSeverity} this is what
 * lets an axis-less heading be recognised as organisational **without** having
 * to see `####` children under it.
 *
 * @param {{ bodyLines: string[] }} block
 * @returns {boolean}
 */
function carriesFieldBullet(block) {
  return block.bodyLines.some((line) => KEY_LINE.test(line));
}

/**
 * A block that declares nothing: no severity axis and no field bullets. A
 * `### Robust` header whose whole body is `_No findings._` is the canonical
 * case — it used to parse as a severity-less finding with no files and no
 * recommendation, which an unattended sweep then filed as an empty Story.
 *
 * @param {{ bodyLines: string[] }} block
 * @returns {boolean}
 */
function isEmptyBlock(block) {
  return !carriesSeverity(block) && !carriesFieldBullet(block);
}

/**
 * Decide whether a `###` block is a **grouping header** rather than a finding,
 * reading its **whole subtree** — its own body and its `####` children.
 *
 * Several lenses nest their findings one level deeper: a `###` per dimension
 * (`### Perceivable`), each holding `####` finding blocks. Read flat, that
 * report parsed as one severity-less finding per dimension, and the unattended
 * sweep filed those empties. The subtree rule this applies, in order:
 *
 *   1. A block whose own body carries the severity axis **or any field
 *      bullet** is a finding. Its `####` sub-sections fold back into its body
 *      rather than splitting into phantom findings, so flat reports parse
 *      exactly as before.
 *   2. A block whose title leads with a backticked path — the anchor the
 *      finding-block skeleton mandates — is a finding even when its own body
 *      is empty, because its fields live under a `#### Evidence`-style
 *      sub-section. Folding is what stops that sub-section's heading from
 *      becoming the finding's title.
 *   3. Otherwise it is a grouping header when its children look like findings:
 *      any child carrying its own path anchor, or more than one child carrying
 *      the severity axis. A **single** axis-bearing child under an anchorless
 *      header is the `#### Evidence` shape again, so it folds.
 *   4. A block with no children at all and nothing declared is a grouping
 *      header (or a stray heading) either way — it yields no finding.
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
 * Fold the flat heading stream into findings: emit a grouping header's
 * children, fold a finding's sub-sections into its own body, and drop every
 * block that declares nothing.
 *
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
 * Slice the `## Executive Summary` section out of a report, or `null` when the
 * report declares none. The tally the cross-check trusts is the one the report
 * envelope mandates *there*; a `Severity tally:` string anywhere else is prose
 * quoting the format, not a declaration.
 *
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
 * Read every `Severity tally:` line the report carries, scoped to its
 * Executive Summary and failing closed on more than one.
 *
 * The tally is what lets a consumer cross-check what the lens says it found
 * against what the parser actually extracted — a parse that silently drops
 * findings is otherwise indistinguishable from a clean report. That only holds
 * while exactly one line claims to be the tally. A report whose prose quotes
 * the format a second time (a remediation section restating a lens's output,
 * say) used to have whichever line the regex reached first silently adopted as
 * the declaration, so the cross-check compared the parse against an arbitrary
 * one of two numbers. Both are now reported and the report fails.
 *
 * `Info` is never counted (the severity scale already excludes it from
 * scheduled work).
 *
 * @param {string} markdown — full report text.
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
    // Outside an Executive Summary the whole document is the scope; with one,
    // a line beyond it is a stray that must not be adopted silently.
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

/**
 * Read the machine-readable severity tally the report envelope mandates in its
 * `## Executive Summary`:
 *
 * ```text
 * Severity tally: Critical 0 / High 2 / Medium 1 / Low 0
 * ```
 *
 * The convenience wrapper over {@link readSeverityTally} for callers that only
 * want the numbers. `null` therefore covers two different facts — no tally, and
 * more than one — so a caller that must tell them apart (the cross-check does:
 * a duplicate names the offending lines) reads the richer function instead.
 *
 * @param {string} markdown — full report text.
 * @returns {{ critical: number, high: number, medium: number, low: number }|null}
 *   `null` when the report declares no tally, or declares more than one.
 */
export function parseSeverityTally(markdown) {
  return readSeverityTally(markdown).tally;
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
 *   and dimension inference when the report omits a `Dimension:` / `Category:`
 *   / `Type:` line.
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
 * Parse N audit reports and return a flat findings array. Reports without a
 * `## Detailed Findings` section yield zero entries rather than throwing —
 * an audit can legitimately come back empty.
 *
 * @param {Array<{ markdown: string, sourceReport: string }>} reports
 * @param {{ repoRoot?: string }} [options] — `repoRoot` relativises absolute
 *   paths quoted in a report so they can match repo-relative group keys.
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

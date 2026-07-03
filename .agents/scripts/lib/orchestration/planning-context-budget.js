/**
 * planning-context-budget.js
 *
 * Bounded planning-context budget for the `--emit-context` planning scripts
 * (Epic #817 Story 9). Provides a summary representation of large markdown
 * payloads (project docs, Epic body, Tech Spec body) so the host LLM is not
 * handed multi-100KB envelopes when the underlying material exceeds the
 * configured `maxBytes` budget.
 *
 * Two pure helpers:
 *   - `summarizeDoc(filePath, content, maxBytes)` extracts headings + bounded
 *     excerpts for one document.
 *   - `applyBudget(items, limits, opts)` decides full vs summary for a
 *     collection of `{ path, content }` items based on `summaryMode` and the
 *     total payload size.
 *
 * Both functions are deterministic and have no I/O.
 */

const HEADING_RE = /^(#{2,3})\s+(.+?)\s*$/;

/**
 * Default per-excerpt cap so a single section heading does not consume the
 * entire per-doc byte budget. The bounded sum across excerpts is enforced
 * separately by {@link summarizeDoc}.
 */
const DEFAULT_PER_EXCERPT_BYTES = 800;

/**
 * Default planning-context limits when callers do not pass through
 * `getLimits(config).planningContext`. Mirrors `LIMITS_DEFAULTS` in
 * `lib/config/limits.js` so this module is usable in standalone tests.
 */
export const PLANNING_CONTEXT_DEFAULTS = Object.freeze({
  maxBytes: 50000,
  summaryMode: 'auto',
});

function byteLen(s) {
  if (s == null) return 0;
  return Buffer.byteLength(String(s), 'utf-8');
}

function extractHeadings(content) {
  if (!content) return [];
  const lines = String(content).split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    const m = HEADING_RE.exec(line);
    if (m) out.push({ level: m[1].length, text: m[2] });
  }
  return out;
}

/**
 * Split a markdown body into preamble + per-heading sections so excerpts can
 * be emitted with the heading they belong to. Lines preceding the first
 * `## ` / `### ` heading become the `preamble` section (heading: null).
 */
function splitSections(content) {
  if (!content) return [];
  const lines = String(content).split(/\r?\n/);
  const sections = [{ heading: null, body: [] }];
  for (const line of lines) {
    const m = HEADING_RE.exec(line);
    if (m) {
      sections.push({ heading: m[2], body: [] });
    } else {
      sections[sections.length - 1].body.push(line);
    }
  }
  return sections;
}

/**
 * Trim a multi-line section to the first non-empty paragraph, capped at
 * `maxBytes` of utf-8. Preserves whitespace inside the kept paragraph but
 * collapses leading/trailing blank lines so excerpts stay compact.
 */
function firstParagraph(lines, maxBytes) {
  const text = lines.join('\n').replace(/^\s+|\s+$/g, '');
  if (!text) return '';
  // Take up to the first blank-line break (paragraph boundary).
  const para = text.split(/\n\s*\n/)[0] ?? '';
  const trimmed = para.trim();
  if (byteLen(trimmed) <= maxBytes) return trimmed;
  // Hard truncate at maxBytes utf-8 with an ellipsis marker so callers can
  // tell the excerpt is bounded rather than corrupt.
  const buf = Buffer.from(trimmed, 'utf-8').subarray(0, maxBytes);
  // Avoid splitting a multi-byte codepoint at the boundary.
  let safe = buf.toString('utf-8');
  if (safe.length > 1 && safe.charCodeAt(safe.length - 1) === 0xfffd) {
    safe = safe.slice(0, -1);
  }
  return `${safe.replace(/\s+$/, '')}…`;
}

/**
 * Summarise a single markdown doc. Emits headings + per-section excerpts
 * (preamble first), each bounded so a runaway section never blows the budget.
 *
 * @param {string} filePath repo-relative path used as the `path` field
 * @param {string} content full markdown body
 * @param {number} [maxBytes=50000] total per-doc byte budget for excerpts
 * @returns {{ path: string, headings: string[], excerpts: Array<{heading: string|null, snippet: string}>, byteSize: number }}
 */
export function summarizeDoc(filePath, content, maxBytes = 50000) {
  const safeContent = typeof content === 'string' ? content : '';
  const byteSize = byteLen(safeContent);
  const headingObjs = extractHeadings(safeContent);
  const headings = headingObjs.map((h) => h.text);

  const sections = splitSections(safeContent);
  const perExcerptCap = Math.min(
    DEFAULT_PER_EXCERPT_BYTES,
    Math.max(120, Math.floor(maxBytes / Math.max(1, sections.length))),
  );

  const excerpts = [];
  let used = 0;
  for (const sec of sections) {
    if (used >= maxBytes) break;
    const remaining = Math.max(0, maxBytes - used);
    const cap = Math.min(perExcerptCap, remaining);
    const snippet = firstParagraph(sec.body, cap);
    if (!snippet) continue;
    excerpts.push({ heading: sec.heading, snippet });
    used += byteLen(snippet);
  }

  return {
    path: filePath,
    headings,
    excerpts,
    byteSize,
  };
}

function normalizeItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .filter((it) => it && typeof it === 'object')
    .map((it) => ({
      path: it.path ?? it.name ?? '',
      content: typeof it.content === 'string' ? it.content : '',
    }));
}

function totalBytes(items) {
  let n = 0;
  for (const it of items) n += byteLen(it.content);
  return n;
}

function buildFullItems(items) {
  return items.map((it) => ({
    path: it.path,
    content: it.content,
    byteSize: byteLen(it.content),
  }));
}

function buildSummaryItems(items, maxBytes) {
  // Distribute the byte budget across docs proportional to their size, with
  // a per-doc floor so even tiny docs get a heading + tiny excerpt.
  const total = totalBytes(items) || 1;
  const floor = Math.max(512, Math.floor(maxBytes / Math.max(1, items.length)));
  return items.map((it) => {
    const share = Math.max(
      floor,
      Math.floor((byteLen(it.content) / total) * maxBytes),
    );
    return summarizeDoc(it.path, it.content, share);
  });
}

/**
 * Apply the planning-context budget to a collection of doc-shaped items.
 *
 * @param {Array<{path?: string, name?: string, content: string}>} items
 * @param {{ maxBytes?: number, summaryMode?: 'auto'|'always'|'never' }} [limits]
 * @param {{ fullContext?: boolean }} [opts] — `fullContext: true` forces full
 *   mode regardless of `summaryMode` (mirrors the `--full-context` CLI flag).
 * @returns {{ mode: 'full'|'summary', items: Array<object>, totalBytes: number }}
 */
export function applyBudget(items, limits = {}, opts = {}) {
  const merged = { ...PLANNING_CONTEXT_DEFAULTS, ...(limits || {}) };
  const { maxBytes, summaryMode } = merged;
  const { fullContext = false } = opts;

  const norm = normalizeItems(items);
  const total = totalBytes(norm);

  if (fullContext || summaryMode === 'never') {
    return { mode: 'full', items: buildFullItems(norm), totalBytes: total };
  }
  if (summaryMode === 'always') {
    return {
      mode: 'summary',
      items: buildSummaryItems(norm, maxBytes),
      totalBytes: total,
    };
  }
  // auto — summarise iff payload exceeds the budget.
  if (total > maxBytes) {
    return {
      mode: 'summary',
      items: buildSummaryItems(norm, maxBytes),
      totalBytes: total,
    };
  }
  return { mode: 'full', items: buildFullItems(norm), totalBytes: total };
}

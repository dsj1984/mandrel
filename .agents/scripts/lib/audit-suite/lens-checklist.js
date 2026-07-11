/**
 * lib/audit-suite/lens-checklist.js — distill an `audit-<lens>.md` workflow
 * body into a compact, drift-gated authoring checklist.
 *
 * Epic #4405 (shift-left audit) moves each lens's concerns to the innermost,
 * write-time tier: instead of an engineer only learning what a lens checks
 * when `/audit-<lens>` runs, a compact per-lens checklist ships as a committed
 * build artifact under `.agents/audit-checklists/`. This module is the pure
 * distillation seam — no IO — so it is unit-testable and the generator
 * (`generate-lens-checklists.js`) owns only the file read/write/prune and the
 * `--check` drift gate.
 *
 * The distillation is a deterministic transform of the workflow markdown: it
 * lifts the lens's *concern* labels — the bold lead-ins of the analysis /
 * evaluation list items — from the audit region of the workflow (everything
 * before the `Output Requirements` / report-template boundary), skipping the
 * recurring boilerplate sections (Role, Context, Scope, Execution strategy,
 * Configuration). When a lens exposes no bold concern items it falls back to
 * its audit-step headings so every checklist is non-empty. The output is
 * hard-capped at {@link MAX_CHECKLIST_LINES} lines.
 *
 * Pure: no IO, no provider calls, safe to unit-test in isolation.
 *
 * @see Story #4408 — per-lens authoring checklists as drift-gated artifacts.
 */

import { clampSummary, extractFrontmatter } from './frontmatter.js';

// All RegExp instances are built via the constructor (rather than literal
// `/.../`) so the maintainability engine's AST walker (typhonjs-escomplex) can
// score this file — see the note in lib/audit-suite/frontmatter.js.
// biome-ignore-start lint/complexity/useRegexLiterals: typhonjs-escomplex MI workaround
const LINE_SPLIT_RE = new RegExp(String.raw`\r?\n`);
const FRONTMATTER_BLOCK_RE = new RegExp(
  String.raw`^---\r?\n([\s\S]*?)\r?\n---`,
);
const BLOCK_SCALAR_INDICATOR_RE = new RegExp('^[|>][+-]?$');
const DESCRIPTION_KEY_RE = new RegExp(String.raw`^description\s*:`);
const INDENTED_LINE_RE = new RegExp(String.raw`^\s+\S`);
const COLLAPSE_WS_RE = new RegExp(String.raw`\s+`, 'g');
const HEADING_RE = new RegExp(String.raw`^(#{1,6})\s+(.*\S)\s*$`);
const BOLD_LEAD_ITEM_RE = new RegExp(
  String.raw`^\s*(?:[-*+]|\d+\.)\s+\*\*(.+?)\*\*`,
);
const STEP_PREFIX_RE = new RegExp(String.raw`^Step\s+\d+\s*[:.]?\s*`, 'i');
const TRAILING_COLON_RE = new RegExp(String.raw`\s*:\s*$`);
// A `##` section whose heading opens with one of these is workflow boilerplate,
// not a lens concern — its list items are skipped during concern extraction.
const BOILERPLATE_SECTION_RE = new RegExp(
  String.raw`^(Role|Context & Objective|Scope|Execution strategy|Configuration|Run Context|Target set)\b`,
  'i',
);
// The report-template / output-contract boundary. Everything at or after the
// first heading matching this is template scaffolding, never a concern.
const OUTPUT_BOUNDARY_RE = new RegExp(
  '(Output Requirements|Generate the Report)',
  'i',
);
// biome-ignore-end lint/complexity/useRegexLiterals: typhonjs-escomplex MI workaround

/** Hard cap on generated checklist lines (asserted by the drift test). */
export const MAX_CHECKLIST_LINES = 40;

/** Fixed header/intro line budget consumed before the checklist items. */
const HEADER_LINE_BUDGET = 12;

/**
 * Pure: walk the workflow body once, collecting the lens's concern labels (bold
 * lead-ins of analysis/evaluation list items) and, as a fallback, its audit
 * step headings. Extraction stops at the report-template boundary and ignores
 * boilerplate sections.
 *
 * @param {string} content — raw `audit-<lens>.md` markdown.
 * @returns {{ title: string|null, concerns: string[], stepHeadings: string[] }}
 */
export function extractLensConcerns(content) {
  const lines = String(content ?? '').split(LINE_SPLIT_RE);
  const concerns = [];
  const stepHeadings = [];
  let title = null;
  let inBoilerplate = false;

  for (const line of lines) {
    const heading = HEADING_RE.exec(line);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2].trim();
      if (level === 1) {
        // First H1 is the lens title; a later H1 opens the report template.
        if (title === null) {
          title = text;
          continue;
        }
        break;
      }
      if (OUTPUT_BOUNDARY_RE.test(text)) break;
      if (level === 2) {
        inBoilerplate = BOILERPLATE_SECTION_RE.test(text);
        if (!inBoilerplate) {
          stepHeadings.push(text.replace(STEP_PREFIX_RE, '').trim());
        }
      }
      continue;
    }
    if (title === null || inBoilerplate) continue;
    const item = BOLD_LEAD_ITEM_RE.exec(line);
    if (item) {
      const label = item[1].replace(TRAILING_COLON_RE, '').trim();
      if (label) concerns.push(label);
    }
  }

  return { title, concerns, stepHeadings };
}

/**
 * Pure: resolve a workflow's `description` to a single clamped line, folding a
 * YAML block scalar (`description: >-` / `|` with indented continuation lines)
 * back into one line. `extractFrontmatter` only sees the indicator token
 * (`>-`) for a block scalar, so this reads the continuation lines directly.
 *
 * @param {string} content — raw workflow markdown.
 * @param {Record<string, string>} fm — parsed frontmatter map.
 * @returns {string} a single-line description (possibly empty).
 */
export function resolveDescription(content, fm) {
  const raw = (fm.description ?? '').trim();
  if (raw && !BLOCK_SCALAR_INDICATOR_RE.test(raw)) {
    return clampSummary(raw).replace(COLLAPSE_WS_RE, ' ');
  }

  const block = FRONTMATTER_BLOCK_RE.exec(String(content ?? ''));
  if (!block) return '';
  const lines = block[1].split(LINE_SPLIT_RE);
  const start = lines.findIndex((line) => DESCRIPTION_KEY_RE.test(line));
  if (start === -1) return '';
  const collected = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (INDENTED_LINE_RE.test(lines[i])) {
      collected.push(lines[i].trim());
      continue;
    }
    break; // a blank line or a dedented next key ends the scalar.
  }
  return clampSummary(collected.join(' ')).replace(COLLAPSE_WS_RE, ' ');
}

/**
 * Pure: dedupe a list case-insensitively, preserving first-seen order.
 *
 * @param {string[]} items
 * @returns {string[]}
 */
function dedupePreserveOrder(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * Pure: render the authoring checklist for a single lens from its workflow
 * markdown. The output is deterministic (a pure function of `content`) and
 * hard-capped at {@link MAX_CHECKLIST_LINES} lines including the trailing
 * newline, so the same input always regenerates byte-identically.
 *
 * @param {string} lens — canonical lens name (e.g. `security`).
 * @param {string} content — raw `audit-<lens>.md` markdown.
 * @returns {string} the checklist markdown (ends with a single newline).
 */
export function renderLensChecklist(lens, content) {
  const fm = extractFrontmatter(content);
  const description = resolveDescription(content, fm);
  const { title, concerns, stepHeadings } = extractLensConcerns(content);
  const displayTitle = title || `audit-${lens}`;

  let items = dedupePreserveOrder(concerns);
  if (items.length === 0) items = dedupePreserveOrder(stepHeadings);
  if (items.length === 0) items = ['Review the full lens workflow'];

  const header = [
    '<!-- GENERATED FILE — do not edit by hand.',
    `     Source of truth: .agents/workflows/audit-${lens}.md`,
    '     Regenerate: node .agents/scripts/generate-lens-checklists.js',
    '     Drift is gated by: npm run docs:check',
    '-->',
    '',
    `# ${displayTitle} — authoring checklist`,
    '',
    `> ${description || `Self-check your change against the ${lens} lens.`}`,
    '',
    "Self-check your change against this lens's concerns before you ship:",
    '',
  ];

  // Reserve room for a truncation marker so the cap is never exceeded.
  const maxItems = MAX_CHECKLIST_LINES - HEADER_LINE_BUDGET;
  let itemLines;
  if (items.length > maxItems) {
    itemLines = items.slice(0, maxItems - 1).map((c) => `- [ ] ${c}`);
    itemLines.push('- [ ] …see the full lens for the remaining concerns');
  } else {
    itemLines = items.map((c) => `- [ ] ${c}`);
  }

  return `${[...header, ...itemLines].join('\n')}\n`;
}

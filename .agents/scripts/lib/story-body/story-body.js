// .agents/scripts/lib/story-body/story-body.js
/**
 * Canonical Story-body parser/serializer (Gap 1, Epic #3211).
 *
 * This module is the single source of truth for the Story body shape.
 * Every consumer that reads or writes a structured Story body MUST go
 * through these exports — do not inline ad-hoc parsing elsewhere.
 *
 * ## Structured Story body shape
 *
 * ```js
 * {
 *   goal:                string,           // one-sentence purpose
 *   slicing:             string,           // v2 intra-Story delivery slice plan (optional; '' when absent)
 *   spec:                string,           // folded Tech Spec text block (optional; '' when absent)
 *   changes:             PathEntry[],      // files/globs this Story touches
 *   acceptance:          string[],         // observable criteria
 *   verify:              string[],         // exact commands / tier annotation
 *   references:          PathEntry[],      // read-only paths (optional)
 *   non_goals:           string[],         // negative-scope bullets (optional, advisory)
 *   wide:                { reason } | null,// declared-wide footprint (optional)
 *   reason_to_exist:     string | null,    // one-sentence cohesion reason (optional)
 *   depends_on:          string[],         // blocker story slugs or #ids
 *   estimated_test_files: number | null,   // absent → null (informational)
 * }
 * ```
 *
 * Where `PathEntry` is:
 *   - `{ path: string, assumption: "creates"|"refactors-existing"|"exists"|"deletes" }`
 *     (canonical form — string bullets are rejected at parse time)
 *
 * ## Round-trip contract
 *
 * `serialize(parse(markdown)) === markdown` when the input is already
 * in the canonical serialized form. Non-canonical whitespace or
 * section ordering may produce a normalized (but equivalent) output.
 *
 * The parser MUST fail closed: a body that cannot be mapped to the
 * canonical shape throws `StoryBodyParseError` — it does NOT silently
 * coerce malformed input. This prevents a corrupt body from supplying
 * wrong `depends_on` edges that reorder the wave DAG.
 *
 * @module story-body
 */

import {
  AUTHORED_MARKER_LINE_RE,
  authoredMarkerLine,
} from '../framework-version.js';
import { FILE_ASSUMPTION_VALUES } from '../orchestration/file-assumption-enum.js';

// ---------------------------------------------------------------------------
// Public types (JSDoc only — no runtime schema file)
// ---------------------------------------------------------------------------

/**
 * @typedef {'creates'|'refactors-existing'|'exists'|'deletes'} AssumptionEnum
 */

/**
 * @typedef {{ path: string, assumption: AssumptionEnum }} PathEntry
 */

/**
 * @typedef {PathEntry} ChangeEntry
 */

/**
 * @typedef {object} StoryBody
 * @property {string}        goal                - One-sentence purpose statement.
 * @property {string}        slicing             - Optional v2 intra-Story delivery slice plan text block; '' when absent.
 * @property {string}        spec                - Optional folded Tech Spec text block; '' when absent.
 * @property {PathEntry[]}   changes             - Files / globs this Story modifies.
 * @property {string[]}      acceptance          - Observable acceptance criteria.
 * @property {string[]}      verify              - Exact commands with tier annotation.
 * @property {PathEntry[]}   references          - Read-only paths (may be empty).
 * @property {string[]}      non_goals           - Negative-scope bullets (advisory; may be empty).
 * @property {{ reason: string }|null} wide      - Declared-wide footprint (reason), or null.
 * @property {string|null}   reason_to_exist     - One-sentence cohesion reason ("why this Story exists"), or null.
 * @property {string[]}      depends_on          - Blocking story slugs / issue refs.
 * @property {number|null}   estimated_test_files - Test surface count or null.
 * @property {string|null}   mandrel_version     - Framework version stamped at authoring, or null.
 * @property {string|null}   authored_at         - Authoring date (YYYY-MM-DD) stamped at authoring, or null.
 */

/**
 * @typedef {object} ParseResult
 * @property {StoryBody}  body      - The parsed structured body.
 * @property {string[]}   warnings  - Non-fatal issues (e.g. unstructured-body).
 * @property {ParseInfo}  info      - Metadata about the parse.
 */

/**
 * @typedef {object} ParseInfo
 * @property {boolean} hasGoalSection       - Whether a `## Goal` section was found.
 * @property {boolean} hasChangesSection    - Whether a `## Changes` section was found.
 * @property {boolean} hasAcceptanceSection - Whether a `## Acceptance` section was found.
 * @property {boolean} hasVerifySection     - Whether a `## Verify` section was found.
 * @property {boolean} hasReferencesSection - Whether a `## References` section was found.
 * @property {boolean} hasNonGoalsSection   - Whether a `## Non-Goals` section was found.
 * @property {boolean} hasSlicingSection    - Whether a `## Slicing` section was found (v2 folded slice plan).
 * @property {boolean} hasSpecSection       - Whether a `## Spec` section was found (folded Tech Spec).
 * @property {boolean} isUnstructuredBody   - True when no structured sections were found.
 */

/**
 * @typedef {object} SerializeOptions
 * @property {boolean} [includeFooter=false] - Include `---\nparent/blocked-by` footer.
 * @property {object}  [footer]              - Footer fields when `includeFooter` is true.
 * @property {number}  [footer.parent]       - Parent feature issue number.
 */

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

/**
 * Thrown when the Story body cannot be parsed into the canonical shape.
 * The parser fails closed — do not catch this to silently continue.
 */
export class StoryBodyParseError extends Error {
  /**
   * @param {string} message
   * @param {{ field?: string, raw?: string }} [context]
   */
  constructor(message, context) {
    super(message);
    this.name = 'StoryBodyParseError';
    this.field = context?.field ?? null;
    this.raw = context?.raw ?? null;
  }
}

// ---------------------------------------------------------------------------
// Section heading map
// ---------------------------------------------------------------------------

// Heading text → body field name. Keys are normalized: lower-cased with `-`
// folded to `_` (see splitSections), so the hyphenated `## Non-Goals` heading
// maps to the `non_goals` field.
const HEADING_TO_FIELD = new Map([
  ['goal', 'goal'],
  ['slicing', 'slicing'],
  ['spec', 'spec'],
  ['changes', 'changes'],
  ['acceptance', 'acceptance'],
  ['verify', 'verify'],
  ['references', 'references'],
  ['non_goals', 'non_goals'],
]);
const TEXT_BLOCK_FIELDS = new Set(['slicing', 'spec']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strip leading `- ` or `- [ ] ` from a markdown list item, returning the
 * raw content.
 *
 * @param {string} line
 * @returns {string}
 */
function stripListMarker(line) {
  return line.replace(/^-\s+(?:\[\s*[xX ]?\s*\]\s+)?/, '').trim();
}

// Humanized PathEntry bullet (Story #4600): `path` — assumption. This is the
// shape serialize() now emits for `## Changes` / `## References`; the legacy
// inline-JSON object bullet remains accepted at parse time indefinitely (live
// issue bodies are never rewritten).
const HUMANIZED_PATH_ENTRY_RE = /^`([^`]+)`\s+—\s+(\S+)$/;

// AC-<n> presentation prefix on acceptance checkboxes (Story #4600). The
// numbering is a stable 1-based human handle only — parse() strips it so the
// top-level acceptance[] machine contract round-trips byte-identical.
const AC_PREFIX_RE = /^AC-\d+:\s+/;

// Visible wide-rationale line (Story #4600): `> **Wide:** <reason>` rendered
// under `## Goal`. Presentation only — the `<!-- meta -->` block stays the
// canonical machine carrier, so the parser skips this line wherever it
// appears (same treatment as the authored-provenance marker).
const WIDE_MARKER_LINE_RE = /^>\s*\*\*Wide:\*\*/;

/**
 * Parse a single `changes` / `references` bullet into a `PathEntry`.
 *
 * Accepted markdown shapes (both parsed indefinitely — live issue bodies
 * are never rewritten):
 *   - Humanized bullet (canonical serialize() output since Story #4600):
 *     `` `src/x.js` — refactors-existing ``
 *   - Legacy inline-JSON object bullet:
 *     `- { "path": "...", "assumption": "..." }`
 *
 * A structured object entry (from a parsed JSON body that was never
 * serialized to markdown) arrives as-is and is validated directly.
 *
 * @param {string|object} raw
 * @param {string[]} warnings
 * @returns {PathEntry}
 */
function parsePathEntry(raw, warnings) {
  // Already a structured object (from a parsed JSON body, not markdown).
  if (raw !== null && typeof raw === 'object') {
    if (
      typeof raw.path === 'string' &&
      raw.path.trim().length > 0 &&
      FILE_ASSUMPTION_VALUES.includes(raw.assumption)
    ) {
      return { path: raw.path.trim(), assumption: raw.assumption };
    }
    // Malformed object: fail closed.
    throw new StoryBodyParseError(
      `changes/references entry is an object but not a valid PathEntry: ${JSON.stringify(raw)}`,
      { field: 'changes', raw: JSON.stringify(raw) },
    );
  }

  const str = typeof raw === 'string' ? raw.trim() : String(raw).trim();
  if (str.length === 0) return null;

  // Humanized bullet shape (the canonical serialize() output since
  // Story #4600): `path` — assumption.
  const humanized = str.match(HUMANIZED_PATH_ENTRY_RE);
  if (humanized) {
    const path = humanized[1].trim();
    if (path.length > 0 && FILE_ASSUMPTION_VALUES.includes(humanized[2])) {
      return { path, assumption: humanized[2] };
    }
    // Recognized the humanized shape but the fields are invalid: fail closed.
    throw new StoryBodyParseError(
      `changes/references entry is a humanized bullet but not a valid PathEntry: ${str.slice(0, 120)}`,
      { field: 'changes', raw: str },
    );
  }

  // Try to detect inline JSON object shape: `{ "path": "...", "assumption": "..." }`
  if (str.startsWith('{')) {
    try {
      const parsed = JSON.parse(str);
      // It's a JSON object — treat it as a path entry.
      // If the path is missing or assumption is invalid, fail closed.
      if (typeof parsed === 'object' && parsed !== null) {
        if (
          typeof parsed.path === 'string' &&
          FILE_ASSUMPTION_VALUES.includes(parsed.assumption)
        ) {
          return { path: parsed.path.trim(), assumption: parsed.assumption };
        }
        // Parsed successfully as JSON object but has invalid fields — fail closed.
        throw new StoryBodyParseError(
          `changes/references entry is a JSON object but not a valid PathEntry: ${str}`,
          { field: 'changes', raw: str },
        );
      }
    } catch (err) {
      // Re-throw StoryBodyParseError so it propagates.
      if (err instanceof StoryBodyParseError) throw err;
      // JSON parse failed — fall through to reject plain-string form.
    }
  }

  throw new StoryBodyParseError(
    `changes/references entry must be a { path, assumption } object; plain string bullets are no longer accepted: ${str.slice(0, 120)}`,
    { field: 'changes', raw: str },
  );
}

/**
 * Extract the `blocked by #N` lines from the footer block (text after
 * the last `---` separator). Returns an array of "#N" strings.
 *
 * @param {string} footerBlock
 * @returns {string[]}
 */
function extractBlockedBy(footerBlock) {
  const deps = [];
  for (const line of footerBlock.split('\n')) {
    const m = line.trim().match(/^blocked by\s+(#\d+)$/i);
    if (m) deps.push(m[1]);
  }
  return deps;
}

// Matches any trailing `<!-- meta: … -->` block. Object payloads are the
// canonical serialize() shape; non-object / malformed payloads are still
// recognized so section parsing can skip them and extractMeta can degrade.
const META_BLOCK_RE = /<!--\s*meta:\s*([\s\S]*?)\s*-->/;
const META_OBJECT_RE = /<!--\s*meta:\s*(\{[\s\S]*?\})\s*-->/;

/**
 * Extract the `wide` / `estimated_test_files` fields from the trailing
 * `<!-- meta: {...} -->` comment block written by {@link serialize}. Returns
 * canonical-shaped values (null when absent or malformed) so the parser
 * round-trips the meta block faithfully.
 *
 * Failing closed here would be wrong: the meta block is an optional,
 * machine-written convenience and a malformed comment must not corrupt an
 * otherwise-valid Story body. A parse failure degrades to the absent-meta
 * defaults instead of throwing.
 *
 * The `mandrel_version` / `authored_at` provenance stamp (written once at
 * authoring time by the ticket-creation path) is recovered here too so a later
 * `parse → serialize` preserves the originally-authored version verbatim
 * rather than dropping or re-deriving it.
 *
 * @param {string} markdown
 * @returns {{ wide: { reason: string }|null, reason_to_exist: string|null, estimated_test_files: number|null, mandrel_version: string|null, authored_at: string|null }}
 */
function extractMeta(markdown) {
  const result = {
    wide: null,
    reason_to_exist: null,
    estimated_test_files: null,
    mandrel_version: null,
    authored_at: null,
  };
  const match = markdown.match(META_OBJECT_RE) ?? markdown.match(META_BLOCK_RE);
  if (!match) return result;

  let parsed;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    // Malformed meta comment — degrade to defaults rather than corrupt the body.
    return result;
  }
  // Non-object JSON (array / scalar / null) is treated as absent meta.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return result;
  }

  result.wide = normalizeWide(parsed.wide);
  result.reason_to_exist = normalizeReasonToExist(parsed.reason_to_exist);
  if (typeof parsed.estimated_test_files === 'number') {
    result.estimated_test_files = parsed.estimated_test_files;
  }
  if (
    typeof parsed.mandrel_version === 'string' &&
    parsed.mandrel_version.trim()
  ) {
    result.mandrel_version = parsed.mandrel_version.trim();
  }
  if (typeof parsed.authored_at === 'string' && parsed.authored_at.trim()) {
    result.authored_at = parsed.authored_at.trim();
  }
  return result;
}

/**
 * Normalize a raw `reason_to_exist` value to a non-empty trimmed string or
 * `null`. The field is the machine-checkable form of the cohesion rule
 * ("one Story = one coherent change with one reason to exist"): the
 * `epic-plan-consolidate` critic flags any Story whose body carries no
 * non-empty reason. An empty or non-string value is treated as absent.
 *
 * @param {unknown} raw
 * @returns {string|null}
 */
function normalizeReasonToExist(raw) {
  if (typeof raw !== 'string') return null;
  const reason = raw.trim();
  return reason.length === 0 ? null : reason;
}

/**
 * Normalize a raw `wide` declaration to the canonical `{ reason }` shape or
 * `null`. A `wide` declaration is only honoured when it carries a non-empty
 * one-line reason — the reason is the whole point of the field (it states why
 * a Story is legitimately broad and lifts the hard file-width ceiling).
 *
 * @param {unknown} raw
 * @returns {{ reason: string }|null}
 */
function normalizeWide(raw) {
  if (raw === null || typeof raw !== 'object') return null;
  const reason = typeof raw.reason === 'string' ? raw.reason.trim() : '';
  if (reason.length === 0) return null;
  return { reason };
}

/**
 * Split markdown into named sections plus a footer block.
 *
 * Returns `{ sections: Map<string, string[]>, footer: string }`.
 * Each map value is the raw non-empty content lines under that heading
 * (heading line stripped).
 *
 * A `---` followed by recognised footer keys (`parent:`, `Epic:`,
 * `blocked by`) marks the start of the footer block. Content after the
 * footer separator is NOT parsed as sections.
 *
 * @param {string} markdown
 * @returns {{ sections: Map<string, string[]>, footer: string, preamble: string }}
 */
function splitSections(markdown) {
  const lines = markdown.split('\n');
  const sections = new Map();
  let currentSection = null;
  let footerStart = -1;
  const preambleLines = [];
  let inPreamble = true;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect footer separator: `---` on its own line
    if (/^---\s*$/.test(line)) {
      const remaining = lines.slice(i + 1).join('\n');
      if (/^(parent:|Epic:|blocked by)/im.test(remaining)) {
        footerStart = i;
        break;
      }
    }

    // Detect `## Heading` (canonical) or `### Heading` lines. GitHub Issue
    // Forms (Story #4227) render every field label as a level-3 heading
    // (`### Goal`), not the level-2 the canonical serializer emits, so the
    // parser accepts both levels. Any other heading depth is ignored.
    //
    // The token class is `[\w-]+` (not bare `\w+`) so a single hyphenated
    // heading word — the canonical `## Non-Goals` negative-scope section —
    // matches as one token. The captured name is normalized (lower-cased,
    // `-` folded to `_`) before the HEADING_TO_FIELD lookup, so `Non-Goals`
    // resolves to the `non_goals` field. Multi-word headings that contain a
    // space (`## Out of Scope`, `## Agent Prompts`) still do NOT match this
    // single-token shape — they fall through to the catch-all heading branch
    // below, which closes the open section. The chosen canonical spelling is
    // therefore the hyphenated single token `## Non-Goals`.
    const fieldHeadingMatch = line.match(/^#{2,3}\s+([\w-]+)\s*$/i);
    const fieldName = fieldHeadingMatch?.[1]?.toLowerCase().replace(/-/g, '_');
    if (HEADING_TO_FIELD.has(fieldName)) {
      inPreamble = false;
      currentSection = fieldName;
      if (!sections.has(currentSection)) sections.set(currentSection, []);
      continue;
    }

    // Any other markdown heading (`## …` / `### …`, single- or multi-word)
    // that is NOT a canonical field heading TERMINATES the current structured
    // section. Trailing extended content a producer appends after the
    // canonical block — `audit-to-stories`'s `## Agent Prompts` / `## Context`
    // / `## Sequencing` blocks, for instance — must not bleed into the last
    // structured section's bullet list (Story #4270). Without this, those
    // lines were silently absorbed into `verify[]` / `acceptance[]`. The
    // heading and everything under it is dropped from structured parsing
    // (it is extended, non-canonical markdown).
    if (
      !inPreamble &&
      /^#{1,6}\s+\S/.test(line) &&
      !TEXT_BLOCK_FIELDS.has(currentSection)
    ) {
      currentSection = null;
      continue;
    }

    // The trailing `<!-- meta: {...} -->` block is machine metadata, not
    // section content. Skip it so a `## References` section immediately
    // followed by the meta block does not swallow the comment as a
    // references entry. `extractMeta` reads it separately from the raw body.
    if (META_BLOCK_RE.test(line)) {
      continue;
    }

    // The visible `> 🏷️ Authored with Mandrel …` provenance marker is
    // machine-managed metadata too (emitted alongside the meta block by the
    // authoring path). Skip it so it never bleeds into the trailing structured
    // section (e.g. `## Verify`); the value round-trips via the meta block.
    if (AUTHORED_MARKER_LINE_RE.test(line)) {
      continue;
    }

    // The visible `> **Wide:** <reason>` rationale line is presentation only
    // (Story #4600): the meta block remains the canonical carrier for
    // `wide.reason`, so this line must not bleed into the goal (or any other)
    // section. Skip it wherever it appears.
    if (WIDE_MARKER_LINE_RE.test(line)) {
      continue;
    }

    if (inPreamble) {
      preambleLines.push(line);
    } else if (currentSection !== null) {
      sections.get(currentSection).push(line);
    }
  }

  const footer =
    footerStart >= 0 ? lines.slice(footerStart + 1).join('\n') : '';
  const preamble = preambleLines.join('\n').trim();
  return { sections, footer, preamble };
}

// ---------------------------------------------------------------------------
// Parser — per-section sub-parsers
// ---------------------------------------------------------------------------

/**
 * Build the minimal {@link ParseResult} returned for an unstructured body —
 * markdown that carries no recognised structured section. The goal falls
 * back to the preamble text (or the whole trimmed input), `depends_on` is
 * still recovered from the footer, and all section arrays are empty.
 *
 * @param {string} input - The original markdown string.
 * @param {string} preamble - Text before the first heading (from splitSections).
 * @param {string} footer - Footer block text (from splitSections).
 * @returns {ParseResult}
 */
function parseUnstructuredBody(input, preamble, footer) {
  const warnings = [
    'unstructured-body: no structured sections found; returning minimal body from preamble text.',
    'test-surface-unestimated: estimated_test_files not present.',
  ];
  const body = {
    goal: preamble || input.trim(),
    slicing: '',
    spec: '',
    changes: [],
    acceptance: [],
    verify: [],
    references: [],
    non_goals: [],
    wide: null,
    reason_to_exist: null,
    depends_on: extractBlockedBy(footer),
    estimated_test_files: null,
    mandrel_version: null,
    authored_at: null,
  };
  return {
    body,
    warnings,
    info: {
      hasGoalSection: false,
      hasChangesSection: false,
      hasAcceptanceSection: false,
      hasVerifySection: false,
      hasReferencesSection: false,
      hasNonGoalsSection: false,
      hasSlicingSection: false,
      hasSpecSection: false,
      isUnstructuredBody: true,
    },
  };
}

/**
 * Parse the `## Goal` section: join its non-empty content lines into a
 * single one-line goal string.
 *
 * @param {string[]} lines - Raw content lines under the heading.
 * @returns {string}
 */
function parseGoalSection(lines) {
  return lines
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ');
}

/**
 * Parse a verbatim text-block section (`## Slicing` or `## Spec`) into a
 * newline-joined string. Unlike {@link parseGoalSection}, line breaks are
 * preserved so a bullet list, compact table, or folded Tech Spec survives the
 * round-trip; only blank lines and trailing whitespace are normalized.
 *
 * @param {string[]} lines
 * @returns {string}
 */
function parseTextBlockSection(lines) {
  return lines
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/^\n+|\n+$/g, '');
}

/**
 * Parse a `## Changes` / `## References` section into a list of
 * `PathEntry` entries. List markers are stripped, blank entries are
 * dropped, and each surviving entry is normalized via {@link parsePathEntry}.
 *
 * @param {string[]} lines - Raw content lines under the heading.
 * @param {string[]} warnings - Mutable warnings sink.
 * @returns {PathEntry[]}
 */
function parsePathEntrySection(lines, warnings) {
  const entries = [];
  for (const line of lines) {
    const stripped = stripListMarker(line);
    if (!stripped) continue;
    const entry = parsePathEntry(stripped, warnings);
    if (entry !== null) entries.push(entry);
  }
  return entries;
}

/**
 * Parse a plain bullet-list section (`## Acceptance` / `## Verify`) into a
 * list of trimmed strings, dropping blank entries.
 *
 * @param {string[]} lines - Raw content lines under the heading.
 * @returns {string[]}
 */
function parseTextListSection(lines) {
  return lines.map((l) => stripListMarker(l)).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse a GitHub Story issue body (markdown string) into a structured
 * {@link StoryBody}. Fails closed on malformed input.
 *
 * Returns a {@link ParseResult} containing the body, any non-fatal
 * warnings, and parse metadata. Use `result.body` directly; inspect
 * `result.warnings` to detect legacy path entries that should be
 * migrated.
 *
 * Informational finding emitted on `result.warnings`:
 * - `test-surface-unestimated` — when `estimated_test_files` is absent
 *   from both a structured body and the markdown. Callers that care about
 *   test-surface coverage SHOULD surface this to the operator.
 *
 * @param {string|object} input - Markdown string or already-structured body object.
 * @returns {ParseResult}
 * @throws {StoryBodyParseError} When the body is structurally unrecoverable.
 */
export function parse(input) {
  if (input === null || input === undefined) {
    throw new StoryBodyParseError('Story body is null or undefined', {
      field: 'body',
    });
  }

  // If the caller already has a structured object (e.g. from the decomposer
  // before it's serialized to markdown), parse it directly.
  if (typeof input === 'object' && !Array.isArray(input)) {
    return parseStructuredObject(input);
  }

  if (typeof input !== 'string') {
    throw new StoryBodyParseError(
      `Story body must be a string or structured object, got ${typeof input}`,
      { field: 'body' },
    );
  }

  const warnings = [];
  const { sections, footer, preamble } = splitSections(input);

  const hasGoalSection = sections.has('goal');
  const hasChangesSection = sections.has('changes');
  const hasAcceptanceSection = sections.has('acceptance');
  const hasVerifySection = sections.has('verify');
  const hasReferencesSection = sections.has('references');
  const hasNonGoalsSection = sections.has('non_goals');
  const hasSlicingSection = sections.has('slicing');
  const hasSpecSection = sections.has('spec');

  // If no structured sections found, treat as unstructured body.
  const isUnstructuredBody =
    !hasGoalSection &&
    !hasChangesSection &&
    !hasAcceptanceSection &&
    !hasVerifySection;

  if (isUnstructuredBody) {
    return parseUnstructuredBody(input, preamble, footer);
  }

  const goal = parseGoalSection(sections.get('goal') ?? []);
  // Optional v2 intra-Story delivery slice plan (`## Slicing`). Preserved as
  // a verbatim text block — a large Story (what v1 called an Epic) folds its
  // Delivery Slicing here instead of fanning out into sibling Stories; a
  // trivial Story omits it entirely. Parsed as a text block so a bullet list
  // or compact table round-trips.
  const slicing = parseTextBlockSection(sections.get('slicing') ?? []);
  const spec = parseTextBlockSection(sections.get('spec') ?? []);
  const changes = parsePathEntrySection(
    sections.get('changes') ?? [],
    warnings,
  );
  // The AC-<n> checkbox prefix is presentation-only (Story #4600): strip it
  // so acceptance[] round-trips byte-identical to the authored array.
  const acceptance = parseTextListSection(sections.get('acceptance') ?? []).map(
    (a) => a.replace(AC_PREFIX_RE, ''),
  );
  const verify = parseTextListSection(sections.get('verify') ?? []);
  const references = parsePathEntrySection(
    sections.get('references') ?? [],
    warnings,
  );
  const non_goals = parseTextListSection(sections.get('non_goals') ?? []);
  const dependsOn = extractBlockedBy(footer);

  // --- Recover wide / estimated_test_files from the meta block ---
  // serialize() writes these into a trailing `<!-- meta: {...} -->` comment
  // so round-trips preserve them. Absent meta block → canonical null defaults.
  const meta = extractMeta(input);
  const estimated_test_files = meta.estimated_test_files;
  const wide = meta.wide;
  const reason_to_exist = meta.reason_to_exist;
  const mandrel_version = meta.mandrel_version;
  const authored_at = meta.authored_at;
  if (estimated_test_files === null) {
    warnings.push(
      'test-surface-unestimated: estimated_test_files not present.',
    );
  }

  const body = {
    goal,
    slicing,
    spec,
    changes,
    acceptance,
    verify,
    references,
    non_goals,
    wide,
    reason_to_exist,
    depends_on: dependsOn,
    estimated_test_files,
    mandrel_version,
    authored_at,
  };

  return {
    body,
    warnings,
    info: {
      hasGoalSection,
      hasChangesSection,
      hasAcceptanceSection,
      hasVerifySection,
      hasReferencesSection,
      hasNonGoalsSection,
      hasSlicingSection,
      hasSpecSection,
      isUnstructuredBody: false,
    },
  };
}

/**
 * Parse a structured body object (as produced by the decomposer's JSON
 * output, before markdown serialization). Normalizes all fields to the
 * canonical shape.
 *
 * @param {object} obj
 * @returns {ParseResult}
 */
function parseStructuredObject(obj) {
  const warnings = [];

  const goal = typeof obj.goal === 'string' ? obj.goal.trim() : '';

  // slicing — optional v2 intra-Story delivery slice plan (verbatim text).
  const slicing = typeof obj.slicing === 'string' ? obj.slicing.trim() : '';

  // spec — optional folded Tech Spec (verbatim text).
  const spec = typeof obj.spec === 'string' ? obj.spec.trim() : '';

  // changes
  const rawChanges = Array.isArray(obj.changes) ? obj.changes : [];
  const changes = [];
  for (const raw of rawChanges) {
    const entry = parsePathEntry(raw, warnings);
    if (entry !== null) changes.push(entry);
  }

  // acceptance
  const acceptance = Array.isArray(obj.acceptance)
    ? obj.acceptance.filter((a) => typeof a === 'string' && a.trim().length > 0)
    : [];

  // verify
  const verify = Array.isArray(obj.verify)
    ? obj.verify.filter((v) => typeof v === 'string' && v.trim().length > 0)
    : [];

  // references
  const rawRefs = Array.isArray(obj.references) ? obj.references : [];
  const references = [];
  for (const raw of rawRefs) {
    const entry = parsePathEntry(raw, warnings);
    if (entry !== null) references.push(entry);
  }

  // non_goals (advisory negative-scope bullets)
  const non_goals = Array.isArray(obj.non_goals)
    ? obj.non_goals.filter((n) => typeof n === 'string' && n.trim().length > 0)
    : [];

  const wide = normalizeWide(obj.wide);
  const reason_to_exist = normalizeReasonToExist(obj.reason_to_exist);

  // depends_on: may be at top level or in body
  const rawDeps = Array.isArray(obj.depends_on) ? obj.depends_on : [];
  const depends_on = rawDeps.filter(
    (d) => typeof d === 'string' && d.trim().length > 0,
  );

  // estimated_test_files
  let estimated_test_files = null;
  if (typeof obj.estimated_test_files === 'number') {
    estimated_test_files = obj.estimated_test_files;
  } else if (obj.estimated_test_files == null) {
    warnings.push(
      'test-surface-unestimated: estimated_test_files not present.',
    );
  }

  // Provenance stamp (preserved verbatim; never re-derived here).
  const mandrel_version =
    typeof obj.mandrel_version === 'string' && obj.mandrel_version.trim()
      ? obj.mandrel_version.trim()
      : null;
  const authored_at =
    typeof obj.authored_at === 'string' && obj.authored_at.trim()
      ? obj.authored_at.trim()
      : null;

  const body = {
    goal,
    slicing,
    spec,
    changes,
    acceptance,
    verify,
    references,
    non_goals,
    wide,
    reason_to_exist,
    depends_on,
    estimated_test_files,
    mandrel_version,
    authored_at,
  };

  return {
    body,
    warnings,
    info: {
      hasGoalSection: 'goal' in obj,
      hasChangesSection: 'changes' in obj,
      hasAcceptanceSection: 'acceptance' in obj,
      hasVerifySection: 'verify' in obj,
      hasReferencesSection: 'references' in obj,
      hasNonGoalsSection: 'non_goals' in obj,
      hasSlicingSection: 'slicing' in obj,
      hasSpecSection: 'spec' in obj,
      isUnstructuredBody: false,
    },
  };
}

// ---------------------------------------------------------------------------
// Serializer
// ---------------------------------------------------------------------------

/**
 * Render a `PathEntry | string` as a markdown list item.
 *
 * @param {PathEntry | string} entry
 * @returns {string}
 */
function serializePathEntry(entry) {
  if (typeof entry === 'string') return entry;
  // Canonical object form (Story #4600): render as a human-readable bullet —
  // path in backticks, em-dash, assumption. parsePathEntry recognizes this
  // shape (and the legacy inline-JSON shape) for round-trip fidelity.
  return `\`${entry.path}\` — ${entry.assumption}`;
}

/**
 * Descriptor table for the human-readable Story-body sections, in canonical
 * emit order (`## Goal`, `## Slicing`, `## Spec`, `## Changes`,
 * `## Acceptance`, `## Verify`, `## References`, `## Non-Goals`). Each
 * descriptor reads one body field and returns the section's markdown block
 * when the field is present and non-empty, or `null` to omit the section.
 *
 * Standardising the section ladder as a single data table makes adding a new
 * optional section a one-line edit here rather than a new control-flow branch
 * in {@link serialize}.
 *
 * @type {Array<{ field: string, render: (value: unknown) => string | null }>}
 */
const SERIALIZE_SECTIONS = [
  {
    field: 'goal',
    render: (goal) =>
      typeof goal === 'string' && goal.trim().length > 0
        ? `## Goal\n${goal.trim()}`
        : null,
  },
  {
    // Visible wide-rationale line (Story #4600), rendered directly under
    // `## Goal`. Presentation only: the `<!-- meta -->` block remains the
    // canonical machine carrier and the parser skips this line, so `wide`
    // round-trips through the meta block alone. Absent/invalid wide emits
    // nothing, keeping every non-wide body byte-identical to before.
    field: 'wide',
    render: (wide) => {
      const normalized = normalizeWide(wide);
      return normalized === null ? null : `> **Wide:** ${normalized.reason}`;
    },
  },
  {
    // Optional v2 intra-Story delivery slice plan. Single-token `## Slicing`
    // heading (recognized by the `[\w-]+` field-heading regex). Verbatim text
    // block. Render-when-non-empty: an absent/empty `slicing` emits nothing,
    // so every pre-v2 body round-trips byte-identically.
    field: 'slicing',
    render: (slicing) =>
      typeof slicing === 'string' && slicing.trim().length > 0
        ? `## Slicing\n${slicing.trim()}`
        : null,
  },
  {
    // Optional folded Tech Spec. Like `## Slicing`, this is a verbatim text
    // block and emits nothing for absent/empty pre-v2 bodies.
    field: 'spec',
    render: (spec) =>
      typeof spec === 'string' && spec.trim().length > 0
        ? `## Spec\n${spec.trim()}`
        : null,
  },
  {
    field: 'changes',
    render: (changes) =>
      Array.isArray(changes) && changes.length > 0
        ? `## Changes\n${changes.map((c) => `- ${serializePathEntry(c)}`).join('\n')}`
        : null,
  },
  {
    // Each checkbox carries a stable 1-based `AC-<n>:` handle (Story #4600)
    // so humans and reviewers can reference criteria by number. The prefix
    // is presentation-only — parse() strips it, and validators compare the
    // top-level acceptance[] array, so numbering never affects gating.
    field: 'acceptance',
    render: (acceptance) =>
      Array.isArray(acceptance) && acceptance.length > 0
        ? `## Acceptance\n${acceptance.map((a, i) => `- [ ] AC-${i + 1}: ${a}`).join('\n')}`
        : null,
  },
  {
    field: 'verify',
    render: (verify) =>
      Array.isArray(verify) && verify.length > 0
        ? `## Verify\n${verify.map((v) => `- ${v}`).join('\n')}`
        : null,
  },
  {
    field: 'references',
    render: (references) =>
      Array.isArray(references) && references.length > 0
        ? `## References\n${references.map((r) => `- ${serializePathEntry(r)}`).join('\n')}`
        : null,
  },
  {
    // Advisory negative-scope bullets. Rendered as the hyphenated canonical
    // `## Non-Goals` heading (the spelling the parser's widened
    // `[\w-]+` field-heading regex recognizes). Render-when-non-empty: an
    // empty or absent `non_goals` emits nothing, so every pre-existing body
    // round-trips byte-identically.
    field: 'non_goals',
    render: (nonGoals) =>
      Array.isArray(nonGoals) && nonGoals.length > 0
        ? `## Non-Goals\n${nonGoals.map((n) => `- ${n}`).join('\n')}`
        : null,
  },
];

/**
 * Build the trailing `<!-- meta: {...} -->` block carrying the fields that
 * have no human-readable section (`wide`, `reason_to_exist`,
 * `estimated_test_files`). Returns the empty string when no meta field is
 * present so {@link serialize} appends nothing.
 *
 * Key insertion order (`wide` → `reason_to_exist` → `estimated_test_files` →
 * `mandrel_version` → `authored_at`) is load-bearing: it fixes the serialized
 * JSON byte sequence the parser's meta round-trip and the unit suite assert
 * against. The provenance stamp keys are appended **last** so every
 * pre-existing (stamp-less) body serialises byte-identically to before.
 *
 * @param {StoryBody} body
 * @returns {string}
 */
function serializeMetaBlock(body) {
  const metaFields = {};
  const wide = normalizeWide(body.wide);
  if (wide !== null) {
    metaFields.wide = wide;
  }
  const reasonToExist = normalizeReasonToExist(body.reason_to_exist);
  if (reasonToExist !== null) {
    metaFields.reason_to_exist = reasonToExist;
  }
  if (typeof body.estimated_test_files === 'number') {
    metaFields.estimated_test_files = body.estimated_test_files;
  }
  if (typeof body.mandrel_version === 'string' && body.mandrel_version.trim()) {
    metaFields.mandrel_version = body.mandrel_version.trim();
  }
  if (typeof body.authored_at === 'string' && body.authored_at.trim()) {
    metaFields.authored_at = body.authored_at.trim();
  }
  if (Object.keys(metaFields).length === 0) return '';
  return `\n\n<!-- meta: ${JSON.stringify(metaFields)} -->`;
}

/**
 * Build the visible `> 🏷️ Authored with Mandrel v<version> · <date>` marker
 * line when the body carries a complete provenance stamp
 * (`mandrel_version` + `authored_at`). Emitted just above the meta block so it
 * round-trips with the hidden field. Returns the empty string when either
 * field is absent, so every pre-existing (stamp-less) body serialises
 * byte-identically to before.
 *
 * @param {StoryBody} body
 * @returns {string}
 */
function serializeAuthoredMarker(body) {
  const version =
    typeof body.mandrel_version === 'string' ? body.mandrel_version.trim() : '';
  const authoredAt =
    typeof body.authored_at === 'string' ? body.authored_at.trim() : '';
  if (!version || !authoredAt) return '';
  return `\n\n${authoredMarkerLine({ version, authoredAt })}`;
}

/**
 * Build the optional `---` footer block (`parent` / `blocked by` lines).
 * Returns the empty string when `opts.includeFooter` is falsy.
 *
 * @param {StoryBody} body
 * @param {SerializeOptions} opts
 * @returns {string}
 */
function serializeFooter(body, opts) {
  if (!opts.includeFooter) return '';
  const footerLines = ['---'];
  if (opts.footer?.parent) footerLines.push(`parent: #${opts.footer.parent}`);
  // Story #4545 — no `Epic: #N` branch. `pr-base-guard.js` hard-refuses a
  // Story body carrying that footer, so composing one here would let the
  // framework generate work it would then reject at delivery.
  if (Array.isArray(body.depends_on)) {
    for (const dep of body.depends_on) {
      footerLines.push(`blocked by ${dep}`);
    }
  }
  return `\n\n${footerLines.join('\n')}`;
}

/**
 * Serialize a structured {@link StoryBody} back to the canonical markdown
 * format written to GitHub issue bodies.
 *
 * The output matches the section order the spec-renderer uses:
 * `## Goal`, `## Slicing`, `## Spec`, `## Changes`, `## Acceptance`,
 * `## Verify`, `## References`, `## Non-Goals` (each omitted when empty).
 *
 * `wide`, `reason_to_exist`, and `estimated_test_files` are emitted as a
 * fenced `<!-- meta -->` comment block so round-trips preserve them without
 * polluting the human-readable body.
 *
 * @param {StoryBody} body
 * @param {SerializeOptions} [opts]
 * @returns {string}
 */
export function serialize(body, opts = {}) {
  if (!body || typeof body !== 'object') {
    throw new StoryBodyParseError('serialize: body must be a non-null object', {
      field: 'body',
    });
  }

  const sections = [];
  for (const descriptor of SERIALIZE_SECTIONS) {
    const block = descriptor.render(body[descriptor.field]);
    if (block !== null) sections.push(block);
  }

  return (
    sections.join('\n\n') +
    serializeAuthoredMarker(body) +
    serializeMetaBlock(body) +
    serializeFooter(body, opts)
  );
}

// ---------------------------------------------------------------------------
// Convenience: extract changes paths for the wave planner
// ---------------------------------------------------------------------------

/**
 * Extract the list of path strings from a parsed `changes[]` array.
 * Glob-bearing entries are flagged via `{ path, isGlob: true }`.
 *
 * The wave planner (Feature 3) uses this to compute file-overlap
 * serialization between Stories: if any entry `isGlob`, the Story's
 * footprint is `unknown-width`.
 *
 * @param {ChangeEntry[]} changes
 * @returns {Array<{ path: string, isGlob: boolean }>}
 */
export function extractChangePaths(changes) {
  if (!Array.isArray(changes)) return [];
  return changes.map((entry) => {
    const raw = typeof entry === 'string' ? entry : entry.path;
    const isGlob = raw.includes('*') || raw.includes('?') || raw.includes('{');
    return { path: raw, isGlob };
  });
}

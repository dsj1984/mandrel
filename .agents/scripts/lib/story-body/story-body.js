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
 *   changes:             PathEntry[],      // files/globs this Story touches
 *   acceptance:          string[],         // observable criteria
 *   verify:              string[],         // exact commands / tier annotation
 *   references:          PathEntry[],      // read-only paths (optional)
 *   wide:                { reason } | null,// declared-wide footprint (optional)
 *   reason_to_exist:     string | null,    // one-sentence cohesion reason (optional)
 *   depends_on:          string[],         // blocker story slugs or #ids
 *   estimated_test_files: number | null,   // absent → null (informational)
 * }
 * ```
 *
 * Where `PathEntry` is one of:
 *   - `{ path: string, assumption: "creates"|"refactors-existing"|"exists"|"deletes" }`
 *     (canonical form)
 *   - `string` (legacy form — emits a `legacy-path-entry` warning)
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
 * @typedef {PathEntry | string} ChangeEntry
 *   Canonical: PathEntry object.
 *   Legacy: bare string bullet (emits a `legacy-path-entry` warning via
 *   the `warnings` array on {@link ParseResult}).
 */

/**
 * @typedef {object} StoryBody
 * @property {string}        goal                - One-sentence purpose statement.
 * @property {ChangeEntry[]} changes             - Files / globs this Story modifies.
 * @property {string[]}      acceptance          - Observable acceptance criteria.
 * @property {string[]}      verify              - Exact commands with tier annotation.
 * @property {PathEntry[]}   references          - Read-only paths (may be empty).
 * @property {{ reason: string }|null} wide      - Declared-wide footprint (reason), or null.
 * @property {string|null}   reason_to_exist     - One-sentence cohesion reason ("why this Story exists"), or null.
 * @property {string[]}      depends_on          - Blocking story slugs / issue refs.
 * @property {number|null}   estimated_test_files - Test surface count or null.
 */

/**
 * @typedef {object} ParseResult
 * @property {StoryBody}  body      - The parsed structured body.
 * @property {string[]}   warnings  - Non-fatal issues (e.g. legacy-path-entry).
 * @property {ParseInfo}  info      - Metadata about the parse.
 */

/**
 * @typedef {object} ParseInfo
 * @property {boolean} hasGoalSection       - Whether a `## Goal` section was found.
 * @property {boolean} hasChangesSection    - Whether a `## Changes` section was found.
 * @property {boolean} hasAcceptanceSection - Whether a `## Acceptance` section was found.
 * @property {boolean} hasVerifySection     - Whether a `## Verify` section was found.
 * @property {boolean} hasReferencesSection - Whether a `## References` section was found.
 * @property {boolean} isLegacyStringBody   - True when no structured sections were found.
 */

/**
 * @typedef {object} SerializeOptions
 * @property {boolean} [includeFooter=false] - Include `---\nparent/epic/blocked-by` footer.
 * @property {object}  [footer]              - Footer fields when `includeFooter` is true.
 * @property {number}  [footer.parent]       - Parent feature issue number.
 * @property {number}  [footer.epic]         - Epic issue number.
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

// Heading text → body field name
const HEADING_TO_FIELD = new Map([
  ['goal', 'goal'],
  ['changes', 'changes'],
  ['acceptance', 'acceptance'],
  ['verify', 'verify'],
  ['references', 'references'],
]);

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

/**
 * Parse a single `changes` / `references` bullet into a `PathEntry` or
 * legacy string. Emits a `legacy-path-entry` warning for string form.
 *
 * Object form: `{ path: "...", assumption: "creates" }` (stored as
 * `- { "path": "...", "assumption": "..." }` or just recognized from the
 * structured body directly — when deserializing from a structured object
 * that was never serialized to markdown, the entry arrives as-is).
 *
 * String form: `src/foo.js: create handleSubmit`
 *
 * @param {string|object} raw
 * @param {string[]} warnings
 * @returns {PathEntry | string}
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
      // JSON parse failed — fall through to legacy string handling.
    }
  }

  // Legacy string form — warn but accept.
  warnings.push(
    `legacy-path-entry: change entry "${str.slice(0, 80)}" is a plain string; prefer { path, assumption } object form.`,
  );
  return str;
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

// Matches the trailing `<!-- meta: {...} -->` block serialize() emits.
const META_BLOCK_RE = /<!--\s*meta:\s*(\{[\s\S]*?\})\s*-->/;

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
 * @param {string} markdown
 * @returns {{ wide: { reason: string }|null, reason_to_exist: string|null, estimated_test_files: number|null }}
 */
function extractMeta(markdown) {
  const result = {
    wide: null,
    reason_to_exist: null,
    estimated_test_files: null,
  };
  const match = markdown.match(META_BLOCK_RE);
  if (!match) return result;

  let parsed;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    // Malformed meta comment — degrade to defaults rather than corrupt the body.
    return result;
  }
  if (parsed === null || typeof parsed !== 'object') return result;

  result.wide = normalizeWide(parsed.wide);
  result.reason_to_exist = normalizeReasonToExist(parsed.reason_to_exist);
  if (typeof parsed.estimated_test_files === 'number') {
    result.estimated_test_files = parsed.estimated_test_files;
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

    // Detect `## Heading` lines
    const headingMatch = line.match(/^##\s+(\w+)\s*$/i);
    if (headingMatch) {
      const name = headingMatch[1].toLowerCase();
      if (HEADING_TO_FIELD.has(name)) {
        inPreamble = false;
        currentSection = name;
        if (!sections.has(currentSection)) sections.set(currentSection, []);
        continue;
      }
    }

    // The trailing `<!-- meta: {...} -->` block is machine metadata, not
    // section content. Skip it so a `## References` section immediately
    // followed by the meta block does not swallow the comment as a
    // references entry. `extractMeta` reads it separately from the raw body.
    if (META_BLOCK_RE.test(line)) {
      continue;
    }

    if (inPreamble) {
      preambleLines.push(line);
    } else if (currentSection !== null) {
      const trimmed = line.trim();
      if (trimmed.length > 0) {
        sections.get(currentSection).push(line);
      }
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
 * Build the minimal {@link ParseResult} returned for a legacy string body —
 * markdown that carries no recognised structured section. The goal falls
 * back to the preamble text (or the whole trimmed input), `depends_on` is
 * still recovered from the footer, and all section arrays are empty.
 *
 * @param {string} input - The original markdown string.
 * @param {string} preamble - Text before the first heading (from splitSections).
 * @param {string} footer - Footer block text (from splitSections).
 * @returns {ParseResult}
 */
function parseLegacyStringBody(input, preamble, footer) {
  const warnings = [
    'legacy-string-body: no structured sections found; returning minimal body from preamble text.',
    'test-surface-unestimated: estimated_test_files not present.',
  ];
  const body = {
    goal: preamble || input.trim(),
    changes: [],
    acceptance: [],
    verify: [],
    references: [],
    wide: null,
    reason_to_exist: null,
    depends_on: extractBlockedBy(footer),
    estimated_test_files: null,
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
      isLegacyStringBody: true,
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
 * Parse a `## Changes` / `## References` section into a list of
 * `PathEntry | string` entries. List markers are stripped, blank entries are
 * dropped, and each surviving entry is normalized via {@link parsePathEntry}
 * (which appends `legacy-path-entry` warnings for bare-string bullets).
 *
 * @param {string[]} lines - Raw content lines under the heading.
 * @param {string[]} warnings - Mutable warnings sink.
 * @returns {Array<PathEntry|string>}
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

  // If no structured sections found, treat as legacy string body.
  const isLegacyStringBody =
    !hasGoalSection &&
    !hasChangesSection &&
    !hasAcceptanceSection &&
    !hasVerifySection;

  if (isLegacyStringBody) {
    return parseLegacyStringBody(input, preamble, footer);
  }

  const goal = parseGoalSection(sections.get('goal') ?? []);
  const changes = parsePathEntrySection(
    sections.get('changes') ?? [],
    warnings,
  );
  const acceptance = parseTextListSection(sections.get('acceptance') ?? []);
  const verify = parseTextListSection(sections.get('verify') ?? []);
  const references = parsePathEntrySection(
    sections.get('references') ?? [],
    warnings,
  );
  const dependsOn = extractBlockedBy(footer);

  // --- Recover wide / estimated_test_files from the meta block ---
  // serialize() writes these into a trailing `<!-- meta: {...} -->` comment
  // so round-trips preserve them. Absent meta block → canonical null defaults.
  const meta = extractMeta(input);
  const estimated_test_files = meta.estimated_test_files;
  const wide = meta.wide;
  const reason_to_exist = meta.reason_to_exist;
  if (estimated_test_files === null) {
    warnings.push(
      'test-surface-unestimated: estimated_test_files not present.',
    );
  }

  const body = {
    goal,
    changes,
    acceptance,
    verify,
    references,
    wide,
    reason_to_exist,
    depends_on: dependsOn,
    estimated_test_files,
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
      isLegacyStringBody: false,
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

  const body = {
    goal,
    changes,
    acceptance,
    verify,
    references,
    wide,
    reason_to_exist,
    depends_on,
    estimated_test_files,
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
      isLegacyStringBody: false,
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
  // Canonical object form: render as JSON inline for round-trip fidelity.
  return JSON.stringify({ path: entry.path, assumption: entry.assumption });
}

/**
 * Descriptor table for the human-readable Story-body sections, in canonical
 * emit order (`## Goal`, `## Changes`, `## Acceptance`, `## Verify`,
 * `## References`). Each descriptor reads one body field and returns the
 * section's markdown block when the field is present and non-empty, or `null`
 * to omit the section.
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
    field: 'changes',
    render: (changes) =>
      Array.isArray(changes) && changes.length > 0
        ? `## Changes\n${changes.map((c) => `- ${serializePathEntry(c)}`).join('\n')}`
        : null,
  },
  {
    field: 'acceptance',
    render: (acceptance) =>
      Array.isArray(acceptance) && acceptance.length > 0
        ? `## Acceptance\n${acceptance.map((a) => `- [ ] ${a}`).join('\n')}`
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
];

/**
 * Build the trailing `<!-- meta: {...} -->` block carrying the fields that
 * have no human-readable section (`wide`, `reason_to_exist`,
 * `estimated_test_files`). Returns the empty string when no meta field is
 * present so {@link serialize} appends nothing.
 *
 * Key insertion order (`wide` → `reason_to_exist` → `estimated_test_files`)
 * is load-bearing: it fixes the serialized JSON byte sequence the parser's
 * meta round-trip and the unit suite assert against.
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
  if (Object.keys(metaFields).length === 0) return '';
  return `\n\n<!-- meta: ${JSON.stringify(metaFields)} -->`;
}

/**
 * Build the optional `---` footer block (`parent` / `Epic` / `blocked by`
 * lines). Returns the empty string when `opts.includeFooter` is falsy.
 *
 * @param {StoryBody} body
 * @param {SerializeOptions} opts
 * @returns {string}
 */
function serializeFooter(body, opts) {
  if (!opts.includeFooter) return '';
  const footerLines = ['---'];
  if (opts.footer?.parent) footerLines.push(`parent: #${opts.footer.parent}`);
  if (opts.footer?.epic) footerLines.push(`Epic: #${opts.footer.epic}`);
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
 * `## Goal`, `## Changes`, `## Acceptance`, `## Verify`, `## References`
 * (omitted when empty).
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

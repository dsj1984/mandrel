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
 *   sizingProfile:       string | null,    // enum; required on wide Stories
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

import { FILE_ASSUMPTION_VALUES } from '../orchestration/task-body-validator.js';

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
 * @property {string|null}   sizingProfile       - Sizing profile or null.
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
    // Extract depends_on from footer even for legacy bodies.
    const dependsOn = extractBlockedBy(footer);
    warnings.push(
      'legacy-string-body: no structured sections found; returning minimal body from preamble text.',
    );
    warnings.push(
      'test-surface-unestimated: estimated_test_files not present.',
    );
    const body = {
      goal: preamble || input.trim(),
      changes: [],
      acceptance: [],
      verify: [],
      references: [],
      sizingProfile: null,
      depends_on: dependsOn,
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

  // --- Parse goal ---
  const goalLines = sections.get('goal') ?? [];
  const goal = goalLines
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ');

  // --- Parse changes ---
  const changeLines = sections.get('changes') ?? [];
  const changes = [];
  for (const line of changeLines) {
    const stripped = stripListMarker(line);
    if (!stripped) continue;
    const entry = parsePathEntry(stripped, warnings);
    if (entry !== null) changes.push(entry);
  }

  // --- Parse acceptance ---
  const acceptanceLines = sections.get('acceptance') ?? [];
  const acceptance = acceptanceLines
    .map((l) => stripListMarker(l))
    .filter(Boolean);

  // --- Parse verify ---
  const verifyLines = sections.get('verify') ?? [];
  const verify = verifyLines.map((l) => stripListMarker(l)).filter(Boolean);

  // --- Parse references (optional) ---
  const referenceLines = sections.get('references') ?? [];
  const references = [];
  for (const line of referenceLines) {
    const stripped = stripListMarker(line);
    if (!stripped) continue;
    const entry = parsePathEntry(stripped, warnings);
    if (entry !== null) {
      // References MUST be object form (canonical).
      if (typeof entry === 'string') {
        // Already warned as legacy-path-entry; keep as string for now.
        references.push(entry);
      } else {
        references.push(entry);
      }
    }
  }

  // --- Parse footer ---
  const dependsOn = extractBlockedBy(footer);

  // --- estimated_test_files (not present in markdown — always null from markdown) ---
  const estimated_test_files = null;
  warnings.push('test-surface-unestimated: estimated_test_files not present.');

  // --- sizingProfile (not in markdown sections — will be null from markdown) ---
  const sizingProfile = null;

  const body = {
    goal,
    changes,
    acceptance,
    verify,
    references,
    sizingProfile,
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

  const sizingProfile =
    typeof obj.sizingProfile === 'string' && obj.sizingProfile.trim().length > 0
      ? obj.sizingProfile.trim()
      : null;

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
    sizingProfile,
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
 * Serialize a structured {@link StoryBody} back to the canonical markdown
 * format written to GitHub issue bodies.
 *
 * The output matches the section order the spec-renderer uses:
 * `## Goal`, `## Changes`, `## Acceptance`, `## Verify`, `## References`
 * (omitted when empty).
 *
 * `sizingProfile` and `estimated_test_files` are emitted as a fenced
 * `<!-- meta -->` comment block so round-trips preserve them without
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

  // ## Goal
  if (typeof body.goal === 'string' && body.goal.trim().length > 0) {
    sections.push(`## Goal\n${body.goal.trim()}`);
  }

  // ## Changes
  if (Array.isArray(body.changes) && body.changes.length > 0) {
    const items = body.changes
      .map((c) => `- ${serializePathEntry(c)}`)
      .join('\n');
    sections.push(`## Changes\n${items}`);
  }

  // ## Acceptance
  if (Array.isArray(body.acceptance) && body.acceptance.length > 0) {
    const items = body.acceptance.map((a) => `- [ ] ${a}`).join('\n');
    sections.push(`## Acceptance\n${items}`);
  }

  // ## Verify
  if (Array.isArray(body.verify) && body.verify.length > 0) {
    const items = body.verify.map((v) => `- ${v}`).join('\n');
    sections.push(`## Verify\n${items}`);
  }

  // ## References (only when non-empty)
  if (Array.isArray(body.references) && body.references.length > 0) {
    const items = body.references
      .map((r) => `- ${serializePathEntry(r)}`)
      .join('\n');
    sections.push(`## References\n${items}`);
  }

  let out = sections.join('\n\n');

  // Meta block for fields not representable as human-readable sections.
  const metaFields = {};
  if (
    typeof body.sizingProfile === 'string' &&
    body.sizingProfile.trim().length > 0
  ) {
    metaFields.sizingProfile = body.sizingProfile;
  }
  if (typeof body.estimated_test_files === 'number') {
    metaFields.estimated_test_files = body.estimated_test_files;
  }
  if (Object.keys(metaFields).length > 0) {
    out += `\n\n<!-- meta: ${JSON.stringify(metaFields)} -->`;
  }

  // Footer
  if (opts.includeFooter) {
    const footerLines = ['---'];
    if (opts.footer?.parent) footerLines.push(`parent: #${opts.footer.parent}`);
    if (opts.footer?.epic) footerLines.push(`Epic: #${opts.footer.epic}`);
    if (Array.isArray(body.depends_on)) {
      for (const dep of body.depends_on) {
        footerLines.push(`blocked by ${dep}`);
      }
    }
    out += `\n\n${footerLines.join('\n')}`;
  }

  return out;
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

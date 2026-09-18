// .agents/scripts/lib/story-body/story-body.js
/**
 * Canonical Story-body parser/serializer — the single source of truth for
 * the Story body shape. The parser fails closed: a body that cannot be mapped
 * to the canonical shape throws, so a corrupt body cannot supply wrong
 * `depends_on` edges. `serialize(parse(md)) === md` for canonical input.
 *
 * @module story-body
 */

import { FILE_ASSUMPTION_VALUES } from '../orchestration/file-assumption-enum.js';
import {
  isProseBullet,
  matchBarePathToken,
  suggestPathEntryFix,
} from './body-format-lints.js';
import { isFooterSeparator, parseFooterBlockedByRefs } from './footer-block.js';

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
 * @property {string}        goal
 * @property {string}        slicing             - Intra-Story slice plan; '' when absent.
 * @property {string}        spec                - Folded Tech Spec; '' when absent.
 * @property {PathEntry[]}   changes
 * @property {string[]}      acceptance
 * @property {string[]}      verify
 * @property {PathEntry[]}   references          - Read-only paths.
 * @property {string[]}      non_goals           - Advisory negative scope.
 * @property {string[]}      depends_on          - Blocking story slugs / issue refs.
 */

/**
 * @typedef {object} ParseResult
 * @property {StoryBody}  body
 * @property {string[]}   warnings
 * @property {ParseInfo}  info
 */

/**
 * @typedef {object} ParseInfo
 * @property {boolean} hasGoalSection
 * @property {boolean} hasChangesSection
 * @property {boolean} hasAcceptanceSection
 * @property {boolean} hasVerifySection
 * @property {boolean} hasReferencesSection
 * @property {boolean} hasNonGoalsSection
 * @property {boolean} hasSlicingSection
 * @property {boolean} hasSpecSection
 * @property {boolean} isUnstructuredBody   - True when no structured sections were found.
 */

/**
 * @typedef {object} SerializeOptions
 * @property {boolean} [includeFooter=false] - Include `---\nparent/blocked-by` footer.
 * @property {object}  [footer]
 * @property {number}  [footer.parent]
 */

/** Thrown when a Story body cannot be parsed; never catch to continue. */
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

// Keys are lower-cased with `-` folded to `_` (see splitSections).
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

/**
 * @param {string} line
 * @returns {string}
 */
function stripListMarker(line) {
  return line.replace(/^-\s+(?:\[\s*[xX ]?\s*\]\s+)?/, '').trim();
}

// `path` — assumption: the shape serialize() emits. The inline-JSON bullet is
// still accepted at parse time because live issue bodies are never rewritten.
const HUMANIZED_PATH_ENTRY_RE = /^`([^`]+)`\s+—\s+(\S+)$/;

// Presentation-only `AC-<n>:` handle (lettered `AC-14a:` too, copied from
// source tickets); parse() strips it so acceptance[] round-trips.
const AC_PREFIX_RE = /^AC-\d+[a-z]?:\s*/i;

// Retired machine-managed marker lines nothing writes any more. Live bodies
// still carry them, so the parser skips them rather than absorbing them into
// the last section; they are dropped on re-serialize.
const WIDE_MARKER_LINE_RE = /^>\s*\*\*Wide:\*\*/;
const AUTHORED_MARKER_LINE_RE = /^\s*>\s*🏷️\s+Authored with Mandrel\b/;
const META_BLOCK_RE = /<!--\s*meta:[\s\S]*?-->/;

/**
 * Parse one `changes` / `references` bullet: bare path (`assumption: null`),
 * humanized `` `path` — assumption ``, or inline-JSON object.
 *
 * @param {string|object} raw
 * @param {string[]} warnings
 * @returns {PathEntry}
 */
function parsePathEntry(raw, warnings) {
  if (raw !== null && typeof raw === 'object') {
    return pathEntryFromObject(raw);
  }

  const str = String(raw).trim();
  if (str.length === 0) return null;

  const entry = pathEntryFromHumanized(str) ?? pathEntryFromInlineJson(str);
  if (entry) return entry;
  return pathEntryFromBare(str);
}

/**
 * Last shape tried, so it owns the rejection. A `{`-leading string here is
 * malformed JSON, not a path. Prose and non-path tokens get distinct refusals
 * because they need different fixes.
 *
 * @param {string} str
 * @returns {PathEntry}
 */
function pathEntryFromBare(str) {
  const bare = str.startsWith('{') ? null : matchBarePathToken(str);
  if (bare !== null) return { path: bare, assumption: null };

  const shape = isProseBullet(str)
    ? 'is prose, not a path'
    : 'names no usable path';
  throw new StoryBodyParseError(
    `changes/references entry ${shape} — a bullet must be a single ` +
      `whitespace-free path token, or a { path, assumption } object: ` +
      `${str.slice(0, 120)}${pathEntryFixIt(str)}`,
    { field: 'changes', raw: str },
  );
}

/**
 * A canonical value (pinned), `null` (omitted — persist derives it), or
 * `undefined` (not an assumption — a typo must fail closed).
 *
 * @param {unknown} raw
 * @returns {string|null|undefined}
 */
function readAssumption(raw) {
  if (FILE_ASSUMPTION_VALUES.includes(raw)) return raw;
  return raw == null ? null : undefined;
}

/**
 * @param {object} raw
 * @returns {PathEntry}
 */
function pathEntryFromObject(raw) {
  const path = typeof raw.path === 'string' ? raw.path.trim() : '';
  const assumption = readAssumption(raw.assumption);
  if (path !== '' && assumption !== undefined) {
    return { path, assumption };
  }
  throw new StoryBodyParseError(
    `changes/references entry is an object but not a valid PathEntry: ${JSON.stringify(raw)}`,
    { field: 'changes', raw: JSON.stringify(raw) },
  );
}

/**
 * `null` when not the humanized shape; throws when recognized but invalid.
 *
 * @param {string} str
 * @returns {PathEntry|null}
 */
function pathEntryFromHumanized(str) {
  const humanized = str.match(HUMANIZED_PATH_ENTRY_RE);
  if (!humanized) return null;
  const path = humanized[1].trim();
  if (path.length > 0 && FILE_ASSUMPTION_VALUES.includes(humanized[2])) {
    return { path, assumption: humanized[2] };
  }
  throw new StoryBodyParseError(
    `changes/references entry is a humanized bullet but not a valid PathEntry: ${str.slice(0, 120)}${pathEntryFixIt(str)}`,
    { field: 'changes', raw: str },
  );
}

/**
 * `null` when not a JSON object (the caller then tries the bare form).
 *
 * @param {string} str
 * @returns {PathEntry|null}
 */
function pathEntryFromInlineJson(str) {
  if (!str.startsWith('{')) return null;
  let parsed;
  try {
    parsed = JSON.parse(str);
  } catch {
    return null;
  }
  return parsed !== null && typeof parsed === 'object'
    ? pathEntryFromObject(parsed)
    : null;
}

/**
 * ` Suggested fix: …` suffix for a rejected bullet, or '' when nothing is
 * inferable.
 *
 * @param {string} raw The rejected bullet text.
 * @returns {string}
 */
function pathEntryFixIt(raw) {
  const suggestion = suggestPathEntryFix(raw);
  if (suggestion === null) return '';
  return ` — Suggested fix: ${suggestion} (adjust the assumption to creates|deletes if this is a new file or a removal).`;
}

/**
 * Delegates to footer-block.js so the body and dispatch-edge parsers cannot
 * disagree about what declares an edge.
 *
 * @param {string} footerBlock
 * @returns {string[]}
 */
function extractBlockedBy(footerBlock) {
  return parseFooterBlockedByRefs(footerBlock);
}

/**
 * Split markdown into named sections plus the footer block; content after
 * the footer separator is not parsed as sections.
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

    if (isFooterSeparator(line, lines, i)) {
      footerStart = i;
      break;
    }

    // `##` or `###` (GitHub Issue Forms render labels as level 3). The token
    // is a single `[\w-]+` word so `Non-Goals` matches; multi-word headings
    // fall through to the terminator branch below.
    const fieldHeadingMatch = line.match(/^#{2,3}\s+([\w-]+)\s*$/i);
    const fieldName = fieldHeadingMatch?.[1]?.toLowerCase().replace(/-/g, '_');
    if (HEADING_TO_FIELD.has(fieldName)) {
      inPreamble = false;
      currentSection = fieldName;
      if (!sections.has(currentSection)) sections.set(currentSection, []);
      continue;
    }

    if (isSectionTerminatorHeading(line, inPreamble, currentSection)) {
      currentSection = null;
      continue;
    }

    if (isMachineMarkerLine(line)) continue;

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

/**
 * A non-canonical heading closes the current section so appended extended
 * content (e.g. `## Agent Prompts`) never bleeds into `verify[]` /
 * `acceptance[]`. Text-block sections keep their own headings.
 *
 * @param {string} line
 * @param {boolean} inPreamble
 * @param {string|null} currentSection
 * @returns {boolean}
 */
function isSectionTerminatorHeading(line, inPreamble, currentSection) {
  return (
    !inPreamble &&
    /^#{1,6}\s+\S/.test(line) &&
    !TEXT_BLOCK_FIELDS.has(currentSection)
  );
}

/**
 * @param {string} line
 * @returns {boolean}
 */
function isMachineMarkerLine(line) {
  return (
    META_BLOCK_RE.test(line) ||
    AUTHORED_MARKER_LINE_RE.test(line) ||
    WIDE_MARKER_LINE_RE.test(line)
  );
}

/**
 * Minimal result for a body with no structured section: goal falls back to
 * the preamble, `depends_on` is still read from the footer.
 *
 * @param {string} input
 * @param {string} preamble
 * @param {string} footer
 * @returns {ParseResult}
 */
function parseUnstructuredBody(input, preamble, footer) {
  const warnings = [
    'unstructured-body: no structured sections found; returning minimal body from preamble text.',
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
    depends_on: extractBlockedBy(footer),
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
 * @param {string[]} lines
 * @returns {string}
 */
function parseGoalSection(lines) {
  return lines
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ');
}

/**
 * Line breaks are preserved so lists and tables round-trip; only blank edge
 * lines and trailing whitespace are normalized.
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
 * @param {string[]} lines
 * @param {string[]} warnings
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
 * @param {string[]} lines
 * @returns {string[]}
 */
function parseTextListSection(lines) {
  return lines.map((l) => stripListMarker(l)).filter(Boolean);
}

/**
 * Strip every stacked `AC-<n>:` handle. serialize() numbers checkboxes from
 * position, so a kept handle would render doubled; parse and persist share
 * this so they agree on the grammar.
 *
 * @param {string} item
 * @returns {{ text: string, stripped: boolean }} The handle-free text, and
 *   whether anything was removed.
 */
export function stripAcceptanceHandle(item) {
  const original = String(item ?? '');
  let text = original;
  while (AC_PREFIX_RE.test(text)) {
    text = text.replace(AC_PREFIX_RE, '');
  }
  return { text, stripped: text !== original };
}

/**
 * Parse a Story issue body (markdown or structured object).
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

  const isUnstructuredBody =
    !hasGoalSection &&
    !hasChangesSection &&
    !hasAcceptanceSection &&
    !hasVerifySection;

  if (isUnstructuredBody) {
    return parseUnstructuredBody(input, preamble, footer);
  }

  const goal = parseGoalSection(sections.get('goal') ?? []);
  const slicing = parseTextBlockSection(sections.get('slicing') ?? []);
  const spec = parseTextBlockSection(sections.get('spec') ?? []);
  const changes = parsePathEntrySection(
    sections.get('changes') ?? [],
    warnings,
  );
  const acceptance = parseTextListSection(sections.get('acceptance') ?? []).map(
    (a) => stripAcceptanceHandle(a).text,
  );
  const verify = parseTextListSection(sections.get('verify') ?? []);
  const references = parsePathEntrySection(
    sections.get('references') ?? [],
    warnings,
  );
  const non_goals = parseTextListSection(sections.get('non_goals') ?? []);
  const dependsOn = extractBlockedBy(footer);

  const body = {
    goal,
    slicing,
    spec,
    changes,
    acceptance,
    verify,
    references,
    non_goals,
    depends_on: dependsOn,
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
 * Normalize a structured body object (pre-serialization decomposer output).
 *
 * @param {object} obj
 * @returns {ParseResult}
 */
function parseStructuredObject(obj) {
  const warnings = [];

  const body = {};
  for (const { name, kind } of STRUCTURED_FIELD_SPECS) {
    body[name] = STRUCTURED_FIELD_NORMALIZERS[kind](obj[name], warnings);
  }

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

/**
 * Field specs in canonical body-key order.
 *
 * @type {Array<{ name: string, kind: keyof typeof STRUCTURED_FIELD_NORMALIZERS }>}
 */
const STRUCTURED_FIELD_SPECS = [
  { name: 'goal', kind: 'text' },
  { name: 'slicing', kind: 'text' },
  { name: 'spec', kind: 'text' },
  { name: 'changes', kind: 'pathEntryList' },
  { name: 'acceptance', kind: 'stringList' },
  { name: 'verify', kind: 'stringList' },
  { name: 'references', kind: 'pathEntryList' },
  { name: 'non_goals', kind: 'stringList' },
  { name: 'depends_on', kind: 'stringList' },
];

/**
 * @type {Record<string, (raw: unknown, warnings: string[]) => unknown>}
 */
const STRUCTURED_FIELD_NORMALIZERS = {
  text: (raw) => (typeof raw === 'string' ? raw.trim() : ''),
  stringList: (raw) =>
    Array.isArray(raw)
      ? raw.filter((s) => typeof s === 'string' && s.trim().length > 0)
      : [],
  pathEntryList: (raw, warnings) => {
    const entries = [];
    for (const item of Array.isArray(raw) ? raw : []) {
      const entry = parsePathEntry(item, warnings);
      if (entry !== null) entries.push(entry);
    }
    return entries;
  },
};

/**
 * @param {PathEntry | string} entry
 * @returns {string}
 */
function serializePathEntry(entry) {
  if (typeof entry === 'string') return entry;
  // A bare entry (no assumption) stays bare; persist derives the assumption.
  return [`\`${entry.path}\``, entry.assumption].filter(Boolean).join(' — ');
}

/**
 * Sections in canonical emit order; `render` returns `null` to omit, so an
 * absent optional field keeps older bodies round-tripping byte-identically.
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
    field: 'slicing',
    render: (slicing) =>
      typeof slicing === 'string' && slicing.trim().length > 0
        ? `## Slicing\n${slicing.trim()}`
        : null,
  },
  {
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
    field: 'non_goals',
    render: (nonGoals) =>
      Array.isArray(nonGoals) && nonGoals.length > 0
        ? `## Non-Goals\n${nonGoals.map((n) => `- ${n}`).join('\n')}`
        : null,
  },
];

/**
 * @param {StoryBody} body
 * @param {SerializeOptions} opts
 * @returns {string}
 */
function serializeFooter(body, opts) {
  if (!opts.includeFooter) return '';
  const footerLines = ['---'];
  if (opts.footer?.parent) footerLines.push(`parent: #${opts.footer.parent}`);
  // Never an `Epic: #N` line: pr-base-guard.js refuses a body carrying one.
  if (Array.isArray(body.depends_on)) {
    for (const dep of body.depends_on) {
      footerLines.push(`blocked by ${dep}`);
    }
  }
  return `\n\n${footerLines.join('\n')}`;
}

/**
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

  return sections.join('\n\n') + serializeFooter(body, opts);
}

/**
 * Path strings from `changes[]`; any glob entry makes the footprint
 * unknown-width for the wave planner.
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

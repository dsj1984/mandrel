/**
 * conventional-subject.js — pure Conventional-Commit rules for the squash
 * subject a Story lands on `main`: type precedence by release impact,
 * acronym-safe casing (commitlint never sees a squash subject, but a mangled
 * acronym is permanent in the changelog), and a breaking change that
 * survives the squash as a `!`.
 */

/**
 * Mirrors commitlint `type-enum` and release-please `changelog-sections`;
 * kept in sync by hand.
 */
const CONVENTIONAL_TYPES = Object.freeze([
  'feat',
  'fix',
  'perf',
  'refactor',
  'revert',
  'docs',
  'style',
  'chore',
  'test',
  'build',
  'ci',
]);

/**
 * Release-impact rank, LOWER wins, from `changelog-sections`; the hidden
 * types tie because the release notes don't distinguish them.
 *
 * @type {Readonly<Record<string, number>>}
 */
const TYPE_RANK = Object.freeze({
  feat: 0, // "Added"
  fix: 1, // "Fixed"
  perf: 2, // "Performance"
  revert: 3, // "Reverted"
  refactor: 4, // "Changed"
  docs: 5, // hidden
  style: 5, // hidden
  chore: 5, // hidden
  test: 5, // hidden
  build: 5, // hidden
  ci: 5, // hidden
});

const UNRANKED = Number.MAX_SAFE_INTEGER;

const TYPE_GROUP = CONVENTIONAL_TYPES.join('|');

// <type>(<scope>)?!?: <description> — the shape config-conventional enforces.
const CONVENTIONAL_HEADER_RE = new RegExp(
  `^(?:${TYPE_GROUP})(?:\\([^()\\r\\n]+\\))?!?: \\S.*$`,
);
const LEADING_TYPE_RE = new RegExp(
  `^(${TYPE_GROUP})(?:\\([^()\\r\\n]+\\))?(!?):`,
);
const HEADER_PARTS_RE = new RegExp(
  `^((?:${TYPE_GROUP})(?:\\([^()\\r\\n]+\\))?)(!?): (.*)$`,
);

/** Case-sensitive, as the parser's `noteKeywords` are. */
const BREAKING_FOOTER_RE = /^BREAKING[ -]CHANGE:[ \t]*(.*)$/;

const TRAILER_RE = /^[A-Za-z][A-Za-z-]*:[ \t]/;
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;

/**
 * @param {string} subject
 * @returns {boolean}
 */
export function isConventionalSubject(subject) {
  if (typeof subject !== 'string') return false;
  return CONVENTIONAL_HEADER_RE.test(subject.trim());
}

/**
 * @param {string} subject
 * @returns {string|null}
 */
function parseConventionalType(subject) {
  if (typeof subject !== 'string') return null;
  const match = subject.trim().match(LEADING_TYPE_RE);
  return match ? match[1] : null;
}

/**
 * Rank, then commit count, then earliest use (the tie-breaks only matter in
 * the hidden tier).
 *
 * @param {{rank: number, count: number, firstIndex: number}} a
 * @param {{rank: number, count: number, firstIndex: number}} b
 * @returns {number}
 */
function compareTypeCandidates(a, b) {
  if (a.rank !== b.rank) return a.rank - b.rank;
  if (a.count !== b.count) return b.count - a.count;
  return a.firstIndex - b.firstIndex;
}

/**
 * `subjects` MUST be oldest-first: the last tie-break treats index 0 as the
 * Story's primary commit.
 *
 * @param {string[]} subjects Commit subjects, oldest first.
 * @returns {string|null}
 */
export function pickDominantType(subjects) {
  /** @type {Map<string, {type: string, rank: number, count: number, firstIndex: number}>} */
  const candidates = new Map();
  const list = Array.isArray(subjects) ? subjects : [];
  list.forEach((subject, index) => {
    const type = parseConventionalType(subject);
    if (!type) return;
    const seen = candidates.get(type);
    if (seen) {
      seen.count += 1;
      return;
    }
    candidates.set(type, {
      type,
      rank: TYPE_RANK[type] ?? UNRANKED,
      count: 1,
      firstIndex: index,
    });
  });
  if (candidates.size === 0) return null;
  return [...candidates.values()].sort(compareTypeCandidates)[0].type;
}

/**
 * Leading all-caps word of 2+ letters (non-letters ignored), so `CI/CD` is an
 * acronym but a lone "A" or `A11y` is not.
 *
 * @param {string} text
 * @returns {boolean}
 */
function leadsWithAcronym(text) {
  const [word = ''] = text.split(/\s+/, 1);
  const letters = word.replace(/[^A-Za-z]/g, '');
  return letters.length >= 2 && letters === letters.toUpperCase();
}

/**
 * Lowercase the first character unless the leading word is an acronym.
 *
 * @param {string} text
 * @returns {string}
 */
export function shapeDescription(text) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (trimmed.length === 0) return trimmed;
  if (leadsWithAcronym(trimmed)) return trimmed;
  return trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
}

/**
 * Insert `!` before the colon (after any scope); otherwise unchanged.
 *
 * @param {string} subject
 * @returns {string}
 */
export function markBreaking(subject) {
  const parts = String(subject ?? '').match(HEADER_PARTS_RE);
  if (!parts) return subject;
  const [, prefix, bang, description] = parts;
  if (bang === '!') return subject;
  return `${prefix}!: ${description}`;
}

/**
 * A footer note runs until a blank line, another trailer, or the end.
 *
 * @param {string[]} lines
 * @param {number} start Index of the matched footer line.
 * @param {string} head The footer line's own text (may be empty).
 * @returns {{ note: string, next: number }}
 */
function readFooterNote(lines, start, head) {
  const collected = head.trim().length > 0 ? [head.trim()] : [];
  let cursor = start + 1;
  while (cursor < lines.length) {
    const line = lines[cursor];
    if (line.trim().length === 0) break;
    if (BREAKING_FOOTER_RE.test(line) || TRAILER_RE.test(line)) break;
    collected.push(line.trim());
    cursor += 1;
  }
  return { note: collected.join(' ').trim(), next: cursor };
}

/**
 * Blank lines inside code fences, so a quoted footer is not a declaration;
 * blanking (not dropping) keeps indices and closes an open note.
 *
 * @param {string[]} lines
 * @returns {string[]}
 */
function blankFencedLines(lines) {
  let fence = null;
  return lines.map((line) => {
    const marker = line.match(FENCE_RE)?.[1][0];
    if (!marker) return fence === null ? line : '';
    if (fence === null) fence = marker;
    else if (fence === marker) fence = null;
    return '';
  });
}

/**
 * @param {string} text
 * @param {boolean} readHeaderBang False for the Story body, which has no header.
 * @returns {{ breaking: boolean, notes: string[], subject: string|null }}
 */
function scanForBreaking(text, readHeaderBang) {
  const lines = blankFencedLines(String(text ?? '').split('\n'));
  const notes = [];
  let breaking = false;
  let subject = null;

  if (readHeaderBang) {
    const header = lines[0]?.trim() ?? '';
    const parts = header.match(HEADER_PARTS_RE);
    if (parts?.[2] === '!') {
      breaking = true;
      subject = parts[3].trim();
    }
  }

  let cursor = 0;
  while (cursor < lines.length) {
    const match = lines[cursor].match(BREAKING_FOOTER_RE);
    if (!match) {
      cursor += 1;
      continue;
    }
    breaking = true;
    const { note, next } = readFooterNote(lines, cursor, match[1]);
    if (note.length > 0) notes.push(note);
    cursor = Math.max(next, cursor + 1);
  }

  return { breaking, notes, subject };
}

/**
 * Breaking declarations from any commit (footer or header `!`) or a footer
 * line in the Story body; prose never counts. With no footer text, the `!`
 * commit's description is the note, per the spec.
 *
 * @param {{ commitMessages?: string[], storyBody?: string }} args
 * @returns {{ breaking: boolean, notes: string[] }}
 */
export function collectBreakingNotes({ commitMessages = [], storyBody = '' }) {
  const notes = [];
  let breaking = false;
  let bangSubject = null;

  for (const message of Array.isArray(commitMessages) ? commitMessages : []) {
    const scan = scanForBreaking(message, true);
    breaking = breaking || scan.breaking;
    notes.push(...scan.notes);
    bangSubject ??= scan.subject;
  }

  const bodyScan = scanForBreaking(storyBody, false);
  breaking = breaking || bodyScan.breaking;
  notes.push(...bodyScan.notes);

  if (breaking && notes.length === 0 && bangSubject) notes.push(bangSubject);
  return { breaking, notes: [...new Set(notes)] };
}

/**
 * dependency-parser.js — Shared Dependency & Metadata Parsing Utilities
 *
 * Canonical implementation of dependency-related regex parsing and
 * ticket metadata extraction, shared by the ticketing provider and the
 * orchestration layer (e.g. providers/github/tickets.js,
 * lib/story-adjacency.js, lib/branch-name-guard.js).
 */

/**
 * Parse `blocked by #NNN` and `depends on #NNN` references from text.
 * Handles case-insensitive variations.
 *
 * @param {string} body - Issue body or freeform text.
 * @returns {number[]} Array of issue numbers this text declares as blockers.
 */
export function parseBlockedBy(body) {
  if (!body) return [];
  const re = /(?:blocked\s+by|depends\s+on):?\s+#(\d+)/gi;
  const ids = [...body.matchAll(re)].map((m) => Number.parseInt(m[1], 10));
  return [...new Set(ids)];
}

/**
 * Parse `blocks #NNN` references from text.
 *
 * @param {string} body - Issue body or freeform text.
 * @returns {number[]} Array of issue numbers this text declares as blocked.
 */
export function parseBlocks(body) {
  if (!body) return [];
  const re = /blocks\s+#(\d+)/gi;
  return [...body.matchAll(re)].map((m) => Number.parseInt(m[1], 10));
}

/**
 * Extract the parent Epic id from a ticket body. Matches `Epic: #NNN`
 * anchored to the start of a line (multiline + case-insensitive). The
 * anchored form prevents accidental matches inside prose ("...this Epic:
 * #...follow-on..."). Used during state-transition notification dispatch
 * and Story-level execution planning.
 *
 * @param {string|null|undefined} body
 * @returns {number|null}
 */
export function extractEpicIdFromBody(body) {
  if (!body) return null;
  const m = body.match(/^Epic:\s*#(\d+)/im);
  return m ? Number.parseInt(m[1], 10) : null;
}

/**
 * Validates that a string is safe to use as a git branch name component.
 * Rejects shell metacharacters, whitespace, and other dangerous patterns.
 *
 * @param {string} value - The value to validate.
 * @returns {boolean} True if safe for use in branch names.
 */
export function isSafeBranchComponent(value) {
  // Allow: alphanumeric, hyphens, underscores, dots, forward slashes
  // Reject: everything else (shell metacharacters, spaces, etc.)
  return /^[a-zA-Z0-9._\-/]+$/.test(value);
}

/**
 * Pre-compiled `**Key**: value` matchers for every metadata key we extract.
 * Construction cost is paid once at module load rather than per task.
 */
const METADATA_FIELD_KEYS = [
  'Persona',
  'Mode',
  'Skills',
  'Focus Areas',
  'Protocol Version',
];
const METADATA_FIELD_RES = new Map(
  METADATA_FIELD_KEYS.map((k) => [
    k,
    new RegExp(`\\*\\*${k}\\*\\*\\s*:?\\s*(.+)`, 'i'),
  ]),
);

/**
 * Parse task execution metadata from the `## Metadata` section of a ticket body.
 * Returns a plain object with `persona`, `mode`, `skills`, `focusAreas`,
 * and `protocolVersion`.
 *
 * @param {string} body - Issue body text.
 * @returns {{ persona: string, mode: string, skills: string[], focusAreas: string[], protocolVersion: string }}
 */
export function parseTaskMetadata(body) {
  const defaults = {
    persona: 'engineer',
    mode: 'fast',
    skills: [],
    focusAreas: [],
    protocolVersion: '',
  };

  if (!body) return defaults;

  const metaMatch = body.match(/##\s*Metadata\s*([\s\S]*?)(?=\n##|$)/i);
  if (!metaMatch) return defaults;

  const block = metaMatch[1];

  function extractField(key) {
    const re = METADATA_FIELD_RES.get(key);
    const m = re ? block.match(re) : null;
    return m ? m[1].trim() : null;
  }

  function extractList(key) {
    const raw = extractField(key);
    if (!raw) return [];
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  return {
    persona: extractField('Persona') || defaults.persona,
    mode: extractField('Mode') || defaults.mode,
    skills: extractList('Skills'),
    focusAreas: extractList('Focus Areas'),
    protocolVersion:
      extractField('Protocol Version') || defaults.protocolVersion,
  };
}

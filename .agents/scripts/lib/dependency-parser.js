/**
 * dependency-parser.js — dependency-edge and ticket-metadata parsing shared
 * by the ticketing provider and orchestration layer.
 */

import { parseFooterBlockedByIds } from './story-body/footer-block.js';

/**
 * Footer-scoped and strict: only a standalone `blocked by #N` line in the
 * `---` footer declares an edge. Prose mentions elsewhere never gate, so a
 * hand-written edge must live in the footer.
 *
 * @param {string} body - Issue body or freeform text.
 * @returns {number[]} Array of issue numbers this body declares as blockers.
 */
export function parseBlockedBy(body) {
  return parseFooterBlockedByIds(body);
}

/**
 * @param {string} body - Issue body or freeform text.
 * @returns {number[]} Array of issue numbers this text declares as blocked.
 */
export function parseBlocks(body) {
  if (!body) return [];
  const re = /blocks\s+#(\d+)/gi;
  return [...body.matchAll(re)].map((m) => Number.parseInt(m[1], 10));
}

/**
 * Line-anchored `Epic: #N`, so prose like "this Epic: #…" cannot match.
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
 * Allow-list: alphanumerics, `.`, `_`, `-`, `/`.
 *
 * @param {string} value - The value to validate.
 * @returns {boolean} True if safe for use in branch names.
 */
export function isSafeBranchComponent(value) {
  return /^[a-zA-Z0-9._\-/]+$/.test(value);
}

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
 * Parse the `## Metadata` section's `**Key**: value` fields.
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

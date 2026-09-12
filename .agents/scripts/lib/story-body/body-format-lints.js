/**
 * body-format-lints.js — SSOT for the deterministic body-format lints that can
 * REJECT an authored Story body at persist time, plus the mechanical auto-fix
 * inference a failing dry-run surfaces (Story #4684).
 *
 * The problem this closes: deterministic format rules (structured `## Changes`
 * bullet shape, non-empty sections) used to be discovered only as persist
 * dry-run failures — every miss cost a full re-author round-trip at
 * resident-context prices. This module is the single home for two remedies:
 *
 *   1. `BODY_FORMAT_LINTS` — the enumerated rejecting lints, each carrying a
 *      concrete good/bad example. `templates/decomposer-prompts.js` renders
 *      them into the story-author system prompt so the first draft is
 *      lint-clean by construction; a test enumerates the registry against the
 *      rendered prompt (Story #4684 AC-1).
 *   2. `suggestPathEntryFix` — the mechanical rewrite. `story-body.js`
 *      (`parsePathEntry`) and `task-body-validator.js`
 *      (`collectChangesErrors`) call it so a failing lint emits the corrected
 *      form ready to paste rather than a bare reject (AC-2), and the persist
 *      dry-run applies the same salvage for real (Story #5312,
 *      `plan-persist/changes-repair.js`).
 *
 * Story #5312 deleted the `verify-tier-suffix` / `verify-manual-reason` lints
 * with the tier suffix itself: a `verify[]` entry is any command, and the
 * `manual:<reason>` escape is gone with the rule it escaped.
 *
 * Import hygiene: this module imports only the cycle-free
 * `file-assumption-enum.js` leaf. It must NOT import `story-body.js` or
 * `task-body-validator.js` — both import this module, and either back-edge
 * would introduce a cycle (see the note in `file-assumption-enum.js`).
 */

import { FILE_ASSUMPTION_VALUES } from '../orchestration/file-assumption-enum.js';

/**
 * The default assumption a mechanical `## Changes` auto-fix proposes. Most
 * bare-path bullets an author drops are in-place edits, so `refactors-existing`
 * is the safe default — the fix-it text tells the author to switch it to
 * `creates` / `deletes` when the edit is net-new or a removal.
 */
const DEFAULT_SUGGESTED_ASSUMPTION = 'refactors-existing';

// A token that looks like a file path / glob / module id: it carries a `/` or a
// `.`-separated segment. Deliberately loose — the suggestion is best-effort, and
// a false positive only produces an unhelpful (still-valid) fix-it string.
const PATH_LIKE_RE = /[\w@*-]*[/.][\w@./*-]+/;

/**
 * Propose the canonical `{ path, assumption }` object form for a `## Changes` /
 * `## References` bullet an author wrote as a bare path string (or a humanized
 * bullet with a bad assumption). Returns `null` when no path-shaped token can
 * be salvaged.
 *
 * The returned string is inline-JSON that round-trips cleanly back through the
 * story-body parser, so it is paste-ready.
 *
 * @param {unknown} raw
 * @returns {string|null} e.g. `{"path":"src/app.js","assumption":"refactors-existing"}`.
 */
export function suggestPathEntryFix(raw) {
  if (typeof raw !== 'string') return null;
  // Strip a leading markdown bullet marker.
  let s = raw
    .trim()
    .replace(/^[-*]\s+/, '')
    .trim();
  // Take the segment before any humanized "— assumption" tail.
  s = s.split('—')[0].trim();
  // Peel surrounding backticks / quotes.
  s = s
    .replace(/^[`'"]+/, '')
    .replace(/[`'"]+$/, '')
    .trim();
  if (s === '' || !PATH_LIKE_RE.test(s)) return null;
  return JSON.stringify({ path: s, assumption: DEFAULT_SUGGESTED_ASSUMPTION });
}

/**
 * A single deterministic body-format lint the persist path enforces.
 *
 * @typedef {object} BodyFormatLint
 * @property {string}  id          Stable identifier (also the prompt anchor).
 * @property {string}  summary     One-line statement of the requirement.
 * @property {string}  badExample  A form the lint rejects.
 * @property {string}  goodExample The lint-clean form to author instead.
 * @property {boolean} autoFixable Whether a failing dry-run emits a fix-it.
 */

/**
 * The enumerated deterministic lints that can reject an authored Story body at
 * persist time. Each carries a concrete example so the story-author prompt can
 * state the requirement example-first (Story #4684 AC-1). The one `autoFixable`
 * lint is the mechanical rewrite the dry-run applies (Story #5312).
 *
 * @type {ReadonlyArray<BodyFormatLint>}
 */
export const BODY_FORMAT_LINTS = Object.freeze([
  {
    id: 'body-is-string',
    summary:
      'The Story `body` MUST be the serialized markdown string produced by `serialize()`, never a JSON object.',
    badExample: '"body": { "goal": "…" }',
    goodExample: '"body": "## Goal\\n…"',
    autoFixable: false,
  },
  {
    id: 'goal-non-empty',
    summary: 'The body MUST open with a non-empty `## Goal` sentence.',
    badExample: '## Goal\n\n## Spec',
    goodExample:
      '## Goal\nExchange short-lived JWTs so sessions survive a restart.',
    autoFixable: false,
  },
  {
    id: 'changes-path-entry-shape',
    summary:
      'Every `## Changes` / `## References` bullet MUST be a `{ path, assumption }` object (assumption ∈ ' +
      `${FILE_ASSUMPTION_VALUES.join(' | ')}); plain path strings are rejected.`,
    badExample: '- src/app.js',
    goodExample: '- {"path": "src/app.js", "assumption": "refactors-existing"}',
    autoFixable: true,
  },
  {
    id: 'changes-non-empty',
    summary: 'A Story MUST declare at least one `## Changes` bullet.',
    badExample: '## Changes\n\n## Acceptance',
    goodExample: '- {"path": "src/app.js", "assumption": "creates"}',
    autoFixable: false,
  },
  {
    id: 'verify-non-empty',
    summary: 'A Story MUST list at least one `verify[]` entry.',
    badExample: '"verify": []',
    goodExample: '"verify": ["npm run validate"]',
    autoFixable: false,
  },
  {
    id: 'acceptance-non-empty',
    summary:
      'A Story MUST list at least one observable `acceptance[]` criterion.',
    badExample: '"acceptance": []',
    goodExample: '"acceptance": ["`npm run build` exits 0"]',
    autoFixable: false,
  },
]);

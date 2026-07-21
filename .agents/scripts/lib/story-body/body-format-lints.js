/**
 * body-format-lints.js — SSOT for the deterministic body-format lints that can
 * REJECT an authored Story body at persist time, plus the mechanical auto-fix
 * inference a failing dry-run surfaces (Story #4684).
 *
 * The problem this closes: deterministic format rules (structured `## Changes`
 * bullet shape, verify-tier suffixes) used to be discovered only as persist
 * dry-run failures — every miss cost a full re-author round-trip at
 * resident-context prices. This module is the single home for two remedies:
 *
 *   1. `BODY_FORMAT_LINTS` — the enumerated rejecting lints, each carrying a
 *      concrete good/bad example. `templates/decomposer-prompts.js` renders
 *      them into the story-author system prompt so the first draft is
 *      lint-clean by construction; a test enumerates the registry against the
 *      rendered prompt (Story #4684 AC-1).
 *   2. `suggestPathEntryFix` / `suggestVerifyFix` — the mechanical rewrites.
 *      `story-body.js` (`parsePathEntry`) and `task-body-validator.js`
 *      (`collectChangesErrors` / `collectVerifyErrors`) call them so a failing
 *      lint emits the corrected form ready to paste rather than a bare reject
 *      (AC-2).
 *
 * Import hygiene: this module imports only the cycle-free
 * `file-assumption-enum.js` leaf. It must NOT import `story-body.js` or
 * `task-body-validator.js` — both import this module, and either back-edge
 * would introduce a cycle (see the note in `file-assumption-enum.js`).
 */

import { FILE_ASSUMPTION_VALUES } from '../orchestration/file-assumption-enum.js';

/**
 * Canonical testing-tier vocabulary an inferred verify suffix may name. Kept in
 * sync with `task-body-validator.js`'s `VERIFY_TIER_VALUES` by a test rather
 * than an import (importing that module here would create a cycle).
 *
 * @type {readonly ['unit','contract','e2e','validate']}
 */
const INFERABLE_VERIFY_TIERS = Object.freeze([
  'unit',
  'contract',
  'e2e',
  'validate',
]);

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
 * Infer the testing tier a bare `verify[]` command implies, when it is
 * unambiguous. Returns `null` when no confident inference is possible (the
 * author must then choose the tier themselves — the lint still fires, just
 * without a fix-it).
 *
 * @param {unknown} command
 * @returns {'unit'|'contract'|'e2e'|'validate'|null}
 */
function inferVerifyTier(command) {
  if (typeof command !== 'string') return null;
  const c = command.toLowerCase();
  if (/\bvalidate\b/.test(c)) return 'validate';
  if (/playwright|\.spec\.|\be2e\b/.test(c)) return 'e2e';
  if (/\.test\.|node --test|node:test|\bvitest\b|\bjest\b/.test(c)) {
    return 'unit';
  }
  if (/\bcontract\b/.test(c)) return 'contract';
  return null;
}

/**
 * Propose the corrected form of a `verify[]` entry that is missing its tier
 * suffix, when the tier is inferable from the command. Returns `null` when the
 * entry is a `manual:` escape, is empty, or the tier cannot be inferred.
 *
 * @param {unknown} entry
 * @returns {string|null} e.g. `"npm run validate (validate)"`.
 */
export function suggestVerifyFix(entry) {
  if (typeof entry !== 'string') return null;
  const trimmed = entry.trim();
  if (trimmed === '' || trimmed.startsWith('manual:')) return null;
  const tier = inferVerifyTier(trimmed);
  if (tier === null) return null;
  // Drop any trailing (…) — a wrong/partial tier suffix — before appending the
  // inferred one, so `npm test (smoke)` becomes `npm test (unit)` not a double.
  const base = trimmed.replace(/\s*\([^)]*\)\s*$/, '').trim();
  if (base === '') return null;
  return `${base} (${tier})`;
}

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
 * state the requirement example-first (Story #4684 AC-1). The two `autoFixable`
 * lints are the mechanical rewrites whose dry-run failure carries the corrected
 * form (AC-2).
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
    id: 'verify-tier-suffix',
    summary:
      'Every `verify[]` entry MUST end with a tier in parentheses — one of ' +
      `(${INFERABLE_VERIFY_TIERS.join(' | ')}) — or be a \`manual:<reason>\` escape.`,
    badExample: 'npm test -- src/app.test.js',
    goodExample: 'npm test -- src/app.test.js (unit)',
    autoFixable: true,
  },
  {
    id: 'verify-non-empty',
    summary:
      'A Story MUST list at least one `verify[]` entry (use `manual:<reason>` only when truly unverifiable in isolation).',
    badExample: '"verify": []',
    goodExample: '"verify": ["npm run validate (validate)"]',
    autoFixable: false,
  },
  {
    id: 'verify-manual-reason',
    summary:
      'A `manual:` verify entry MUST carry a reason after the colon; a bare `manual:` is rejected.',
    badExample: 'manual:',
    goodExample: 'manual: copy-only edit an auditor eyeballs',
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

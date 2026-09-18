/**
 * body-format-lints.js — SSOT for the deterministic lints that can reject an
 * authored Story body at persist time (rendered into the story-author prompt
 * so a first draft is lint-clean), plus the mechanical `## Changes` fix-it.
 *
 * Imports only the cycle-free `file-assumption-enum.js` leaf: story-body.js
 * and task-body-validator.js both import this module, so importing either
 * back would create a cycle.
 */

import { FILE_ASSUMPTION_VALUES } from '../orchestration/file-assumption-enum.js';

// Most bare-path bullets are in-place edits; the fix-it text tells the author
// to switch to creates/deletes when needed.
const DEFAULT_SUGGESTED_ASSUMPTION = 'refactors-existing';

/**
 * The one definition of a path bullet, shared by the story-body parser and
 * the persist repair pass (which cannot import each other). Any single
 * non-whitespace token, optionally backtick-wrapped — this admits route
 * segments (`app/[slug]/page.tsx`) and extensionless files (`Makefile`) while
 * whitespace still marks prose.
 */
const BARE_PATH_TOKEN_RE = /^(?:`([^\s`]+)`|([^\s`]+))$/;

/**
 * @param {unknown} raw
 * @returns {string|null} The path, with any wrapping backticks peeled.
 */
export function matchBarePathToken(raw) {
  if (typeof raw !== 'string') return null;
  const match = raw.trim().match(BARE_PATH_TOKEN_RE);
  return match ? (match[1] ?? match[2]) : null;
}

/**
 * Prose (carries whitespace) versus a single non-path token — distinct
 * failures with distinct fixes.
 *
 * @param {unknown} raw
 * @returns {boolean}
 */
export function isProseBullet(raw) {
  return typeof raw === 'string' && /\s/.test(raw.trim());
}

// Deliberately loose: a false positive only yields an unhelpful fix-it.
const PATH_LIKE_RE = /[\w@*-]*[/.][\w@./*-]+/;

/**
 * Paste-ready inline-JSON `{ path, assumption }` for a rejected bullet, or
 * `null` when no path-shaped token can be salvaged.
 *
 * @param {unknown} raw
 * @returns {string|null} e.g. `{"path":"src/app.js","assumption":"refactors-existing"}`.
 */
export function suggestPathEntryFix(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw
    .trim()
    .replace(/^[-*]\s+/, '')
    .trim();
  s = s.split('—')[0].trim();
  s = s
    .replace(/^[`'"]+/, '')
    .replace(/[`'"]+$/, '')
    .trim();
  if (s === '' || !PATH_LIKE_RE.test(s)) return null;
  return JSON.stringify({ path: s, assumption: DEFAULT_SUGGESTED_ASSUMPTION });
}

/**
 * @typedef {object} BodyFormatLint
 * @property {string}  id          Stable identifier (also the prompt anchor).
 * @property {string}  summary
 * @property {string}  badExample
 * @property {string}  goodExample
 * @property {boolean} autoFixable Whether a failing dry-run emits a fix-it.
 */

/**
 * Only rules that still refuse; warnings live elsewhere.
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
      'Every `## Changes` / `## References` bullet MUST name a path — a bare ' +
      'path string is the default form and persist derives its assumption by ' +
      'probing the base branch. Use the `{ path, assumption }` object ' +
      `(assumption ∈ ${FILE_ASSUMPTION_VALUES.join(' | ')}) only to pin one ` +
      'yourself; `deletes` always needs it. Prose bullets are rejected.',
    badExample: '- the routing module and its tests',
    goodExample: '- src/app.js',
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
    id: 'acceptance-non-empty',
    summary:
      'A Story MUST list at least one observable `acceptance[]` criterion.',
    badExample: '"acceptance": []',
    goodExample: '"acceptance": ["`npm run build` exits 0"]',
    autoFixable: false,
  },
]);

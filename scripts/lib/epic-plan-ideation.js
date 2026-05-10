/**
 * epic-plan-ideation.js — Phase 0c/0d helpers for /epic-plan
 *
 * Phase 0c: render an Epic body from a sharpened ideation one-pager
 * using the canonical template at `.agents/templates/epic-from-idea.md`.
 * Phase 0d: open the GitHub Issue via an injected provider with the
 * `type::epic` label only — no `state::draft` (the Epic carries only
 * `type::epic` until PRD authoring writes `agent::review-spec`).
 *
 * The template is parsed from a string the caller has already loaded
 * (typically via `fs.readFile`). The renderer is pure — no I/O — and
 * the opener takes a tiny `createIssue` port so the test suite can
 * mock the provider call without touching the GitHub HTTP client.
 */

import { TYPE_LABELS } from './label-constants.js';

const SECTION_RE = {
  problem: /^##\s+Problem\s+Statement\s*$/im,
  direction: /^##\s+Recommended\s+Direction\s*$/im,
  assumptions: /^##\s+Key\s+Assumptions(?:\s+to\s+Validate)?\s*$/im,
  mvpScope: /^##\s+MVP\s+Scope\s*$/im,
  notDoing: /^##\s+Not\s+Doing(?:\s+\(and\s+Why\))?\s*$/im,
};

const ORDER = ['problem', 'direction', 'assumptions', 'mvpScope', 'notDoing'];

/**
 * Extract the five canonical sections from an idea-refinement one-pager.
 *
 * @param {string} onePager - Markdown produced by Phase 3 of the
 *   `idea-refinement` skill.
 * @returns {{
 *   title: string,
 *   problem: string,
 *   direction: string,
 *   assumptions: string,
 *   mvpScope: string,
 *   notDoing: string,
 * }}
 */
export function parseOnePager(onePager) {
  if (!onePager || typeof onePager !== 'string') {
    throw new Error('parseOnePager: onePager must be a non-empty string');
  }

  const titleMatch = onePager.match(/^#\s+(.+?)\s*$/m);
  const title = titleMatch ? titleMatch[1].trim() : 'Untitled Epic';

  // Build a map of section name -> [headingMatch.index, headingLength].
  const positions = [];
  for (const key of ORDER) {
    const m = onePager.match(SECTION_RE[key]);
    if (m && typeof m.index === 'number') {
      positions.push({ key, start: m.index, headingLength: m[0].length });
    }
  }
  positions.sort((a, b) => a.start - b.start);

  const sections = {
    problem: '',
    direction: '',
    assumptions: '',
    mvpScope: '',
    notDoing: '',
  };

  for (let i = 0; i < positions.length; i += 1) {
    const cur = positions[i];
    const next = positions[i + 1];
    const sliceStart = cur.start + cur.headingLength;
    const sliceEnd = next ? next.start : onePager.length;
    sections[cur.key] = onePager.slice(sliceStart, sliceEnd).trim();
  }

  return { title, ...sections };
}

/**
 * Render the Epic body from a parsed one-pager and a template string.
 * Substitutes `{{key}}` tokens for the matching section. Missing
 * sections are rendered as `_(not specified)_` so the operator can spot
 * gaps during the HITL review (Phase 0c).
 *
 * @param {{
 *   onePager: string,
 *   template: string,
 * }} args
 * @returns {{ title: string, body: string }}
 */
export function renderEpicBody({ onePager, template }) {
  if (!template || typeof template !== 'string') {
    throw new Error('renderEpicBody: template must be a non-empty string');
  }
  const parsed = parseOnePager(onePager);

  const body = template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (key === 'title') return parsed.title;
    const value = parsed[key];
    return value && value.length > 0 ? value : '_(not specified)_';
  });

  return { title: parsed.title, body };
}

/**
 * Open a new GitHub Issue for the Epic. The label set is exactly
 * `[type::epic]` — no `state::*` label is added at creation time.
 *
 * The `createIssue` port matches the shape
 * `({ title, body, labels }) => Promise<{ id, url }>` so the unit
 * test can pass an in-memory mock and assert on the captured payload.
 *
 * @param {{
 *   onePager: string,
 *   template: string,
 *   createIssue: (payload: { title: string, body: string, labels: string[] }) => Promise<{ id: number, url?: string }>,
 * }} args
 * @returns {Promise<{ id: number, title: string, body: string, labels: string[], url?: string, payload: { title: string, body: string, labels: string[] } }>}
 */
export async function openEpicFromOnePager({
  onePager,
  template,
  createIssue,
}) {
  if (typeof createIssue !== 'function') {
    throw new Error('openEpicFromOnePager: createIssue must be a function');
  }
  const { title, body } = renderEpicBody({ onePager, template });
  const labels = [TYPE_LABELS.EPIC];
  const payload = { title, body, labels };
  const created = await createIssue(payload);
  if (!created || typeof created.id !== 'number') {
    throw new Error(
      'openEpicFromOnePager: createIssue must return { id: number, url? }',
    );
  }
  return { id: created.id, title, body, labels, url: created.url, payload };
}

export const __test = { ORDER, SECTION_RE };

/**
 * epic-plan-ideation.js — Phase 3/4 helpers for /plan
 *
 * Phase 3: render an Epic body from a sharpened ideation one-pager
 * using the canonical template at `.agents/templates/epic-from-idea.md`.
 * Phase 4: open the GitHub Issue via an injected provider with the
 * `type::epic` label only — no `state::draft` (the Epic carries only
 * `type::epic` until PRD authoring writes `agent::review-spec`).
 *
 * The template is parsed from a string the caller has already loaded
 * (typically via `fs.readFile`). The renderer is pure — no I/O — and
 * the opener takes a tiny `createIssue` port so the test suite can
 * mock the provider call without touching the GitHub HTTP client.
 */

import { TYPE_LABELS } from './label-constants.js';

// Canonical section keys match the rendered template at
// `.agents/templates/epic-from-idea.md`. The regex accepts both the
// new canonical headings and the pre-canonical-headings ideation shape
// so an in-flight one-pager parses cleanly during the transition. The
// older `assumptions` key is accepted as input but is no longer a
// canonical rendered section — it lands implicitly in `context` if the
// one-pager carries one.
const SECTION_RE = {
  context:
    /^##\s+(?:Context(?:\s+&\s+Problem)?|Background|Problem(?:\s+Statement)?)\s*$/im,
  goal: /^##\s+(?:Goals?|Objectives?|(?:Recommended\s+)?Direction)\s*$/im,
  nonGoals:
    /^##\s+(?:Non[\s-]?Goals|Out\s+of\s+Scope|Not\s+Doing(?:\s+\(and\s+Why\))?)\s*$/im,
  scope:
    /^##\s+(?:MVP\s+|Proposed\s+)?Scope(?:\s+\([^)]+\))?\s*$|^##\s+Work\s+Breakdown\s*$/im,
  acceptanceCriteria: /^##\s+(?:Acceptance(?:\s+Criteria)?|AC)\s*$/im,
};

const ORDER = ['context', 'goal', 'nonGoals', 'scope', 'acceptanceCriteria'];

/**
 * Extract the five canonical sections from an idea-refinement one-pager.
 *
 * @param {string} onePager - Markdown produced by Phase 3 of the
 *   `idea-refinement` skill.
 * @returns {{
 *   title: string,
 *   context: string,
 *   goal: string,
 *   nonGoals: string,
 *   scope: string,
 *   acceptanceCriteria: string,
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
    context: '',
    goal: '',
    nonGoals: '',
    scope: '',
    acceptanceCriteria: '',
  };

  // Generic next-heading regex — slice up to the next `## ` heading,
  // not just the next canonical one, so non-canonical sections the
  // author included (e.g. "Open Questions") don't get folded into the
  // preceding canonical section.
  const NEXT_HEADING_RE = /^##\s+/m;
  for (let i = 0; i < positions.length; i += 1) {
    const cur = positions[i];
    const sliceStart = cur.start + cur.headingLength;
    const rest = onePager.slice(sliceStart);
    const nextMatch = rest.match(NEXT_HEADING_RE);
    const sliceEnd =
      nextMatch && typeof nextMatch.index === 'number'
        ? sliceStart + nextMatch.index
        : onePager.length;
    sections[cur.key] = onePager.slice(sliceStart, sliceEnd).trim();
  }

  return { title, ...sections };
}

/**
 * Render the Epic body from a parsed one-pager and a template string.
 * Substitutes `{{key}}` tokens for the matching section. Missing
 * sections are rendered as `_(not specified)_` so the operator can spot
 * gaps during the HITL review (Phase 3).
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
 * `({ title, body, labels }) => Promise<{ id, nodeId?, url? }>` so the
 * unit test can pass an in-memory mock and assert on the captured
 * payload. In production the port delegates to the ticketing provider's
 * `createIssue` (GitHub: `TicketGateway.createIssue`), which adds the
 * new issue to the configured Projects V2 board via the shared
 * `addIssueToBoard` helper — idempotent, non-fatal, and a no-op when no
 * project number is configured (Story #3822) — so the Epic lands on the
 * board without relying on GitHub's "Auto-add to project" workflow. The
 * created issue's GraphQL `node_id` is surfaced as `nodeId` on the
 * returned envelope for observability and follow-up board operations.
 *
 * @param {{
 *   onePager: string,
 *   template: string,
 *   createIssue: (payload: { title: string, body: string, labels: string[] }) => Promise<{ id: number, nodeId?: string, url?: string }>,
 * }} args
 * @returns {Promise<{ id: number, nodeId: string|null, title: string, body: string, labels: string[], url?: string, payload: { title: string, body: string, labels: string[] } }>}
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
      'openEpicFromOnePager: createIssue must return { id: number, nodeId?, url? }',
    );
  }
  return {
    id: created.id,
    nodeId: created.nodeId ?? null,
    title,
    body,
    labels,
    url: created.url,
    payload,
  };
}

/**
 * Update an existing Epic Issue's body from a sharpened one-pager. The
 * single persistence path used by the Phase 6 Epic Clarity Gate.
 *
 * The `editIssue` port matches the shape
 * `({ epicId, body }) => Promise<void|object>` so unit tests can pass an
 * in-memory mock. Idempotent: when `currentBody` exactly matches the
 * freshly rendered body, the port is **not** called and the function
 * returns `{ changed: false }`.
 *
 * @param {{
 *   epicId: number,
 *   onePager: string,
 *   template: string,
 *   editIssue: (payload: { epicId: number, body: string }) => Promise<unknown>,
 *   currentBody?: string|null,
 * }} args
 * @returns {Promise<{
 *   epicId: number,
 *   title: string,
 *   body: string,
 *   changed: boolean,
 *   payload?: { epicId: number, body: string },
 * }>}
 */
export async function updateEpicFromOnePager({
  epicId,
  onePager,
  template,
  editIssue,
  currentBody = null,
}) {
  if (typeof editIssue !== 'function') {
    throw new Error('updateEpicFromOnePager: editIssue must be a function');
  }
  if (!Number.isInteger(epicId) || epicId <= 0) {
    throw new Error(
      'updateEpicFromOnePager: epicId must be a positive integer',
    );
  }

  const { title, body } = renderEpicBody({ onePager, template });

  if (typeof currentBody === 'string' && currentBody === body) {
    return { epicId, title, body, changed: false };
  }

  const payload = { epicId, body };
  await editIssue(payload);
  return { epicId, title, body, changed: true, payload };
}

export const __test = { ORDER, SECTION_RE };

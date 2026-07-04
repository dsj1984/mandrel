/**
 * epic-body-sections.js — marker-delimited managed sections of the Epic body.
 *
 * Story #4324 retired the `context::tech-spec` / `context::acceptance-spec`
 * ticket classes: the Epic body is now the single planning document. The
 * Tech Spec (opening with `## Delivery Slicing`, per #4316) and the
 * Acceptance Spec's AC-ID table (`## Acceptance Table`, Outcomes keyed to
 * Epic AC bullets per #4315) land as **managed sections** of the Epic body,
 * delimited by invisible HTML comment markers so each writer can update
 * *only its own region* without rewriting the rest of the body.
 *
 * Section-scoped writes are the load-bearing contract (extending the
 * single-writer discipline #4303 established for the body trailer):
 *
 *   - The Phase 7 spec persist path (`epic-plan-spec/phases/plan-epic.js`)
 *     upserts the `techSpec` and `acceptanceTable` regions.
 *   - The close-time acceptance reconciler
 *     (`acceptance-spec-reconciler.js`) reads and rewrites the
 *     `acceptanceTable` region only (verification dispositions).
 *
 * Everything outside a managed region is byte-preserved by every helper in
 * this module. Markers are chosen so GitHub renders nothing for them; the
 * human-visible headings (`## Delivery Slicing`, `## Acceptance Table`)
 * live INSIDE the regions as ordinary content.
 *
 * Pure ESM, no I/O.
 */

/**
 * Managed-region descriptors. `start`/`end` are the literal marker lines;
 * `label` is the human name used in log lines and error messages.
 *
 * @type {Readonly<Record<'techSpec'|'acceptanceTable', { start: string, end: string, label: string }>>}
 */
export const EPIC_BODY_SECTIONS = Object.freeze({
  techSpec: Object.freeze({
    start: '<!-- mandrel:tech-spec:start -->',
    end: '<!-- mandrel:tech-spec:end -->',
    label: 'Tech Spec',
  }),
  acceptanceTable: Object.freeze({
    start: '<!-- mandrel:acceptance-table:start -->',
    end: '<!-- mandrel:acceptance-table:end -->',
    label: 'Acceptance Table',
  }),
});

/**
 * Canonical heading the acceptance-table region opens with. Distinct from
 * the Epic's ideation `## Acceptance Criteria` bullets (which remain the
 * SSOT for *what* the table verifies — the table anchors to those bullets).
 */
export const ACCEPTANCE_TABLE_HEADING = '## Acceptance Table';

/**
 * Regex matching the Tech Spec's required opening heading (same variants
 * `spec-section-validator.js` accepts).
 */
const DELIVERY_SLICING_RE = /^##\s+(?:Delivery\s+)?Slicing\s*$/im;

/**
 * @param {'techSpec'|'acceptanceTable'} kind
 * @returns {{ start: string, end: string, label: string }}
 */
function descriptor(kind) {
  const d = EPIC_BODY_SECTIONS[kind];
  if (!d) {
    throw new TypeError(
      `epic-body-sections: unknown section kind "${kind}" (expected ${Object.keys(EPIC_BODY_SECTIONS).join(' | ')})`,
    );
  }
  return d;
}

/**
 * Locate a managed region. Returns `null` when either marker is absent or
 * the end marker precedes the start marker (malformed body — treated as
 * absent so a writer re-appends a well-formed region rather than
 * corrupting the body further).
 *
 * @param {string} body
 * @param {'techSpec'|'acceptanceTable'} kind
 * @returns {{ startIdx: number, contentStart: number, contentEnd: number, endIdx: number }|null}
 */
function locate(body, kind) {
  const { start, end } = descriptor(kind);
  if (typeof body !== 'string' || body.length === 0) return null;
  const startIdx = body.indexOf(start);
  if (startIdx === -1) return null;
  const contentStart = startIdx + start.length;
  const endIdx = body.indexOf(end, contentStart);
  if (endIdx === -1) return null;
  return { startIdx, contentStart, contentEnd: endIdx, endIdx };
}

/**
 * True when the body carries a well-formed managed region of `kind`.
 *
 * @param {string} body
 * @param {'techSpec'|'acceptanceTable'} kind
 * @returns {boolean}
 */
export function hasEpicSection(body, kind) {
  return locate(body, kind) !== null;
}

/**
 * Extract a managed region's content (between the markers, trimmed).
 * Returns `null` when the region is absent.
 *
 * @param {string} body
 * @param {'techSpec'|'acceptanceTable'} kind
 * @returns {string|null}
 */
export function extractEpicSection(body, kind) {
  const loc = locate(body, kind);
  if (!loc) return null;
  return body.slice(loc.contentStart, loc.contentEnd).trim();
}

/**
 * Insert or replace a managed region, preserving every byte outside it.
 *
 * When the region exists, only the content between the markers is
 * replaced. When absent, the region is appended at the end of the body
 * (trailing whitespace normalised to a single blank-line separator). The
 * `techSpec` region is appended before an existing `acceptanceTable`
 * region so the rendered document keeps its canonical order
 * (ideation sections → Tech Spec → Acceptance Table).
 *
 * @param {string} body
 * @param {'techSpec'|'acceptanceTable'} kind
 * @param {string} content Section content (headings included).
 * @returns {string}
 */
export function upsertEpicSection(body, kind, content) {
  const { start, end } = descriptor(kind);
  const safeBody = typeof body === 'string' ? body : '';
  const trimmedContent = typeof content === 'string' ? content.trim() : '';
  const region = `${start}\n\n${trimmedContent}\n\n${end}`;

  const loc = locate(safeBody, kind);
  if (loc) {
    return (
      safeBody.slice(0, loc.startIdx) +
      region +
      safeBody.slice(loc.endIdx + end.length)
    );
  }

  // Keep canonical order when appending: the Tech Spec region goes before
  // an already-present acceptance-table region.
  if (kind === 'techSpec') {
    const acceptanceLoc = locate(safeBody, 'acceptanceTable');
    if (acceptanceLoc) {
      const head = safeBody
        .slice(0, acceptanceLoc.startIdx)
        .replace(/\s+$/, '');
      const tail = safeBody.slice(acceptanceLoc.startIdx);
      return `${head}\n\n${region}\n\n${tail}`;
    }
  }

  const trimmedBody = safeBody.replace(/\s+$/, '');
  return trimmedBody.length > 0
    ? `${trimmedBody}\n\n${region}\n`
    : `${region}\n`;
}

/**
 * Remove a managed region (markers and content). Byte-preserving outside
 * the region; collapses the surrounding blank lines the writer added.
 * No-op when the region is absent.
 *
 * @param {string} body
 * @param {'techSpec'|'acceptanceTable'} kind
 * @returns {string}
 */
export function stripEpicSection(body, kind) {
  const { end } = descriptor(kind);
  const loc = locate(body, kind);
  if (!loc) return typeof body === 'string' ? body : '';
  const before = body.slice(0, loc.startIdx).replace(/\n+$/, '\n');
  const after = body.slice(loc.endIdx + end.length).replace(/^\n+/, '\n');
  return (before + after).replace(/\n{3,}/g, '\n\n');
}

/**
 * Re-plan / decompose detection: true when the Epic body carries folded
 * Tech Spec content — the managed region, or (defence in depth for a
 * hand-authored body) a bare `## Delivery Slicing` heading.
 *
 * @param {string} body
 * @returns {boolean}
 */
export function hasTechSpecContent(body) {
  if (hasEpicSection(body, 'techSpec')) return true;
  return typeof body === 'string' && DELIVERY_SLICING_RE.test(body);
}

/**
 * `##` headings dropped from the delivery-hydrated Epic body. These are
 * ideation / authoring / close-machinery sections a story agent never acts
 * on: keeping them out of the per-Story prompt trims token cost without
 * losing any binding context (the Story carries its own inline
 * acceptance[] / verify[]).
 *
 * @type {ReadonlySet<string>}
 */
const DELIVERY_DROP_HEADINGS = new Set([
  'context',
  'scope',
  'acceptance criteria',
]);

/**
 * Slice an Epic body down to the sections a delivery story agent acts on.
 *
 * KEEP: the Epic title / preamble before the first `##`, `## Goal`,
 * `## Non-Goals`, `## User Stories`, the `techSpec` managed region, and —
 * fail-open — any unknown / operator-authored `##` section not in the drop
 * list. DROP: `## Context`, `## Scope`, `## Acceptance Criteria`, and the
 * `acceptanceTable` managed region.
 *
 * The `techSpec` region is located by its markers (not by heading
 * boundaries) so its inner `## Delivery Slicing` heading is preserved
 * verbatim and never mistaken for a plain droppable section. Plain `##`
 * sections outside the managed regions are sliced by heading boundaries.
 *
 * Fail-open is load-bearing: any heading not explicitly in the drop set is
 * kept, so operator-authored content is never silently lost.
 *
 * @param {string} body
 * @returns {string}
 */
export function sliceEpicBodyForDelivery(body) {
  if (typeof body !== 'string' || body.length === 0) return '';

  // 1. Drop the acceptance-table managed region outright (authoring/close
  //    machinery, never delivery context).
  let working = stripEpicSection(body, 'acceptanceTable');

  // 2. Protect the techSpec managed region from heading-boundary slicing by
  //    lifting it out behind an opaque placeholder, then restoring it after
  //    the plain-section pass. Its inner `## Delivery Slicing` heading must
  //    survive verbatim.
  const techLoc = locate(working, 'techSpec');
  let techRegion = null;
  const PLACEHOLDER = ' MANDREL_TECH_SPEC_PLACEHOLDER ';
  if (techLoc) {
    const { end } = descriptor('techSpec');
    techRegion = working.slice(techLoc.startIdx, techLoc.endIdx + end.length);
    working =
      working.slice(0, techLoc.startIdx) +
      PLACEHOLDER +
      working.slice(techLoc.endIdx + end.length);
  }

  // 3. Slice plain `##` sections by heading boundaries, dropping only the
  //    known ideation/authoring headings. The preamble before the first
  //    `##` (Epic title / lede) is always kept.
  const kept = [];
  let dropping = false;
  for (const line of working.split('\n')) {
    const headingMatch = line.match(/^##\s+(.*?)\s*$/);
    if (headingMatch) {
      dropping = DELIVERY_DROP_HEADINGS.has(
        headingMatch[1].trim().toLowerCase(),
      );
      if (dropping) continue;
    }
    if (dropping) continue;
    kept.push(line);
  }
  working = kept.join('\n');

  // 4. Restore the techSpec region in place.
  if (techRegion !== null) {
    working = working.replace(PLACEHOLDER, () => techRegion);
  }

  // 5. Normalise the blank-line runs left by the drops.
  return working
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .trimEnd();
}

/**
 * Strip the retired machine-managed `## Planning Artifacts` checklist from
 * an Epic body (the section that linked the now-retired context tickets).
 * The slice ends at the next `## ` heading, a managed-region marker, or
 * EOF. Historical bodies without the section pass through untouched.
 *
 * @param {string} body
 * @returns {string}
 */
export function stripPlanningArtifactsSection(body) {
  if (typeof body !== 'string' || body.length === 0) return '';
  const headingMatch = body.match(/^##\s+Planning Artifacts[^\n]*$/m);
  if (!headingMatch || typeof headingMatch.index !== 'number') return body;
  const start = headingMatch.index;
  const afterHeading = start + headingMatch[0].length;
  const rest = body.slice(afterHeading);
  const boundary = rest.search(/^(?:##\s|<!-- mandrel:)/m);
  const end = boundary === -1 ? body.length : afterHeading + boundary;
  const before = body.slice(0, start).replace(/\n+$/, '\n');
  const after = body.slice(end);
  return (before + after).replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
}

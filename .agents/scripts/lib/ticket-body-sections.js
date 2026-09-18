/**
 * Marker-delimited managed sections of a planning ticket body. Each writer
 * updates only its own region (persist: `techSpec` + `acceptanceTable`; the
 * close reconciler: `acceptanceTable` only); every byte outside a region is
 * preserved. Markers render as nothing on GitHub; visible headings live
 * inside the regions. Pure, no I/O.
 */

/**
 * @type {Readonly<Record<'techSpec'|'acceptanceTable', { start: string, end: string, label: string }>>}
 */
export const TICKET_BODY_SECTIONS = Object.freeze({
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

/** Distinct from `## Acceptance Criteria`, which stays the SSOT it anchors to. */
export const ACCEPTANCE_TABLE_HEADING = '## Acceptance Table';

/** SSOT for the `## (Delivery) Slicing` heading, case-insensitive. */
export const DELIVERY_SLICING_RE = /^##\s+(?:Delivery\s+)?Slicing\s*$/im;

/**
 * @param {'techSpec'|'acceptanceTable'} kind
 * @returns {{ start: string, end: string, label: string }}
 */
function descriptor(kind) {
  const d = TICKET_BODY_SECTIONS[kind];
  if (!d) {
    throw new TypeError(
      `ticket-body-sections: unknown section kind "${kind}" (expected ${Object.keys(TICKET_BODY_SECTIONS).join(' | ')})`,
    );
  }
  return d;
}

/**
 * `null` when a marker is missing or out of order: treated as absent so a
 * writer re-appends a well-formed region instead of corrupting further.
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
 * @param {string} body
 * @param {'techSpec'|'acceptanceTable'} kind
 * @returns {boolean}
 */
export function hasTicketSection(body, kind) {
  return locate(body, kind) !== null;
}

/**
 * Insert or replace a managed region. An absent region is appended, except
 * `techSpec`, which goes before an existing `acceptanceTable` to keep order.
 *
 * @param {string} body
 * @param {'techSpec'|'acceptanceTable'} kind
 * @param {string} content Section content (headings included).
 * @returns {string}
 */
export function upsertTicketSection(body, kind, content) {
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
 * Remove a region and the blank lines the writer added around it.
 *
 * @param {string} body
 * @param {'techSpec'|'acceptanceTable'} kind
 * @returns {string}
 */
export function stripTicketSection(body, kind) {
  const { end } = descriptor(kind);
  const loc = locate(body, kind);
  if (!loc) return typeof body === 'string' ? body : '';
  const before = body.slice(0, loc.startIdx).replace(/\n+$/, '\n');
  const after = body.slice(loc.endIdx + end.length).replace(/^\n+/, '\n');
  return (before + after).replace(/\n{3,}/g, '\n\n');
}

/**
 * Folded Tech Spec present: the region, or a hand-authored slicing heading.
 *
 * @param {string} body
 * @returns {boolean}
 */
export function hasTechSpecContent(body) {
  if (hasTicketSection(body, 'techSpec')) return true;
  return typeof body === 'string' && DELIVERY_SLICING_RE.test(body);
}

/**
 * Ideation sections a delivering agent never acts on.
 *
 * @type {ReadonlySet<string>}
 */
const DELIVERY_DROP_HEADINGS = new Set([
  'context',
  'scope',
  'acceptance criteria',
]);

/**
 * Slice a planning body to what a delivering agent acts on: drops the
 * `acceptanceTable` region and the {@link DELIVERY_DROP_HEADINGS} sections.
 * Fail-open — any other heading is kept so operator content is never lost.
 *
 * @param {string} body
 * @returns {string}
 */
export function sliceTicketBodyForDelivery(body) {
  if (typeof body !== 'string' || body.length === 0) return '';

  let working = stripTicketSection(body, 'acceptanceTable');

  // Lift the techSpec region out behind a placeholder so heading slicing
  // cannot touch its inner `##` headings.
  const techLoc = locate(working, 'techSpec');
  let techRegion = null;
  const PLACEHOLDER = '\u0000MANDREL_TECH_SPEC_PLACEHOLDER\u0000';
  if (techLoc) {
    const { end } = descriptor('techSpec');
    techRegion = working.slice(techLoc.startIdx, techLoc.endIdx + end.length);
    working =
      working.slice(0, techLoc.startIdx) +
      PLACEHOLDER +
      working.slice(techLoc.endIdx + end.length);
  }

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

  if (techRegion !== null) {
    working = working.replace(PLACEHOLDER, () => techRegion);
  }

  return working
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .trimEnd();
}

/**
 * Strip a `## Planning Artifacts` section, up to the next `## `, managed
 * marker, or EOF.
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

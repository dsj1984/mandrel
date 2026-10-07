/**
 * The one normalized record shape every adapter emits, and the extraction of
 * the three facts a justification can carry: the reason text, the tickets it
 * cites, and an expiry date.
 *
 * @module lib/audit-exceptions/record
 */

/** `#123`, `owner/repo#123`, or a GitHub issue / pull URL. */
const TICKET_RE =
  /(?:https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+))|(?:(?<![\w/&])([\w.-]+\/[\w.-]+)?#(\d+)\b)/g;

/**
 * A ref only counts as what an exception waits on when a tracking word leads
 * into it (`TODO(#12)`, "until #12", "tracked in #12", "remove once #12").
 * Citing the Story that introduced an exception is provenance, not a
 * dependency — a closed one must not make the exception read as orphaned.
 */
const TRACKING_LEAD_RE =
  /\b(?:todo|fixme|hack|until|track(?:ed|ing)?|blocked|pending|remove|drop|revisit|follow[- ]?up|workaround|waiting|depends|upstream)\b[^.;\n#]{0,25}$/i;

const EXPIRY_RE =
  /\b(?:expires?|expiry|review[- ]by|until|revisit(?:\s+by)?)\s*[:=]?\s*(\d{4}-\d{2}-\d{2})\b/i;

/**
 * @param {string|null|undefined} text
 * @returns {string[]} unique tracking refs, `#N` for this repo, `owner/repo#N` otherwise.
 */
export function ticketRefsIn(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const refs = new Set();
  for (const m of text.matchAll(TICKET_RE)) {
    if (!TRACKING_LEAD_RE.test(text.slice(Math.max(0, m.index - 60), m.index)))
      continue;
    const repo = m[1] ?? m[3] ?? '';
    const num = m[2] ?? m[4];
    refs.add(`${repo}#${num}`);
  }
  return [...refs];
}

/**
 * @param {string|null|undefined} text
 * @returns {string|null} ISO date
 */
export function expiryIn(text) {
  if (typeof text !== 'string') return null;
  return EXPIRY_RE.exec(text)?.[1] ?? null;
}

/**
 * Normalize a justification fragment: trim punctuation-only or empty text to
 * `null`, so "no reason given" has exactly one representation.
 *
 * @param {unknown} text
 * @returns {string|null}
 */
function cleanJustification(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text
    .replace(/\s+/g, ' ')
    .replace(/^[\s:—–-]+|[\s*/>-]+$/g, '')
    .trim();
  return /[A-Za-z0-9]/.test(trimmed) ? trimmed : null;
}

/**
 * @param {object} fields
 * @param {string} fields.adapter
 * @param {string} fields.category
 * @param {string} fields.surface
 * @param {string} fields.file
 * @param {number} fields.line
 * @param {string} fields.target - what the exception exempts (rule, package, glob, …).
 * @param {string} [fields.rule] - cluster key within the adapter.
 * @param {string|null} [fields.justification]
 * @param {{ verdict: string, basis: string }|null} [fields.probe] - mechanical probe outcome.
 * @param {string|null} [fields.permanentHint]
 * @returns {object}
 */
export function makeRecord(fields) {
  const justification = cleanJustification(fields.justification);
  return {
    id: `${fields.adapter}:${fields.file}:${fields.line}:${fields.target}`,
    adapter: fields.adapter,
    category: fields.category,
    surface: fields.surface,
    file: fields.file,
    line: fields.line,
    target: fields.target,
    rule: fields.rule ?? fields.target,
    justification,
    ticketRefs: ticketRefsIn(justification),
    expires: expiryIn(justification),
    addedAt: null,
    introduced: false,
    verdict: 'live',
    verdictBasis: 'none',
    permanentHint: fields.permanentHint ?? fields.probe?.permanentHint ?? null,
    probe: fields.probe ?? null,
  };
}

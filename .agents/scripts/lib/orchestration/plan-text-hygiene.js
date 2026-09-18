/**
 * plan-text-hygiene.js — advisory draft-Story lints for the persist dry-run:
 * `open-question` over body prose (a non-interactive sub-agent can never
 * answer "TBD" or "confirm with the operator") and `pinned-identifier` over
 * `acceptance[]`. Findings are warnings only; an unparseable body is skipped,
 * since structural rejection belongs to the persist validators. Pure, no I/O.
 *
 * @module lib/orchestration/plan-text-hygiene
 */

import { parse } from '../story-body/story-body.js';
import { findPinnedIdentifiers } from './pinned-identifier-lint.js';

const EVIDENCE_MAX_CHARS = 160;

const OPEN_QUESTION_MARKERS = [
  /\bflag if\b/i,
  /\bTBD\b/,
  /\bconfirm with the operator\b/i,
];

/**
 * @typedef {Object} TextHygieneFinding
 * @property {'open-question'|'pinned-identifier'} kind
 * @property {string} slug - The draft Story's slug ('' when absent).
 * @property {string} evidence - Excerpt of the offending text.
 * @property {string} message - Human-readable, re-author-actionable text.
 */

/**
 * Private-use stand-in for an inline code span: inert to the heuristic but
 * keeps the sentence split where the span sat.
 */
const CODE_SLOT = '\uE000';

/**
 * Remove code so shell snippets or patterns never trip a prose heuristic.
 *
 * @param {string} text
 * @returns {string}
 */
function stripCodeSpans(text) {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, CODE_SLOT);
}

/**
 * Newlines are boundaries too: one unit per bullet.
 *
 * @param {string} text
 * @returns {string[]}
 */
function splitSentences(text) {
  return stripCodeSpans(text)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((unit) => unit.replaceAll(CODE_SLOT, ' ').trim())
    .filter((unit) => unit.length > 0);
}

/**
 * @param {string} text
 * @returns {string}
 */
function excerpt(text) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > EVIDENCE_MAX_CHARS
    ? `${flat.slice(0, EVIDENCE_MAX_CHARS - 1)}…`
    : flat;
}

/**
 * @param {string} prose - Raw Goal/Spec prose.
 * @param {string} slug
 * @returns {TextHygieneFinding[]}
 */
function findOpenQuestions(prose, slug) {
  const findings = [];
  for (const sentence of splitSentences(prose)) {
    const marked =
      OPEN_QUESTION_MARKERS.some((m) => m.test(sentence)) ||
      sentence.endsWith('?');
    if (!marked) continue;
    findings.push({
      kind: 'open-question',
      slug,
      evidence: excerpt(sentence),
      message:
        'Body text carries an operator-directed open question; the Story ' +
        'is executed by a non-interactive sub-agent that cannot answer it. ' +
        'Record the decision, or restate the unknown as a declarative Key ' +
        'Assumption.',
    });
  }
  return findings;
}

/**
 * @param {{ draftStories?: Array<object>|null }} args - The draft
 *   `stories.json` array; null/absent yields no findings.
 * @returns {{ findings: TextHygieneFinding[] }}
 */
export function evaluateTextHygiene({ draftStories = null } = {}) {
  const stories = Array.isArray(draftStories) ? draftStories : [];
  const findings = [];
  for (const story of stories) {
    const slug = typeof story?.slug === 'string' ? story.slug : '';
    let body;
    try {
      body = parse(story?.body).body;
    } catch {
      continue;
    }
    const goal = typeof body.goal === 'string' ? body.goal : '';
    const spec = typeof body.spec === 'string' ? body.spec : '';
    findings.push(
      ...findOpenQuestions([goal, spec].join('\n'), slug),
      ...findPinnedIdentifiers(story, body, slug, excerpt),
    );
  }
  return { findings };
}

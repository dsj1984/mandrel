/**
 * plan-text-hygiene.js — the `open-question` lint over draft Story bodies
 * (Story #4599; narrowed to one lint by Story #5312).
 *
 * A Story is executed by a non-interactive sub-agent, so an operator-directed
 * open question persisted into its body ("Flag if…", "TBD", "confirm with the
 * operator", a trailing `?`) can never be answered where it is read. This
 * module makes that class checkable at the one point a re-author loop exists —
 * the persist dry-run, which lists every match as a **warning** and proceeds.
 *
 * Story #5312 deleted the sibling `dangling-citation` and `slicing-mass`
 * lints with the critic gate that surfaced them: both scored prose shape the
 * authoring model already judges, and neither ever changed a persisted body.
 *
 * Advisory by contract: findings are deterministic text for the dry-run's
 * warning list. They never gate persist and spawn nothing.
 *
 * Pure, synchronous, no I/O. Operates on the draft `stories.json` array,
 * reusing `parse()` from `lib/story-body/story-body.js` for section access.
 * An unparseable draft body is skipped, not failed — hygiene is advisory
 * and the persist validators own structural rejection.
 *
 * @module lib/orchestration/plan-text-hygiene
 */

import { parse } from '../story-body/story-body.js';

/** Truncation length for the `evidence` excerpt on each finding. */
const EVIDENCE_MAX_CHARS = 160;

/**
 * Operator-directed open-question phrasings. Each match is an instruction
 * or question aimed at a human, which a non-interactive delivery sub-agent
 * can never answer.
 */
const OPEN_QUESTION_MARKERS = [
  /\bflag if\b/i,
  /\bTBD\b/,
  /\bconfirm with the operator\b/i,
];

/**
 * @typedef {Object} TextHygieneFinding
 * @property {'open-question'} kind
 * @property {string} slug - The draft Story's slug ('' when absent).
 * @property {string} evidence - Excerpt of the offending text.
 * @property {string} message - Human-readable, re-author-actionable text.
 */

/**
 * Private-use sentinel standing in for one extracted inline code span. It
 * carries no question marker and no sentence boundary, so it is inert for
 * the heuristic while keeping the sentence split where the span sat.
 */
const CODE_SLOT = '\uE000';

/**
 * Replace fenced code blocks with a space and each inline code span with a
 * positional slot, so code content (shell snippets, grep patterns, JSON)
 * never trips a prose heuristic.
 *
 * @param {string} text
 * @returns {string}
 */
function stripCodeSpans(text) {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, CODE_SLOT);
}

/**
 * Split prose into sentence-ish units with code content removed. Newlines
 * are boundaries too, so a bullet list yields one unit per bullet.
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
 * Truncate an excerpt for the finding's `evidence` field.
 *
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
 * open-question: operator-directed phrasing (or a trailing `?`) in prose a
 * non-interactive sub-agent executes.
 *
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
 * Evaluate the open-question lint over a draft Story array.
 *
 * @param {{ draftStories?: Array<object>|null }} args - The draft
 *   `stories.json` array (raw Story objects with top-level `slug` /
 *   `body`). Null/absent evaluates to zero findings (the single-delivery
 *   shape authors no draft tickets).
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
      // Advisory lint: an unparseable body is the persist validators'
      // rejection to make, not this evaluator's.
      continue;
    }
    const goal = typeof body.goal === 'string' ? body.goal : '';
    const spec = typeof body.spec === 'string' ? body.spec : '';
    findings.push(...findOpenQuestions([goal, spec].join('\n'), slug));
  }
  return { findings };
}

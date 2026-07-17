/**
 * plan-text-hygiene.js — deterministic text-hygiene lints over draft Story
 * bodies (Story #4599).
 *
 * The text analysis of Stories #4592–#4594 (and domio#1684) surfaced three
 * body-defect classes no gate checks: dangling prose citations whose carrier
 * document is unlocatable, operator-directed open questions persisted into
 * tickets executed by non-interactive sub-agents, and `## Slicing` sections
 * carrying more mass than the `## Spec` they are supposed to checkpoint.
 * This module makes those classes checkable at the one point a re-author
 * loop exists — the pre-persist critic gate (`plan-critics.js`).
 *
 * Advisory by contract: findings are deterministic text for the workflow's
 * re-author round. They never gate persist, never flip a dispatch verdict,
 * and spawn nothing.
 *
 * Heuristics are deliberately narrow (few false positives over recall):
 *
 *   - **dangling-citation** — a sentence referencing a document section
 *     (`§`, "design note", "review doc") with no repo-relative path and no
 *     `#<digits>` issue anchor in the same sentence.
 *   - **open-question** — interrogative-to-operator phrasing ("Flag if",
 *     "TBD", "confirm with the operator", a trailing `?`) in Goal/Spec
 *     prose outside code spans. Bodies record decisions; unresolved
 *     unknowns belong in declarative Key Assumptions.
 *   - **slicing-mass** — `## Slicing` character mass exceeding `## Spec`
 *     character mass when both are present: checkpoints carrying
 *     Spec-grade detail the Spec then re-covers.
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
 * Phrases the citation heuristic treats as a reference to an external
 * carrier document. Matched case-insensitively within one sentence.
 */
const CITATION_MARKERS = [/§/, /\bdesign note\b/i, /\breview doc\b/i];

/**
 * Anchors that locate a citation: a `#<digits>` issue reference or a
 * repo-relative path (a slash-joined token carrying a file-ish segment).
 */
const ISSUE_ANCHOR = /#\d+/;
const REPO_PATH_ANCHOR = /[\w.-]+\/[\w./-]+/;

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
 * @property {'dangling-citation'|'open-question'|'slicing-mass'} kind
 * @property {string} slug - The draft Story's slug ('' when absent).
 * @property {string} evidence - Excerpt of the offending text.
 * @property {string} message - Human-readable, re-author-actionable text.
 */

/**
 * Strip fenced code blocks and inline code spans so code content (shell
 * snippets, grep patterns, JSON) never trips a prose heuristic.
 *
 * @param {string} text
 * @returns {string}
 */
function stripCodeSpans(text) {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
}

/**
 * Split prose into sentence-ish units. Newlines are boundaries too, so a
 * bullet list yields one unit per bullet.
 *
 * @param {string} text
 * @returns {string[]}
 */
function splitSentences(text) {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
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
 * dangling-citation: a citation-marker sentence with no locating anchor.
 *
 * @param {string} prose - Code-stripped body prose.
 * @param {string} slug
 * @returns {TextHygieneFinding[]}
 */
function findDanglingCitations(prose, slug) {
  const findings = [];
  for (const sentence of splitSentences(prose)) {
    const cites = CITATION_MARKERS.some((m) => m.test(sentence));
    if (!cites) continue;
    const anchored =
      ISSUE_ANCHOR.test(sentence) || REPO_PATH_ANCHOR.test(sentence);
    if (anchored) continue;
    findings.push({
      kind: 'dangling-citation',
      slug,
      evidence: excerpt(sentence),
      message:
        'Citation names a document section but no repo-relative path or ' +
        '#<issue> anchor locates it in the same sentence — the executing ' +
        'agent cannot follow it. Anchor the citation or inline the claim.',
    });
  }
  return findings;
}

/**
 * open-question: operator-directed phrasing (or a trailing `?`) in prose a
 * non-interactive sub-agent executes.
 *
 * @param {string} prose - Code-stripped Goal/Spec prose.
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
 * slicing-mass: `## Slicing` outweighing `## Spec` when both are present.
 *
 * @param {{ slicing?: string, spec?: string }} body - Parsed Story body.
 * @param {string} slug
 * @returns {TextHygieneFinding[]}
 */
function findSlicingMass(body, slug) {
  const slicing = typeof body.slicing === 'string' ? body.slicing : '';
  const spec = typeof body.spec === 'string' ? body.spec : '';
  if (slicing.length === 0 || spec.length === 0) return [];
  if (slicing.length <= spec.length) return [];
  return [
    {
      kind: 'slicing-mass',
      slug,
      evidence: excerpt(slicing),
      message:
        `## Slicing (${slicing.length} chars) outweighs ## Spec ` +
        `(${spec.length} chars) — checkpoints are carrying Spec-grade ` +
        'detail. Keep each Slicing checkpoint to one line and move the ' +
        'detail into ## Spec.',
    },
  ];
}

/**
 * Evaluate the three text-hygiene lints over a draft Story array.
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
    const bodyProse = stripCodeSpans(
      typeof story.body === 'string' ? story.body : [goal, spec].join('\n'),
    );
    findings.push(
      ...findDanglingCitations(bodyProse, slug),
      ...findOpenQuestions(stripCodeSpans([goal, spec].join('\n')), slug),
      ...findSlicingMass(body, slug),
    );
  }
  return { findings };
}

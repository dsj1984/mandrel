/**
 * story-plan.js — helpers for `/plan`.
 *
 * Pure functions used by `.agents/scripts/story-plan.js` (the CLI).
 * Kept side-effect-free so the CLI stays a thin orchestrator and these
 * helpers are easy to unit-test.
 *
 * Surfaces:
 *   - DEFAULT_REFINE_THRESHOLD     — seed length below which refinement
 *                                    is auto-suggested.
 *   - REQUIRED_SECTIONS            — canonical section headings the body
 *                                    must carry to be accepted by
 *                                    /single-story-deliver.
 *   - rankDuplicateCandidates({ seed, openStories, maxResults })
 *                                  — Jaccard-overlap ranking of open
 *                                    Stories whose titles fuzzy-match
 *                                    the seed.
 *   - validateStoryBody(body)      — schema-light shape check:
 *                                    required sections present, no
 *                                    `Epic:` reference, AC checklist
 *                                    non-empty.
 *   - buildContextEnvelope(opts)   — assemble the context envelope the
 *                                    host LLM consumes.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { overlapScore, tokenize } from './duplicate-search.js';

export const DEFAULT_REFINE_THRESHOLD = 200;
export const DEFAULT_DUPLICATE_MAX_RESULTS = 5;
export const DEFAULT_DUPLICATE_MIN_SCORE = 0.15;

export const REQUIRED_SECTIONS = [
  'Context',
  'Acceptance Criteria',
  'Out of Scope',
  'Notes',
];

const EPIC_REF_PATTERN = /^\s*Epic:\s*#\d+/m;
const AC_HEADING_PATTERN = /^##\s+Acceptance Criteria\s*$/m;
const CHECKLIST_PATTERN = /^\s*-\s*\[\s?\]/m;

/**
 * Rank open Stories by title-overlap with the seed. Reuses the same
 * tokenize + Jaccard primitives that `duplicate-search.js` exposes for
 * Epic-level dedupe — Stories are a different ticket type but the
 * scoring shape is the same.
 *
 * @param {{ seed: string, openStories: Array<{ id:number, title:string, url?:string, body?:string }>, maxResults?: number, minScore?: number }} opts
 * @returns {Array<{ id:number, title:string, url?:string, score:number }>}
 */
export function rankDuplicateCandidates({
  seed,
  openStories,
  maxResults = DEFAULT_DUPLICATE_MAX_RESULTS,
  minScore = DEFAULT_DUPLICATE_MIN_SCORE,
}) {
  if (!seed || typeof seed !== 'string') {
    throw new Error('rankDuplicateCandidates: seed must be a non-empty string');
  }
  if (!Array.isArray(openStories)) {
    throw new Error('rankDuplicateCandidates: openStories must be an array');
  }
  const seedTokens = tokenize(seed);
  if (seedTokens.size === 0) return [];

  const ranked = [];
  for (const story of openStories) {
    if (!story || typeof story.title !== 'string') continue;
    const corpus = `${story.title}\n${story.body ?? ''}`;
    const candTokens = tokenize(corpus);
    const score = overlapScore(seedTokens, candTokens);
    if (score >= minScore) {
      ranked.push({
        id: story.id,
        title: story.title,
        url: story.url,
        score: Number(score.toFixed(4)),
      });
    }
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, maxResults);
}

/**
 * Decide whether the seed warrants a Phase-2 idea-refinement pass.
 * The default rule: refine when the seed is shorter than
 * `DEFAULT_REFINE_THRESHOLD` chars. Operator overrides via
 * `--refine` / `--no-refine` short-circuit the heuristic.
 *
 * @param {{ seed:string, override?:'on'|'off'|null, threshold?:number }} opts
 * @returns {{ refine:boolean, reason:string }}
 */
export function shouldRefine({
  seed,
  override = null,
  threshold = DEFAULT_REFINE_THRESHOLD,
}) {
  if (override === 'on') return { refine: true, reason: 'operator-forced-on' };
  if (override === 'off')
    return { refine: false, reason: 'operator-forced-off' };
  if (typeof seed !== 'string' || seed.trim().length === 0) {
    return { refine: true, reason: 'empty-seed' };
  }
  if (seed.trim().length < threshold) {
    return {
      refine: true,
      reason: `seed-shorter-than-${threshold}-chars`,
    };
  }
  return { refine: false, reason: `seed-meets-${threshold}-char-threshold` };
}

/**
 * Schema-light validator for a standalone-Story body. Used by the persist
 * path *and* by tests asserting `--dry-run` output stability. The check
 * is deliberately tolerant of authoring whitespace: it asserts the
 * canonical headings are present, that no `Epic: #N` reference leaks
 * (the standalone contract), and that the Acceptance Criteria section
 * carries at least one unchecked checklist item.
 *
 * @param {string} body
 * @returns {{ ok:boolean, errors:string[] }}
 */
export function validateStoryBody(body) {
  const errors = [];
  if (typeof body !== 'string' || body.trim().length === 0) {
    return { ok: false, errors: ['body is empty'] };
  }

  for (const section of REQUIRED_SECTIONS) {
    const pattern = new RegExp(`^##\\s+${escapeRegex(section)}\\s*$`, 'm');
    if (!pattern.test(body)) {
      errors.push(`missing required section: "## ${section}"`);
    }
  }

  if (EPIC_REF_PATTERN.test(body)) {
    errors.push(
      'body contains an "Epic: #N" reference — standalone Stories must not link to an Epic',
    );
  }

  // AC checklist non-empty: extract from "## Acceptance Criteria" to the
  // next "## " heading (or EOF) and assert at least one checklist item.
  const acStart = body.search(AC_HEADING_PATTERN);
  if (acStart !== -1) {
    const rest = body.slice(acStart);
    const nextHeading = rest.slice(1).search(/^##\s+/m);
    const acBlock = nextHeading === -1 ? rest : rest.slice(0, nextHeading + 1);
    if (!CHECKLIST_PATTERN.test(acBlock)) {
      errors.push(
        'Acceptance Criteria section has no unchecked checklist items (`- [ ] ...`)',
      );
    }
  }

  return { ok: errors.length === 0, errors };
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Load the body-template file from disk. Resolves relative to a project
 * root so callers (CLI, tests) can pin the lookup deterministically.
 *
 * @param {string} projectRoot
 * @returns {Promise<string>}
 */
export async function loadBodyTemplate(projectRoot) {
  const tpl = path.join(
    projectRoot,
    '.agents',
    'templates',
    'single-story-body.md',
  );
  return readFile(tpl, 'utf8');
}

/**
 * Assemble the context envelope the host LLM consumes to author a draft
 * Story body. Pure — no I/O beyond what the caller passed in.
 *
 * @param {{
 *   seed: string,
 *   refine: { refine:boolean, reason:string },
 *   persona: string,
 *   bodyTemplate: string,
 *   duplicateCandidates: Array<object>,
 *   techStack?: string|null,
 *   maxResults?: number,
 * }} opts
 */
export function buildContextEnvelope({
  seed,
  refine,
  persona,
  bodyTemplate,
  duplicateCandidates,
  techStack = null,
  maxResults = DEFAULT_DUPLICATE_MAX_RESULTS,
}) {
  return {
    kind: 'story-plan-context',
    version: 1,
    seed,
    refine,
    persona,
    bodyTemplate,
    requiredSections: [...REQUIRED_SECTIONS],
    duplicateCandidates: {
      maxResults,
      candidates: duplicateCandidates,
    },
    techStack,
    deliverContract: {
      workflow: '.agents/workflows/helpers/single-story-deliver.md',
      requiredLabels: ['type::story', `persona::${persona}`],
      forbidden: ['Epic: #N references in the body'],
    },
  };
}

/**
 * Strip the leading "Tech Stack" section of `docs/architecture.md` for
 * the host LLM. Returns `null` when the file or section is missing.
 *
 * @param {string} projectRoot
 * @returns {Promise<string|null>}
 */
export async function readTechStackSummary(projectRoot) {
  const archPath = path.join(projectRoot, 'docs', 'architecture.md');
  let content;
  try {
    content = await readFile(archPath, 'utf8');
  } catch {
    return null;
  }
  const match = content.match(/^##\s+Tech Stack\s*$([\s\S]*?)(?=^##\s+\S)/m);
  return match ? `## Tech Stack${match[1]}`.trim() : null;
}

/**
 * v2 spec spill-to-doc helper.
 *
 * The v2 Story body folds its Tech Spec inline (`docs/roadmap.md` § v2.0.0).
 * To keep trivial-Story bodies lean while still giving a large Story (what v1
 * called an Epic) a home for heavy spec prose, an over-budget spec **spills to
 * a committed `docs/specs/<storyId>.md`** and the Story body references it
 * instead of carrying the prose inline. This also hands large Stories back a
 * single canonical spec document (softening the "sharded spec" trade-off).
 *
 * The budget reuses the §2 FinOps estimator ({@link estimateTokens}, ~4
 * chars/token) so the spill threshold speaks the same units as the rest of the
 * hydration budget.
 *
 * The decision is pure; the file write is injectable (`opts.fs`) so callers and
 * tests can dry-run or redirect I/O. Nothing wires this yet — the planner calls
 * it in Stage 3.
 */

import fs from 'node:fs';
import path from 'node:path';
import { estimateTokens } from './context-envelope.js';

/**
 * Default soft budget (in estimated tokens) for an inline folded spec before
 * it spills to a doc. ~1500 tokens ≈ 6KB — generous for a real Tech Spec while
 * still well under the 22KB issue-body bloat the spill exists to prevent.
 */
export const DEFAULT_SPEC_BODY_TOKEN_BUDGET = 1500;

/** Default directory (repo-relative) for spilled spec docs. */
const DEFAULT_SPECS_DIR = 'docs/specs';

/**
 * @typedef {object} SpecSpillResult
 * @property {boolean} spilled       Whether the spec was written to a doc.
 * @property {number}  estimatedTokens Estimated tokens of the spec content.
 * @property {string}  content       The spec content (unchanged).
 * @property {string|null} docPath   Repo-relative doc path when spilled, else null.
 * @property {{ path: string, assumption: 'creates' }|null} reference
 *   A Story-body `references[]` entry pointing at the spilled doc, or null when inline.
 */

/**
 * Decide whether a Story's folded spec fits inline or must spill to a doc, and
 * perform the spill when it does not fit.
 *
 * @param {object} args
 * @param {string} args.storyId  Story identifier used for the doc filename (slug or id).
 * @param {string} args.spec     The folded Tech Spec markdown for this Story.
 * @param {object} [opts]
 * @param {number} [opts.tokenBudget=DEFAULT_SPEC_BODY_TOKEN_BUDGET] Soft budget in estimated tokens.
 * @param {string} [opts.specsDir=DEFAULT_SPECS_DIR] Repo-relative spilled-spec directory.
 * @param {string} [opts.repoRoot=process.cwd()] Absolute root the doc path resolves under.
 * @param {boolean} [opts.write=true] When false, decide but do not write (dry run).
 * @param {Pick<typeof fs, 'writeFileSync'|'mkdirSync'>} [opts.fs=fs] Injectable fs for tests.
 * @returns {SpecSpillResult}
 */
export function spillSpecIfOverBudget({ storyId, spec }, opts = {}) {
  const {
    tokenBudget = DEFAULT_SPEC_BODY_TOKEN_BUDGET,
    specsDir = DEFAULT_SPECS_DIR,
    repoRoot = process.cwd(),
    write = true,
    fs: fsImpl = fs,
  } = opts;

  const content = typeof spec === 'string' ? spec : '';
  const estimatedTokens = estimateTokens(content);

  if (estimatedTokens <= tokenBudget) {
    return {
      spilled: false,
      estimatedTokens,
      content,
      docPath: null,
      reference: null,
    };
  }

  if (typeof storyId !== 'string' || storyId.trim() === '') {
    throw new Error(
      'spillSpecIfOverBudget: a non-empty storyId is required to spill an over-budget spec.',
    );
  }

  const safeId = sanitizeStoryId(storyId);
  const docPath = `${specsDir}/${safeId}.md`;

  if (write) {
    const absPath = path.resolve(repoRoot, docPath);
    fsImpl.mkdirSync(path.dirname(absPath), { recursive: true });
    fsImpl.writeFileSync(absPath, ensureTrailingNewline(content));
  }

  return {
    spilled: true,
    estimatedTokens,
    content,
    docPath,
    reference: { path: docPath, assumption: 'creates' },
  };
}

/**
 * Reduce a Story id to a filesystem-safe basename: strip a leading `#`, lower
 * the case, and replace any non `[a-z0-9._-]` run with a single `-`.
 *
 * @param {string} id
 * @returns {string}
 */
export function sanitizeStoryId(id) {
  return id
    .trim()
    .replace(/^#/, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * @param {string} text
 * @returns {string}
 */
function ensureTrailingNewline(text) {
  return text.endsWith('\n') ? text : `${text}\n`;
}

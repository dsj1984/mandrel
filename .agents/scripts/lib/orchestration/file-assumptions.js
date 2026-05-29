/**
 * file-assumptions.js — Phase 8 path-assumption validator.
 *
 * Story #2635 added the Tech Spec freshness check at Phase 7. This module
 * is the matching gate at Phase 8: every Story's `body.changes` /
 * `body.references` entry that declares an explicit `assumption` is
 * cross-checked against the actual state of `baseBranchRef`. Mismatches
 * are batched per-Story and surfaced through the same error envelope the
 * decompose loop already uses.
 *
 * Under the 3-tier hierarchy (Epic → Feature → Story; Epic #3078 / #3238)
 * the Story is the implementation unit — there is no `type::task` ticket
 * layer — so the gate scans `type === 'story'` tickets and reads the
 * `{ path, assumption }` entries inlined on each Story body.
 *
 * Rules (one error per mismatched path):
 *   - `creates`            + path **exists**  → error (Story would clobber).
 *   - `refactors-existing` + path **absent** → error (no target to refactor).
 *   - `exists`             + path **absent** → error (read dependency missing).
 *   - `deletes`            + path **absent** → error (nothing to delete).
 *
 * Legacy compatibility: stories whose `body.changes` items are still bare
 * strings carry no assumption and are skipped silently here. The
 * deprecation signal is emitted *once* per validator invocation through
 * `collectDeprecationWarnings`, so consumers running an older planner
 * see a clear migration nudge without a hard failure mid-flight.
 */

import { gitSpawn } from '../git-utils.js';
import { parse as parseStoryBody } from '../story-body/story-body.js';
import { FILE_ASSUMPTION_VALUES } from './file-assumption-enum.js';
import { isObjectPathEntry } from './task-body-validator.js';

/**
 * Default git probe — returns `true` when `path` exists at
 * `baseBranchRef`. Mirrors the existence check used by
 * {@link ./ticket-validator.js#validateAcFreshness} and
 * {@link ./spec-freshness.js} so all three gates share semantics.
 *
 * @param {{ baseBranchRef: string, path: string, cwd?: string }} opts
 * @returns {boolean}
 */
function defaultGitRunner({ baseBranchRef, path, cwd }) {
  const result = gitSpawn(
    cwd ?? process.cwd(),
    'cat-file',
    '-e',
    `${baseBranchRef}:${path}`,
  );
  return result.status === 0;
}

/**
 * Pull every `(path, assumption, source)` triple from a Story body.
 * `source` is one of `'changes' | 'references'` so error messages can
 * point the operator at the right list.
 *
 * Returns an empty array when the body is absent, a plain string, or
 * carries no object-form entries — that's the legacy path. Callers use
 * the resulting array's emptiness to decide whether to emit a
 * deprecation warning for the Story.
 *
 * @param {object} story
 * @returns {Array<{ path: string, assumption: string, source: 'changes' | 'references' }>}
 */
export function collectStoryAssumptionEntries(story) {
  const out = [];
  const body = story?.body;

  // Story #3302: when the body is a markdown string (canonical serialized
  // form emitted by `serialize()` from story-body.js), parse it first to
  // extract the structured changes[] / references[] arrays. Without this,
  // every story with a string body would be treated as the legacy case
  // (no object-form entries) and the assumption gate would silently no-op.
  let structuredBody;
  if (typeof body === 'string' && body.trim().length > 0) {
    try {
      structuredBody = parseStoryBody(body).body;
    } catch {
      // Unparseable body — treat as legacy (no assumptions to check).
      return out;
    }
  } else if (body !== null && typeof body === 'object') {
    structuredBody = body;
  } else {
    return out;
  }

  if (Array.isArray(structuredBody.changes)) {
    for (const entry of structuredBody.changes) {
      if (isObjectPathEntry(entry)) {
        out.push({
          path: entry.path,
          assumption: entry.assumption,
          source: 'changes',
        });
      }
    }
  }
  if (Array.isArray(structuredBody.references)) {
    for (const entry of structuredBody.references) {
      if (isObjectPathEntry(entry)) {
        out.push({
          path: entry.path,
          assumption: entry.assumption,
          source: 'references',
        });
      }
    }
  }
  return out;
}

/**
 * Predicate: does the story have any string-form `body.changes` bullets
 * left over after a partial migration? Used to decide whether to emit a
 * per-story deprecation warning even when at least one object entry is
 * present.
 *
 * @param {object} story
 * @returns {boolean}
 */
export function hasLegacyChangeBullets(story) {
  const body = story?.body;
  if (body === null || typeof body !== 'object') return false;
  if (!Array.isArray(body.changes)) return false;
  return body.changes.some((c) => typeof c === 'string');
}

/**
 * Render a single mismatch into a stable error string. Kept pure so
 * tests can pin the exact message shape downstream tooling parses.
 *
 * @param {{ slug: string, source: string, path: string, assumption: string, expected: 'present' | 'absent' }} mismatch
 * @returns {string}
 */
function renderMismatch({ slug, source, path, assumption, expected }) {
  if (expected === 'present') {
    return `"${slug}" → body.${source} declares assumption="${assumption}" for ${path} but the path is absent at the base branch.`;
  }
  return `"${slug}" → body.${source} declares assumption="${assumption}" for ${path} but the path already exists at the base branch.`;
}

/**
 * Validate every Story's declared file assumptions against the actual
 * state of `baseBranchRef`. Returns an envelope:
 *
 *   {
 *     errors:    string[]   // one entry per mismatch, batched per Story
 *     warnings:  string[]   // legacy/no-assumption deprecation nudges
 *     mismatches: object[]  // structured payload for downstream tooling
 *   }
 *
 * Under the 3-tier hierarchy the Story is the implementation unit, so the
 * gate scans `type === 'story'` tickets and reads the inline
 * `{ path, assumption }` entries on each Story body.
 *
 * The function never throws on a probe failure — the runner is expected
 * to return `false` for any unreadable git ref, which surfaces the path
 * as a mismatch (for `refactors-existing` / `exists` / `deletes`) or as
 * fresh (for `creates`). This matches the non-blocking, advisory shape
 * of the Phase 7 freshness check.
 *
 * @param {object}   opts
 * @param {object[]} opts.tickets
 * @param {string}   opts.baseBranchRef
 * @param {Function} [opts.gitRunner]
 * @param {string}   [opts.cwd]
 * @returns {{ errors: string[], warnings: string[], mismatches: Array }}
 */
export function validateStoryFileAssumptions(opts) {
  const { tickets, baseBranchRef, gitRunner = defaultGitRunner, cwd } = opts;
  if (!baseBranchRef || typeof baseBranchRef !== 'string') {
    throw new Error(
      'validateStoryFileAssumptions: baseBranchRef is required and must be a string.',
    );
  }
  const stories = (tickets ?? []).filter((t) => t.type === 'story');
  const errors = [];
  const warnings = [];
  const mismatches = [];
  const probeCache = new Map();

  for (const story of stories) {
    const slug = story.slug ?? story.title ?? '<unknown>';
    const entries = collectStoryAssumptionEntries(story);

    if (entries.length === 0) {
      // Legacy path: this Story carries no object-form entries. Emit a
      // single deprecation warning so the operator sees the migration
      // nudge once per Story rather than per-bullet.
      if (hasLegacyChangeBullets(story)) {
        warnings.push(
          `"${slug}" → body.changes uses legacy string bullets without { path, assumption }. Migrate to object form so Phase 8 can verify file-state assumptions. See Story #2636.`,
        );
      }
      continue;
    }

    // Partial-migration warning: some entries are object-form, some are
    // still strings. Surface once so the operator notices the gap.
    if (hasLegacyChangeBullets(story)) {
      warnings.push(
        `"${slug}" → body.changes mixes object-form entries with legacy string bullets. Migrate every bullet for full freshness coverage.`,
      );
    }

    for (const { path, assumption, source } of entries) {
      let exists = probeCache.get(path);
      if (exists === undefined) {
        exists = Boolean(gitRunner({ baseBranchRef, path, cwd }));
        probeCache.set(path, exists);
      }
      const mismatch = checkAssumption({
        slug,
        source,
        path,
        assumption,
        exists,
      });
      if (mismatch !== null) {
        mismatches.push(mismatch);
        errors.push(renderMismatch(mismatch));
      }
    }
  }
  return { errors, warnings, mismatches };
}

/**
 * Apply one assumption rule and return a structured mismatch or `null`
 * when the declared assumption matches reality. Extracted from
 * `validateStoryFileAssumptions` so the rules table sits in one place
 * that's trivially unit-testable.
 *
 * @param {{ slug: string, source: string, path: string, assumption: string, exists: boolean }} args
 * @returns {object|null}
 */
function checkAssumption({ slug, source, path, assumption, exists }) {
  switch (assumption) {
    case 'creates':
      if (exists) {
        return {
          slug,
          source,
          path,
          assumption,
          expected: 'absent',
          actual: 'present',
        };
      }
      return null;
    case 'refactors-existing':
    case 'exists':
    case 'deletes':
      if (!exists) {
        return {
          slug,
          source,
          path,
          assumption,
          expected: 'present',
          actual: 'absent',
        };
      }
      return null;
    default:
      // Unknown assumption values were already rejected by the body
      // schema validator — defensive default so future enum additions
      // surface as test failures rather than silent passes.
      return {
        slug,
        source,
        path,
        assumption,
        expected: 'unknown',
        actual: exists ? 'present' : 'absent',
      };
  }
}

/**
 * Re-export the canonical assumption enum so callers can reach for the
 * list without depending on task-body-validator's internals.
 */
export { FILE_ASSUMPTION_VALUES };

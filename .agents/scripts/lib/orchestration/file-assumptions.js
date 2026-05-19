/**
 * file-assumptions.js — Phase 8 path-assumption validator.
 *
 * Story #2635 added the Tech Spec freshness check at Phase 7. This module
 * is the matching gate at Phase 8: every Task's `body.changes` /
 * `body.references` entry that declares an explicit `assumption` is
 * cross-checked against the actual state of `baseBranchRef`. Mismatches
 * are batched per-Task and surfaced through the same error envelope the
 * decompose loop already uses.
 *
 * Rules (one error per mismatched path):
 *   - `creates`            + path **exists**  → error (Task would clobber).
 *   - `refactors-existing` + path **absent** → error (no target to refactor).
 *   - `exists`             + path **absent** → error (read dependency missing).
 *   - `deletes`            + path **absent** → error (nothing to delete).
 *
 * Legacy compatibility: tasks whose `body.changes` items are still bare
 * strings carry no assumption and are skipped silently here. The
 * deprecation signal is emitted *once* per validator invocation through
 * `collectDeprecationWarnings`, so consumers running an older planner
 * see a clear migration nudge without a hard failure mid-flight.
 */

import { gitSpawn } from '../git-utils.js';
import {
  FILE_ASSUMPTION_VALUES,
  isObjectPathEntry,
} from './task-body-validator.js';

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
 * Pull every `(path, assumption, source)` triple from a Task body.
 * `source` is one of `'changes' | 'references'` so error messages can
 * point the operator at the right list.
 *
 * Returns an empty array when the body is absent, a plain string, or
 * carries no object-form entries — that's the legacy path. Callers use
 * the resulting array's emptiness to decide whether to emit a
 * deprecation warning for the Task.
 *
 * @param {object} task
 * @returns {Array<{ path: string, assumption: string, source: 'changes' | 'references' }>}
 */
export function collectTaskAssumptionEntries(task) {
  const out = [];
  const body = task?.body;
  if (body === null || typeof body !== 'object') return out;
  if (Array.isArray(body.changes)) {
    for (const entry of body.changes) {
      if (isObjectPathEntry(entry)) {
        out.push({
          path: entry.path,
          assumption: entry.assumption,
          source: 'changes',
        });
      }
    }
  }
  if (Array.isArray(body.references)) {
    for (const entry of body.references) {
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
 * Predicate: does the task have any string-form `body.changes` bullets
 * left over after a partial migration? Used to decide whether to emit a
 * per-task deprecation warning even when at least one object entry is
 * present.
 *
 * @param {object} task
 * @returns {boolean}
 */
export function hasLegacyChangeBullets(task) {
  const body = task?.body;
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
 * Validate every Task's declared file assumptions against the actual
 * state of `baseBranchRef`. Returns an envelope:
 *
 *   {
 *     errors:    string[]   // one entry per mismatch, batched per Task
 *     warnings:  string[]   // legacy/no-assumption deprecation nudges
 *     mismatches: object[]  // structured payload for downstream tooling
 *   }
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
export function validateTaskFileAssumptions(opts) {
  const { tickets, baseBranchRef, gitRunner = defaultGitRunner, cwd } = opts;
  if (!baseBranchRef || typeof baseBranchRef !== 'string') {
    throw new Error(
      'validateTaskFileAssumptions: baseBranchRef is required and must be a string.',
    );
  }
  const tasks = (tickets ?? []).filter((t) => t.type === 'task');
  const errors = [];
  const warnings = [];
  const mismatches = [];
  const probeCache = new Map();

  for (const task of tasks) {
    const slug = task.slug ?? task.title ?? '<unknown>';
    const entries = collectTaskAssumptionEntries(task);

    if (entries.length === 0) {
      // Legacy path: this Task carries no object-form entries. Emit a
      // single deprecation warning so the operator sees the migration
      // nudge once per Task rather than per-bullet.
      if (hasLegacyChangeBullets(task)) {
        warnings.push(
          `"${slug}" → body.changes uses legacy string bullets without { path, assumption }. Migrate to object form so Phase 8 can verify file-state assumptions. See Story #2636.`,
        );
      }
      continue;
    }

    // Partial-migration warning: some entries are object-form, some are
    // still strings. Surface once so the operator notices the gap.
    if (hasLegacyChangeBullets(task)) {
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
 * `validateTaskFileAssumptions` so the rules table sits in one place
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

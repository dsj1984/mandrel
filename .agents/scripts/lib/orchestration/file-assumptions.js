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
 * Under the 2-tier hierarchy (Epic → Story; Epic #3078 / #3238)
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
 * Wave awareness (Story #3960): the base-branch-only rules above produce
 * false signals once an earlier Story in the same epic creates (or deletes)
 * a file before a later Story touches it. `validateStoryFileAssumptions`
 * therefore validates each Story against the **simulated post-predecessor
 * tree** — base-branch existence overlaid with the create/delete delta of
 * the Story's transitive `depends_on` predecessors (the same reachability
 * walk the conflict gate uses, imported from the shared
 * `story-reachability.js` leaf rather than re-derived). Two extra
 * wave-aware rules layer on top of the
 * base-branch rules:
 *   - `creates`            + path created by a **predecessor** → mismatch
 *     (`expected: 'refactors-existing'`) telling the planner to declare
 *     `refactors-existing` and naming the producing Story.
 *   - `refactors-existing` + path absent from base but created by a
 *     **predecessor** → validates clean (no false-positive base-branch
 *     "absent" mismatch).
 * Concurrent same-path creates between Stories with no `depends_on` path are
 * the shared-editor conflict gate's domain — that finding's rendering is
 * cross-referenced (see `renderMismatch`), not duplicated here.
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
import { computeStoryReachability } from './story-reachability.js';
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
 * The `expected` discriminator selects the message shape:
 *   - `'present'`            — base-branch read/refactor/delete target absent.
 *   - `'absent'`             — base-branch `creates` target already exists.
 *   - `'refactors-existing'` — wave-aware: a transitive predecessor already
 *     creates this path, so the dependent Story should declare
 *     `refactors-existing` (Story #3960). Names the producing Story.
 *   - `'predecessor-conflict'` — wave-aware: a concurrent Story (no
 *     `depends_on` ordering) also creates this path. Cross-references the
 *     shared-editor conflict finding rather than re-deriving its prose.
 *
 * @param {{ slug: string, source: string, path: string, assumption: string, expected: string, producerSlug?: string }} mismatch
 * @returns {string}
 */
function renderMismatch({
  slug,
  source,
  path,
  assumption,
  expected,
  producerSlug,
}) {
  if (expected === 'refactors-existing') {
    return `"${slug}" → body.${source} declares assumption="${assumption}" for ${path} but predecessor Story "${producerSlug}" already creates that path — declare assumption="refactors-existing" instead (the file exists in the simulated post-predecessor tree).`;
  }
  if (expected === 'predecessor-conflict') {
    return `"${slug}" → body.${source} declares assumption="${assumption}" for ${path} but concurrent Story "${producerSlug}" also creates that path with no depends_on ordering between them — see the shared-editor conflict finding for the resolution (add a depends_on chain or split the create into a dedicated late-wave Story).`;
  }
  if (expected === 'present') {
    return `"${slug}" → body.${source} declares assumption="${assumption}" for ${path} but the path is absent at the base branch.`;
  }
  return `"${slug}" → body.${source} declares assumption="${assumption}" for ${path} but the path already exists at the base branch.`;
}

/**
 * Index, across every Story, which Stories declare a `creates` (and which
 * declare a `deletes`) for each `changes`-sourced path. The maps drive the
 * wave-aware simulated-tree overlay: a path created by a transitive
 * predecessor is treated as present, a path deleted by one as absent.
 *
 * Only `changes`-sourced entries count — `references` describe read
 * dependencies, never writes, so they cannot mutate the simulated tree.
 *
 * @param {object[]} stories
 * @returns {{ creators: Map<string, string[]>, deleters: Map<string, string[]> }}
 */
function indexPathMutations(stories) {
  const creators = new Map();
  const deleters = new Map();
  for (const story of stories) {
    const slug = story.slug ?? story.title ?? '<unknown>';
    for (const { path, assumption, source } of collectStoryAssumptionEntries(
      story,
    )) {
      if (source !== 'changes') continue;
      const bucket =
        assumption === 'creates'
          ? creators
          : assumption === 'deletes'
            ? deleters
            : null;
      if (!bucket) continue;
      const existing = bucket.get(path);
      if (existing) {
        if (!existing.includes(slug)) existing.push(slug);
      } else {
        bucket.set(path, [slug]);
      }
    }
  }
  return { creators, deleters };
}

/**
 * Resolve the first transitive predecessor of `story` that mutates `path`
 * in the requested way (`creators` or `deleters` index). Returns the
 * producing Story's slug, or `null` when no predecessor mutates the path.
 *
 * @param {Map<string, string[]>} index
 * @param {string} path
 * @param {Set<string>} predecessors  Transitive `depends_on` slug set.
 * @returns {string|null}
 */
function predecessorMutator(index, path, predecessors) {
  const slugs = index.get(path);
  if (!slugs) return null;
  for (const slug of slugs) {
    if (predecessors.has(slug)) return slug;
  }
  return null;
}

/**
 * Validate every Story's declared file assumptions against the simulated
 * post-predecessor tree: the actual state of `baseBranchRef` overlaid with
 * the create/delete delta of the Story's transitive `depends_on`
 * predecessors (Story #3960). Returns an envelope:
 *
 *   {
 *     errors:    string[]   // one entry per mismatch, batched per Story
 *     warnings:  string[]   // legacy/no-assumption deprecation nudges
 *     mismatches: object[]  // structured payload for downstream tooling
 *   }
 *
 * Under the 2-tier hierarchy the Story is the implementation unit, so the
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

  // Wave-aware setup (Story #3960): transitive predecessor sets over the
  // story-level `depends_on` graph, plus per-path create/delete indices so
  // each Story is validated against the simulated post-predecessor tree
  // rather than the base branch alone.
  const reach = computeStoryReachability(stories);
  const { creators, deleters } = indexPathMutations(stories);

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

    const predecessors = reach.get(slug) ?? new Set();

    for (const { path, assumption, source } of entries) {
      let baseExists = probeCache.get(path);
      if (baseExists === undefined) {
        baseExists = Boolean(gitRunner({ baseBranchRef, path, cwd }));
        probeCache.set(path, baseExists);
      }
      const predecessorCreator = predecessorMutator(
        creators,
        path,
        predecessors,
      );
      const predecessorDeleter = predecessorMutator(
        deleters,
        path,
        predecessors,
      );
      // Simulated post-predecessor existence: base state, then a
      // predecessor `creates` makes the path present, a predecessor
      // `deletes` (with no predecessor create) makes it absent.
      let simulatedExists = baseExists;
      if (predecessorCreator) simulatedExists = true;
      else if (predecessorDeleter) simulatedExists = false;
      const mismatch = checkAssumption({
        slug,
        source,
        path,
        assumption,
        baseExists,
        simulatedExists,
        predecessorCreator,
      });
      if (mismatch !== null) {
        mismatches.push(mismatch);
        errors.push(renderMismatch(mismatch));
        continue;
      }
      // Wave-aware concurrent-create check (Story #3960): two Stories with
      // no `depends_on` ordering both declaring `creates` on the same path.
      // The shared-editor conflict gate owns the canonical resolution; this
      // gate surfaces the same signal in the assumption channel and
      // cross-references that finding rather than re-deriving its prose.
      // Only reached when `checkAssumption` returned clean — a base-branch
      // clobber or a predecessor-create already produced a richer mismatch.
      if (assumption === 'creates') {
        const concurrent = concurrentCoCreator({
          creators,
          path,
          slug,
          reach,
        });
        if (concurrent) {
          const conflict = {
            slug,
            source,
            path,
            assumption,
            expected: 'predecessor-conflict',
            actual: 'concurrent-creates',
            producerSlug: concurrent,
          };
          mismatches.push(conflict);
          errors.push(renderMismatch(conflict));
        }
      }
    }
  }
  return { errors, warnings, mismatches };
}

/**
 * Find the first *concurrent* co-creator of `path` for the Story `slug`:
 * another Story that declares `creates` on the same path with no
 * `depends_on` ordering in either direction. Returns that Story's slug, or
 * `null` when every co-creator is ordered relative to `slug` (predecessor
 * or successor) — those are handled by the predecessor-create rule, not the
 * concurrent-conflict rule.
 *
 * @param {{ creators: Map<string, string[]>, path: string, slug: string, reach: Map<string, Set<string>> }} args
 * @returns {string|null}
 */
function concurrentCoCreator({ creators, path, slug, reach }) {
  const slugs = creators.get(path);
  if (!slugs || slugs.length < 2) return null;
  const myPredecessors = reach.get(slug) ?? new Set();
  for (const other of slugs) {
    if (other === slug) continue;
    const otherPredecessors = reach.get(other) ?? new Set();
    // Ordered in either direction → not concurrent.
    if (myPredecessors.has(other)) continue;
    if (otherPredecessors.has(slug)) continue;
    return other;
  }
  return null;
}

/**
 * Apply one assumption rule against the simulated post-predecessor tree and
 * return a structured mismatch or `null` when the declared assumption
 * matches. Extracted from `validateStoryFileAssumptions` so the rules table
 * sits in one place that's trivially unit-testable.
 *
 * `baseExists` is the path's existence on the base branch; `simulatedExists`
 * is `baseExists` overlaid with the create/delete delta of the Story's
 * transitive predecessors. `predecessorCreator` (when non-null) is the slug
 * of the predecessor Story that creates the path — used to distinguish a
 * wave-aware `creates`-on-a-will-exist-path mismatch from the base-branch
 * "already exists" mismatch, and to name the producing Story in the nudge.
 *
 * @param {{ slug: string, source: string, path: string, assumption: string, baseExists: boolean, simulatedExists: boolean, predecessorCreator: string|null }} args
 * @returns {object|null}
 */
function checkAssumption({
  slug,
  source,
  path,
  assumption,
  baseExists,
  simulatedExists,
  predecessorCreator,
}) {
  switch (assumption) {
    case 'creates':
      // Base-branch clobber — the path already exists before any Story
      // runs. Unchanged from the base-branch-only rule.
      if (baseExists) {
        return {
          slug,
          source,
          path,
          assumption,
          expected: 'absent',
          actual: 'present',
        };
      }
      // Wave-aware (Story #3960): a transitive predecessor already creates
      // this path, so it exists in the simulated tree. Nudge the planner to
      // declare `refactors-existing` and name the producing Story.
      if (predecessorCreator) {
        return {
          slug,
          source,
          path,
          assumption,
          expected: 'refactors-existing',
          actual: 'predecessor-creates',
          producerSlug: predecessorCreator,
        };
      }
      return null;
    case 'refactors-existing':
    case 'exists':
    case 'deletes':
      // Validate against the simulated tree: a predecessor `creates` makes
      // an otherwise-absent base path present, so `refactors-existing` /
      // `exists` / `deletes` against it is no longer a false-positive
      // mismatch (Story #3960).
      if (!simulatedExists) {
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
        actual: simulatedExists ? 'present' : 'absent',
      };
  }
}

/**
 * Re-export the canonical assumption enum so callers can reach for the
 * list without depending on task-body-validator's internals.
 */
export { FILE_ASSUMPTION_VALUES };

/**
 * file-assumptions.js — Phase 8 path-assumption validator: every Story's
 * `{ path, assumption }` entry in `body.changes` / `body.references` is
 * checked against `baseBranchRef`, overlaid with the create/delete delta of
 * the Story's transitive `depends_on` predecessors (the simulated
 * post-predecessor tree). `changes[]` is an advisory sketch, so every
 * mismatch is a warning except `deletes` on an absent path (nothing to act
 * on), which is an error.
 */

import { gitSpawn } from '../git-utils.js';
import { parse as parseStoryBody } from '../story-body/story-body.js';
import { FILE_ASSUMPTION_VALUES } from './file-assumption-enum.js';
import { computeStoryReachability } from './story-reachability.js';
import { isObjectPathEntry } from './task-body-validator.js';

/**
 * Existence probe at `baseBranchRef`; same semantics as
 * `ticket-validator.js#validateAcFreshness`.
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
 * Find `path`'s rename target in a commit's `--name-status -M` output. The
 * diff must be the whole commit, not pathspec-limited: limiting to the
 * source path filters out the add half, so git reports a plain `D`.
 *
 * @param {string} stdout
 * @param {string} path
 * @returns {string|null} The rename target, or `null`.
 */
function parseRenameTarget(stdout, path) {
  for (const line of String(stdout ?? '').split('\n')) {
    const fields = line.split('\t');
    if (fields.length < 3) continue;
    if (!fields[0].startsWith('R')) continue;
    if (fields[1].trim() !== path) continue;
    const target = fields[2].trim();
    if (target) return target;
  }
  return null;
}

/**
 * History probe: did `baseBranchRef` ever track `path`, and which commit
 * removed it? Separates a mislabelled create from a plan written against a
 * deleted file. Fails open (`hadHistory: false`) so a probe failure never
 * becomes an error.
 *
 * @param {{ baseBranchRef: string, path: string, cwd?: string }} opts
 * @returns {{ hadHistory: boolean, commit: string|null, renamedTo: string|null }}
 */
function defaultHistoryRunner({ baseBranchRef, path, cwd }) {
  const absent = { hadHistory: false, commit: null, renamedTo: null };
  const root = cwd ?? process.cwd();
  const last = gitSpawn(root, 'rev-list', '-1', baseBranchRef, '--', path);
  const commit = last.status === 0 ? String(last.stdout ?? '').trim() : '';
  if (!commit) return absent;
  const status = gitSpawn(
    root,
    'show',
    '--name-status',
    '-M',
    '--diff-filter=R',
    '--format=',
    commit,
  );
  const renamedTo =
    status.status === 0 ? parseRenameTarget(status.stdout, path) : null;
  return { hadHistory: true, commit, renamedTo };
}

/**
 * @param {object} story
 * @returns {Array<{ path: string, assumption: string, source: 'changes' | 'references' }>}
 */
export function collectStoryAssumptionEntries(story) {
  const out = [];
  const body = story?.body;

  // A serialized markdown body must be parsed, or the gate silently no-ops.
  let structuredBody;
  if (typeof body === 'string' && body.trim().length > 0) {
    try {
      structuredBody = parseStoryBody(body).body;
    } catch {
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
 * Render a mismatch as a stable string (downstream tooling parses it),
 * selected by `expected`: `present`, `absent`, `refactors-existing`
 * (predecessor creates it), `predecessor-conflict` (unordered co-creator),
 * `present-was-removed` (base branch removed it).
 *
 * @param {{ slug: string, source: string, path: string, assumption: string, expected: string, producerSlug?: string, removedInCommit?: string, renamedTo?: string|null }} mismatch
 * @returns {string}
 */
function renderMismatch({
  slug,
  source,
  path,
  assumption,
  expected,
  producerSlug,
  removedInCommit,
  renamedTo,
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
  if (expected === 'present-was-removed') {
    return renderRemovedPathMismatch({
      slug,
      source,
      path,
      assumption,
      removedInCommit,
      renamedTo,
    });
  }
  return `"${slug}" → body.${source} declares assumption="${assumption}" for ${path} but the path already exists at the base branch.`;
}

/**
 * A refactor of a path the base branch once tracked is a plan written
 * against stale docs; normalizing it to `creates` would resurrect a
 * deliberately removed file. The removing commit points at its replacement.
 *
 * @param {{ slug: string, source: string, path: string, assumption: string, removedInCommit?: string, renamedTo?: string|null }} mismatch
 * @returns {string}
 */
function renderRemovedPathMismatch({
  slug,
  source,
  path,
  assumption,
  removedInCommit,
  renamedTo,
}) {
  const successor = renamedTo
    ? ` git detects it was renamed to ${renamedTo} — retarget the declaration there.`
    : ' Retarget the declaration at the path that replaced it, or declare assumption="creates" if this Story genuinely reintroduces the file.';
  return `"${slug}" → body.${source} declares assumption="${assumption}" for ${path} but the base branch removed that path in commit ${removedInCommit}. The plan is authored against stale documentation, not a mislabelled create, so it is refused rather than normalized.${successor}`;
}

/**
 * @param {{ slug: string, source: string, path: string, assumption: string }} normalization
 * @returns {string}
 */
function renderNormalization({ slug, source, path, assumption }) {
  return `"${slug}" → body.${source} declares assumption="${assumption}" for ${path} but the path is untracked at the base branch — auto-normalized to "creates" (a refactor of a base-untracked path is deterministically a create). Declare assumption="creates" in the plan to silence this warning.`;
}

/**
 * Index which Stories `creates` / `deletes` each path. Only `changes`
 * entries count; `references` are reads and never mutate the tree.
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
 * Validate every Story's file assumptions against the simulated
 * post-predecessor tree. `errors` holds refusals (`deletes` on an absent
 * path, legacy string bullets); `warnings` every other mismatch plus
 * normalization notices. Never throws on a probe failure.
 *
 * @param {object}   opts
 * @param {object[]} opts.tickets
 * @param {string}   opts.baseBranchRef
 * @param {Function} [opts.gitRunner]      Existence probe at `baseBranchRef`.
 * @param {Function} [opts.historyRunner]  Returns `{ hadHistory, commit, renamedTo }`.
 * @param {string}   [opts.cwd]
 * @returns {{ errors: string[], warnings: string[], mismatches: Array, normalizations: Array }}
 */
export function validateStoryFileAssumptions(opts) {
  const {
    tickets,
    baseBranchRef,
    gitRunner = defaultGitRunner,
    historyRunner = defaultHistoryRunner,
    cwd,
  } = opts;
  if (!baseBranchRef || typeof baseBranchRef !== 'string') {
    throw new Error(
      'validateStoryFileAssumptions: baseBranchRef is required and must be a string.',
    );
  }
  const stories = (tickets ?? []).filter((t) => t.type === 'story');
  const errors = [];
  const warnings = [];
  const mismatches = [];
  const normalizations = [];
  const probeCache = new Map();
  const historyCache = new Map();
  const probeHistory = (path) =>
    probeRemoval({
      historyRunner,
      baseBranchRef,
      path,
      cwd,
      cache: historyCache,
    });

  const reach = computeStoryReachability(stories);
  const { creators, deleters } = indexPathMutations(stories);

  for (const story of stories) {
    const slug = story.slug ?? story.title ?? '<unknown>';
    const entries = collectStoryAssumptionEntries(story);

    if (entries.length === 0) {
      if (hasLegacyChangeBullets(story)) {
        errors.push(
          `"${slug}" → body.changes uses legacy string bullets without { path, assumption }. Migrate every bullet to object form so Phase 8 can verify file-state assumptions. See Story #2636.`,
        );
      }
      continue;
    }

    if (hasLegacyChangeBullets(story)) {
      errors.push(
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
      // A predecessor create wins over a predecessor delete.
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
        const { kind, finding } = classifyMismatch(mismatch, probeHistory);
        if (kind === 'normalization') {
          normalizations.push(finding);
          warnings.push(renderNormalization(finding));
          continue;
        }
        mismatches.push(finding);
        routeMismatch(finding, { errors, warnings });
        continue;
      }
      // Unordered co-creators: the shared-editor conflict gate owns the
      // resolution; this only cross-references it.
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
          warnings.push(renderMismatch(conflict));
        }
      }
    }
  }
  return { errors, warnings, mismatches, normalizations };
}

/**
 * Only a `deletes` on an absent path is an error; the rest are warnings.
 *
 * @param {object} finding
 * @param {{ errors: string[], warnings: string[] }} channels
 * @returns {void}
 */
function routeMismatch(finding, { errors, warnings }) {
  const channel = finding.assumption === 'deletes' ? errors : warnings;
  channel.push(renderMismatch(finding));
}

/**
 * Decide whether a `normalizedTo: 'creates'` mismatch keeps its rescue: no
 * history keeps it; history ending in a removal becomes a refusal.
 *
 * @param {object} mismatch
 * @param {(path: string) => ({ commit: string|null, renamedTo: string|null }|null)} probeHistory
 * @returns {{ kind: 'error'|'normalization', finding: object }}
 */
function classifyMismatch(mismatch, probeHistory) {
  if (mismatch.normalizedTo !== 'creates') {
    return { kind: 'error', finding: mismatch };
  }
  const removal = probeHistory(mismatch.path);
  if (removal === null) return { kind: 'normalization', finding: mismatch };
  return {
    kind: 'error',
    finding: {
      slug: mismatch.slug,
      source: mismatch.source,
      path: mismatch.path,
      assumption: mismatch.assumption,
      expected: 'present-was-removed',
      actual: 'removed',
      removedInCommit: removal.commit,
      renamedTo: removal.renamedTo,
    },
  };
}

/**
 * Memoized per run (the probe costs two git processes). A throwing runner
 * means "no history" — a probe failure must never manufacture a refusal.
 *
 * @param {{ historyRunner: Function, baseBranchRef: string, path: string, cwd?: string, cache: Map<string, object|null> }} args
 * @returns {{ commit: string|null, renamedTo: string|null }|null}
 */
function probeRemoval({ historyRunner, baseBranchRef, path, cwd, cache }) {
  if (cache.has(path)) return cache.get(path);
  let verdict = null;
  try {
    const report = historyRunner({ baseBranchRef, path, cwd });
    if (report?.hadHistory) {
      verdict = {
        commit: report.commit ?? null,
        renamedTo: report.renamedTo ?? null,
      };
    }
  } catch {
    verdict = null;
  }
  cache.set(path, verdict);
  return verdict;
}

/**
 * First other Story creating `path` with no `depends_on` ordering either
 * way; ordered co-creators fall to the predecessor-create rule.
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
    if (myPredecessors.has(other)) continue;
    if (otherPredecessors.has(slug)) continue;
    return other;
  }
  return null;
}

/**
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
      if (!simulatedExists) {
        // A `changes` refactor of a base-untracked path is deterministically
        // a create. A `references` entry (not authored here) or a tracked
        // path a predecessor deletes stays a genuine mismatch.
        if (source === 'changes' && !baseExists) {
          return {
            slug,
            source,
            path,
            assumption,
            expected: 'creates',
            actual: 'absent',
            normalizedTo: 'creates',
          };
        }
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
    case 'exists':
    case 'deletes':
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
      // Schema already rejects unknown values; fail loud on new enum members.
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

export { FILE_ASSUMPTION_VALUES };

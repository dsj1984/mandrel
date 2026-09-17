import { ValidationError } from '../errors/index.js';
import { normalizeOwnedProvenance } from '../findings/provenance-field.js';
import { detectCycle } from '../Graph.js';
import { gitSpawn } from '../git-utils.js';

import { validateStoryFileAssumptions } from './file-assumptions.js';
import { isExternalDependencyRef } from './plan-persist/external-deps.js';
import {
  assertStoryBodiesParse,
  parseStoryBodyOrThrow,
} from './story-body-gate.js';
import { computeConflictFindings } from './ticket-validator-conflicts.js';

/**
 * Regex matching code-asset paths the freshness gate cares about. The three
 * roots — `.agents/scripts`, `lib`, and `tests` — cover the executable surface
 * the decomposer's tasks legitimately reference. Anchoring on the leading dot
 * for `.agents` and a word boundary for `lib`/`tests` keeps URLs, image paths,
 * and unrelated prose ("library", "testimonial", "established") from being
 * scanned as fictitious file references.
 *
 * The regex is intentionally global + multi-match per body string so a single
 * Task naming several files surfaces every miss in one error.
 */
const FRESHNESS_PATH_RE =
  /(?:^|[\s`([<])(\.agents\/scripts|lib|tests)\/[\w./-]+\.js\b/g;

function collectPathsFromText(text, paths) {
  if (!text || typeof text !== 'string') return;
  // Reset lastIndex on the shared regex literal between calls.
  FRESHNESS_PATH_RE.lastIndex = 0;
  let match = FRESHNESS_PATH_RE.exec(text);
  while (match !== null) {
    // Capture group 1 is the root; full match index 0 includes the leading
    // delimiter — slice it off so the path is a clean repo-relative reference.
    const captured = match[0];
    const rootStart = captured.indexOf(match[1]);
    paths.add(captured.slice(rootStart));
    match = FRESHNESS_PATH_RE.exec(text);
  }
}

function collectTaskPathReferences(task) {
  const paths = new Set();
  const body = task.body;
  if (typeof body === 'string') {
    collectPathsFromText(body, paths);
  } else if (body !== null && typeof body === 'object') {
    if (typeof body.goal === 'string') collectPathsFromText(body.goal, paths);
    for (const arr of [body.changes, body.acceptance, body.verify]) {
      if (!Array.isArray(arr)) continue;
      for (const item of arr) collectPathsFromText(String(item ?? ''), paths);
    }
  }
  // Some planner shapes carry a top-level `acceptance` array even on string
  // bodies — scan it defensively.
  if (Array.isArray(task.acceptance)) {
    for (const item of task.acceptance) {
      collectPathsFromText(String(item ?? ''), paths);
    }
  }
  return paths;
}

/**
 * Collect every code-asset path a Task declares it will *create or modify*
 * via its `body.changes` array. These paths are net-new (or about to be
 * touched) from the planner's perspective, so the freshness gate must
 * accept them even when they're absent from `baseBranchRef`.
 *
 * Three shapes are accepted:
 *
 * 1. **Canonical string body** — the body is a markdown string produced by
 *    `serialize()` from `story-body.js`. Parsed via `parse()` to extract
 *    the structured `changes[]` and `references[]` arrays. This is the
 *    shape emitted by the decomposer after Story #3302.
 * 2. **Legacy string bullets** — `"<path>: <verb> <object>"` inside an
 *    object body's `changes[]`. The regex `FRESHNESS_PATH_RE` picks the
 *    path out of the prose.
 * 3. **Object form** — `{ path: "<path>", assumption: "creates" | ... }`,
 *    introduced by Story #2636 as the canonical declaration shape and
 *    documented in `lib/templates/decomposer-prompts.js`. The path is
 *    trusted verbatim.
 *
 * Only `body.changes` (and `body.references`) is consulted —
 * `body.goal`, `body.acceptance`, and `body.verify` are deliberately
 * excluded so the gate continues to flag a planner that hallucinates a
 * fictitious file in narrative copy without declaring it in the
 * changes/references contract.
 */
function collectTaskChangesPaths(task) {
  const paths = new Set();
  const body = task.body;

  // Story #3302: when the body is a markdown string (canonical serialized
  // form), parse it to extract the structured changes[] / references[]
  // arrays before scanning. Without this, a string body causes the
  // object-form branch below to fall through on every item, leaving the
  // freshness gate blind to declared paths.
  //
  // Story #4541: a parse failure is NOT swallowed here. Swallowing it
  // returned an empty whitelist, so a single malformed `## Changes` entry
  // surfaced downstream as "files do not exist at main" naming the very
  // paths the Story *had* declared — a misdiagnosis that cost two authoring
  // round-trips. `assertStoryBodiesParse` runs before the freshness gate and
  // owns that failure with a named error; the throw here is the same error
  // for any caller that drives `validateAcFreshness` directly.
  if (typeof body === 'string' && body.trim().length > 0) {
    const parsed = parseStoryBodyOrThrow(task);
    for (const arrName of ['changes', 'references']) {
      const arr = parsed[arrName];
      if (!Array.isArray(arr)) continue;
      for (const item of arr) {
        if (typeof item === 'string') {
          collectPathsFromText(item, paths);
        } else if (
          item !== null &&
          typeof item === 'object' &&
          typeof item.path === 'string' &&
          item.path.length > 0
        ) {
          paths.add(item.path);
        }
      }
    }
    return paths;
  }

  if (body === null || typeof body !== 'object') return paths;
  for (const arrName of ['changes', 'references']) {
    const arr = body[arrName];
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      if (typeof item === 'string') {
        collectPathsFromText(item, paths);
      } else if (
        item !== null &&
        typeof item === 'object' &&
        typeof item.path === 'string' &&
        item.path.length > 0
      ) {
        paths.add(item.path);
      }
    }
  }
  return paths;
}

/**
 * Default git probe: returns true when `path` exists at `ref` in the cwd repo.
 * Uses `git cat-file -e <ref>:<path>` which is the standard low-cost existence
 * check (no blob materialisation, no tree walk in node).
 *
 * Callers may inject their own runner with the same `(ref, path) => boolean`
 * signature for unit tests.
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
 * Wrap a `(ref, path) → boolean` git runner in a memoizing closure keyed by
 * `"${baseBranchRef}:${path}"`. The wrapper is created once per
 * `validateAndNormalizeTickets` call and threaded into both
 * `validateAcFreshness` and `validateStoryFileAssumptions` so the two gates
 * share a single probe cache rather than maintaining independent ones.
 *
 * @param {Function} runner - The underlying `({ baseBranchRef, path, cwd }) => boolean` probe.
 * @returns {Function} A memoized probe with the same signature.
 */
function makeMemoizedGitRunner(runner) {
  const cache = new Map();
  return function memoizedGitRunner({ baseBranchRef, path, cwd }) {
    const key = `${baseBranchRef}:${path}`;
    let result = cache.get(key);
    if (result === undefined) {
      result = Boolean(runner({ baseBranchRef, path, cwd }));
      cache.set(key, result);
    }
    return result;
  };
}

/**
 * Check that every code-asset path referenced by a Story body or AC exists at
 * `baseBranchRef`, and report the ones that do not. A missing path usually
 * means the planner named a file it is about to create without declaring it,
 * or a stale reference — worth saying, not worth refusing on: Story #5312
 * demoted this gate from a throw to the **warning list** the dry-run prints,
 * because the paths a goal or acceptance line names are prose the deliverer
 * reads against the real tree, never a contract the validator can hold it to.
 *
 * Only Stories are scanned — they are the implementation unit; the Epic
 * carries narrative copy, not implementation paths.
 *
 * @param {object}   opts
 * @param {object[]} opts.tickets         - Validated ticket hierarchy.
 * @param {string}   opts.baseBranchRef   - Ref to probe (e.g. 'main' or 'origin/main').
 * @param {Function} [opts.gitRunner]     - Probe override (testing seam).
 * @param {string}   [opts.cwd]           - Repo cwd (forwarded to default runner).
 * @returns {string[]} One warning line per missing reference, empty when clean.
 */
export function validateAcFreshness({
  tickets,
  baseBranchRef,
  gitRunner = defaultGitRunner,
  cwd,
}) {
  if (!baseBranchRef || typeof baseBranchRef !== 'string') {
    throw new ValidationError(
      'validateAcFreshness: baseBranchRef is required.',
    );
  }
  const stories = (tickets ?? []).filter((t) => t.type === 'story');
  // Union every Story's `body.changes` paths into an expected-new set. Any
  // path the planner has declared in `changes` is considered intentional
  // (net-new or about-to-be-modified) and the git probe is skipped for it
  // — otherwise the freshness gate would reject the very test/source file
  // a Story is meant to create, even when the Story is well-formed.
  const expectedNewPaths = new Set();
  for (const story of stories) {
    for (const path of collectTaskChangesPaths(story)) {
      expectedNewPaths.add(path);
    }
  }
  const misses = [];
  // Cache per-path probe results — sibling Stories frequently cite the same
  // helper module; avoid re-spawning git for each repeat.
  const probeCache = new Map();
  for (const story of stories) {
    const refs = collectTaskPathReferences(story);
    for (const path of refs) {
      if (expectedNewPaths.has(path)) continue;
      let exists = probeCache.get(path);
      if (exists === undefined) {
        exists = gitRunner({ baseBranchRef, path, cwd });
        probeCache.set(path, exists);
      }
      if (!exists) {
        misses.push({ slug: story.slug ?? '<unknown>', path });
      }
    }
  }
  return misses.map((m) => renderMissLine(m, baseBranchRef));
}

/**
 * Render one missing-path warning with a remediation hint pointing at the
 * Story's `changes[]`. For `tests/**` paths we suggest the explicit
 * "add the test file" verb; for everything else we emit a generic hint
 * since the planner knows whether the path is net-new or a typo.
 */
function renderMissLine({ slug, path }, baseBranchRef) {
  const verb = path.startsWith('tests/') ? 'add test file' : 'create';
  return `Story "${slug}" references ${path}, which does not exist at ${baseBranchRef} — if net-new, declare {"path":"${path}","assumption":"creates"} in changes[] (${verb}); otherwise fix the typo or stale reference.`;
}

/**
 * Validates the generated ticket hierarchy and handles lifting cross-story dependencies.
 *
 * The returned tickets array carries extra non-array properties:
 *   - `findings` — the advisory cross-Story conflict findings.
 *   - `errors`   — human-readable strings, one per hard refusal: a `deletes`
 *     naming a path absent at base (prefixed `File assumption mismatch:`).
 *     The hierarchy/cycle/parse checks continue to throw.
 *   - `warnings` — the demoted footprint probes (Story #5312): a `creates`
 *     or `refactors-existing` mismatch, a goal/acceptance/verify path absent
 *     at base. Listed by the dry-run; the persist proceeds.
 *   - `normalizations` — the `refactors-existing`→`creates` rewrites applied.
 *
 * @param {object[]}                   tickets             - Array of ticket objects parsed from LLM output.
 * @param {object}                     [opts]
 * @param {string}                     [opts.baseBranchRef] - When set, runs the base-branch probes against this ref.
 * @param {Function}                   [opts.gitRunner]     - Optional git probe override.
 * @param {string}                     [opts.cwd]           - Repo cwd (forwarded to the probes).
 * @returns {object[] & { findings: object[], errors: string[], warnings: string[], normalizations: object[] }}
 */
/**
 * Internal helpers extracted from `validateAndNormalizeTickets` so each
 * stage can be unit-tested in isolation and the orchestration method stays
 * at a low cyclomatic complexity. Exported via the `_internal` bundle at
 * the bottom of the module for tests; production callers should keep
 * using `validateAndNormalizeTickets`.
 */

function indexTicketsBySlug(tickets) {
  const ticketBySlug = new Map();
  const stories = [];
  const slugAdjacency = new Map();
  for (const t of tickets) {
    if (t.slug) {
      if (ticketBySlug.has(t.slug)) {
        throw new Error(
          `Cross-Validation Failed: Duplicate slug "${t.slug}" — slugs must be unique across the backlog. Colliding titles: "${ticketBySlug.get(t.slug).title}" and "${t.title}".`,
        );
      }
      ticketBySlug.set(t.slug, t);
    }
    // External `#<id>` refs (Story #5155) name issues already on the tracker,
    // not nodes in this run's graph — they cannot close a cycle back into a
    // Story that does not exist yet, so they are not edges here.
    slugAdjacency.set(
      t.slug,
      (t.depends_on ?? []).filter((d) => !isExternalDependencyRef(d)),
    );
    if (t.type === 'story') stories.push(t);
  }
  return { ticketBySlug, stories, slugAdjacency };
}

/**
 * 2-tier invariant (Story #4041): the decomposer emits Stories only — every
 * ticket in the backlog must be `type: "story"` and at least one must be
 * present. Any other type (the retired `feature`/`task` tiers, or planner
 * hallucinations) HARD-rejects the decomposition.
 */
function assertAllTicketsAreStories({ tickets, stories }) {
  const nonStories = (tickets ?? []).filter((t) => t.type !== 'story');
  if (nonStories.length > 0) {
    const list = nonStories
      .map((t) => `"${t.title}" (${t.slug ?? '<no slug>'}, type: ${t.type})`)
      .join(', ');
    throw new Error(
      `Cross-Validation Failed: ${nonStories.length} ticket(s) are not Stories: ${list}. ` +
        'The 2-tier hierarchy (Epic → Story) admits type "story" only — there is no Feature or Task tier.',
    );
  }
  if (stories.length === 0)
    throw new Error(
      'Cross-Validation Failed: Backlog must contain at least one Story.',
    );
}

/**
 * Return true when a Story carries a non-empty top-level `acceptance[]` —
 * the inline-contract shape (Epic #3078) where the Story is itself the
 * implementation unit and its criteria live on the Story rather than in
 * child Task tickets.
 *
 * Story #5342 narrowed the invariant to `acceptance[]` alone. A Story with
 * no observable criterion is genuinely unimplementable and nothing
 * downstream can recover it; an empty `verify[]` only means the deliverer
 * picks the commands, which the close gate chain runs regardless — so that
 * half is a warning ({@link collectMissingVerifyWarnings}), not a refusal.
 */
function hasInlineAcceptance(story) {
  if (story === null || typeof story !== 'object') return false;
  const { acceptance } = story;
  return Array.isArray(acceptance) && acceptance.length > 0;
}

function assertEveryStoryHasInlineContract({ stories }) {
  const missing = stories.filter((s) => !hasInlineAcceptance(s));
  if (missing.length === 0) return;
  const list = missing.map((s) => `"${s.title}" (${s.slug})`).join(', ');
  throw new Error(
    `Cross-Validation Failed: ${missing.length} Story/Stories lack an inline acceptance contract: ${list}. Every Story must carry a non-empty top-level acceptance[] — the outcomes a PR reviewer confirms once it lands.`,
  );
}

/**
 * One warning per Story with no `verify[]` entry (Story #5342).
 *
 * Demoted from the hard refusal above: an absent verify list costs the
 * acceptance critic its cheapest evidence, which is worth saying on the
 * dry-run, but it never makes the Story unimplementable — the deliverer
 * derives the commands and the close gate chain runs either way.
 *
 * @param {object[]} stories
 * @returns {string[]}
 */
function collectMissingVerifyWarnings(stories) {
  return (stories ?? [])
    .filter((s) => !Array.isArray(s?.verify) || s.verify.length === 0)
    .map(
      (s) =>
        `Story "${s.slug ?? s.title ?? '<unknown>'}" lists no verify[] entry — ` +
        'the deliverer and the acceptance critic have no mechanical check to ' +
        'read as evidence. Add the exact command or test path unless the ' +
        'Story genuinely has none.',
    );
}

/**
 * Shape-check the optional per-Story `provenance` field (Story #5045).
 *
 * The field decides which audit identities persist stamps into a Story body,
 * so a malformed entry has to fail at the validator rather than at the
 * stamper: by the time assembly runs, an unnoticed drop is indistinguishable
 * from a Story that legitimately owns nothing — and the cost lands a whole
 * sweep later, when the next audit re-files work this plan already tracked.
 *
 * Absence is valid and common: a Story with no `provenance` inherits the
 * whole-seed union carry, which is the recall-safe default.
 *
 * Errors are batched across the backlog so one pass names every offender.
 *
 * @param {{ stories: object[] }} args
 * @throws {Error} naming each malformed field.
 */
function assertStoryProvenanceShape({ stories }) {
  const violations = [];
  for (const story of stories) {
    try {
      normalizeOwnedProvenance(story?.provenance, story?.slug ?? '<unknown>');
    } catch (err) {
      violations.push(`  - ${err.message}`);
    }
  }
  if (violations.length === 0) return;
  throw new Error(
    `Cross-Validation Failed: ${violations.length} Story provenance field(s) ` +
      `are malformed:\n${violations.join('\n')}\n\nAuthor provenance as ` +
      '{ "fingerprints": ["<40-char sha1>"], "semanticKeys": ["<area␟path>"] }, ' +
      'or omit it entirely to inherit the seed-wide union.',
  );
}

function assertNoUnknownDeps({ tickets, ticketBySlug }) {
  const unknownDeps = [];
  for (const t of tickets) {
    for (const depSlug of t.depends_on ?? []) {
      // An external `#<id>` ref is resolved against the tracker at persist
      // (`assertExternalDependenciesResolvable`), never against this backlog.
      if (isExternalDependencyRef(depSlug)) continue;
      if (!ticketBySlug.has(depSlug)) {
        unknownDeps.push({ slug: t.slug, title: t.title, dep: depSlug });
      }
    }
  }
  if (unknownDeps.length === 0) return;
  const list = unknownDeps
    .map((u) => `"${u.title}" (${u.slug}) → "${u.dep}"`)
    .join(', ');
  throw new Error(
    `Cross-Validation Failed: ${unknownDeps.length} depends_on reference(s) use unknown slugs: ${list}. Every slug in depends_on must match a slug present in the backlog.`,
  );
}

function assertAcyclic(slugAdjacency) {
  const cycle = detectCycle(slugAdjacency);
  if (cycle) {
    throw new Error(
      `Cross-Validation Failed: Circular dependency detected: ${cycle.join(' → ')}.`,
    );
  }
}

function attachFindingsAndErrors(
  tickets,
  { findings, errors, warnings, normalizations },
) {
  for (const [key, value] of [
    ['findings', findings],
    ['errors', errors],
    ['warnings', warnings],
    // Story #5265: the auto-normalizations the assumption gate applied. They
    // used to end at a `Logger.warn` and die with the process, so persist's
    // emitted result reported a plan whose declarations it had silently
    // rewritten as if nothing had been rewritten.
    ['normalizations', normalizations],
  ]) {
    Object.defineProperty(tickets, key, {
      value,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
}

export function validateAndNormalizeTickets(tickets, opts = {}) {
  const { ticketBySlug, stories, slugAdjacency } = indexTicketsBySlug(tickets);

  assertAllTicketsAreStories({ tickets, stories });
  assertEveryStoryHasInlineContract({ stories });
  assertStoryProvenanceShape({ stories });
  assertNoUnknownDeps({ tickets, ticketBySlug });

  assertAcyclic(slugAdjacency);

  // Story #4541 — refuse an unparseable Story body up front, with a named
  // error pointing at the offending section + entry. Must precede the
  // freshness gate: it parses the body, and its net-new whitelist comes from
  // `body.changes`, so a malformed body used to surface as a stale-path miss
  // naming the paths the Story had legitimately declared.
  assertStoryBodiesParse({ tickets });

  // Hoist a single memoized (ref, path) → boolean probe shared across both
  // git-probe gates below. Without this, `validateAcFreshness` and
  // `validateStoryFileAssumptions` each maintain an independent cache, so a
  // path that appears in both the AC-freshness scan and the file-assumption
  // scan spawns two `git cat-file` processes. The memoizing wrapper captures
  // results by `"${baseBranchRef}:${path}"` key so the second gate reuses
  // the first's results without any additional git I/O.
  const sharedGitRunner = opts.baseBranchRef
    ? makeMemoizedGitRunner(opts.gitRunner ?? defaultGitRunner)
    : null;

  const warnings = [...collectMissingVerifyWarnings(stories)];
  // Story #5312: a goal / acceptance / verify path absent at base is a
  // warning the dry-run lists, not a refusal. Skipped when the caller omits
  // `baseBranchRef` so unit tests keep their semantics; production
  // call-sites always pass it.
  if (opts.baseBranchRef) {
    warnings.push(
      ...validateAcFreshness({
        tickets,
        baseBranchRef: opts.baseBranchRef,
        gitRunner: sharedGitRunner,
        cwd: opts.cwd,
      }),
    );
  }

  // Story #2636 — Phase 8 path-assumption gate. Cross-check every Story's
  // declared `{ path, assumption }` against the actual state of the base
  // branch. A `deletes` on an absent path batches into the validator's
  // errors envelope; every other mismatch is a warning (Story #5312).
  let assumptionErrors = [];
  let assumptionNormalizations = [];
  if (opts.baseBranchRef) {
    const assumptionReport = validateStoryFileAssumptions({
      tickets,
      baseBranchRef: opts.baseBranchRef,
      gitRunner: sharedGitRunner,
      cwd: opts.cwd,
    });
    warnings.push(...assumptionReport.warnings);
    assumptionErrors = assumptionReport.errors;
    assumptionNormalizations = assumptionReport.normalizations ?? [];
  }

  // Cross-Story path-conflict pass observes the story-level depends_on
  // graph. Every finding is advisory; the persist surfaces them and the
  // plan summary renders the shared-editor class beside the wave table.
  const findings = computeConflictFindings({ stories });
  const errors = assumptionErrors.map((e) => `File assumption mismatch: ${e}`);

  attachFindingsAndErrors(tickets, {
    findings,
    errors,
    warnings,
    normalizations: assumptionNormalizations,
  });
  return tickets;
}

// Internal helpers exposed for unit tests; not part of the public surface.
export const _internal = {
  assertStoryBodiesParse,
  indexTicketsBySlug,
  assertAllTicketsAreStories,
  assertEveryStoryHasInlineContract,
  assertStoryProvenanceShape,
  assertNoUnknownDeps,
  assertAcyclic,
  attachFindingsAndErrors,
  hasInlineAcceptance,
  collectMissingVerifyWarnings,
};

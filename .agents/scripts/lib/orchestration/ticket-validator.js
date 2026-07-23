import { ValidationError } from '../errors/index.js';
import { detectCycle } from '../Graph.js';
import { gitSpawn } from '../git-utils.js';

import { Logger } from '../Logger.js';
import { validateStoryFileAssumptions } from './file-assumptions.js';
import { computeSpecBudgetFindings } from './spec-budget.js';
import {
  assertStoryBodiesParse,
  parseStoryBodyOrThrow,
} from './story-body-gate.js';
import {
  computeConflictFindings,
  renderHardConflictError,
} from './ticket-validator-conflicts.js';
import {
  computeSizingFindings,
  renderHardFindingError,
} from './ticket-validator-sizing.js';

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

/**
 * Resolve every acceptance line a Story declares, across both authoring
 * shapes (Story #4541).
 *
 * The canonical shape is a **serialized string body** with the criteria at
 * the ticket's **top level** — the machine contract persist syncs into the
 * body. `validateAcceptanceSubjectPrefix` used to read `body.acceptance` on
 * an object body only, so on every real plan it scanned nothing and the gate
 * silently passed. Union both sources (deduplicated) so the gate fires on
 * whichever surface the author used.
 *
 * @param {object} story
 * @returns {string[]}
 */
function resolveAcceptanceLines(story) {
  const lines = new Set();
  if (Array.isArray(story?.acceptance)) {
    for (const item of story.acceptance) lines.add(String(item ?? ''));
  }
  const body = story?.body;
  let bodyAcceptance = null;
  if (typeof body === 'string' && body.trim().length > 0) {
    bodyAcceptance = parseStoryBodyOrThrow(story).acceptance;
  } else if (body !== null && typeof body === 'object') {
    bodyAcceptance = body.acceptance;
  }
  if (Array.isArray(bodyAcceptance)) {
    for (const item of bodyAcceptance) lines.add(String(item ?? ''));
  }
  return [...lines];
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
 * Verify that every code-asset path referenced by a Task body or AC exists at
 * `baseBranchRef`. A missing path means the planner LLM hallucinated (or the
 * path was deleted between planning and decomposition) — refuse to decompose
 * because the resulting Task would be unimplementable as written.
 *
 * Only Stories are scanned — they are the implementation unit; the Epic
 * carries narrative copy, not implementation paths.
 *
 * @param {object}   opts
 * @param {object[]} opts.tickets         - Validated ticket hierarchy.
 * @param {string}   opts.baseBranchRef   - Ref to probe (e.g. 'main' or 'origin/main').
 * @param {Function} [opts.gitRunner]     - Probe override (testing seam).
 * @param {string}   [opts.cwd]           - Repo cwd (forwarded to default runner).
 * @throws {ValidationError} when one or more Story references are stale.
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
  if (misses.length === 0) return;
  const lines = misses.map((m) => renderMissLine(m)).join('\n');
  throw new ValidationError(
    `Cross-Validation Failed: ${misses.length} Story reference(s) name files that do not exist at ${baseBranchRef}:\n${lines}\n\nEither declare the path in body.changes (signals net-new) or correct the reference.`,
    { misses, baseBranchRef },
  );
}

/**
 * Allowed leading Conventional-Commits types. Mirrors the `changelog-sections`
 * keys in `release-please-config.json` and the `type-enum` list in
 * `commitlint.config.js`. When a planner LLM prescribes a commit subject in a
 * Task acceptance item via the "Commit subject begins with '<prefix>:'" form,
 * the captured prefix must reduce to one of these types (optionally followed
 * by a `(scope)` qualifier) — anything else fails commitlint locally and
 * release-please's changelog parser on `main`, so the decompose is rejected
 * before the Story branch is ever cut.
 *
 * Epic #2501 introduced this guard after the legacy `baseline-refresh`
 * leading-token prescription created a wave of commit-msg hook failures
 * across story-deliver sub-agents. See
 * `.agents/skills/core/gates-and-baselines/SKILL.md` for the canonical refresh
 * shape (Conventional-Commits subject + `baseline-refresh: true` body
 * trailer).
 */
const ALLOWED_COMMIT_TYPES = new Set([
  'feat',
  'fix',
  'chore',
  'refactor',
  'perf',
  'docs',
  'style',
  'test',
  'build',
  'ci',
  'revert',
]);

/**
 * Regex matching the canonical "Commit subject begins with '<prefix>:'"
 * prescription shape the planner emits in `body.acceptance[]` entries.
 * The leading quote is captured loosely (single, double, or backtick) so the
 * three quoting styles the decomposer LLM has historically emitted all
 * match. The captured group is the prefix token *without* the trailing
 * colon — callers normalize by stripping an optional `(scope)` qualifier
 * before comparing against the allowed-types set.
 */
const SUBJECT_PREFIX_RE = /Commit subject begins with ['"`]([^'"`]+):['"`]/g;

/**
 * Scan every Story's `body.acceptance[]` for "Commit subject begins with
 * '<prefix>:'" prescriptions and reject the decompose when any captured
 * prefix is not a valid Conventional-Commits type.
 *
 * A captured prefix of the form `chore(baselines)` is accepted — the
 * leading `chore` is in the allowed-types set, and the `(scope)` qualifier
 * is the standard Conventional-Commits scope shape. A captured prefix of
 * the form `baseline-refresh` is rejected because no Conventional-Commits
 * type starts with that token.
 *
 * Only acceptance criteria are scanned; `body.goal` / `body.verify` /
 * `body.changes` are not commit-subject prescriptions by convention and
 * scanning them would surface false positives from prose that happens to
 * quote a forbidden prefix while explaining why it's forbidden.
 *
 * Both authoring shapes are covered (Story #4541): the canonical top-level
 * `acceptance[]` on a serialized string body, and the pre-serialize
 * `body.acceptance[]` object shape. Scanning only the latter made the gate
 * inert on every real plan.
 *
 * @param {object}   opts
 * @param {object[]} opts.tickets - Validated ticket hierarchy.
 * @throws {ValidationError} when one or more Story acceptance items
 *   prescribe a forbidden subject prefix. The error carries
 *   `code: 'forbidden-subject-prefix'` and a `violations[]` payload
 *   listing each `{ slug, prefix, line }` so the decompose loop can
 *   surface the exact offending text to the operator.
 */
export function validateAcceptanceSubjectPrefix({ tickets }) {
  const violations = [];
  const stories = (tickets ?? []).filter((t) => t.type === 'story');
  for (const story of stories) {
    for (const line of resolveAcceptanceLines(story)) {
      // Reset the global regex between iterations.
      SUBJECT_PREFIX_RE.lastIndex = 0;
      let match = SUBJECT_PREFIX_RE.exec(line);
      while (match !== null) {
        const rawPrefix = match[1];
        // Strip an optional `(scope)` qualifier — `chore(baselines)` reduces
        // to `chore` for the allowed-types check.
        const type = rawPrefix.replace(/\(.*\)$/, '').trim();
        if (!ALLOWED_COMMIT_TYPES.has(type)) {
          violations.push({
            slug: story.slug ?? '<unknown>',
            prefix: rawPrefix,
            line,
          });
        }
        match = SUBJECT_PREFIX_RE.exec(line);
      }
    }
  }
  if (violations.length === 0) return;
  const allowed = [...ALLOWED_COMMIT_TYPES].join('|');
  const lines = violations
    .map(
      (v) =>
        `  - "${v.slug}" → forbidden subject prefix "${v.prefix}:" in acceptance item: ${v.line}`,
    )
    .join('\n');
  const err = new ValidationError(
    `Cross-Validation Failed: ${violations.length} Story acceptance item(s) prescribe a non-Conventional-Commits subject prefix:\n${lines}\n\nAllowed leading types: ${allowed}. Use a Conventional-Commits subject (e.g. "chore(baselines): refresh ...") and a body trailer (e.g. "baseline-refresh: true") for machine-readable markers. See Epic #2501.`,
    { violations },
  );
  err.code = 'forbidden-subject-prefix';
  throw err;
}

/**
 * Render one missing-path line with a remediation hint pointing at the
 * task's `body.changes`. For `tests/**` paths we suggest the explicit
 * "add the test file" verb; for everything else we emit a generic hint
 * since the planner knows whether the path is net-new or a typo.
 */
function renderMissLine({ slug, path }) {
  const verb = path.startsWith('tests/') ? 'add test file' : 'create';
  return `  - "${slug}" → ${path}\n      hint: if net-new, add '${path}: ${verb}' to body.changes; otherwise fix the typo or stale reference against current main.`;
}

/**
 * Validates the generated ticket hierarchy and handles lifting cross-story dependencies.
 *
 * The returned tickets array carries two extra non-array properties:
 *   - `findings` — structured sizing findings (hard + soft) keyed by the
 *     three-layer sizing model. The bounded re-decomposition loop in
 *     `/plan` reads `findings.filter(f => f.severity === 'hard')` to decide
 *     whether to re-prompt.
 *   - `errors`   — human-readable strings, one per hard finding. Non-empty
 *     `errors[]` is the AC-visible "block normalization" signal; the legacy
 *     hierarchy/cycle/freshness checks continue to throw, so callers that
 *     only inspect the array shape are unaffected when no sizing
 *     violations occur.
 *
 * @param {object[]}                   tickets             - Array of ticket objects parsed from LLM output.
 * @param {object}                     [opts]
 * @param {string}                     [opts.baseBranchRef] - When set, runs `validateAcFreshness` against this ref.
 * @param {Function}                   [opts.gitRunner]     - Optional git probe override.
 * @param {string}                     [opts.cwd]           - Repo cwd (forwarded to the freshness gate).
 * @param {object}                     [opts.modelCapacity] - Programmatic override of `DEFAULT_MODEL_CAPACITY` (tests only — not read from `.agentrc.json`).
 * @param {object}                     [opts.conflictPolicy] - Severity controls for cross-Story conflict findings.
 * @param {boolean}                    [opts.conflictPolicy.failOnSharedEditors=false]          - Upgrade `shared-editor` findings to `hard`.
 * @param {boolean}                    [opts.conflictPolicy.requireExplicitCrossStoryDeps=false] - Upgrade `implicit-cross-story-dep` findings to `hard`.
 * @returns {object[] & { findings: object[], errors: string[] }} Validated tickets with normalized dependencies and attached sizing + conflict findings.
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
    slugAdjacency.set(t.slug, t.depends_on ?? []);
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
 * Return true when a Story object carries inline acceptance + verify
 * arrays — the inline-contract shape (Epic #3078) where the Story is itself the
 * implementation unit and acceptance / verify live on the Story body
 * rather than in child Task tickets.
 *
 * Both arrays must be present, be actual arrays, and contain at least
 * one entry. Either alone is insufficient — a Story with only
 * `acceptance[]` (no `verify[]`) cannot be implemented without a
 * verification handle, and a Story with only `verify[]` (no
 * `acceptance[]`) carries no observable criterion. Requiring both is the
 * inline-contract invariant every Story must satisfy.
 */
function hasInlineAcceptanceAndVerify(story) {
  if (story === null || typeof story !== 'object') return false;
  const { acceptance, verify } = story;
  return (
    Array.isArray(acceptance) &&
    acceptance.length > 0 &&
    Array.isArray(verify) &&
    verify.length > 0
  );
}

function assertEveryStoryHasInlineContract({ stories }) {
  // Every Story is its own implementation
  // unit and MUST carry a non-empty inline contract — top-level
  // `acceptance[]` AND `verify[]`. A Story missing either is the legacy
  // 4-tier shape that expected child Tasks; there is no Task tier any
  // more, so such a Story is unimplementable and the decompose is
  // rejected outright.
  const missing = stories.filter((s) => !hasInlineAcceptanceAndVerify(s));
  if (missing.length === 0) return;
  const list = missing.map((s) => `"${s.title}" (${s.slug})`).join(', ');
  throw new Error(
    `Cross-Validation Failed: ${missing.length} Story/Stories lack an inline acceptance + verify contract: ${list}. Every Story must carry non-empty top-level acceptance[] and verify[].`,
  );
}

function assertNoUnknownDeps({ tickets, ticketBySlug }) {
  const unknownDeps = [];
  for (const t of tickets) {
    for (const depSlug of t.depends_on ?? []) {
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

function attachFindingsAndErrors(tickets, findings, errors) {
  Object.defineProperty(tickets, 'findings', {
    value: findings,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(tickets, 'errors', {
    value: errors,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}

export function validateAndNormalizeTickets(tickets, opts = {}) {
  const { ticketBySlug, stories, slugAdjacency } = indexTicketsBySlug(tickets);

  assertAllTicketsAreStories({ tickets, stories });
  assertEveryStoryHasInlineContract({ stories });
  assertNoUnknownDeps({ tickets, ticketBySlug });

  assertAcyclic(slugAdjacency);

  // Story #4541 — refuse an unparseable Story body up front, with a named
  // error pointing at the offending section + entry. Must precede both the
  // subject-prefix scan and the freshness gate: each parses the body, and
  // the freshness gate's net-new whitelist comes from `body.changes`, so a
  // malformed body used to surface as a stale-path miss naming the paths the
  // Story had legitimately declared.
  assertStoryBodiesParse({ tickets });

  // Reject any Task acceptance item that prescribes a non-Conventional-Commits
  // subject prefix (e.g. legacy "Commit subject begins with 'baseline-refresh:'"
  // from pre-Epic-#2501 planner output). Runs before the freshness gate so
  // the failure mode is reported up-front rather than after a git probe.
  validateAcceptanceSubjectPrefix({ tickets });

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

  // Refuse to decompose when any Task body or AC names a code-asset path
  // missing from the Epic's base branch tree. Skipped when the caller
  // omits `baseBranchRef` so legacy unit tests keep their existing
  // semantics; production call-sites always pass it.
  if (opts.baseBranchRef) {
    validateAcFreshness({
      tickets,
      baseBranchRef: opts.baseBranchRef,
      gitRunner: sharedGitRunner,
      cwd: opts.cwd,
    });
  }

  // Story #2636 — Phase 8 path-assumption gate. Cross-check every Story's
  // declared `{ path, assumption }` against the actual state of the base
  // branch and batch the mismatches per-Story into the validator's errors
  // envelope. Skipped when the caller omits `baseBranchRef` so legacy
  // unit tests keep their semantics; production call-sites always pass
  // it.
  let assumptionErrors = [];
  if (opts.baseBranchRef) {
    const assumptionReport = validateStoryFileAssumptions({
      tickets,
      baseBranchRef: opts.baseBranchRef,
      gitRunner: sharedGitRunner,
      cwd: opts.cwd,
    });
    // Auto-normalizations (#4496 fix 5) get their own prefix so the logged
    // warning is self-explanatory; everything else on the warnings channel
    // is a legacy-shape deprecation nudge.
    const normalizationWarnings = new Set(
      (assumptionReport.normalizations ?? []).map((n) => n.path),
    );
    for (const warning of assumptionReport.warnings) {
      const isNormalization = warning.includes('auto-normalized to "creates"');
      Logger.warn(
        `[ticket-validator] ${isNormalization ? 'assumption-normalized' : 'assumption-deprecation'}: ${warning}`,
      );
    }
    if (normalizationWarnings.size > 0) {
      Logger.warn(
        `[ticket-validator] ${normalizationWarnings.size} refactors-existing ` +
          'declaration(s) on base-untracked path(s) auto-normalized to ' +
          '"creates" — the gate proceeds; update the plan declarations at ' +
          'the next amend.',
      );
    }
    assumptionErrors = assumptionReport.errors;
  }

  const sizingFindings = computeSizingFindings({
    stories,
    capacity: opts.modelCapacity,
  });
  // Cross-Story path-conflict pass observes the story-level depends_on
  // graph. Findings are appended to the same `findings` array consumed by
  // the decompose-loop's hard-finding gate; severity is controlled by
  // `opts.conflictPolicy`.
  const conflictFindings = computeConflictFindings({
    stories,
    policy: opts.conflictPolicy,
  });
  // Advisory `## Spec` word-budget pass (Story #4723) — soft findings only,
  // surfaced as warnings here and via the persist soft-finding channel;
  // never promoted to `errors[]`, so an over-budget Spec cannot fail the
  // persist. Runs after `assertStoryBodiesParse`, so string bodies parse.
  const specBudgetFindings = computeSpecBudgetFindings({ stories });
  for (const finding of specBudgetFindings) {
    Logger.warn(`[ticket-validator] spec-word-budget: ${finding.message}`);
  }
  const findings = [
    ...sizingFindings,
    ...conflictFindings,
    ...specBudgetFindings,
  ];
  const CONFLICT_KINDS = new Set([
    'shared-editor',
    'implicit-cross-story-dep',
    'cross-cutting-registries',
    'fan-out-warning',
    'missing-bdd-scaffold',
  ]);
  const errors = findings
    .filter((f) => f.severity === 'hard')
    .map((f) =>
      CONFLICT_KINDS.has(f.kind)
        ? renderHardConflictError(f)
        : renderHardFindingError(f),
    );
  // Append per-Story path-assumption mismatches (Story #2636) to the
  // hard-error list. The decompose loop already gates on
  // `errors.length > 0` to trigger a re-prompt, so the new check
  // participates in the same loop without bespoke wiring.
  for (const e of assumptionErrors) {
    errors.push(`File assumption mismatch: ${e}`);
  }

  attachFindingsAndErrors(tickets, findings, errors);
  return tickets;
}

// Internal helpers exposed for unit tests; not part of the public surface.
export const _internal = {
  assertStoryBodiesParse,
  indexTicketsBySlug,
  assertAllTicketsAreStories,
  assertEveryStoryHasInlineContract,
  assertNoUnknownDeps,
  assertAcyclic,
  attachFindingsAndErrors,
  hasInlineAcceptanceAndVerify,
};

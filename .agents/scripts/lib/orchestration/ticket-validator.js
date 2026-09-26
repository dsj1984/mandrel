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
 * Code-asset paths under `.agents/scripts`, `lib`, `tests`. The leading
 * delimiter keeps URLs and prose ("library") out. Global: every miss surfaces.
 */
const FRESHNESS_PATH_RE =
  /(?:^|[\s`([<])(\.agents\/scripts|lib|tests)\/[\w./-]+\.js\b/g;

function collectPathsFromText(text, paths) {
  if (!text || typeof text !== 'string') return;
  FRESHNESS_PATH_RE.lastIndex = 0;
  let match = FRESHNESS_PATH_RE.exec(text);
  while (match !== null) {
    // Slice off the leading delimiter the match includes.
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
  // Some planner shapes carry top-level `acceptance` even on string bodies.
  if (Array.isArray(task.acceptance)) {
    for (const item of task.acceptance) {
      collectPathsFromText(String(item ?? ''), paths);
    }
  }
  return paths;
}

/**
 * Paths a Story declares in `changes[]` / `references[]` — exempt from the
 * freshness probe since they may be net-new. Accepts a serialized markdown
 * body, string bullets, or `{ path, assumption }` objects. Goal / acceptance
 * / verify are deliberately excluded so undeclared narrative paths still flag.
 */
function collectTaskChangesPaths(task) {
  const paths = new Set();
  const source = resolveChangesSource(task);
  if (source === null) return paths;
  for (const arrName of ['changes', 'references']) {
    const arr = source[arrName];
    if (!Array.isArray(arr)) continue;
    for (const item of arr) collectChangesItem(item, paths);
  }
  return paths;
}

function resolveChangesSource(task) {
  const body = task.body;
  // A parse failure throws rather than yielding an empty whitelist, which
  // would misreport every declared path as missing.
  if (typeof body === 'string' && body.trim().length > 0) {
    return parseStoryBodyOrThrow(task);
  }
  return body !== null && typeof body === 'object' ? body : null;
}

function collectChangesItem(item, paths) {
  if (typeof item === 'string') {
    collectPathsFromText(item, paths);
  } else if (typeof item?.path === 'string' && item.path.length > 0) {
    paths.add(item.path);
  }
}

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
 * One cache shared by the freshness and file-assumption gates.
 *
 * @param {Function} runner - `({ baseBranchRef, path, cwd }) => boolean`.
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
 * Warn (never refuse) on Story-referenced code paths absent at the base:
 * narrative paths are prose, not a contract the validator can enforce.
 *
 * @param {object}   opts
 * @param {object[]} opts.tickets
 * @param {string}   opts.baseBranchRef
 * @param {Function} [opts.gitRunner]
 * @param {string}   [opts.cwd]
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
  // Declared paths (any Story) are intentional and skip the probe.
  const expectedNewPaths = new Set();
  for (const story of stories) {
    for (const path of collectTaskChangesPaths(story)) {
      expectedNewPaths.add(path);
    }
  }
  const misses = [];
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

function renderMissLine({ slug, path }, baseBranchRef) {
  const verb = path.startsWith('tests/') ? 'add test file' : 'create';
  return `Story "${slug}" references ${path}, which does not exist at ${baseBranchRef} — if net-new, declare {"path":"${path}","assumption":"creates"} in changes[] (${verb}); otherwise fix the typo or stale reference.`;
}

/**
 * Hierarchy, cycle and parse checks throw. The returned array also carries
 * non-enumerable `findings` (advisory conflicts), `errors` (a `deletes` of a
 * path absent at base), `warnings` (demoted footprint probes) and
 * `normalizations` (`refactors-existing`→`creates` rewrites).
 *
 * @param {object[]}                   tickets
 * @param {object}                     [opts]
 * @param {string}                     [opts.baseBranchRef] - Enables the base-branch probes.
 * @param {Function}                   [opts.gitRunner]
 * @param {string}                     [opts.cwd]
 * @returns {object[] & { findings: object[], errors: string[], warnings: string[], normalizations: object[] }}
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
    // External `#<id>` refs are tracker issues, not graph nodes — no cycle.
    slugAdjacency.set(
      t.slug,
      (t.depends_on ?? []).filter((d) => !isExternalDependencyRef(d)),
    );
    if (t.type === 'story') stories.push(t);
  }
  return { ticketBySlug, stories, slugAdjacency };
}

/** Every ticket must be `type: "story"`, and at least one must exist. */
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
 * Only `acceptance[]` is required: a Story with no criterion is
 * unimplementable, while an empty `verify[]` is merely a warning.
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
 * Fail malformed `provenance` here: at the stamper a silent drop looks like a
 * Story owning nothing. Absent is valid (inherits the seed-wide union).
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
      // External refs resolve against the tracker at persist.
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

  // Must precede the freshness gate, whose whitelist comes from the parsed
  // body — a malformed body would otherwise read as stale paths.
  assertStoryBodiesParse({ tickets });

  const sharedGitRunner = opts.baseBranchRef
    ? makeMemoizedGitRunner(opts.gitRunner ?? defaultGitRunner)
    : null;

  const warnings = [...collectMissingVerifyWarnings(stories)];
  // Base probes run only with `baseBranchRef` (production always passes it).
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

  // Only a `deletes` of an absent path is an error; other mismatches warn.
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

  // Conflict findings are advisory.
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

/**
 * Flat Story creation for plan-persist. Each Story body is the single
 * executable document: the Spec stays inline at any length, and top-level
 * `acceptance[]` / `verify[]` (the machine contract) are synced into it.
 *
 * @module lib/orchestration/plan-persist/story-ops
 */

import { createHash } from 'node:crypto';
import { applyBlockedByDependencies } from '../../../providers/github/blocked-by-add.js';
import {
  normalizeOwnedProvenance,
  ownedProvenanceSource,
} from '../../findings/provenance-field.js';
import { carryProvenanceFooters } from '../../findings/route-finding.js';
import { describeGhFailure } from '../../gh-exec.js';
import { Logger } from '../../Logger.js';
import { AGENT_LABELS, TYPE_LABELS } from '../../label-constants.js';
import {
  parse as parseStoryBody,
  serialize as serializeStoryBody,
} from '../../story-body/story-body.js';
import {
  concurrentMap,
  FANOUT_CONCURRENCY,
} from '../../util/concurrent-map.js';
import {
  externalDependencyId,
  isExternalDependencyRef,
} from './external-deps.js';
import {
  normalizeSupersedes,
  resolveSupersedePartition,
} from './supersede-ops.js';

/**
 * Label prefix grouping the Stories one plan-persist run authored. Metadata
 * only: delivery never reads it as an ordering input.
 */
export const PLAN_RUN_LABEL_PREFIX = 'plan-run::';

const PLAN_RUN_LABEL_COLOR = '#C5DEF5';

const PLAN_RUN_ID_LENGTH = 8;

/**
 * @param {string} id
 * @returns {string}
 */
export function normalizePlanRunId(id) {
  const token = String(id ?? '')
    .trim()
    .toLowerCase()
    .replace(/^plan-run::/, '')
    .replace(/[^a-z0-9._-]+/g, '-');
  if (!token) {
    throw new Error('plan-run id requires a non-empty planRunId');
  }
  return token;
}

/**
 * Never mints a random token — that would split a resumed persist's cohort
 * across two labels; derive the id via {@link derivePlanRunId}.
 *
 * @param {string} id
 * @returns {string}
 */
export function planRunLabel(id) {
  return `${PLAN_RUN_LABEL_PREFIX}${normalizePlanRunId(id)}`;
}

/**
 * Hash of the sorted per-Story fingerprints, so a resumed persist derives the
 * same label its adopted Stories already carry, independent of creation order.
 *
 * @param {string[]} fingerprints
 * @returns {string}
 */
export function derivePlanRunId(fingerprints) {
  const sorted = (Array.isArray(fingerprints) ? fingerprints : [])
    .map(String)
    .sort();
  return createHash('sha256')
    .update(sorted.join(' '))
    .digest('hex')
    .slice(0, PLAN_RUN_ID_LENGTH);
}

/**
 * Marker prefix stamped into every created body; the resume path adopts an
 * open Story whose marker matches.
 */
const PLAN_FINGERPRINT_MARKER_PREFIX = 'plan-story:';

const PLAN_FINGERPRINT_LENGTH = 16;

/**
 * Content identity of one authored Story: slug + title + the *assembled* body
 * (whose `depends_on` are still slugs, so it is stable across a run and its
 * resume). A hit means the open Story is byte-identical to what this run
 * would author; a reused slug/title or an edited `stories.json` misses and
 * gets a fresh Story instead of a stale adoption.
 *
 * The fields are joined on NUL separators, written as the `\u0000` escape and
 * never as a raw byte — a literal NUL would make git classify this file as
 * binary and silently drop its diffs. NUL cannot occur in any field, so the
 * join is unambiguous.
 *
 * @param {{ slug: string, title: string, body?: string }} story
 * @returns {string}
 */
export function planStoryFingerprint({ slug, title, body = '' }) {
  return createHash('sha256')
    .update(`${slug}\u0000${title}\u0000${body}`)
    .digest('hex')
    .slice(0, PLAN_FINGERPRINT_LENGTH);
}

/**
 * @param {string} fingerprint
 * @returns {string}
 */
function planFingerprintMarker(fingerprint) {
  return `<!-- ${PLAN_FINGERPRINT_MARKER_PREFIX} ${fingerprint} -->`;
}

const PLAN_FINGERPRINT_MARKER_RE = new RegExp(
  `<!--\\s*${PLAN_FINGERPRINT_MARKER_PREFIX}\\s*([0-9a-f]+)\\s*-->`,
);

/**
 * The single marker reader, shared by the resume index and the create-retry
 * probe so they never disagree on "already created".
 *
 * @param {unknown} body
 * @returns {string|null}
 */
function extractPlanFingerprint(body) {
  if (typeof body !== 'string') return null;
  const match = body.match(PLAN_FINGERPRINT_MARKER_RE);
  return match ? match[1] : null;
}

/**
 * Label axes the runtime owns (lifecycle, type, cohort) or has retired
 * (persona, route); authored entries on them are dropped.
 */
const FORBIDDEN_LABEL_PREFIXES = Object.freeze([
  'agent::',
  'type::',
  'persona::',
  PLAN_RUN_LABEL_PREFIX,
  'route::',
]);

/** GitHub's own label-name ceiling. */
const MAX_LABEL_LENGTH = 50;

/**
 * Drop runtime-owned and malformed labels, dedupe, and guarantee `type::story`.
 *
 * @param {unknown} rawLabels
 * @param {string} slug
 * @returns {string[]}
 */
export function sanitizeAuthoredLabels(rawLabels, slug) {
  const kept = new Set([TYPE_LABELS.STORY]);
  const dropped = [];
  for (const raw of Array.isArray(rawLabels) ? rawLabels : []) {
    const label = typeof raw === 'string' ? raw.trim() : '';
    if (label === '' || label.length > MAX_LABEL_LENGTH) {
      dropped.push(String(raw));
      continue;
    }
    if (label === TYPE_LABELS.STORY) continue;
    if (FORBIDDEN_LABEL_PREFIXES.some((p) => label.startsWith(p))) {
      dropped.push(label);
      continue;
    }
    kept.add(label);
  }
  if (dropped.length > 0) {
    Logger.warn(
      `[plan-persist] Story "${slug}": dropped ${dropped.length} authored ` +
        `label(s) the runtime owns or cannot apply: ${dropped.join(', ')}.`,
    );
  }
  return [...kept];
}

function bodyObjectFromTicket(ticket) {
  if (typeof ticket.body === 'string') {
    return parseStoryBody(ticket.body).body;
  }
  if (ticket.body && typeof ticket.body === 'object') {
    return parseStoryBody(ticket.body).body;
  }

  // Allow top-level structured fields (goal/changes/…) without a `body` key.
  return parseStoryBody({
    goal: ticket.goal ?? '',
    slicing: ticket.slicing ?? '',
    spec: ticket.spec ?? '',
    changes: ticket.changes ?? [],
    acceptance: ticket.acceptance ?? [],
    verify: ticket.verify ?? [],
    references: ticket.references ?? [],
    non_goals: ticket.non_goals ?? [],
    depends_on: ticket.depends_on ?? [],
  }).body;
}

function normalizeDependsOn(ticket, bodyObject) {
  if (Array.isArray(ticket.depends_on)) {
    return ticket.depends_on.filter((d) => typeof d === 'string');
  }
  return Array.isArray(bodyObject.depends_on) ? bodyObject.depends_on : [];
}

function arraysEqual(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Sync a top-level contract field into the body; fail closed when both are
 * set and disagree.
 *
 * @param {object} ticket
 * @param {object} bodyObject
 * @param {'acceptance'|'verify'} field
 */
function syncContractFieldFromTopLevel(ticket, bodyObject, field) {
  if (!Array.isArray(ticket[field])) return;
  const topLevel = ticket[field].map(String);
  const bodyValue = Array.isArray(bodyObject[field])
    ? bodyObject[field].map(String)
    : [];
  if (bodyValue.length > 0 && !arraysEqual(topLevel, bodyValue)) {
    throw new Error(
      `[plan-persist] Story "${ticket.slug ?? ticket.title ?? 'unknown'}" has mismatched top-level and body ${field} arrays`,
    );
  }
  bodyObject[field] = topLevel;
}

/**
 * `supersedes[]` and `provenance` are top-level-only: planning bookkeeping and
 * footer input respectively, never serialized as body sections.
 *
 * @param {object} ticket
 * @returns {{ slug: string, title: string, bodyObject: object, depends_on: string[], labels: string[], supersedes: Array<{ id: number, note: string|null }>, provenance: { fingerprints: string[], semanticKeys: string[] }|null }}
 */
export function normalizeStoryTicket(ticket) {
  if (!ticket || typeof ticket !== 'object') {
    throw new Error('[plan-persist] each story ticket must be an object');
  }
  const slug =
    typeof ticket.slug === 'string' && ticket.slug.trim() !== ''
      ? ticket.slug.trim()
      : null;
  if (!slug) {
    throw new Error(
      '[plan-persist] each story ticket requires a non-empty slug',
    );
  }
  const title =
    typeof ticket.title === 'string' && ticket.title.trim() !== ''
      ? ticket.title.trim()
      : `Story ${slug}`;
  const bodyObject = bodyObjectFromTicket(ticket);
  syncContractFieldFromTopLevel(ticket, bodyObject, 'acceptance');
  syncContractFieldFromTopLevel(ticket, bodyObject, 'verify');
  const depends_on = normalizeDependsOn(ticket, bodyObject);
  const supersedes = normalizeSupersedes(ticket, slug);
  const labels = sanitizeAuthoredLabels(ticket.labels, slug);
  let provenance;
  try {
    provenance = normalizeOwnedProvenance(ticket.provenance, slug);
  } catch (err) {
    throw new Error(`[plan-persist] ${err.message}`);
  }

  return {
    slug,
    title,
    bodyObject,
    depends_on,
    labels,
    supersedes,
    provenance,
  };
}

/**
 * Per-Story `body.spec` wins; otherwise `sharedSpec` (N===1 only).
 *
 * @param {object} bodyObject
 * @param {string} slug
 * @param {object} [opts]
 * @param {string|null} [opts.sharedSpec]
 * @returns {{ bodyObject: object }}
 */
export function foldSpecIntoStoryBody(bodyObject, slug, opts = {}) {
  const { sharedSpec = null } = opts;

  const next = {
    ...bodyObject,
    references: Array.isArray(bodyObject.references)
      ? [...bodyObject.references]
      : [],
  };

  const inline =
    typeof next.spec === 'string' && next.spec.trim() !== ''
      ? next.spec.trim()
      : typeof sharedSpec === 'string' && sharedSpec.trim() !== ''
        ? sharedSpec.trim()
        : '';

  if (inline === '') {
    return { bodyObject: next };
  }

  next.spec = inline;
  return { bodyObject: next };
}

/**
 * An authored `provenance` stamps exactly the identities this Story owns;
 * otherwise the whole seed's footers are carried. Keep that union fallback:
 * without it a non-attributing plan persists Stories with no provenance and
 * the next audit sweep re-files planned work.
 *
 * @param {{ fingerprints: string[], semanticKeys: string[] }|null} provenance
 * @param {object} opts
 * @returns {string}
 */
function resolveProvenanceSource(provenance, opts) {
  if (provenance !== null) return ownedProvenanceSource(provenance);
  return opts.provenanceSource ?? '';
}

function assembleOnePlanStory(ticket, opts) {
  const {
    slug,
    title,
    bodyObject,
    depends_on,
    labels,
    supersedes,
    provenance,
  } = normalizeStoryTicket(ticket);
  const { bodyObject: folded } = foldSpecIntoStoryBody(bodyObject, slug, {
    sharedSpec: opts.sharedSpec ?? null,
  });
  const serialized = serializeStoryBody({ ...folded, depends_on });
  // Mechanical on purpose: the authoring agent is not asked to hand-carry
  // audit footers. A non-audit seed has none, so this is a no-op there.
  const { body } = carryProvenanceFooters({
    from: resolveProvenanceSource(provenance, opts),
    into: serialized,
  });
  const fingerprint = planStoryFingerprint({ slug, title, body });
  return {
    story: {
      slug,
      title,
      body,
      bodyObject: { ...folded, depends_on },
      acceptance: Array.isArray(folded.acceptance) ? folded.acceptance : [],
      depends_on,
      labels,
      fingerprint,
      supersedes,
    },
  };
}

/**
 * @param {object[]} tickets
 * @param {string|null|undefined} sharedSpec
 */
function assertSharedSpecAllowed(tickets, sharedSpec) {
  if (tickets.length <= 1) return;
  if (typeof sharedSpec !== 'string' || sharedSpec.trim() === '') return;
  throw new Error(
    '[plan-persist] a shared techspec.md cannot be folded into N>1 Stories — ' +
      "put each Story's approach in its own ## Spec so every Story stays a " +
      'complete executable document.',
  );
}

/**
 * Normalize → fold spec → dependency-order → supersede partition, all before
 * any GitHub write. The dependency sort runs here only, so `stories[0]` is the
 * one primary Story every consumer sees; an unknown sibling or cycle fails
 * this write-free pass.
 *
 * @param {object[]} tickets
 * @param {object} [opts]
 * @param {string|null} [opts.sharedSpec]
 * @param {number[]} [opts.sourceTicketIds] Ids passed to `/mandrel-plan --tickets`.
 * @returns {{ stories: Array<{ slug: string, title: string, body: string, acceptance: string[], depends_on: string[], supersedes: Array<{ id: number, note: string|null }> }>, warnings: string[] }}
 */
export function assemblePlanStories(tickets, opts = {}) {
  if (!Array.isArray(tickets) || tickets.length === 0) {
    throw new Error(
      '[plan-persist] stories payload must be a non-empty array — author at least one Story (default-single).',
    );
  }

  assertSharedSpecAllowed(tickets, opts.sharedSpec);

  const stories = orderStoriesByDependencies(
    tickets.map((ticket) => assembleOnePlanStory(ticket, opts).story),
  );

  const warnings = resolveSupersedePartition(
    stories,
    opts.sourceTicketIds ?? [],
  );

  return { stories, warnings };
}

function orderStoriesByDependencies(stories) {
  const list = Array.isArray(stories) ? stories : [];
  const known = new Set(list.map((story) => story.slug));
  for (const story of list) {
    const unknown = story.depends_on.filter(
      (slug) => !isExternalDependencyRef(slug) && !known.has(slug),
    );
    if (unknown.length > 0) {
      throw new Error(
        `[plan-persist] Story "${story.slug}" depends on unknown sibling(s): ${unknown.join(', ')}`,
      );
    }
  }
  const ordered = [];
  const scheduled = new Set();
  const pending = [...list];
  while (pending.length > 0) {
    // External refs are already live, never "scheduled" here; counting them
    // would wedge the sort into a false cycle.
    const index = pending.findIndex((story) =>
      story.depends_on
        .filter((slug) => !isExternalDependencyRef(slug))
        .every((slug) => scheduled.has(slug)),
    );
    if (index === -1) {
      throw new Error(
        `[plan-persist] dependency cycle prevents Story creation: ${pending.map((story) => story.slug).join(', ')}`,
      );
    }
    const [story] = pending.splice(index, 1);
    ordered.push(story);
    scheduled.add(story.slug);
  }
  return ordered;
}

/**
 * Index open Stories for resume. `byFingerprint` is the adoption key;
 * `idsByTitle` only warns (a title is not an identity). Best-effort: a
 * missing or failing listing degrades resume, not a first run, so it warns.
 *
 * @param {object} provider
 * @returns {Promise<{
 *   byFingerprint: Map<string, { id: number, title: string, url?: string }>,
 *   idsByTitle: Map<string, number[]>,
 * }>}
 */
async function indexExistingStories(provider) {
  const byFingerprint = new Map();
  const idsByTitle = new Map();
  if (typeof provider?.listIssuesByLabel !== 'function') {
    Logger.warn(
      '[plan-persist] provider does not expose listIssuesByLabel — cannot ' +
        'check for Stories a previous persist already created. A re-run after ' +
        'a mid-creation failure may duplicate them.',
    );
    return { byFingerprint, idsByTitle };
  }
  let issues;
  try {
    issues = await provider.listIssuesByLabel({
      state: 'open',
      labels: TYPE_LABELS.STORY,
    });
  } catch (err) {
    Logger.warn(
      `[plan-persist] open-Story lookup failed (${err.message}) — proceeding ` +
        'without resume; a re-run may duplicate Stories.',
    );
    return { byFingerprint, idsByTitle };
  }
  for (const issue of Array.isArray(issues) ? issues : []) {
    const id = Number(issue?.number ?? issue?.id);
    if (!Number.isInteger(id)) continue;
    const title = issue?.title ?? '';
    if (title !== '') {
      idsByTitle.set(title, [...(idsByTitle.get(title) ?? []), id]);
    }
    const fingerprint = extractPlanFingerprint(issue?.body);
    if (!fingerprint) continue;
    byFingerprint.set(fingerprint, {
      id,
      title,
      url: issue.html_url ?? issue.url ?? undefined,
    });
  }
  return { byFingerprint, idsByTitle };
}

/**
 * Probe `createIssue` runs before a retry POST: a create whose response was
 * lost already filed the issue, and the posted marker answers that from
 * server state. Best-effort — `null` lets the retry proceed.
 *
 * @param {{ provider: object, fingerprint: string }} args
 * @returns {Promise<object|null>}
 */
async function findOpenStoryByPlanFingerprint({ provider, fingerprint }) {
  if (typeof provider?.listIssuesByLabel !== 'function') return null;
  if (typeof fingerprint !== 'string' || fingerprint.length === 0) return null;
  let issues;
  try {
    issues = await provider.listIssuesByLabel({
      state: 'open',
      labels: TYPE_LABELS.STORY,
    });
  } catch {
    return null;
  }
  for (const issue of Array.isArray(issues) ? issues : []) {
    if (extractPlanFingerprint(issue?.body) === fingerprint) return issue;
  }
  return null;
}

/**
 * Name a same-title open Story whose content differs, so the duplicate a fresh
 * create leaves behind is a visible decision rather than silent litter.
 *
 * @param {{ slug: string, title: string }} story
 * @param {Map<string, number[]>} idsByTitle
 */
function warnOnDivergentSameTitleStory(story, idsByTitle) {
  const ids = idsByTitle.get(story.title) ?? [];
  if (ids.length === 0) return;
  Logger.warn(
    `[plan-persist] Story "${story.slug}": ${ids.length} open Story(ies) ` +
      `already carry this exact title (${ids.map((id) => `#${id}`).join(', ')}) ` +
      'but none match the authored content, so a new Story is being created ' +
      'rather than silently adopting a stale body. If that is an abandoned ' +
      'plan or a superseded draft, close it.',
  );
}

/**
 * The posted body: sibling slugs resolved to issue ids, plus the fingerprint
 * marker.
 *
 * @param {object} story
 * @param {Map<string, number>} idBySlug
 * @returns {string}
 */
function renderStoryBodyForCreate(story, idBySlug) {
  const dependencyRefs = story.depends_on.map((slug) =>
    isExternalDependencyRef(slug) ? slug.trim() : `#${idBySlug.get(slug)}`,
  );
  let base = story.body;
  if (dependencyRefs.length > 0) {
    // `bodyObject` never held the provenance footers (they were appended to
    // the body string), so re-serializing drops them unless re-carried.
    // `from: story.body`, not the seed, keeps this Story's attributed
    // identities; the carry is idempotent.
    const reserialized = serializeStoryBody(
      { ...story.bodyObject, depends_on: dependencyRefs },
      { includeFooter: true },
    );
    base = carryProvenanceFooters({
      from: story.body,
      into: reserialized,
    }).body;
  }
  return `${base}\n\n${planFingerprintMarker(story.fingerprint)}`;
}

/**
 * Mirror sibling `depends_on` into native `blocked_by` edges. Non-fatal: the
 * `blocked by #N` body footer already carries the ordering.
 *
 * `applyBlockedByDependencies` indexes `slugToIssueNumber` by property access
 * and reads `dependsOn`, so the Map must be flattened to an object and the key
 * renamed — either miss silently skips every edge and reports success.
 *
 * @param {object} args
 * @param {object} args.provider
 * @param {Array<{ slug: string, depends_on: string[] }>} args.stories
 * @param {Map<string, number>} args.idBySlug
 * @returns {Promise<{ edgesAdded: number, edgesSkipped: number, edgesFailed: number, storiesProcessed: number }|null>}
 */
async function mirrorNativeDependencyEdges({ provider, stories, idBySlug }) {
  const withEdges = stories.filter((story) => story.depends_on.length > 0);
  if (withEdges.length === 0) return null;

  if (
    typeof provider?.getDependencyWriteContext !== 'function' ||
    typeof provider?.getTicket !== 'function'
  ) {
    Logger.warn(
      '[plan-persist] provider exposes no getDependencyWriteContext/getTicket — ' +
        'skipping native blocked_by edges. Ordering survives in the ' +
        '`blocked by #N` body footers.',
    );
    return null;
  }

  try {
    const { gh, owner, repo } = provider.getDependencyWriteContext();
    // An external `#<id>` ref needs only an identity entry here.
    const slugToIssueNumber = Object.fromEntries(idBySlug);
    for (const story of stories) {
      for (const entry of story.depends_on) {
        const externalId = externalDependencyId(entry);
        if (externalId !== null) slugToIssueNumber[entry.trim()] = externalId;
      }
    }
    const summary = await applyBlockedByDependencies({
      stories: stories.map((story) => ({
        slug: story.slug,
        dependsOn: story.depends_on,
      })),
      slugToIssueNumber,
      getTicket: (issueNumber) => provider.getTicket(issueNumber),
      owner,
      repo,
      gh,
    });
    if (summary.edgesFailed > 0) {
      Logger.warn(
        `[plan-persist] ${summary.edgesFailed} native blocked_by edge(s) could ` +
          'not be written. Ordering survives in the `blocked by #N` body ' +
          'footers; add the edges by hand if you want them in the GitHub UI.',
      );
    } else {
      Logger.info(
        `[plan-persist] native blocked_by edges: ${summary.edgesAdded} added, ` +
          `${summary.edgesSkipped} already present.`,
      );
    }
    return summary;
  } catch (err) {
    Logger.warn(
      `[plan-persist] native blocked_by mirroring failed (${err.message}) — ` +
        'ordering survives in the `blocked by #N` body footers.',
    );
    return null;
  }
}

/**
 * Ensure a label exists before it is applied (create-issue does not always
 * auto-create). Non-fatal: on failure the Stories are created without it,
 * since an unensured label could fail the create itself.
 *
 * @param {object} args
 * @param {object} args.provider
 * @param {string} args.label
 * @param {string} args.color
 * @param {string} args.description
 * @param {string} args.role
 * @returns {Promise<boolean>} Whether to apply the label.
 */
async function ensurePersistLabel({
  provider,
  label,
  color,
  description,
  role,
}) {
  if (typeof provider?.ensureLabels !== 'function') {
    return true;
  }
  try {
    const result = await provider.ensureLabels([
      { name: label, color, description },
    ]);
    if (Array.isArray(result?.missing) && result.missing.includes(label)) {
      Logger.warn(
        `[plan-persist] ${role} label "${label}" could not be verified ` +
          'on the remote — creating the Stories without it. Add the label ' +
          'by hand if you want it.',
      );
      return false;
    }
    return true;
  } catch (err) {
    Logger.warn(
      `[plan-persist] ${role} label ensure failed (${describeGhFailure(err)})` +
        ' — creating the Stories without it. Add the label by hand if you ' +
        'want it.',
    );
    return false;
  }
}

/**
 * Create Story issues resumably, adopting any open Story whose fingerprint
 * matches. Stories are born without `agent::ready`; `markStoriesReady` flips
 * it last, once every plan comment is on the ticket.
 *
 * The loop stays serial: `idBySlug` is filled in loop order by the POSTs, and
 * a concurrent create would render `#undefined` dependency refs.
 *
 * @param {object} args
 * @param {object} args.provider
 * @param {ReturnType<typeof assemblePlanStories>['stories']} args.stories
 * @param {object} [args.opts]
 * @param {boolean} [args.opts.dryRun=false]
 * @returns {Promise<{
 *   created: Array<{ slug: string, id: number, url?: string, title: string, adopted: boolean }>,
 *   dependencyEdges: { edgesAdded: number, edgesSkipped: number, edgesFailed: number, storiesProcessed: number }|null,
 *   planRunLabel: string,
 *   planRunLabelApplied: boolean,
 * }>}
 */
export async function createStoryIssues({ provider, stories, opts = {} }) {
  if (typeof provider?.createIssue !== 'function') {
    throw new Error(
      '[plan-persist] provider does not expose createIssue; cannot persist Stories.',
    );
  }

  const list = Array.isArray(stories) ? stories : [];

  const cohortLabel = planRunLabel(
    derivePlanRunId(list.map((story) => story.fingerprint)),
  );

  if (opts.dryRun) {
    return {
      created: list.map((s, i) => ({
        slug: s.slug,
        id: -(i + 1),
        title: s.title,
        url: undefined,
        adopted: false,
      })),
      dependencyEdges: null,
      planRunLabel: cohortLabel,
      planRunLabelApplied: false,
    };
  }

  const applyCohortLabel = await ensurePersistLabel({
    provider,
    label: cohortLabel,
    color: PLAN_RUN_LABEL_COLOR,
    description:
      'Groups the Stories one /mandrel-plan persist run authored — ' +
      'metadata only, never a deliver input.',
    role: 'cohort',
  });
  const { byFingerprint, idsByTitle } = await indexExistingStories(provider);
  const created = [];
  const idBySlug = new Map();

  // Already dependency-ordered; re-sorting would disagree on the primary.
  for (const story of list) {
    const already = byFingerprint.get(story.fingerprint);
    if (!already) warnOnDivergentSameTitleStory(story, idsByTitle);
    if (already) {
      Logger.info(
        `[plan-persist] resuming: Story "${story.slug}" already exists as ` +
          `#${already.id} with byte-identical authored content ` +
          `(plan fingerprint ${story.fingerprint}) — skipping create.`,
      );
      created.push({
        slug: story.slug,
        id: already.id,
        title: story.title,
        url: already.url,
        adopted: true,
      });
      idBySlug.set(story.slug, already.id);
      continue;
    }

    const result = await provider.createIssue({
      title: story.title,
      body: renderStoryBodyForCreate(story, idBySlug),
      labels: [...story.labels, ...(applyCohortLabel ? [cohortLabel] : [])],
      findExisting: () =>
        findOpenStoryByPlanFingerprint({
          provider,
          fingerprint: story.fingerprint,
        }),
    });
    const id = result?.id ?? result?.number;
    if (!Number.isInteger(id)) {
      throw new Error(
        `[plan-persist] createIssue for slug "${story.slug}" did not return a numeric id`,
      );
    }
    created.push({
      slug: story.slug,
      id,
      title: story.title,
      url: result.url,
      // The database id — the only id the native sub-issue write accepts.
      internalId: result.internalId,
      // True when the retry probe adopted a lost-response first attempt.
      adopted: result.adopted === true,
    });
    idBySlug.set(story.slug, id);
  }

  // Includes adopted ids, so a resume mirrors the whole cohort (idempotent).
  const dependencyEdges = await mirrorNativeDependencyEdges({
    provider,
    stories: list,
    idBySlug,
  });

  return {
    created,
    dependencyEdges,
    // Check the flag before advertising a `label:` filter that may match nothing.
    planRunLabel: cohortLabel,
    planRunLabelApplied: applyCohortLabel,
  };
}

/**
 * Terminal step: flip every created Story to `agent::ready`, so the label
 * means "fully persisted". Fails closed, but attempts every Story first — the
 * mapper absorbs its own rejection so the error names the complete set of ids
 * still needing the label.
 *
 * @param {object} args
 * @param {object} args.provider
 * @param {Array<{ id: number, slug: string }>} args.created
 * @returns {Promise<{ readied: number[] }>}
 */
export async function markStoriesReady({ provider, created }) {
  if (typeof provider?.updateTicket !== 'function') {
    throw new Error(
      '[plan-persist] provider does not expose updateTicket; cannot flip ' +
        'Stories to agent::ready.',
    );
  }
  const outcomes = await concurrentMap(
    created,
    async (story) => {
      try {
        await provider.updateTicket(story.id, {
          labels: { add: [AGENT_LABELS.READY] },
        });
        return { id: story.id, failure: null };
      } catch (err) {
        return {
          id: story.id,
          failure: `#${story.id} (${story.slug}): ${err.message}`,
        };
      }
    },
    { concurrency: FANOUT_CONCURRENCY },
  );
  const readied = outcomes
    .filter((outcome) => outcome.failure === null)
    .map((outcome) => outcome.id);
  const failed = outcomes
    .filter((outcome) => outcome.failure !== null)
    .map((outcome) => outcome.failure);
  if (failed.length > 0) {
    throw new Error(
      `[plan-persist] ${failed.length} Story(ies) were created with their ` +
        'plan comments but could not be flipped to agent::ready:\n' +
        `${failed.map((f) => `  - ${f}`).join('\n')}\n` +
        'They are invisible to /mandrel-deliver until the label lands. Re-run persist ' +
        '(it resumes rather than duplicating) or add the label by hand.',
    );
  }
  return { readied };
}

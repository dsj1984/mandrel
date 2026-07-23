/**
 * story-ops.js — flat Story creation for v2 plan-persist (Stage 3).
 *
 * Under the Story collapse (`docs/roadmap.md` § Stage 3), `/plan` persists
 * zero-or-more Story issues directly — no Epic parent, no reconciler tree,
 * no `deliveryShape` mode matrix. Default is **one Story**; N>1 is gated by
 * the Stage-1 split-policy validator (`assertAcceptancePartition`).
 *
 * Each Story body is the single executable document: Tech Spec stays inline
 * under `## Spec`. Over-budget Specs fail closed (split / tighten) — never
 * spill to `docs/`. Top-level `acceptance[]` / `verify[]` are the machine
 * contract and are synced into the body so the GitHub issue stays complete
 * without requiring the LLM to dual-author the same lists.
 *
 * @module lib/orchestration/plan-persist/story-ops
 */

import { createHash } from 'node:crypto';
import { applyBlockedByDependencies } from '../../../providers/github/blocked-by-add.js';
import { Logger } from '../../Logger.js';
import { AGENT_LABELS, TYPE_LABELS } from '../../label-constants.js';
import {
  parse as parseStoryBody,
  serialize as serializeStoryBody,
} from '../../story-body/story-body.js';
import { assertSpecWithinBudget } from '../spec-spill.js';
import { assertAcceptancePartition } from '../split-policy-validator.js';
import {
  assertSupersedePartition,
  normalizeSupersedes,
} from './supersede-ops.js';

/**
 * Label prefix grouping the Stories one plan-persist run authored.
 *
 * Reintroduced (Story #4692) after Story #4540 retired it: #4540 was right
 * that batch identity is the wrong axis for *ordering delivery across runs*
 * (`/deliver` takes ids and resolves the graph from live state — that stays),
 * but it is the correct axis for *grouping the Stories one plan run created*
 * so a cohort is filterable and traceable in the GitHub UI. The label is
 * metadata only; nothing in persist or delivery reads it as a
 * delivery-resolution input.
 */
export const PLAN_RUN_LABEL_PREFIX = 'plan-run::';

/** Stable color for the cohort grouping label (`ensureLabels`). */
const PLAN_RUN_LABEL_COLOR = '#C5DEF5';

/** Stable color for the `route::lite` ceremony-route marker (Story #4707). */
const LITE_ROUTE_LABEL_COLOR = '#D4C5F9';

/** Length of the derived plan-run id (hex chars). */
const PLAN_RUN_ID_LENGTH = 8;

/**
 * Normalize a caller-supplied plan-run token. Kept shared so human-readable
 * ids map to one canonical label shape.
 *
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
 * Build a `plan-run::<id>` label from an explicit id.
 *
 * Unlike the pre-#4540 shape, this never mints a random token — a random id
 * would split a resumed persist's cohort across two labels. Derive the id
 * from the authored artifacts via {@link derivePlanRunId} instead.
 *
 * @param {string} id
 * @returns {string}
 */
export function planRunLabel(id) {
  return `${PLAN_RUN_LABEL_PREFIX}${normalizePlanRunId(id)}`;
}

/**
 * Derive the deterministic plan-run id for a cohort of assembled Stories.
 *
 * Hashes the **sorted** set of per-Story plan fingerprints (the same
 * content identities the resumable-create contract adopts on), so the id is
 * a pure function of the authored artifacts: the same `stories.json` yields
 * the same `plan-run::<id>` on every run — a persist resumed after a
 * mid-run failure applies the identical label to the newly-created
 * remainder that the already-created (adopted) Stories carry — while a
 * different plan derives a different label. Sorting makes the id
 * independent of creation order.
 *
 * @param {string[]} fingerprints Per-Story plan fingerprints.
 * @returns {string} Hex id, {@link PLAN_RUN_ID_LENGTH} chars.
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
 * Marker prefix for the per-Story plan fingerprint appended to every
 * created body. `createStoryIssues` greps open `type::story` issues for
 * `<!-- plan-story: <fingerprint> -->` to decide whether a Story already
 * exists — the idempotency half of the resumable-create contract.
 */
const PLAN_FINGERPRINT_MARKER_PREFIX = 'plan-story:';

/** Length of the hex fingerprint digest. Collision-free at plan scale. */
const PLAN_FINGERPRINT_LENGTH = 16;

/**
 * Compute the deterministic identity of one authored Story within a plan.
 *
 * Derived from `slug` + `title` + the **assembled** body, so the fingerprint
 * identifies the authored *content*, not merely a name. Because the marker is
 * what `createStoryIssues` adopts on, that is the whole safety property of the
 * resume path: a fingerprint hit means the open Story on the tracker is
 * byte-identical to what this run would author, so adopting it instead of
 * creating it is a genuine no-op.
 *
 * **Why the body is in scope.** It used to be excluded, on the rationale that
 * creation rewrites the body to substitute real issue ids into `depends_on`
 * footers, so a body-derived fingerprint would differ between an aborted run
 * and its resume. That conflated two different bodies. The fingerprint is
 * computed in `assembleOnePlanStory` over the *assembled* body — whose
 * `depends_on` are still sibling **slugs**, and which is a pure function of
 * `stories.json` plus the shared Spec. The id substitution happens later, and
 * only inside `renderStoryBodyForCreate`, which produces the *posted* body.
 * Nothing ever re-derives a fingerprint from a posted body; the lookup reads
 * the marker that body carries. The assembled body is therefore stable across
 * a run and its resume, and folding it in defeats no lookup.
 *
 * Excluding it cost two silent failures, both closed by this:
 *
 *   1. A later, unrelated plan that reused a slug **and** title adopted the
 *      stale open Story — never rewriting its body or Spec, and landing this
 *      run's checkpoints, ready-flip, and supersede comments on the wrong
 *      issue.
 *   2. A legitimate resume after the operator edited `stories.json` adopted
 *      the pre-edit Story and kept its stale body, discarding the edit.
 *
 * With the body in scope both cases simply miss the lookup, and a correct new
 * Story is created; only a genuinely identical Story is ever adopted.
 *
 * The fields are joined on NUL separators, written as the `\u0000` escape and
 * never as a raw byte — a literal NUL would make git classify this file as
 * binary and silently drop its diffs. NUL cannot occur in a slug, a title, or
 * a serialized body, so the join is unambiguous: `{slug:'a-b', title:'c'}` and
 * `{slug:'a', title:'b-c'}` cannot collide the way a hyphen or space separator
 * would let them.
 *
 * @param {{ slug: string, title: string, body?: string }} story
 * @returns {string} Hex digest.
 */
export function planStoryFingerprint({ slug, title, body = '' }) {
  return createHash('sha256')
    .update(`${slug}\u0000${title}\u0000${body}`)
    .digest('hex')
    .slice(0, PLAN_FINGERPRINT_LENGTH);
}

/**
 * Render the HTML-comment marker carrying a Story's plan fingerprint. It is
 * invisible in GitHub's rendered issue body and survives edits to every
 * other section.
 *
 * @param {string} fingerprint
 * @returns {string}
 */
function planFingerprintMarker(fingerprint) {
  return `<!-- ${PLAN_FINGERPRINT_MARKER_PREFIX} ${fingerprint} -->`;
}

/**
 * Labels the authoring pass is never allowed to set. The `agent::*` axis is
 * the runtime's lifecycle state (persist owns the terminal `agent::ready`
 * flip itself), `type::*` is fixed to `type::story` by the v2 hierarchy,
 * `persona::*` is a retired axis, `plan-run::*` is the runtime-derived
 * cohort grouping axis (Story #4692), and `route::*` is the runtime-derived
 * ceremony-route axis (Story #4707) — a hand-authored entry on either
 * derived axis would compete with the deterministic label persist applies
 * itself.
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
 * Sanitize the author-supplied `labels[]` on a plan Story (Story #4541).
 *
 * The schema descriptor and the authoring prompt both ask for `labels[]`,
 * but persist never read the field — it hard-coded its own list, so every
 * authored label was silently discarded. Rather than keep asking for input
 * that goes nowhere, apply it: drop the axes the runtime owns, drop
 * malformed entries, dedupe, and always guarantee `type::story`.
 *
 * @param {unknown} rawLabels
 * @param {string} slug For the dropped-label warning.
 * @returns {string[]} Sanitized labels, always including `type::story`.
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
    wide: ticket.wide ?? null,
    reason_to_exist: ticket.reason_to_exist ?? null,
    depends_on: ticket.depends_on ?? [],
    estimated_test_files: ticket.estimated_test_files ?? null,
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
 * Top-level `acceptance[]` / `verify[]` are the machine contract (validator
 * SSOT). Sync them into the body so the persisted GitHub issue is complete.
 * When the body already lists the same items, keep them; when the body is
 * empty, fill from top-level; when both disagree, fail closed.
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
 * Normalize a plan Story ticket into `{ slug, title, bodyObject }`.
 * Accepts either a serialized markdown `body` string or a structured body.
 *
 * `supersedes[]` is a top-level-only field (Story #4535) — it is planning
 * bookkeeping for the `--tickets` source issues, not part of the Story's
 * executable body, so it is deliberately not serialized into the markdown.
 *
 * @param {object} ticket
 * @returns {{ slug: string, title: string, bodyObject: object, depends_on: string[], labels: string[], supersedes: Array<{ id: number, note: string|null }> }}
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

  return { slug, title, bodyObject, depends_on, labels, supersedes };
}

/**
 * Fold optional shared Tech Spec prose into a Story body when the Story has
 * no inline Spec. Specs stay inline; over-budget Specs throw.
 *
 * Precedence: per-Story `body.spec` wins; otherwise `sharedSpec` is used
 * (N===1 convenience only — callers must not share one Spec across N>1).
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

  const { content } = assertSpecWithinBudget({ storyId: slug, spec: inline });
  next.spec = content;
  return { bodyObject: next };
}

function assembleOnePlanStory(ticket, opts) {
  const { slug, title, bodyObject, depends_on, labels, supersedes } =
    normalizeStoryTicket(ticket);
  const { bodyObject: folded } = foldSpecIntoStoryBody(bodyObject, slug, {
    sharedSpec: opts.sharedSpec ?? null,
  });
  // Body first: the fingerprint is an identity over the *assembled* content,
  // so it cannot be computed until that content exists.
  const body = serializeStoryBody({ ...folded, depends_on });
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
 * Shared techspec.md is an N===1 convenience only — folding one Spec into
 * every sibling duplicates approach prose and breaks Story-as-SSOT.
 *
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
 * Assemble markdown bodies for every Story: normalize → fold spec →
 * assertAcceptancePartition → assertSupersedePartition → serialize.
 *
 * Both partition checks run **before** any GitHub write so a mis-authored
 * plan never leaves Stories live against an inconsistent tracker.
 *
 * @param {object[]} tickets
 * @param {object} [opts]
 * @param {string|null} [opts.sharedSpec]
 * @param {string[]} [opts.planAcceptance]
 * @param {number[]} [opts.sourceTicketIds] Ids passed to `/plan --tickets`.
 * @returns {{ stories: Array<{ slug: string, title: string, body: string, acceptance: string[], depends_on: string[], supersedes: Array<{ id: number, note: string|null }> }> }}
 */
export function assemblePlanStories(tickets, opts = {}) {
  if (!Array.isArray(tickets) || tickets.length === 0) {
    throw new Error(
      '[plan-persist] stories payload must be a non-empty array — author at least one Story (default-single).',
    );
  }

  assertSharedSpecAllowed(tickets, opts.sharedSpec);

  const stories = tickets.map(
    (ticket) => assembleOnePlanStory(ticket, opts).story,
  );

  assertAcceptancePartition(stories, {
    planAcceptance: opts.planAcceptance,
  });
  assertSupersedePartition(stories, opts.sourceTicketIds ?? []);

  return { stories };
}

function orderStoriesByDependencies(stories) {
  const list = Array.isArray(stories) ? stories : [];
  const known = new Set(list.map((story) => story.slug));
  for (const story of list) {
    const unknown = story.depends_on.filter((slug) => !known.has(slug));
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
    const index = pending.findIndex((story) =>
      story.depends_on.every((slug) => scheduled.has(slug)),
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
 * Index the open `type::story` backlog so a re-run can recognise Stories a
 * previous, partially-failed persist already created.
 *
 * Two indexes come back. `byFingerprint` is the adoption key — an exact match
 * on the authored content (see {@link planStoryFingerprint}). `idsByTitle` is
 * only used to *warn*: it catches the near miss where a Story with this title
 * is already open but its content differs, which is what an abandoned earlier
 * plan or an edited `stories.json` leaves behind. Adoption deliberately does
 * not key on it — a title is not an identity, and adopting on one would let a
 * later unrelated plan overwrite someone else's Story.
 *
 * Best-effort by construction: a provider with no `listIssuesByLabel` (or a
 * listing that errors) yields empty indexes and the create loop proceeds
 * un-deduplicated, exactly as it did before. That degrades resume, not
 * correctness of a first run — so it warns rather than throws.
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
    const body = typeof issue?.body === 'string' ? issue.body : '';
    const match = body.match(
      new RegExp(
        `<!--\\s*${PLAN_FINGERPRINT_MARKER_PREFIX}\\s*([0-9a-f]+)\\s*-->`,
      ),
    );
    if (!match) continue;
    byFingerprint.set(match[1], {
      id,
      title,
      url: issue.html_url ?? issue.url ?? undefined,
    });
  }
  return { byFingerprint, idsByTitle };
}

/**
 * Warn when a Story with this title is already open but did **not** match the
 * fingerprint — i.e. its authored content differs from what this run is about
 * to create.
 *
 * This is the visible half of the fingerprint tightening. Keying adoption on
 * content means these cases correctly get a fresh Story rather than a silent
 * stale-body adoption, but the divergent Story stays open, and a duplicate the
 * operator never hears about is its own small trap. Naming it converts silent
 * litter into a decision.
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
 * Render the body actually posted for a Story: the assembled markdown with
 * sibling `depends_on` slugs resolved to real issue ids, plus the invisible
 * plan-fingerprint marker that makes the create loop resumable.
 *
 * @param {object} story
 * @param {Map<string, number>} idBySlug
 * @returns {string}
 */
function renderStoryBodyForCreate(story, idBySlug) {
  const dependencyRefs = story.depends_on.map(
    (slug) => `#${idBySlug.get(slug)}`,
  );
  const base =
    dependencyRefs.length === 0
      ? story.body
      : serializeStoryBody(
          { ...story.bodyObject, depends_on: dependencyRefs },
          { includeFooter: true },
        );
  return `${base}\n\n${planFingerprintMarker(story.fingerprint)}`;
}

/**
 * Mirror the plan's sibling `depends_on` edges into native GitHub `blocked_by`
 * dependency edges (Story #4544).
 *
 * Ordering is authored as slugs and, until now, survived persist only as
 * `blocked by #N` prose in the body footer. That footer stays — it is what
 * `/deliver`'s resolver falls back on — but a native edge is the durable,
 * machine-readable form: visible in the GitHub UI, readable without parsing
 * markdown, and settable by an operator later for cross-run order.
 *
 * **Non-fatal by design, and deliberately asymmetric with the read path.** A
 * missing native edge is cosmetic here: `renderStoryBodyForCreate` has already
 * written the footer, so ordering is not lost when the dependencies API says
 * no. `/deliver`'s *read* of these edges is a real dispatch gate, which is why
 * that side fails loud. Persist reports the failure and completes.
 *
 * Two shape hazards this crossing has to get right, both silent if missed:
 * `applyBlockedByDependencies` indexes `slugToIssueNumber` with property
 * access, so the `Map` the create loop builds must be flattened to a plain
 * object — a `Map` would yield `undefined` for every lookup, skip every edge,
 * and (being non-fatal) report success having written nothing. And it reads
 * `dependsOn`, not the `depends_on` the assembled Story carries.
 *
 * @param {object} args
 * @param {object} args.provider
 * @param {Array<{ slug: string, depends_on: string[] }>} args.stories
 * @param {Map<string, number>} args.idBySlug
 * @returns {Promise<{ edgesAdded: number, edgesSkipped: number, edgesFailed: number, storiesProcessed: number }|null>}
 *   `null` when there was nothing to mirror or no interface to mirror through.
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
    const summary = await applyBlockedByDependencies({
      stories: stories.map((story) => ({
        slug: story.slug,
        dependsOn: story.depends_on,
      })),
      slugToIssueNumber: Object.fromEntries(idBySlug),
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
 * Ensure a runtime-derived persist label (`plan-run::<id>` cohort grouping,
 * `route::lite` route marker) exists before it is applied — GitHub's
 * create-issue path does not auto-create unknown labels on every provider
 * route, and an opaque derived label never exists yet.
 *
 * **Non-fatal by design**, matching the native-blocked_by mirroring posture:
 * neither label is load-bearing for correctness (grouping is cosmetic; a
 * missing route marker degrades a lite Story to the standard — safer —
 * sub-agent dispatch), so it is never a reason to fail persist. On an ensure
 * failure (throw, or the label reported `missing` by the post-loop
 * reconcile) the create loop proceeds **without** the label — applying an
 * unensured label could fail the issue create itself, and the Stories matter
 * more than their metadata. A provider that exposes no `ensureLabels` (test
 * fakes, minimal providers) is assumed to accept arbitrary labels on create.
 *
 * @param {object} args
 * @param {object} args.provider
 * @param {string} args.label
 * @param {string} args.color
 * @param {string} args.description
 * @param {string} args.role Human-readable role for the degrade warning.
 * @returns {Promise<boolean>} Whether the create loop should apply the label.
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
      `[plan-persist] ${role} label ensure failed (${err.message}) — ` +
        'creating the Stories without it. Add the label by hand if you ' +
        'want it.',
    );
    return false;
  }
}

/**
 * Create Story issues via `provider.createIssue`, resumably.
 *
 * **Stories are born without `agent::ready`** (Story #4541). They used to
 * carry it in the creating POST while the `story-plan-state` checkpoint was
 * upserted afterwards, so anything that picked a Story up inside that window —
 * or after a comment failure aborted the loop — read the checkpoint as `null`.
 * Creation now applies `type::story` plus the sanitized authored labels only;
 * `markStoriesReady` performs the flip as the terminal step, once every
 * checkpoint is on the ticket.
 *
 * **The loop is resumable, and adoption is content-keyed.** Each body carries
 * a plan-fingerprint marker, and the open `type::story` backlog is indexed by
 * it before the first POST. A Story whose fingerprint already exists is
 * adopted rather than re-created, so a re-run after a 502 at story *k* of *N*
 * completes the cohort instead of minting a second copy of `1..k-1`.
 *
 * The fingerprint covers the assembled body, not just slug + title, so a hit
 * means the open Story *is* what this run would author and adoption changes
 * nothing. A same-named Story whose content has drifted — an abandoned plan, or
 * an edited `stories.json` — misses the lookup, gets a correct new Story, and
 * is named in a warning. Adoption never rewrites a body, so keying it on
 * anything weaker than content would silently ship a stale one.
 *
 * **Every created Story carries the cohort's `plan-run::<id>` grouping
 * label** (Story #4692, metadata only). The id is deterministic over the
 * authored artifacts ({@link derivePlanRunId}), so a resumed persist derives
 * the identical label its adopted Stories already carry from their original
 * create — no relabel call is needed on the resume path, and the cohort is
 * never split across two labels. The label is ensured to exist before the
 * first POST, **non-fatally**: grouping is cosmetic and never fails the run
 * (see `ensureCohortLabel`). `/deliver` never reads it — delivery stays
 * ids-only over live state (Story #4540's actual point).
 *
 * **Sibling order is mirrored into native GitHub `blocked_by` edges** once
 * every id is known (Story #4544), so plan-created order stops depending on
 * prose. That pass is non-fatal — see `mirrorNativeDependencyEdges`.
 *
 * **A lite-routed cohort carries the `route::lite` marker** (Story #4707).
 * When the caller resolves the plan's effective complexity route to `lite`
 * (envelope verdict, or an audited planner downgrade), it passes the marker
 * via `opts.routeLabel` and every created Story carries it — the persisted,
 * `/deliver`-readable form of the route (`resolveStoryDispatchMode`). A
 * full-routed plan passes nothing and its Stories carry **no** route marker.
 * Like the cohort label, the ensure is non-fatal: a Story created without
 * the marker degrades to the standard sub-agent dispatch, never to a skipped
 * gate.
 *
 * @param {object} args
 * @param {object} args.provider
 * @param {ReturnType<typeof assemblePlanStories>['stories']} args.stories
 * @param {object} [args.opts]
 * @param {boolean} [args.opts.dryRun=false]
 * @param {string|null} [args.opts.routeLabel=null] Route marker label to
 *   apply to every created Story (`route::lite`), or null for none.
 * @returns {Promise<{
 *   created: Array<{ slug: string, id: number, url?: string, title: string, adopted: boolean }>,
 *   dependencyEdges: { edgesAdded: number, edgesSkipped: number, edgesFailed: number, storiesProcessed: number }|null,
 *   planRunLabel: string,
 *   routeLabel: string|null,
 * }>}
 */
export async function createStoryIssues({ provider, stories, opts = {} }) {
  if (typeof provider?.createIssue !== 'function') {
    throw new Error(
      '[plan-persist] provider does not expose createIssue; cannot persist Stories.',
    );
  }

  const list = Array.isArray(stories) ? stories : [];
  const routeLabel =
    typeof opts.routeLabel === 'string' && opts.routeLabel.trim() !== ''
      ? opts.routeLabel.trim()
      : null;

  // Derived once for the whole cohort, before any write — a pure function of
  // the authored artifacts, so dry-run can report it write-free and a resume
  // re-derives the identical label.
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
      routeLabel,
    };
  }

  const applyCohortLabel = await ensurePersistLabel({
    provider,
    label: cohortLabel,
    color: PLAN_RUN_LABEL_COLOR,
    description:
      'Groups the Stories one /plan persist run authored (metadata ' +
      'only — /deliver stays ids-only).',
    role: 'cohort',
  });
  const applyRouteLabel =
    routeLabel !== null &&
    (await ensurePersistLabel({
      provider,
      label: routeLabel,
      color: LITE_ROUTE_LABEL_COLOR,
      description:
        'Ceremony-lite route marker: /deliver executes this Story inline ' +
        '(no sub-agent fan-out); every close gate runs unchanged.',
      role: 'route-marker',
    }));

  const { byFingerprint, idsByTitle } = await indexExistingStories(provider);
  const created = [];
  const idBySlug = new Map();

  for (const story of orderStoriesByDependencies(list)) {
    const already = byFingerprint.get(story.fingerprint);
    if (!already) warnOnDivergentSameTitleStory(story, idsByTitle);
    if (already) {
      // Adopted Stories already carry the cohort label from their original
      // create — the deterministic derivation guarantees it is the same
      // label this run derived, so no relabel call is needed here.
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
      labels: [
        ...story.labels,
        ...(applyCohortLabel ? [cohortLabel] : []),
        ...(applyRouteLabel ? [routeLabel] : []),
      ],
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
      adopted: false,
    });
    idBySlug.set(story.slug, id);
  }

  // Every id is known now — including the adopted ones a resumed run reused —
  // so a re-run mirrors the whole cohort's edges, not just the Stories this
  // invocation happened to POST. Re-application is idempotent.
  const dependencyEdges = await mirrorNativeDependencyEdges({
    provider,
    stories: list,
    idBySlug,
  });

  return {
    created,
    dependencyEdges,
    planRunLabel: cohortLabel,
    routeLabel: applyRouteLabel ? routeLabel : null,
  };
}

/**
 * Flip every created Story to `agent::ready` — the terminal step of persist
 * (Story #4541).
 *
 * This is what makes `agent::ready` *mean* "fully persisted": by the time it
 * lands, the Story's `story-plan-state` checkpoint is already on the ticket, so
 * a `/deliver` that picks it up cannot read a null checkpoint.
 *
 * Fails closed: an un-flipped Story is invisible to `/deliver`, which is the
 * safe direction — the operator is told exactly which ids need the label.
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
  const readied = [];
  const failed = [];
  for (const story of created) {
    try {
      await provider.updateTicket(story.id, {
        labels: { add: [AGENT_LABELS.READY] },
      });
      readied.push(story.id);
    } catch (err) {
      failed.push(`#${story.id} (${story.slug}): ${err.message}`);
    }
  }
  if (failed.length > 0) {
    throw new Error(
      `[plan-persist] ${failed.length} Story(ies) were created with their ` +
        'checkpoints but could not be flipped to agent::ready:\n' +
        `${failed.map((f) => `  - ${f}`).join('\n')}\n` +
        'They are invisible to /deliver until the label lands. Re-run persist ' +
        '(it resumes rather than duplicating) or add the label by hand.',
    );
  }
  return { readied };
}

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

// Story #4540 removed PLAN_RUN_LABEL_PREFIX / normalizePlanRunId /
// planRunLabel from here. They minted an opaque random-hex label per N>1
// plan that nothing ever deleted, and their only external consumer was the
// (now deleted) `--run` resolver. Sibling order survives in the
// `blocked by #N` body footers this module already writes.

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
 * @returns {{ slug: string, title: string, bodyObject: object, depends_on: string[], supersedes: Array<{ id: number, note: string|null }> }}
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

  return { slug, title, bodyObject, depends_on, supersedes };
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
  const { slug, title, bodyObject, depends_on, supersedes } =
    normalizeStoryTicket(ticket);
  const { bodyObject: folded } = foldSpecIntoStoryBody(bodyObject, slug, {
    sharedSpec: opts.sharedSpec ?? null,
  });
  const body = serializeStoryBody({ ...folded, depends_on });
  return {
    story: {
      slug,
      title,
      body,
      bodyObject: { ...folded, depends_on },
      acceptance: Array.isArray(folded.acceptance) ? folded.acceptance : [],
      depends_on,
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
 * Create Story issues via `provider.createIssue`. Applies `type::story`,
 * `agent::ready`, and — when N>1 — a shared plan-run label.
 *
 * @param {object} args
 * Story #4540 retired the `plan-run::<id>` label this used to apply when
 * N>1. Batch identity was the wrong axis to encode: it could not express an
 * edge to a Story planned in a different run, and ordering already lives in
 * the `blocked by #N` footers written below — which `/deliver`'s resolver
 * reads directly, alongside native GitHub edges, from live state.
 *
 * @param {object} args.provider
 * @param {ReturnType<typeof assemblePlanStories>['stories']} args.stories
 * @param {object} [args.opts]
 * @param {boolean} [args.opts.dryRun=false]
 * @returns {Promise<{ created: Array<{ slug: string, id: number, url?: string, title: string }> }>}
 */
export async function createStoryIssues({ provider, stories, opts = {} }) {
  if (typeof provider?.createIssue !== 'function') {
    throw new Error(
      '[plan-persist] provider does not expose createIssue; cannot persist Stories.',
    );
  }

  const list = Array.isArray(stories) ? stories : [];
  const labels = [TYPE_LABELS.STORY, AGENT_LABELS.READY];

  if (opts.dryRun) {
    return {
      created: list.map((s, i) => ({
        slug: s.slug,
        id: -(i + 1),
        title: s.title,
        url: undefined,
      })),
    };
  }

  const created = [];
  const createdBySlug = new Map();
  for (const story of orderStoriesByDependencies(list)) {
    const dependencyRefs = story.depends_on.map(
      (slug) => `#${createdBySlug.get(slug)}`,
    );
    const body =
      dependencyRefs.length === 0
        ? story.body
        : serializeStoryBody(
            { ...story.bodyObject, depends_on: dependencyRefs },
            { includeFooter: true },
          );
    const result = await provider.createIssue({
      title: story.title,
      body,
      labels: [...labels],
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
    });
    createdBySlug.set(story.slug, id);
  }

  return { created };
}

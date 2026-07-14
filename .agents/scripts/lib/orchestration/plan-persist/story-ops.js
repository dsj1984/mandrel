/**
 * story-ops.js — flat Story creation for v2 plan-persist (Stage 3).
 *
 * Under the Story collapse (`docs/roadmap.md` § Stage 3), `/plan` persists
 * zero-or-more Story issues directly — no Epic parent, no reconciler tree,
 * no `deliveryShape` mode matrix. Default is **one Story**; N>1 is gated by
 * the Stage-1 split-policy validator (`assertAcceptancePartition`).
 *
 * Each Story body absorbs its folded Tech Spec (`## Spec`). When that prose
 * exceeds the soft token budget, {@link spillSpecIfOverBudget} writes
 * `docs/specs/<slug>.md` and records a `references[]` pointer instead.
 *
 * @module lib/orchestration/plan-persist/story-ops
 */

import { randomBytes } from 'node:crypto';

import { AGENT_LABELS, TYPE_LABELS } from '../../label-constants.js';
import {
  parse as parseStoryBody,
  serialize as serializeStoryBody,
} from '../../story-body/story-body.js';
import { spillSpecIfOverBudget } from '../spec-spill.js';
import { assertAcceptancePartition } from '../split-policy-validator.js';

/** Label prefix grouping sibling Stories from one plan run (N>1). */
export const PLAN_RUN_LABEL_PREFIX = 'plan-run::';

/**
 * Normalize a caller-supplied plan-run token. Persistence and resolution
 * share this helper so human-readable ids map to one canonical label.
 *
 * @param {string} id
 * @returns {string}
 */
export function normalizePlanRunId(id) {
  return String(id ?? '')
    .trim()
    .toLowerCase()
    .replace(/^plan-run::/, '')
    .replace(/[^a-z0-9._-]+/g, '-');
}

/**
 * Build a `plan-run::<id>` label. When `id` is omitted, generates a short
 * random hex token (8 chars) suitable for a rare multi-Story plan.
 *
 * @param {string} [id]
 * @returns {string}
 */
export function planRunLabel(id) {
  const token =
    typeof id === 'string' && id.trim() !== ''
      ? normalizePlanRunId(id)
      : randomBytes(4).toString('hex');
  return `${PLAN_RUN_LABEL_PREFIX}${token}`;
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

function assertContractFieldMatches(ticket, bodyObject, field) {
  if (!Array.isArray(ticket[field])) return;
  const topLevel = ticket[field].map(String);
  const bodyValue = Array.isArray(bodyObject[field])
    ? bodyObject[field].map(String)
    : [];
  if (
    topLevel.length !== bodyValue.length ||
    topLevel.some((value, index) => value !== bodyValue[index])
  ) {
    throw new Error(
      `[plan-persist] Story "${ticket.slug ?? ticket.title ?? 'unknown'}" has mismatched top-level and body ${field} arrays`,
    );
  }
}

/**
 * Normalize a plan Story ticket into `{ slug, title, bodyObject }`.
 * Accepts either a serialized markdown `body` string or a structured body.
 *
 * @param {object} ticket
 * @returns {{ slug: string, title: string, bodyObject: object, depends_on: string[] }}
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
  assertContractFieldMatches(ticket, bodyObject, 'acceptance');
  assertContractFieldMatches(ticket, bodyObject, 'verify');
  const depends_on = normalizeDependsOn(ticket, bodyObject);

  return { slug, title, bodyObject, depends_on };
}

/**
 * Fold optional shared Tech Spec prose into a Story body and spill when
 * over budget. Mutates a copy — never the caller's object.
 *
 * Precedence: per-Story `body.spec` wins; otherwise `sharedSpec` is used.
 * When the chosen prose spills, inline `spec` is cleared and a references
 * pointer is appended.
 *
 * @param {object} bodyObject
 * @param {string} slug
 * @param {object} [opts]
 * @param {string|null} [opts.sharedSpec]
 * @param {string} [opts.repoRoot]
 * @param {boolean} [opts.write]
 * @param {object} [opts.fs]
 * @returns {{ bodyObject: object, spill: import('../spec-spill.js').SpecSpillResult|null }}
 */
export function foldSpecIntoStoryBody(bodyObject, slug, opts = {}) {
  const {
    sharedSpec = null,
    repoRoot = process.cwd(),
    write = true,
    fs: fsAdapter,
  } = opts;

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
    return { bodyObject: next, spill: null };
  }

  const spill = spillSpecIfOverBudget(
    { storyId: slug, spec: inline },
    { repoRoot, write, ...(fsAdapter ? { fs: fsAdapter } : {}) },
  );

  if (spill.spilled && spill.reference) {
    next.spec = '';
    const already = next.references.some(
      (r) =>
        (typeof r === 'string' && r === spill.reference.path) ||
        (r && typeof r === 'object' && r.path === spill.reference.path),
    );
    if (!already) next.references.push(spill.reference);
  } else {
    next.spec = spill.content;
  }

  return { bodyObject: next, spill };
}

function assembleOnePlanStory(ticket, opts) {
  const { slug, title, bodyObject, depends_on } = normalizeStoryTicket(ticket);
  const { bodyObject: folded, spill } = foldSpecIntoStoryBody(
    bodyObject,
    slug,
    {
      sharedSpec: opts.sharedSpec ?? null,
      repoRoot: opts.repoRoot,
      write: opts.write,
      fs: opts.fs,
    },
  );
  const body = serializeStoryBody({ ...folded, depends_on });
  return {
    story: {
      slug,
      title,
      body,
      bodyObject: { ...folded, depends_on },
      acceptance: Array.isArray(folded.acceptance) ? folded.acceptance : [],
      depends_on,
    },
    spill: spill ? { slug, spill } : null,
  };
}

/**
 * Assemble markdown bodies for every Story: normalize → fold/spill spec →
 * assertAcceptancePartition → serialize.
 *
 * @param {object[]} tickets
 * @param {object} [opts]
 * @param {string|null} [opts.sharedSpec]
 * @param {string[]} [opts.planAcceptance]
 * @param {string} [opts.repoRoot]
 * @param {boolean} [opts.write]
 * @param {object} [opts.fs]
 * @returns {{ stories: Array<{ slug: string, title: string, body: string, acceptance: string[], depends_on: string[] }>, spills: object[] }}
 */
export function assemblePlanStories(tickets, opts = {}) {
  if (!Array.isArray(tickets) || tickets.length === 0) {
    throw new Error(
      '[plan-persist] stories payload must be a non-empty array — author at least one Story (default-single).',
    );
  }

  const spills = [];
  const stories = tickets.map((ticket) => {
    const { story, spill } = assembleOnePlanStory(ticket, opts);
    if (spill) spills.push(spill);
    return story;
  });

  assertAcceptancePartition(stories, {
    planAcceptance: opts.planAcceptance,
  });

  return { stories, spills };
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
 * `agent::ready`, optional persona, and — when N>1 — a shared plan-run label.
 *
 * @param {object} args
 * @param {object} args.provider
 * @param {ReturnType<typeof assemblePlanStories>['stories']} args.stories
 * @param {object} [args.opts]
 * @param {string} [args.opts.personaLabel]
 * @param {string} [args.opts.planRunId]
 * @param {boolean} [args.opts.dryRun=false]
 * @returns {Promise<{ created: Array<{ slug: string, id: number, url?: string, title: string }>, planRunLabel: string|null }>}
 */
export async function createStoryIssues({ provider, stories, opts = {} }) {
  if (typeof provider?.createIssue !== 'function') {
    throw new Error(
      '[plan-persist] provider does not expose createIssue; cannot persist Stories.',
    );
  }

  const list = Array.isArray(stories) ? stories : [];
  const planLabel = list.length > 1 ? planRunLabel(opts.planRunId) : null;
  const labels = [TYPE_LABELS.STORY, AGENT_LABELS.READY];
  if (
    typeof opts.personaLabel === 'string' &&
    opts.personaLabel.trim() !== ''
  ) {
    labels.push(opts.personaLabel.trim());
  }
  if (planLabel) labels.push(planLabel);

  if (opts.dryRun) {
    return {
      created: list.map((s, i) => ({
        slug: s.slug,
        id: -(i + 1),
        title: s.title,
        url: undefined,
      })),
      planRunLabel: planLabel,
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

  return { created, planRunLabel: planLabel };
}

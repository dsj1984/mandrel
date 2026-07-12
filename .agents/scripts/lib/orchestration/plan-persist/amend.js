/**
 * amend.js — the `--amend` change-request delta path of the collapsed
 * persist surface (Epic #4474 PR4, design §2 mode matrix, amend row).
 *
 * An amend run receives the full ticket set with every ticket carrying an
 * `op` field:
 *
 *   - `add`    — a new Story; created fresh.
 *   - `modify` — an existing Story whose contract changed; closed and
 *                recreated (close-and-recreate is scoped to modify/close
 *                slugs ONLY — never the whole tree, which is `--force`'s
 *                semantics).
 *   - `keep`   — an existing Story left byte-untouched; it participates in
 *                the merged-set DAG validation but no provider mutation
 *                ever targets it.
 *   - `close`  — an existing Story dropped from the plan; closed.
 *
 * The DAG (and the full ticket validator) runs over the MERGED set —
 * keeps + adds + modifies, closes excluded — so a cycle introduced by an
 * add that depends on a kept Story that depends on a modify is caught
 * before any GitHub call, and a dependency pointing at a closed slug fails
 * the unknown-slug check.
 *
 * Close ops are destructive, so they are gated behind the same explicit
 * confirmation contract as `epic-reconcile.js`: without `--explicit-delete`
 * the run stops BEFORE any mutation, prints the dry-run op diff, and exits
 * 2 ({@link AmendExplicitCloseError} carries the rendered diff; the CLI
 * maps it onto the exit code). Non-interactive callers pass the flag.
 *
 * Slug → issue resolution: an explicit `id` on the ticket (the authoring
 * envelope's open-children listing carries issue numbers) wins; otherwise
 * the reconciler state ledger (`.agents/epics/<id>.state.json`) resolves
 * the slug. A modify/keep/close slug that resolves nowhere is a hard error
 * — the amend never guesses which Story it is about to close.
 *
 * @module lib/orchestration/plan-persist/amend
 */

import { Logger } from '../../Logger.js';

/** Valid `op` values on an amend ticket. */
const AMEND_OPS = Object.freeze(['add', 'modify', 'keep', 'close']);

/**
 * Error carrying the rendered dry-run diff for the exit-2 confirmation
 * path (mirrors `epic-reconcile.js` EXIT_CODES.EXPLICIT_DELETE_REQUIRED).
 */
export class AmendExplicitCloseError extends Error {
  /**
   * @param {string} message
   * @param {{ diff: string }} detail
   */
  constructor(message, { diff }) {
    super(message);
    this.name = 'AmendExplicitCloseError';
    this.code = 'PLAN_AMEND_EXPLICIT_DELETE_REQUIRED';
    this.diff = diff;
  }
}

/**
 * Partition an amend ticket set by `op`, validating the op vocabulary and
 * slug uniqueness. Every ticket MUST carry an op — a missing op on one
 * ticket of an amend payload is an authoring defect, not a default.
 *
 * @param {Array<{ slug?: string, op?: string }>} tickets
 * @returns {{ add: object[], modify: object[], keep: object[], close: object[] }}
 */
export function partitionAmendTickets(tickets) {
  const partition = { add: [], modify: [], keep: [], close: [] };
  const seen = new Set();
  for (const ticket of tickets) {
    const slug = ticket?.slug;
    if (typeof slug !== 'string' || slug.length === 0) {
      throw new Error(
        '[plan-persist] amend ticket without a slug — every amend ticket ' +
          'must carry both slug and op.',
      );
    }
    if (seen.has(slug)) {
      throw new Error(
        `[plan-persist] duplicate slug "${slug}" in the amend payload.`,
      );
    }
    seen.add(slug);
    const op = ticket?.op;
    if (!AMEND_OPS.includes(op)) {
      throw new Error(
        `[plan-persist] amend ticket "${slug}" carries invalid op ` +
          `"${op}" — expected one of ${AMEND_OPS.join(', ')}.`,
      );
    }
    partition[op].push(ticket);
  }
  return partition;
}

/**
 * Project the MERGED ticket set for validation and spec rendering:
 * keeps + adds + modifies in original authoring order, closes excluded,
 * with the amend-only `op`/`id` carrier fields stripped so the ticket
 * validator and `renderSpec` see the exact fan-out ticket shape.
 *
 * @param {Array<{ op?: string }>} tickets the full amend payload
 * @returns {object[]} merged set, op/id stripped
 */
export function buildMergedTicketSet(tickets) {
  return tickets
    .filter((t) => t?.op !== 'close')
    .map(({ op: _op, id: _id, ...rest }) => rest);
}

/**
 * Resolve every modify/keep/close slug to its live issue number and
 * hard-error on any ambiguity (the "closing the wrong stories" risk):
 *
 *   - modify/keep/close must resolve via explicit `id` or the state
 *     ledger mapping — no resolution is a hard error;
 *   - an add slug must NOT already resolve to an issue (a collision means
 *     the author meant modify, or picked a stale slug);
 *   - resolved modify/close targets are fetched and must exist; a target
 *     already closed on GitHub is surfaced (skipped close, not an error —
 *     re-running an interrupted amend must stay safe).
 *
 * @param {{
 *   partition: ReturnType<typeof partitionAmendTickets>,
 *   stateMapping: Record<string, { issueNumber?: number }>,
 *   provider: { getTicket: (id: number) => Promise<object|null> },
 * }} args
 * @returns {Promise<{
 *   modify: Array<{ ticket: object, issueNumber: number, alreadyClosed: boolean }>,
 *   keep: Array<{ ticket: object, issueNumber: number }>,
 *   close: Array<{ ticket: object, issueNumber: number, alreadyClosed: boolean }>,
 * }>}
 */
export async function resolveAmendTargets({
  partition,
  stateMapping,
  provider,
}) {
  const mapping = stateMapping ?? {};
  const resolveSlug = (ticket) => {
    if (Number.isInteger(ticket.id)) return ticket.id;
    const entry = mapping[ticket.slug];
    if (Number.isInteger(entry?.issueNumber)) return entry.issueNumber;
    return null;
  };

  for (const ticket of partition.add) {
    const collision = resolveSlug(ticket);
    if (collision !== null) {
      throw new Error(
        `[plan-persist] amend op "add" for slug "${ticket.slug}" collides ` +
          `with existing issue #${collision} — use op "modify" to replace ` +
          'it, or pick a fresh slug.',
      );
    }
  }

  const resolveExisting = async (ticket, op) => {
    const issueNumber = resolveSlug(ticket);
    if (issueNumber === null) {
      throw new Error(
        `[plan-persist] amend op "${op}" for slug "${ticket.slug}" resolves ` +
          'to no existing issue (no `id` on the ticket, no state-ledger ' +
          'mapping). Refusing to guess — carry the issue number as `id`.',
      );
    }
    const issue = await provider.getTicket(issueNumber);
    if (!issue) {
      throw new Error(
        `[plan-persist] amend op "${op}" for slug "${ticket.slug}" points ` +
          `at issue #${issueNumber}, which does not exist.`,
      );
    }
    return { ticket, issueNumber, alreadyClosed: issue.state === 'closed' };
  };

  const modify = [];
  for (const t of partition.modify)
    modify.push(await resolveExisting(t, 'modify'));
  const close = [];
  for (const t of partition.close)
    close.push(await resolveExisting(t, 'close'));
  const keep = [];
  for (const t of partition.keep) {
    const { ticket, issueNumber } = await resolveExisting(t, 'keep');
    keep.push({ ticket, issueNumber });
  }
  return { modify, keep, close };
}

/**
 * Render the operator-facing dry-run diff of the amend plan — printed on
 * the exit-2 confirmation path and logged before an `--explicit-delete`
 * apply so the destructive set is always visible.
 *
 * @param {{
 *   epicId: number,
 *   targets: Awaited<ReturnType<typeof resolveAmendTargets>>,
 *   adds: Array<{ slug: string, title?: string }>,
 * }} args
 * @returns {string}
 */
export function renderAmendPlanDiff({ epicId, targets, adds }) {
  const rows = [
    ...targets.close.map(
      (t) =>
        `| close | \`${t.ticket.slug}\` | #${t.issueNumber} | closed${t.alreadyClosed ? ' (already closed)' : ''} |`,
    ),
    ...targets.modify.map(
      (t) =>
        `| modify | \`${t.ticket.slug}\` | #${t.issueNumber} | closed + recreated |`,
    ),
    ...adds.map((t) => `| add | \`${t.slug}\` | — | created |`),
    ...targets.keep.map(
      (t) => `| keep | \`${t.ticket.slug}\` | #${t.issueNumber} | untouched |`,
    ),
  ];
  return [
    `Amend plan for Epic #${epicId} (dry-run):`,
    '',
    '| Op | Slug | Issue | Effect |',
    '| --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

/**
 * Enforce the close-op confirmation gate: when the amend plan carries
 * close ops (including the close half of modify) affecting live issues and
 * `--explicit-delete` was not passed, throw {@link AmendExplicitCloseError}
 * with the rendered diff — BEFORE any mutation. Mirrors the
 * `epic-reconcile.js` exit-2 contract.
 *
 * @param {{
 *   epicId: number,
 *   targets: Awaited<ReturnType<typeof resolveAmendTargets>>,
 *   adds: object[],
 *   explicitDelete: boolean,
 * }} args
 */
export function enforceAmendCloseGate({
  epicId,
  targets,
  adds,
  explicitDelete,
}) {
  const liveCloses = [
    ...targets.close.filter((t) => !t.alreadyClosed),
    ...targets.modify.filter((t) => !t.alreadyClosed),
  ];
  if (liveCloses.length === 0 || explicitDelete) return;
  const diff = renderAmendPlanDiff({ epicId, targets, adds });
  const named = liveCloses
    .map((t) => `#${t.issueNumber} (\`${t.ticket.slug}\`)`)
    .join(', ');
  throw new AmendExplicitCloseError(
    `[plan-persist] amend plan would close ${liveCloses.length} live ` +
      `issue(s): ${named}. Review the dry-run diff and re-run with ` +
      '--explicit-delete to apply.',
    { diff },
  );
}

/**
 * Apply the amend ops against the provider, in destructive-last order per
 * slug class: closes first (their disappearance is what the operator
 * confirmed), then modify (close old + create new), then adds. Keeps are
 * never touched by construction — no code path here receives them.
 *
 * @param {{
 *   epicId: number,
 *   provider: {
 *     updateTicket: (id: number, patch: object) => Promise<object>,
 *     createTicket: (parentId: number, payload: object) => Promise<{ id: number }>,
 *   },
 *   targets: Awaited<ReturnType<typeof resolveAmendTargets>>,
 *   validatedBySlug: Map<string, { slug: string, title: string, body?: string, labels?: string[] }>,
 * }} args
 * @returns {Promise<{
 *   closed: Array<{ slug: string, issueNumber: number }>,
 *   recreated: Array<{ slug: string, oldIssueNumber: number, issueNumber: number }>,
 *   created: Array<{ slug: string, issueNumber: number }>,
 *   mapping: Record<string, { entity: 'story', issueNumber: number }>,
 *   closedSlugs: string[],
 * }>}
 */
export async function applyAmendOps({
  epicId,
  provider,
  targets,
  validatedBySlug,
}) {
  const closed = [];
  const recreated = [];
  const created = [];
  const mapping = {};
  const closedSlugs = [];

  const createFromValidated = async (slug) => {
    const validated = validatedBySlug.get(slug);
    if (!validated) {
      throw new Error(
        `[plan-persist] amend apply: no validated ticket for slug "${slug}".`,
      );
    }
    const result = await provider.createTicket(epicId, {
      title: validated.title,
      body: validated.body ?? '',
      labels: validated.labels ?? [],
    });
    return result.id;
  };

  for (const target of targets.close) {
    if (!target.alreadyClosed) {
      await provider.updateTicket(target.issueNumber, { state: 'closed' });
    } else {
      Logger.info(
        `[plan-persist] amend close: #${target.issueNumber} ` +
          `(${target.ticket.slug}) already closed — skipping.`,
      );
    }
    closed.push({ slug: target.ticket.slug, issueNumber: target.issueNumber });
    closedSlugs.push(target.ticket.slug);
  }

  for (const target of targets.modify) {
    if (!target.alreadyClosed) {
      await provider.updateTicket(target.issueNumber, { state: 'closed' });
    }
    const newId = await createFromValidated(target.ticket.slug);
    recreated.push({
      slug: target.ticket.slug,
      oldIssueNumber: target.issueNumber,
      issueNumber: newId,
    });
    mapping[target.ticket.slug] = { entity: 'story', issueNumber: newId };
  }

  for (const [slug] of validatedBySlug) {
    const isModify = targets.modify.some((t) => t.ticket.slug === slug);
    const isKeep = targets.keep.some((t) => t.ticket.slug === slug);
    if (isModify || isKeep) continue;
    const newId = await createFromValidated(slug);
    created.push({ slug, issueNumber: newId });
    mapping[slug] = { entity: 'story', issueNumber: newId };
  }

  for (const target of targets.keep) {
    mapping[target.ticket.slug] = {
      entity: 'story',
      issueNumber: target.issueNumber,
    };
  }

  return { closed, recreated, created, mapping, closedSlugs };
}

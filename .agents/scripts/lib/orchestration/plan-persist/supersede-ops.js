/**
 * supersede-ops.js — close the `/plan --tickets` source issues that the
 * authored Stories supersede (Story #4535).
 *
 * `plan-context.js` fetches the source issues, emits `sourceTickets[]` on the
 * `/plan` envelope, and (with `--out`) writes that envelope to disk.
 * `resolveSourceTicketIds` below reads the id set back off it, so the normal
 * `/plan --tickets` path needs no flag; an explicit `--source-tickets` still
 * wins when passed, as the override for hand-driven runs (Story #4554).
 * Before that thread existed the ids reached
 * this module *solely* via the hand-passed flag, so a forgotten flag left
 * `sourceTicketIds` empty — the partition below then passed **vacuously** (an
 * empty set trivially partitions), the close phase short-circuited, and the
 * run reported success while every source issue stayed open.
 *
 * Two halves, deliberately separated by the `createIssue` boundary:
 *
 *   1. **`assertSupersedePartition`** — a plan-time, fail-closed check that
 *      runs *before* any GitHub write. Mirrors `assertAcceptancePartition`:
 *      every id passed to `--tickets` must be claimed by exactly one Story,
 *      and no Story may claim an id that was not a source ticket. A partial
 *      supersede map is a planning error, not something to paper over at
 *      write time.
 *   2. **`closeSupersededTickets`** — the bookkeeping pass that runs *after*
 *      the Stories exist. It **never throws**: a throw here would leave the
 *      run half-done with Stories already live. An already-closed, deleted,
 *      or inaccessible source ticket is a clean skip-and-report, and a
 *      partial failure reports which tickets were and were not closed so the
 *      operator can finish by hand.
 *
 * Idempotency is keyed off the `superseded-by` structured-comment marker
 * (`upsertStructuredComment`), not a bare `postComment`, so a re-run cannot
 * double-comment.
 *
 * @module lib/orchestration/plan-persist/supersede-ops
 */

import { Logger } from '../../Logger.js';
import { upsertStructuredComment } from '../ticketing.js';

/** Structured-comment type marking a source issue as superseded. */
const SUPERSEDED_BY_COMMENT_TYPE = 'superseded-by';

/**
 * GitHub `state_reason` used when closing a superseded source issue.
 *
 * At persist time nothing has shipped — the issue will not be actioned in
 * its own right, so `not_planned` (not `completed`) is the honest reason.
 * The repo history was inconsistent here (#4211 used `completed`, #2870
 * `not_planned`); this constant settles it.
 */
export const SUPERSEDE_CLOSE_REASON = 'not_planned';

/**
 * Coerce one `supersedes[]` entry into `{ id, note }`.
 *
 * Accepts a bare issue number (`4525`), a numeric string (`"4525"`, `"#4525"`),
 * or an object carrying an optional per-supersede note
 * (`{ id: 4525, note: "…" }`). The note is what lets a Story record a
 * *correction* to the source issue's analysis rather than template-only prose.
 *
 * @param {unknown} entry
 * @param {string} slug Story slug, for error reporting.
 * @returns {{ id: number, note: string|null }}
 */
function normalizeSupersedeEntry(entry, slug) {
  const raw =
    entry !== null && typeof entry === 'object'
      ? (entry.id ?? entry.ticket)
      : entry;
  const id =
    typeof raw === 'string' ? Number(raw.trim().replace(/^#/, '')) : raw;
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(
      `[plan-persist] Story "${slug}" has an invalid supersedes entry: ` +
        `${JSON.stringify(entry)} — expected a positive issue number or ` +
        '{ id, note }.',
    );
  }
  const note =
    entry !== null &&
    typeof entry === 'object' &&
    typeof entry.note === 'string' &&
    entry.note.trim() !== ''
      ? entry.note.trim()
      : null;
  return { id, note };
}

/**
 * Normalize a plan Story ticket's `supersedes[]` into `{ id, note }[]`.
 * Absent / empty is a no-op returning `[]`.
 *
 * @param {object} ticket
 * @param {string} slug
 * @returns {Array<{ id: number, note: string|null }>}
 */
export function normalizeSupersedes(ticket, slug) {
  const raw = ticket?.supersedes;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error(
      `[plan-persist] Story "${slug}" has a non-array supersedes field — ` +
        'expected number[] (or { id, note }[]).',
    );
  }
  const normalized = raw.map((entry) => normalizeSupersedeEntry(entry, slug));
  const seen = new Set();
  for (const { id } of normalized) {
    if (seen.has(id)) {
      throw new Error(
        `[plan-persist] Story "${slug}" claims #${id} twice in supersedes[].`,
      );
    }
    seen.add(id);
  }
  return normalized;
}

/**
 * Normalize a source-ticket id list into deduped positive integers.
 *
 * @param {unknown} ids
 * @param {string} [label] Channel name used in the error message, so an
 *   envelope-derived failure does not blame the `--source-tickets` flag.
 * @returns {number[]}
 */
export function normalizeSourceTicketIds(ids, label = '--source-tickets') {
  if (ids === undefined || ids === null) return [];
  const list = Array.isArray(ids)
    ? ids
    : String(ids)
        .split(',')
        .map((token) => token.trim())
        .filter((token) => token !== '');
  const out = [];
  for (const entry of list) {
    const id =
      typeof entry === 'string' ? Number(entry.replace(/^#/, '')) : entry;
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error(
        `[plan-persist] ${label} expects positive issue ids; got ${JSON.stringify(entry)}.`,
      );
    }
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Pull the `--tickets` id set out of a `plan-context.js` envelope.
 *
 * The envelope's `sourceTickets[]` carries whole ticket records
 * (`{ id, title, body, … }`); only the ids matter here. A non-`tickets`-mode
 * envelope (seed / seed-file) has no source tickets and yields `[]`.
 *
 * @param {object|null} envelope
 * @returns {number[]}
 */
export function extractEnvelopeSourceTicketIds(envelope) {
  const raw = envelope?.sourceTickets;
  if (!Array.isArray(raw) || raw.length === 0) return [];
  return normalizeSourceTicketIds(
    raw.map((ticket) =>
      ticket !== null && typeof ticket === 'object' ? ticket.id : ticket,
    ),
    'plan-context envelope sourceTickets[]',
  );
}

function sameIdSet(a, b) {
  return a.length === b.length && a.every((id) => b.includes(id));
}

/**
 * Resolve which source-ticket ids reach the partition and the close phase.
 *
 * Precedence — an explicit flag wins, the envelope is the default channel
 * (Story #4554):
 *
 *   1. `--source-tickets` when supplied — the explicit override for
 *      hand-driven runs. A disagreement with the envelope is warned about
 *      loudly (the operator is overriding what the run actually fetched)
 *      but honoured.
 *   2. otherwise the envelope's `sourceTickets[]` — so the common
 *      `/plan --tickets` path needs no flag at all.
 *   3. otherwise empty, reported as `origin: 'none'`.
 *
 * `origin` is surfaced on the persist envelope so a run that superseded
 * nothing says *why* rather than looking like a clean no-op.
 *
 * @param {object} [args]
 * @param {unknown} [args.explicitIds] Raw `--source-tickets` value.
 * @param {object|null} [args.envelope] Parsed `plan-context.js` envelope.
 * @returns {{ ids: number[], origin: 'flag'|'envelope'|'none' }}
 */
export function resolveSourceTicketIds({
  explicitIds = null,
  envelope = null,
} = {}) {
  const explicit = normalizeSourceTicketIds(explicitIds);
  const derived = extractEnvelopeSourceTicketIds(envelope);

  if (explicit.length > 0) {
    if (derived.length > 0 && !sameIdSet(explicit, derived)) {
      Logger.warn(
        '[plan-persist] --source-tickets ' +
          `(${explicit.map((id) => `#${id}`).join(', ')}) disagrees with the ` +
          'plan-context envelope ' +
          `(${derived.map((id) => `#${id}`).join(', ')}) — honouring the ` +
          'explicit flag. Drop --source-tickets to use the envelope.',
      );
    }
    return { ids: explicit, origin: 'flag' };
  }

  if (derived.length > 0) {
    Logger.info(
      `[plan-persist] derived ${derived.length} source ticket(s) from the ` +
        `plan-context envelope: ${derived.map((id) => `#${id}`).join(', ')}.`,
    );
    return { ids: derived, origin: 'envelope' };
  }

  return { ids: [], origin: 'none' };
}

function describeStoryIds(entries) {
  return entries.map((e) => `"${e}"`).join(', ');
}

/**
 * Fail closed on a partial supersede map.
 *
 * Runs **before** `createIssue` so a mis-authored map never leaves Stories
 * live against an inconsistent tracker.
 *
 * @param {Array<{ slug: string, supersedes: Array<{ id: number }> }>} stories
 * @param {number[]} sourceTicketIds Ids passed to `/plan --tickets`.
 */
export function assertSupersedePartition(stories, sourceTicketIds = []) {
  const list = Array.isArray(stories) ? stories : [];
  const sources = new Set(sourceTicketIds);

  /** @type {Map<number, string[]>} */
  const claims = new Map();
  for (const story of list) {
    for (const { id } of story.supersedes ?? []) {
      const owners = claims.get(id) ?? [];
      owners.push(story.slug);
      claims.set(id, owners);
    }
  }

  const errors = [];

  for (const [id, owners] of claims) {
    if (owners.length > 1) {
      errors.push(
        `source ticket #${id} is claimed by ${owners.length} Stories ` +
          `(${describeStoryIds(owners)}) — exactly one Story must own it.`,
      );
    }
    if (!sources.has(id)) {
      errors.push(
        `Story "${owners[0]}" supersedes #${id}, which was not passed to ` +
          '--tickets. Only source tickets may be superseded.',
      );
    }
  }

  for (const id of sources) {
    if (!claims.has(id)) {
      errors.push(
        `source ticket #${id} is not claimed by any Story's supersedes[] — ` +
          'a partial supersede map is a planning error. Claim it, or drop it ' +
          'from --tickets.',
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `[plan-persist] supersede partition failed with ${errors.length} ` +
        `error(s):\n${errors.map((e) => `  - ${e}`).join('\n')}`,
    );
  }
}

/**
 * Render the supersede comment posted on a source issue.
 *
 * @param {object} args
 * @param {{ id: number, title: string }} args.story The claiming Story.
 * @param {string|null} [args.note] Optional per-supersede note authored on
 *   the Story — carries a correction to this issue's analysis.
 * @param {number[]} args.sourceTicketIds Full `--tickets` argument.
 * @returns {string}
 */
export function buildSupersedeCommentBody({
  story,
  note = null,
  sourceTicketIds,
}) {
  // Story #4540 retired the plan-run label, which used to be listed here
  // alongside the type/state labels.
  const labels = ['`type::story`', '`agent::ready`'];

  const lines = [
    `**Superseded by #${story.id}** — *${story.title}* (${labels.join(', ')}).`,
    '',
    `Planned via \`/plan --tickets ${sourceTicketIds.join(',')}\`.`,
  ];
  if (note) {
    lines.push('', note);
  }
  lines.push(
    '',
    'The analysis in this issue is preserved as the historical record; ' +
      `#${story.id} carries the delivery contract.`,
  );
  return lines.join('\n');
}

/**
 * Resolve the live state of a source ticket.
 *
 * @returns {Promise<{ ok: true, state: string } | { ok: false, reason: string }>}
 */
async function probeSourceTicket(provider, id) {
  try {
    const ticket = await provider.getTicket(id, { fresh: true });
    if (!ticket) return { ok: false, reason: 'not-found' };
    return { ok: true, state: String(ticket.state ?? 'open').toLowerCase() };
  } catch (err) {
    return { ok: false, reason: `inaccessible: ${err.message}` };
  }
}

/**
 * Comment on and close one source ticket. Never throws.
 *
 * @returns {Promise<{ outcome: 'closed'|'skipped'|'failed', reason?: string }>}
 */
async function closeOneSupersededTicket({
  provider,
  id,
  note,
  story,
  sourceTicketIds,
}) {
  const probe = await probeSourceTicket(provider, id);
  if (!probe.ok) return { outcome: 'skipped', reason: probe.reason };
  if (probe.state === 'closed') {
    return { outcome: 'skipped', reason: 'already-closed' };
  }

  try {
    await upsertStructuredComment(
      provider,
      id,
      SUPERSEDED_BY_COMMENT_TYPE,
      buildSupersedeCommentBody({
        story,
        note,
        sourceTicketIds,
      }),
    );
    await provider.updateTicket(id, {
      state: 'closed',
      state_reason: SUPERSEDE_CLOSE_REASON,
    });
    return { outcome: 'closed' };
  } catch (err) {
    return { outcome: 'failed', reason: err.message };
  }
}

/**
 * @typedef {object} SupersedeReport
 * @property {boolean} enabled
 * @property {boolean} dryRun
 * @property {string|null} reason  Why the phase was skipped wholesale.
 * @property {'flag'|'envelope'|'none'} [sourceTicketOrigin] Which channel the
 *   source ids came from. Stamped by `runPlanPersist`, not this module.
 * @property {number[]} closed
 * @property {Array<{ ticket: number, storySlug: string }>} planned Dry-run
 *   only. Keyed by slug, not id: under `--dry-run` no issue was created, so
 *   `createStoryIssues` hands back a synthetic negative placeholder id. The
 *   slug is the only identifier that means anything before the writes land.
 * @property {Array<{ ticket: number, reason: string }>} skipped
 * @property {Array<{ ticket: number, reason: string }>} failed
 */

function emptyReport(overrides) {
  return {
    enabled: false,
    dryRun: false,
    reason: null,
    closed: [],
    planned: [],
    skipped: [],
    failed: [],
    ...overrides,
  };
}

/**
 * Comment on and close every superseded source ticket.
 *
 * **Never throws** and never fails the run — Stories are already live by the
 * time this executes, so bookkeeping failures degrade to a report the
 * operator can act on.
 *
 * @param {object} args
 * @param {object} args.provider
 * @param {Array<{ slug: string, supersedes: Array<{ id: number, note: string|null }> }>} args.stories
 * @param {Array<{ slug: string, id: number, title: string }>} args.created
 * @param {number[]} args.sourceTicketIds
 * @param {boolean} [args.dryRun=false]
 * @param {boolean} [args.closeSuperseded=true]
 * @returns {Promise<SupersedeReport>}
 */
export async function closeSupersededTickets({
  provider,
  stories,
  created,
  sourceTicketIds,
  dryRun = false,
  closeSuperseded = true,
}) {
  const sources = Array.isArray(sourceTicketIds) ? sourceTicketIds : [];
  if (sources.length === 0) {
    return emptyReport({ reason: 'no-source-tickets' });
  }
  if (!closeSuperseded) {
    return emptyReport({ reason: 'disabled-by-flag' });
  }

  const createdBySlug = new Map(
    (created ?? []).map((story) => [story.slug, story]),
  );

  const report = emptyReport({ enabled: true, dryRun });

  for (const story of stories ?? []) {
    const createdStory = createdBySlug.get(story.slug);
    for (const { id, note } of story.supersedes ?? []) {
      if (!createdStory) {
        report.skipped.push({ ticket: id, reason: 'story-not-created' });
        continue;
      }
      if (dryRun) {
        report.planned.push({ ticket: id, storySlug: createdStory.slug });
        continue;
      }
      const result = await closeOneSupersededTicket({
        provider,
        id,
        note,
        story: createdStory,
        sourceTicketIds: sources,
      });
      if (result.outcome === 'closed') {
        report.closed.push(id);
      } else if (result.outcome === 'skipped') {
        report.skipped.push({ ticket: id, reason: result.reason });
      } else {
        report.failed.push({ ticket: id, reason: result.reason });
      }
    }
  }

  logSupersedeReport(report);
  return report;
}

/**
 * Surface the supersede outcome on the console so a partial failure is
 * visible without reading the JSON envelope.
 *
 * @param {SupersedeReport} report
 */
function logSupersedeReport(report) {
  if (report.dryRun) {
    for (const { ticket, storySlug } of report.planned) {
      Logger.info(
        `[plan-persist] dry-run: would comment on and close #${ticket} ` +
          `as superseded by Story "${storySlug}" (${SUPERSEDE_CLOSE_REASON}).`,
      );
    }
    return;
  }
  if (report.closed.length > 0) {
    Logger.info(
      `[plan-persist] closed ${report.closed.length} superseded source ` +
        `ticket(s): ${report.closed.map((id) => `#${id}`).join(', ')}.`,
    );
  }
  for (const { ticket, reason } of report.skipped) {
    Logger.info(`[plan-persist] skipped source ticket #${ticket}: ${reason}.`);
  }
  for (const { ticket, reason } of report.failed) {
    Logger.warn(
      `[plan-persist] could NOT close source ticket #${ticket}: ${reason} — ` +
        'close it by hand.',
    );
  }
}

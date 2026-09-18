/**
 * supersede-ops.js — close the `/mandrel-plan --tickets` source issues the
 * authored Stories supersede. The `superseded-by` marker makes re-runs
 * idempotent.
 *
 * @module lib/orchestration/plan-persist/supersede-ops
 */

import { Logger } from '../../Logger.js';
import { AGENT_LABELS } from '../../label-constants.js';
import {
  concurrentMap,
  FANOUT_CONCURRENCY,
} from '../../util/concurrent-map.js';
import { rollUpEpicForStory } from '../epic-rollup.js';
import { upsertStructuredComment } from '../ticketing.js';

const SUPERSEDED_BY_COMMENT_TYPE = 'superseded-by';

/** Nothing has shipped at persist time, so `not_planned`, not `completed`. */
export const SUPERSEDE_CLOSE_REASON = 'not_planned';

/**
 * Stripped, not rewritten to `agent::done`: a retired ticket has no agent
 * state, and a lingering `agent::blocked` pins its container Epic open.
 */
const AGENT_STATE_LABELS = Object.freeze(Object.values(AGENT_LABELS));

/**
 * Close and strip `agent::*` in ONE write, so the ticket never ends closed
 * but still blocked. No agent label → bare close, sparing a read-back.
 *
 * @param {{ labels?: unknown }} ticket The probe's fresh copy.
 * @returns {object} Mutations for `provider.updateTicket`.
 */
function supersedeCloseMutations(ticket) {
  const close = { state: 'closed', state_reason: SUPERSEDE_CLOSE_REASON };
  const labels = Array.isArray(ticket?.labels) ? ticket.labels : [];
  const remove = AGENT_STATE_LABELS.filter((label) => labels.includes(label));
  if (remove.length === 0) return close;
  return { ...close, labels: { remove }, _ticketSnapshot: ticket };
}

/**
 * Coerce a number, `"#N"` string, or `{ id, note }` into `{ id, note }`.
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
 * @param {unknown} ids
 * @param {string} [label] Channel named in the error message.
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
 * Resolve the source-ticket ids: an explicit `--source-tickets` wins (warned
 * when it disagrees with the envelope), else the envelope's
 * `sourceTickets[]`. `origin` lets a run that superseded nothing say why.
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
 * @param {Array<{ slug: string, supersedes?: Array<{ id: number }> }>} list
 * @returns {Map<number, string[]>} id → claiming slugs, in draft order.
 */
function indexSupersedeClaims(list) {
  /** @type {Map<number, string[]>} */
  const claims = new Map();
  for (const story of list) {
    for (const { id } of story.supersedes ?? []) {
      const owners = claims.get(id) ?? [];
      owners.push(story.slug);
      claims.set(id, owners);
    }
  }
  return claims;
}

/**
 * Runs before `createIssue`. A non-source or doubly-claimed id throws; an
 * unclaimed source id goes to the primary Story (`stories[0]`, as the list
 * arrives in create order) with a warning.
 *
 * @param {Array<{ slug: string, supersedes: Array<{ id: number, note: string|null }> }>} stories
 *   Dependency-ordered and non-empty.
 * @param {number[]} sourceTicketIds Ids passed to `/mandrel-plan --tickets`.
 * @returns {string[]} One warning per id assigned by default.
 */
export function resolveSupersedePartition(stories, sourceTicketIds = []) {
  const list = Array.isArray(stories) ? stories : [];
  const sources = new Set(sourceTicketIds);
  const claims = indexSupersedeClaims(list);

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
  if (errors.length > 0) {
    throw new Error(
      `[plan-persist] supersede partition failed with ${errors.length} ` +
        `error(s):\n${errors.map((e) => `  - ${e}`).join('\n')}`,
    );
  }

  const primary = list[0];
  const warnings = [];
  for (const id of sources) {
    if (claims.has(id)) continue;
    primary.supersedes = [...(primary.supersedes ?? []), { id, note: null }];
    warnings.push(
      `source ticket #${id} was claimed by no Story's supersedes[] — ` +
        `assigned to the primary Story "${primary.slug}". Author the claim ` +
        'explicitly if another Story is the one that replaces it.',
    );
  }
  return warnings;
}

/**
 * @param {object} args
 * @param {{ id: number, title: string }} args.story The claiming Story.
 * @param {string|null} [args.note] Correction to this issue's analysis.
 * @param {number[]} args.sourceTicketIds Full `--tickets` argument.
 * @returns {string}
 */
export function buildSupersedeCommentBody({
  story,
  note = null,
  sourceTicketIds,
}) {
  const labels = ['`type::story`', '`agent::ready`'];

  const lines = [
    `**Superseded by #${story.id}** — *${story.title}* (${labels.join(', ')}).`,
    '',
    `Planned via \`/mandrel-plan --tickets ${sourceTicketIds.join(',')}\`.`,
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
 * The ticket rides along so the close needs no second read.
 *
 * @returns {Promise<{ ok: true, state: string, ticket: object } | { ok: false, reason: string }>}
 */
async function probeSourceTicket(provider, id) {
  try {
    const ticket = await provider.getTicket(id, { fresh: true });
    if (!ticket) return { ok: false, reason: 'not-found' };
    return {
      ok: true,
      state: String(ticket.state ?? 'open').toLowerCase(),
      ticket,
    };
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
    await provider.updateTicket(id, supersedeCloseMutations(probe.ticket));
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
 * @property {'flag'|'envelope'|'none'} [sourceTicketOrigin] Stamped by `runPlanPersist`.
 * @property {number[]} closed
 * @property {Array<{ ticket: number, storySlug: string }>} planned Dry-run
 *   only; keyed by slug because dry-run Story ids are placeholders.
 * @property {Array<{ ticket: number, reason: string }>} skipped
 * @property {Array<{ ticket: number, reason: string }>} failed
 * @property {{ closed: number[], pending: number[] }} epicRollup
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
    epicRollup: { closed: [], pending: [] },
    ...overrides,
  };
}

/**
 * Re-derive the container Epic above every closed ticket — no delivery will
 * ever fire that rollup for a superseded cohort. Runs after the closes land
 * (it reads child state back), and sequentially with one shared `skipEpicIds`
 * so siblings do not re-close the same Epic.
 *
 * @param {{ closedIds: number[], provider: object, config?: object }} opts
 * @returns {Promise<{ closed: number[], pending: number[] }>}
 */
async function rollUpContainersFor({ closedIds, provider, config }) {
  const seen = new Set();
  const closed = new Set();
  const pending = new Set();
  for (const storyId of closedIds) {
    const outcome = await rollUpEpicForStory({
      storyId,
      provider,
      config,
      skipEpicIds: seen,
    });
    for (const epic of outcome.epics) seen.add(epic.epicId);
    for (const epicId of outcome.closed) closed.add(epicId);
    for (const epicId of outcome.pending) pending.add(epicId);
  }
  // A container reported pending by one ticket's rollup and closed by a later
  // one is closed: the last answer saw the whole cohort.
  for (const epicId of closed) pending.delete(epicId);
  return { closed: [...closed], pending: [...pending] };
}

/**
 * Comment on and close every superseded source ticket. Never throws: Stories
 * are already live, so failures degrade to a report.
 *
 * @param {object} args
 * @param {object} args.provider
 * @param {Array<{ slug: string, supersedes: Array<{ id: number, note: string|null }> }>} args.stories
 * @param {Array<{ slug: string, id: number, title: string }>} args.created
 * @param {number[]} args.sourceTicketIds
 * @param {object} [args.config] Resolved `.agentrc.json`, for the Epic rollup.
 * @param {boolean} [args.dryRun=false]
 * @param {boolean} [args.closeSuperseded=true]
 * @returns {Promise<SupersedeReport>}
 */
export async function closeSupersededTickets({
  provider,
  stories,
  created,
  sourceTicketIds,
  config,
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
  const units = collectSupersedeUnits(stories, createdBySlug);

  // The mapper never throws, so no unit is abandoned for a sibling's failure.
  // Units are distinct tickets (the partition refused duplicates); within one
  // the probe → comment → close sequence stays strictly ordered.
  const outcomes = await concurrentMap(
    units,
    ({ id, note, createdStory }) => {
      if (!createdStory) {
        return { outcome: 'skipped', reason: 'story-not-created' };
      }
      if (dryRun) return { outcome: 'planned' };
      return closeOneSupersededTicket({
        provider,
        id,
        note,
        story: createdStory,
        sourceTicketIds: sources,
      });
    },
    { concurrency: FANOUT_CONCURRENCY },
  );

  const report = emptyReport({ enabled: true, dryRun });
  outcomes.forEach((result, index) => {
    recordSupersedeOutcome(report, units[index], result);
  });

  if (report.closed.length > 0) {
    report.epicRollup = await rollUpContainersFor({
      closedIds: report.closed,
      provider,
      config,
    });
  }

  logSupersedeReport(report);
  return report;
}

/**
 * @param {Array<{ slug: string, supersedes?: Array<{ id: number, note: string|null }> }>|undefined} stories
 * @param {Map<string, { slug: string, id: number, title: string }>} createdBySlug
 * @returns {Array<{ id: number, note: string|null, createdStory: object|undefined }>}
 */
function collectSupersedeUnits(stories, createdBySlug) {
  const units = [];
  for (const story of stories ?? []) {
    const createdStory = createdBySlug.get(story.slug);
    for (const { id, note } of story.supersedes ?? []) {
      units.push({ id, note, createdStory });
    }
  }
  return units;
}

/**
 * @param {SupersedeReport} report
 * @param {{ id: number, createdStory: object|undefined }} unit
 * @param {{ outcome: string, reason?: string }} result
 * @returns {void}
 */
function recordSupersedeOutcome(report, unit, result) {
  if (result.outcome === 'closed') {
    report.closed.push(unit.id);
    return;
  }
  if (result.outcome === 'planned') {
    report.planned.push({
      ticket: unit.id,
      storySlug: unit.createdStory.slug,
    });
    return;
  }
  if (result.outcome === 'skipped') {
    report.skipped.push({ ticket: unit.id, reason: result.reason });
    return;
  }
  report.failed.push({ ticket: unit.id, reason: result.reason });
}

/**
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
  if (report.epicRollup.closed.length > 0) {
    Logger.info(
      `[plan-persist] container Epic(s) closed by the supersede rollup: ` +
        `${report.epicRollup.closed.map((id) => `#${id}`).join(', ')}.`,
    );
  }
}

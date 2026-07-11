/**
 * phases/gather-signals.js — retro Phase 1: aggregate retro signals.
 *
 * Reads child Stories' `story-perf-summary` comments, descendant labels
 * (HITL events), the Epic's `parked-follow-ons` structured comment, and
 * per-Story `signals.ndjson` streams. Composes the routed-proposal
 * sections via `composeRoutedProposals`.
 *
 * Exported as `gatherRetroSignals` for the parent sequencer (and tests).
 */

import { TYPE_LABELS } from '../../../label-constants.js';
import {
  forEachEpicLine,
  forEachLine,
} from '../../../observability/signals-writer.js';
import { concurrentMap } from '../../../util/concurrent-map.js';
import { read as readEpicRunState } from '../../epic-run-state-store.js';
import { composeRoutedProposals } from '../../retro-proposals.js';
import { parseFencedJsonComment } from '../../structured-comment-parser.js';
import { findStructuredComment } from '../../ticketing.js';

/**
 * Default framework repo (the Mandrel mirror) used when the caller does
 * not supply an override. Consumer projects re-routing framework friction
 * back to mandrel rely on this constant.
 */
export const DEFAULT_FRAMEWORK_REPO = 'dsj1984/mandrel';

const RECUT_BODY_MARKER = /<!--\s*recut-of:\s*#?\d+\s*-->/;

// Story #3347 — bounded fan-out cap for the per-Story `signals.ndjson`
// reads below. Mirrors the read-concurrency convention used elsewhere in
// the orchestrator (e.g. SUBTICKET_HYDRATION_CONCURRENCY,
// CASCADE_SIBLING_READ_CONCURRENCY); keeps a large Epic from opening an
// unbounded number of concurrent file handles while still collapsing N
// sequential disk reads into one wall-clock fan-out.
const SIGNALS_READ_CONCURRENCY = 8;

// Detects #NNN issue references in an Epic body — any match means the Epic
// likely has child Stories enumerated in the planning artifact, so a
// zero-descendant walk is suspicious.
const EPIC_BODY_REFERENCE = /#\d+/;

/**
 * Fallback category stamped on a snapshot-derived blocked event that
 * carries no `category` of its own. A non-empty category is what promotes
 * the event to an actionable routed proposal in `composeRoutedProposals`,
 * so a category-less `agent::blocked` record must still resolve to a
 * concrete bucket rather than being silently dropped.
 */
const BLOCKED_EVENT_FALLBACK_CATEGORY = 'agent-blocked';

/**
 * Pure: aggregate `frictionByCategory` payloads into a single integer.
 */
function sumFriction(byCategory) {
  if (!byCategory || typeof byCategory !== 'object') return 0;
  let total = 0;
  for (const v of Object.values(byCategory)) {
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) total += v;
  }
  return total;
}

/**
 * Fold one parsed `signals.ndjson` record into the routed-signal
 * accumulator. Shared by the per-Story and per-Epic scans so both streams
 * contribute to the SAME unified counts that feed the routed proposals AND
 * the compact/full retro decision. Reads the canonical envelope: top-level
 * `category` and the string `source` classifier tag (Epic #4406). Non-object
 * records and records without a `category` contribute nothing.
 *
 * @param {unknown} parsed
 * @param {Array<{ category: string, source: 'framework'|'consumer' }>} routedSignals
 */
function accumulateSignalRecord(parsed, routedSignals) {
  if (parsed === null || typeof parsed !== 'object') return;
  const record = /** @type {Record<string, unknown>} */ (parsed);
  const category = typeof record.category === 'string' ? record.category : null;
  if (!category) return;
  const source = record.source === 'framework' ? 'framework' : 'consumer';
  routedSignals.push({ category, source });
}

/**
 * Read the `epic-run-state` snapshot and project every Story still recorded
 * as `blocked` into an `unresolvedBlockedEvents` entry for
 * `composeRoutedProposals`. Each event carries a **non-empty** category —
 * the snapshot record's own `category` when present, otherwise the
 * `agent-blocked` fallback — so it force-promotes an actionable proposal
 * even when no friction signal shares its category. Best-effort: a read
 * failure or shapeless snapshot degrades to an empty array (observability
 * MUST NOT take down the retro path).
 *
 * @param {{
 *   epicId: number,
 *   provider: object,
 *   logger?: { warn?: Function },
 *   readFn: typeof readEpicRunState,
 * }} args
 * @returns {Promise<Array<{ ticketId?: number, category: string, source: 'framework'|'consumer' }>>}
 */
async function readUnresolvedBlockedEvents({
  epicId,
  provider,
  logger,
  readFn,
}) {
  let snapshot;
  try {
    snapshot = await readFn({ provider, epicId });
  } catch (err) {
    logger?.warn?.(
      `[retro-runner] Failed to read epic-run-state for blocked events (continuing): ${
        err?.message ?? err
      }`,
    );
    return [];
  }
  const storiesMap =
    snapshot && typeof snapshot.stories === 'object' && snapshot.stories
      ? snapshot.stories
      : {};
  const events = [];
  for (const [key, record] of Object.entries(storiesMap)) {
    if (!record || typeof record !== 'object' || record.status !== 'blocked') {
      continue;
    }
    const rawCategory =
      typeof record.category === 'string' ? record.category.trim() : '';
    const category =
      rawCategory.length > 0 ? rawCategory : BLOCKED_EVENT_FALLBACK_CATEGORY;
    const source = record.source === 'framework' ? 'framework' : 'consumer';
    const ticketId = Number(key);
    const event = { category, source };
    if (Number.isInteger(ticketId) && ticketId > 0) event.ticketId = ticketId;
    events.push(event);
  }
  return events;
}

/**
 * Walk every descendant ticket of `epicId` once. Returns the flat list with
 * each ticket's labels + body + state — the consumer derives its own
 * counts from this snapshot. Pure with respect to the provider injection.
 *
 * `provider.getSubTickets` is part of the `ITicketingProvider` contract;
 * the call is **not** optional-chained so a missing method (or a typo'd
 * test stub) surfaces as a thrown error rather than a silent empty graph.
 */
async function collectDescendants(provider, epicId) {
  const visited = new Set([epicId]);
  const out = [];
  // Story #2853 — level-order BFS so every parent at the current depth
  // fires its getSubTickets call concurrently. Previously this loop
  // awaited one parent at a time, serializing one network round-trip per
  // descendant tier (a 2-level Epic with 10 Stories was 11 sequential
  // calls). Each `getSubTickets` already fans out child hydration
  // internally with concurrency=8 (issues.js:SUBTICKET_HYDRATION_CONCURRENCY),
  // so outer parallelism is consistent with the existing design.
  let frontier = [epicId];
  while (frontier.length > 0) {
    const results = await Promise.all(
      frontier.map((id) => provider.getSubTickets(id)),
    );
    const nextFrontier = [];
    for (const subs of results) {
      for (const sub of subs ?? []) {
        const subId = Number(sub?.id ?? sub?.number);
        if (!Number.isInteger(subId) || visited.has(subId)) continue;
        visited.add(subId);
        out.push(sub);
        nextFrontier.push(subId);
      }
    }
    frontier = nextFrontier;
  }
  return out;
}

/**
 * Defensive guard: when the descendant walker returned zero, probe the
 * Epic ticket itself. If the Epic exists and its body references child
 * issues (e.g., `#123` planning refs), the empty walk is almost certainly
 * a contract drift in the underlying provider — emit a loud warn so the
 * silent failure surfaces. Probe errors degrade silently (the guard is
 * best-effort observability, not a correctness gate).
 */
async function warnIfEpicLooksPopulated({ epicId, provider, logger }) {
  let epic;
  try {
    epic = await provider.getTicket?.(epicId);
  } catch (err) {
    logger?.warn?.(
      `[retro-runner] guard: getTicket(#${epicId}) failed (continuing): ${err?.message ?? err}`,
    );
    return;
  }
  if (!epic) return;
  const body = typeof epic.body === 'string' ? epic.body : '';
  if (!EPIC_BODY_REFERENCE.test(body)) return;
  logger?.warn?.(
    `[retro-runner] WARNING: Epic #${epicId} body references child issues, ` +
      'but the descendant walker returned zero — retro will under-report ' +
      'friction. Possible provider contract drift in getSubTickets.',
  );
}

/**
 * Read raw retro signals from the GitHub graph. Pure with respect to the
 * provider injection — exported so tests can drive the predicate end-to-end
 * with a stub provider.
 *
 * When `descendants.length === 0`, the function probes `provider.getTicket`
 * to distinguish "Epic legitimately empty" from "the descendant walker
 * silently returned nothing under a populated Epic" (the failure mode the
 * pre-Story #2289 `getSubIssues` contract drift produced). A populated
 * Epic with zero walked descendants emits a loud warn via the supplied
 * `logger` so the silent failure becomes visible. Probe failure degrades
 * gracefully — the function never throws on the guard alone.
 *
 * **2-tier ledgers (Story #3151, Story #3200).** Under the 2-tier
 * hierarchy (Epic → Story; no Task-tier children), `friction`
 * / `parked` / `recuts` / `storyPerfSummaries` are all Story-scoped, so
 * the function continues to produce a non-empty signals report. The
 * empty-walk guard above is **not** triggered for this shape because
 * `descendants` is populated (it contains the Stories themselves); the
 * guard fires only when the walker returned literally nothing under a
 * body that references children.
 *
 * @returns {Promise<{
 *   stories: Array<{ id: number, body?: string, labels?: string[] }>,
 *   counts:  { friction: number, parked: number, recuts: number, hitl: number },
 *   storyPerfSummaries: object[],
 *   epicPerfReport: object|null,
 *   parkedFollowOns: { recuts: object[], parked: object[], present: boolean },
 * }>}
 */
export async function gatherRetroSignals({
  epicId,
  provider,
  logger,
  frameworkRepo,
  consumerRepo,
  forEachLineFn = forEachLine,
  forEachEpicLineFn = forEachEpicLine,
  epicRunStateReadFn = readEpicRunState,
  composeRoutedProposalsFn = composeRoutedProposals,
}) {
  const descendants = await collectDescendants(provider, epicId);
  if (descendants.length === 0) {
    await warnIfEpicLooksPopulated({ epicId, provider, logger });
  }
  const stories = descendants.filter((t) =>
    (t.labels ?? []).includes(TYPE_LABELS.STORY),
  );
  // HITL count: distinct descendants that currently or historically carry
  // `agent::blocked`. We can only see "currently" here without an event
  // stream — counts undercount but never overcount.
  const hitl = descendants.filter((t) =>
    (t.labels ?? []).includes('agent::blocked'),
  ).length;

  // Aggregate per-Story `story-perf-summary` payloads for friction totals.
  // Story #2853 — fan out the per-Story `findStructuredComment` lookups
  // concurrently. Each Story's lookup resolves to a single paginated
  // `getTicketComments` round-trip (the raw-comments cache at
  // ticketing/reads.js:381-412 dedupes the per-type lookups within a
  // ticket), so parallelization adds no extra wire calls — it just
  // collapses N sequential round-trips into one wall-clock fan-out.
  // `Promise.all` preserves index order, so the resulting
  // `storyPerfSummaries` array stays deterministic relative to `stories`.
  const perStoryComments = await Promise.all(
    stories.map((story) =>
      findStructuredComment(
        provider,
        story.id ?? story.number,
        'story-perf-summary',
      ),
    ),
  );
  const storyPerfSummaries = [];
  let frictionFromSummaries = 0;
  for (const comment of perStoryComments) {
    const parsed = parseFencedJsonComment(comment);
    if (parsed) {
      storyPerfSummaries.push(parsed);
      frictionFromSummaries += sumFriction(parsed.frictionByCategory);
    }
  }

  // Epic-level perf report (used by the full retro's "Top hotspots").
  const epicPerfComment = await findStructuredComment(
    provider,
    epicId,
    'epic-perf-report',
  );
  const epicPerfReport = parseFencedJsonComment(epicPerfComment);

  // Parked + recut counts: prefer the structured comment; fall back to body
  // grep for the recut marker when the comment is absent.
  const parkedComment = await findStructuredComment(
    provider,
    epicId,
    'parked-follow-ons',
  );
  const parkedParsed = parseFencedJsonComment(parkedComment);
  let parkedFollowOns;
  if (parkedParsed) {
    parkedFollowOns = {
      present: true,
      recuts: Array.isArray(parkedParsed.recuts) ? parkedParsed.recuts : [],
      parked: Array.isArray(parkedParsed.parked) ? parkedParsed.parked : [],
    };
  } else {
    const recutsByBody = stories.filter(
      (s) => typeof s.body === 'string' && RECUT_BODY_MARKER.test(s.body),
    );
    parkedFollowOns = {
      present: false,
      recuts: recutsByBody.map((s) => ({ storyId: s.id ?? s.number })),
      parked: [],
    };
  }

  // Story #4417 — the compact/full retro decision, the automerge-verdict
  // cleanSprint flag, and the routed proposals must all read from ONE
  // signals scan. We fold the per-Story `signals.ndjson` streams AND the
  // per-Epic `signals.ndjson` stream (the `appendEpicSignal` wave-lifecycle
  // writers, e.g. lifecycle-emit) into a single `routedSignals`
  // accumulation; `counts.friction` then derives from that same scan so a
  // retro can never read "clean" from the comment substrate while
  // actionable friction sits unrendered in the ndjson substrate.
  //
  // Story #2558 — the streams are source-tagged by the writer's
  // `tagSignalSource`; `accumulateSignalRecord` reads the canonical
  // envelope (top-level `category` + string `source`, Epic #4406). Read
  // failures degrade silently — observability MUST NOT take down the retro.
  //
  // Story #3347 — the per-Story reads fan out via `concurrentMap` with a
  // bounded cap (`SIGNALS_READ_CONCURRENCY`); `concurrentMap` preserves
  // input order so we concatenate the per-Story `routedSignals` in
  // `stories` order, keeping the composed `routedProposals` deterministic.
  const perStorySignals = await concurrentMap(
    stories,
    async (story) => {
      const sid = Number(story.id ?? story.number);
      if (!Number.isInteger(sid) || sid <= 0) {
        return { routedSignals: [] };
      }
      const localRoutedSignals = [];
      try {
        await forEachLineFn(epicId, sid, (parsed) => {
          accumulateSignalRecord(parsed, localRoutedSignals);
        });
      } catch (err) {
        logger?.warn?.(
          `[retro-runner] forEachLine failed for story #${sid} (continuing): ${
            err?.message ?? err
          }`,
        );
      }
      return { routedSignals: localRoutedSignals };
    },
    { concurrency: SIGNALS_READ_CONCURRENCY },
  );
  const routedSignals = [];
  for (const perStory of perStorySignals) {
    routedSignals.push(...perStory.routedSignals);
  }

  // Story #4417 — fold in the per-Epic `signals.ndjson` stream
  // (`appendEpicSignal` wave-lifecycle writers, e.g. lifecycle-emit) so the
  // unified scan is not blind to Epic-scoped friction that never lands on
  // an individual Story stream.
  try {
    await forEachEpicLineFn(epicId, (parsed) => {
      accumulateSignalRecord(parsed, routedSignals);
    });
  } catch (err) {
    logger?.warn?.(
      `[retro-runner] forEachEpicLine failed for epic #${epicId} (continuing): ${
        err?.message ?? err
      }`,
    );
  }

  const counts = {
    // `friction` derives from the unified ndjson scan (every categorized
    // signal across the per-Story and per-Epic streams) PLUS the legacy
    // story-perf-summary totals, so a non-empty ndjson substrate forces the
    // full retro even when no `story-perf-summary` comment was posted.
    friction: frictionFromSummaries + routedSignals.length,
    parked: parkedFollowOns.parked.length,
    recuts: parkedFollowOns.recuts.length,
    hitl,
  };

  // Story #4417 — project unresolved `agent::blocked` Stories from the
  // epic-run-state snapshot into force-flag events for the routed-proposal
  // composer. This replaces the formerly hardwired empty array: a blocked
  // Story now force-promotes an actionable proposal even absent a matching
  // friction category (its category falls back to `agent-blocked`).
  const unresolvedBlockedEvents = await readUnresolvedBlockedEvents({
    epicId,
    provider,
    logger,
    readFn: epicRunStateReadFn,
  });

  // Resolve repos. The framework repo falls back to the Mandrel mirror
  // constant (a known, stable default). The consumer repo does NOT fall
  // back to the framework repo: when the caller resolves no consumer repo
  // from `config.github`, the consumer proposal pane is DISABLED loudly
  // (Story #4417) rather than silently routing consumer-tagged friction at
  // the framework mirror.
  const resolvedFrameworkRepo =
    typeof frameworkRepo === 'string' && frameworkRepo.length > 0
      ? frameworkRepo
      : DEFAULT_FRAMEWORK_REPO;
  const resolvedConsumerRepo =
    typeof consumerRepo === 'string' && consumerRepo.length > 0
      ? consumerRepo
      : '';
  if (resolvedConsumerRepo.length === 0) {
    logger?.warn?.(
      '[retro-runner] No consumer repo resolved from config.github — the ' +
        'consumer proposal pane is DISABLED for this retro. Set ' +
        'github.owner / github.repo to route consumer-tagged friction.',
    );
  }

  const routedProposals = composeRoutedProposalsFn({
    epicId,
    frameworkRepo: resolvedFrameworkRepo,
    consumerRepo: resolvedConsumerRepo,
    signals: routedSignals,
    unresolvedBlockedEvents,
  });

  return {
    stories,
    counts,
    storyPerfSummaries,
    epicPerfReport,
    parkedFollowOns,
    routedProposals,
  };
}

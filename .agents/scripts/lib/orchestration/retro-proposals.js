/**
 * Pure composer: source-tagged friction signals → framework / consumer /
 * discarded proposal sections. No I/O, no clock; output sorted by `category`
 * so a given input renders byte-identically.
 *
 * A category is actionable at ≥ 2 occurrences (any anchor kind — a per-Story
 * window has population 1, so a lower bar files every event) or when an
 * unresolved block forces it; recovered incidents net out first. Actionable
 * items route to the dominant `source` (ties → first seen). The corpus is the
 * whole recurrence window, so bodies name the window, not the triggering run.
 * Unpublishable (fixture) Story ids are never printed, and a bucket whose ids
 * are all unpublishable is discarded rather than filed.
 *
 * @typedef {Object} FrictionSignal
 * @property {string} category
 * @property {"framework"|"consumer"} source
 * @property {number} [storyId]  Used to net out recovered incidents.
 * @property {string} [tool]     Descriptive only, never routing.
 * @property {string|null} [ts]  ISO-8601; `null` when unreadable.
 * @property {object} [details]  `details.recovered === true` marks a recovery.
 *
 * @typedef {Object} BlockedEvent
 * @property {number} ticketId
 * @property {"framework"|"consumer"} source
 * @property {string} [category]
 * @property {string} [summary]
 *
 * @typedef {Object} RoutedProposalsInput
 * @property {number}                anchorId
 * @property {'story'|'run'}  [anchorKind]    Wording only (default `story`).
 * @property {string}                [runToken]    `plan-run::<id>` / `adhoc-<ids>`.
 * @property {Array<number|string>}  [anchorStoryIds] The run's own Stories;
 *   decides whether the corpus is confined to the run. Defaults to `[anchorId]`.
 * @property {string}                frameworkRepo   `"<owner>/<repo>"`.
 * @property {string}                consumerRepo    `"<owner>/<repo>"`.
 * @property {FrictionSignal[]}      [signals]
 * @property {BlockedEvent[]}        [unresolvedBlockedEvents]
 *
 * @typedef {Object} RoutedItem
 * @property {string} category
 * @property {number} occurrences
 * @property {"framework"|"consumer"} source
 * @property {string} title
 * @property {string} body
 * @property {string} command       Pre-drafted `gh issue create` line.
 *
 * @typedef {Object} DiscardedItem
 * @property {string} category
 * @property {number} occurrences
 * @property {"framework"|"consumer"} source
 * @property {string[]} tools
 * @property {string} fingerprint    Stable 8-hex shape token.
 * @property {number} storyCount     Distinct publishable Stories spanned.
 *
 * @typedef {Object} RoutedProposals
 * @property {RoutedItem[]}     framework
 * @property {RoutedItem[]}     consumer
 * @property {DiscardedItem[]}  discarded
 */

import crypto from 'node:crypto';

import {
  isRecoveredSignal,
  RUNTIME_FRICTION_CATEGORIES,
} from '../observability/runtime-friction.js';
import { isPublishableTicketId } from '../reserved-test-ids.js';

/** @returns {RoutedProposals} */
function emptyResult() {
  return { framework: [], consumer: [], discarded: [] };
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function asString(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

/**
 * @param {unknown} ts
 * @returns {number|null}
 */
function tsMillis(ts) {
  if (typeof ts !== 'string') return null;
  const ms = Date.parse(ts.trim());
  return Number.isFinite(ms) ? ms : null;
}

/**
 * @param {string} category
 * @param {number} storyId
 * @returns {string}
 */
function incidentKey(category, storyId) {
  return `${category}\u0000${storyId}`;
}

/**
 * Drop every record in a `(category, storyId)` pair that carries a recovery
 * marker (`details.recovered === true`), so only never-resolved incidents are
 * counted. Deliberately coarse — the stream has no reliable ordering to pair
 * incident/recover cycles — and keyed per category so a recovered close does
 * not cancel the same Story's unrelated `story-blocked`.
 *
 * @param {FrictionSignal[]} signals
 * @returns {FrictionSignal[]}
 */
function netOutRecoveredIncidents(signals) {
  const recovered = new Set();
  for (const sig of signals) {
    if (isRecoveredSignal(sig) && Number.isInteger(sig.storyId)) {
      recovered.add(incidentKey(asString(sig.category), sig.storyId));
    }
  }
  if (recovered.size === 0) return signals;
  return signals.filter((sig) => {
    if (sig === null || typeof sig !== 'object') return true;
    if (!Number.isInteger(sig.storyId)) return true;
    return !recovered.has(incidentKey(asString(sig.category), sig.storyId));
  });
}

/**
 * A `story-blocked` record with no recovery marker is a Story still parked at
 * `agent::blocked`, worth filing at one occurrence. Sorted by `ticketId`.
 *
 * @param {FrictionSignal[]} signals
 * @returns {BlockedEvent[]}
 */
export function deriveUnresolvedBlockedEvents(signals) {
  if (!Array.isArray(signals)) return [];
  /** @type {Map<number, "framework"|"consumer">} */
  const blocked = new Map();
  const recovered = new Set();
  for (const sig of signals) {
    if (sig === null || typeof sig !== 'object') continue;
    if (sig.category !== RUNTIME_FRICTION_CATEGORIES.STORY_BLOCKED) continue;
    const storyId = Number(sig.storyId);
    if (!Number.isInteger(storyId) || storyId <= 0) continue;
    if (isRecoveredSignal(sig)) {
      recovered.add(storyId);
      continue;
    }
    if (!blocked.has(storyId)) {
      blocked.set(
        storyId,
        sig.source === 'framework' ? 'framework' : 'consumer',
      );
    }
  }
  const out = [];
  for (const [ticketId, source] of blocked) {
    if (recovered.has(ticketId)) continue;
    out.push({
      ticketId,
      source,
      category: RUNTIME_FRICTION_CATEGORIES.STORY_BLOCKED,
    });
  }
  return out.sort((a, b) => a.ticketId - b.ticketId);
}

/**
 * Hash of the emitting tools and `details` KEYS (values vary per event, so
 * would identify nothing). Descriptive only — routing stays keyed on category.
 *
 * @param {string} category
 * @param {string[]} tools       Sorted, de-duplicated.
 * @param {string[]} detailKeys  Sorted, de-duplicated.
 * @returns {string} 8 hex characters.
 */
function fingerprintBucket(category, tools, detailKeys) {
  return crypto
    .createHash('sha1')
    .update(`${category}|${tools.join(',')}|${detailKeys.join(',')}`)
    .digest('hex')
    .slice(0, 8);
}

/**
 * Reason texts from both emitter shapes: singular `details.reason` and the
 * light-path refusal's `details.reasons` array. Non-strings are skipped, not
 * coerced to `[object Object]`.
 *
 * @param {object} details
 * @returns {string[]}
 */
function collectReasons(details) {
  const out = [];
  const single = asString(details.reason);
  if (single.length > 0) out.push(single);
  if (Array.isArray(details.reasons)) {
    for (const raw of details.reasons) {
      const text = asString(raw);
      if (text.length > 0) out.push(text);
    }
  }
  return out;
}

/**
 * A row with no usable `ts` is counted but never moves the window.
 *
 * @param {{ firstMs: number|null, lastMs: number|null }} entry
 * @param {number|null} ms
 * @returns {void}
 */
function widenWindow(entry, ms) {
  if (ms === null) return;
  entry.firstMs = entry.firstMs === null ? ms : Math.min(entry.firstMs, ms);
  entry.lastMs = entry.lastMs === null ? ms : Math.max(entry.lastMs, ms);
}

/**
 * Aggregate by `category` — the unit the graduator's idempotency marker keys
 * on, so it must not split by emitter. Missing category is skipped; unknown
 * `source` defaults to `"consumer"`.
 *
 * @param {FrictionSignal[]} signals
 * @returns {Map<string, {
 *   category: string,
 *   total: number,
 *   bySource: { framework: number, consumer: number },
 *   firstSource: "framework"|"consumer",
 *   tools: Set<string>,
 *   detailKeys: Set<string>,
 *   surfaces: Set<string>,
 *   reasons: Set<string>,
 *   storyIds: Set<number>,
 *   withheldStoryIds: Set<number>,
 *   firstMs: number|null,
 *   lastMs: number|null,
 * }>}
 */
function aggregateByCategory(signals) {
  const out = new Map();
  for (const sig of signals) {
    if (sig === null || typeof sig !== 'object') continue;
    const category = asString(sig.category);
    if (category.length === 0) continue;
    const source = sig.source === 'framework' ? 'framework' : 'consumer';
    let entry = out.get(category);
    if (!entry) {
      entry = {
        category,
        total: 0,
        bySource: { framework: 0, consumer: 0 },
        firstSource: source,
        tools: new Set(),
        detailKeys: new Set(),
        surfaces: new Set(),
        reasons: new Set(),
        storyIds: new Set(),
        withheldStoryIds: new Set(),
        firstMs: null,
        lastMs: null,
      };
      out.set(category, entry);
    }
    entry.total += 1;
    widenWindow(entry, tsMillis(sig.ts));
    entry.bySource[source] += 1;
    const tool = asString(sig.tool);
    if (tool.length > 0) entry.tools.add(tool);
    if (sig.details !== null && typeof sig.details === 'object') {
      for (const key of Object.keys(sig.details)) entry.detailKeys.add(key);
      // Surface and reason values reach the body, never the fingerprint.
      const surface = asString(sig.details.surface);
      if (surface.length > 0) entry.surfaces.add(surface);
      for (const reason of collectReasons(sig.details)) {
        entry.reasons.add(reason);
      }
    }
    // Unpublishable ids are withheld, not dropped: they gate auto-filing.
    if (Number.isInteger(sig.storyId) && sig.storyId > 0) {
      if (isPublishableTicketId(sig.storyId)) entry.storyIds.add(sig.storyId);
      else entry.withheldStoryIds.add(sig.storyId);
    }
  }
  return out;
}

/**
 * False only when every contributing id is unpublishable — a filed issue would
 * then cite evidence that resolves to nothing. No ids at all is fine.
 *
 * @param {{ storyIds: Set<number>, withheldStoryIds: Set<number> }} entry
 * @returns {boolean}
 */
function hasPublishableStoryEvidence(entry) {
  return entry.storyIds.size > 0 || entry.withheldStoryIds.size === 0;
}

/**
 * @param {{ category: string, tools: Set<string>, detailKeys: Set<string>, storyIds: Set<number> }} entry
 * @returns {{ tools: string[], fingerprint: string, storyCount: number }}
 */
function describeBucket(entry) {
  const tools = [...entry.tools].sort();
  const detailKeys = [...entry.detailKeys].sort();
  return {
    tools,
    fingerprint: fingerprintBucket(entry.category, tools, detailKeys),
    storyCount: entry.storyIds.size,
  };
}

/**
 * Evidence an actionable body names. Collections are sorted: the body is
 * rewritten to a live issue on every recurrence.
 *
 * @param {{
 *   category: string,
 *   tools: Set<string>,
 *   detailKeys: Set<string>,
 *   surfaces: Set<string>,
 *   reasons: Set<string>,
 *   storyIds: Set<number>,
 *   firstMs: number|null,
 *   lastMs: number|null,
 * }} entry
 * @returns {{
 *   tools: string[], fingerprint: string, storyCount: number,
 *   surfaces: string[], reasons: string[], storyIds: number[],
 *   window: { firstMs: number|null, lastMs: number|null },
 * }}
 */
function describeEvidence(entry) {
  return {
    ...describeBucket(entry),
    surfaces: [...entry.surfaces].sort(),
    reasons: [...entry.reasons].sort(),
    storyIds: [...entry.storyIds].sort((a, b) => a - b),
    // Only a filed issue claims a window; discarded rows omit it.
    window: { firstMs: entry.firstMs, lastMs: entry.lastMs },
  };
}

/** Evidence stand-in for a category with no aggregated signals behind it. */
function emptyEvidence() {
  return {
    tools: [],
    fingerprint: '',
    storyCount: 0,
    surfaces: [],
    reasons: [],
    storyIds: [],
    window: { firstMs: null, lastMs: null },
  };
}

/** Most reason texts a rendered body lists before eliding the rest. */
const MAX_RENDERED_REASONS = 3;

/** Most contributing Story ids a rendered body names before eliding. */
const MAX_RENDERED_STORIES = 12;

/**
 * `null` (omitted) rather than "none" when there are no values.
 *
 * @param {string} label
 * @param {string[]} values
 * @returns {string|null}
 */
function evidenceLine(label, values) {
  return values.length > 0 ? `${label}: ${values.join(', ')}` : null;
}

/**
 * @param {number[]} storyIds
 * @param {number} storyCount
 * @returns {string|null}
 */
function storiesLine(storyIds, storyCount) {
  if (storyIds.length === 0) return null;
  const shown = storyIds.slice(0, MAX_RENDERED_STORIES).map((id) => `#${id}`);
  const elided = storyIds.length - shown.length;
  const list =
    elided > 0 ? `${shown.join(', ')} (+${elided} more)` : shown.join(', ');
  return `Contributing Stories (${storyCount}): ${list}`;
}

/**
 * @param {string[]} reasons
 * @returns {string|null}
 */
function reasonsLine(reasons) {
  if (reasons.length === 0) return null;
  const shown = reasons.slice(0, MAX_RENDERED_REASONS);
  const elided = reasons.length - shown.length;
  const head = shown.map((r) => `"${r}"`).join('; ');
  return `Reason: ${head}${elided > 0 ? ` (+${elided} more)` : ''}`;
}

/**
 * Ties resolve to `firstSource` so routing is deterministic.
 *
 * @param {{ bySource: { framework: number, consumer: number }, firstSource: "framework"|"consumer" }} entry
 * @returns {"framework"|"consumer"}
 */
function dominantSource(entry) {
  const { framework, consumer } = entry.bySource;
  if (framework > consumer) return 'framework';
  if (consumer > framework) return 'consumer';
  return entry.firstSource;
}

/**
 * @param {'story'|'run'} kind
 * @param {number} id
 * @param {string} runToken
 * @returns {string}
 */
function formatAnchor(kind, id, runToken) {
  return kind === 'run' ? `plan-run ${runToken || id}` : `Story #${id}`;
}

/**
 * @param {'story'|'run'} kind
 * @returns {string}
 */
function formatTriggerLabel(kind) {
  return kind === 'run' ? 'Triggering run' : 'Triggering Story';
}

/**
 * UTC day, deliberately: a full timestamp would rewrite the live issue body on
 * every recurrence.
 *
 * @param {number|null} ms
 * @returns {string}
 */
function isoDay(ms) {
  return ms === null ? '' : new Date(ms).toISOString().slice(0, 10);
}

/**
 * `''` when the corpus is undateable — never a made-up range.
 *
 * @param {{ firstMs: number|null, lastMs: number|null }} window
 * @returns {string}
 */
function windowPhrase(window) {
  const first = isoDay(window.firstMs);
  const last = isoDay(window.lastMs);
  if (!first || !last) return '';
  return first === last ? `on ${first}` : `between ${first} and ${last}`;
}

/**
 * @param {{ firstMs: number|null, lastMs: number|null }} window
 * @returns {string}
 */
function windowSpan(window) {
  const first = isoDay(window.firstMs);
  const last = isoDay(window.lastMs);
  if (!first || !last) return '';
  return first === last ? first : `${first} → ${last}`;
}

/**
 * @param {number} storyCount
 * @returns {string}
 */
function storySpan(storyCount) {
  if (!Number.isInteger(storyCount) || storyCount <= 0) return '';
  return `across ${storyCount} ${storyCount === 1 ? 'Story' : 'Stories'}`;
}

const ACTIONABLE_THRESHOLD = 2;

function isActionableFriction(total, force) {
  return total >= ACTIONABLE_THRESHOLD || Boolean(force);
}

/**
 * Sized and dated by the corpus itself, never by the triggering run.
 *
 * @param {string} category
 * @param {number} occurrences
 * @param {{ storyCount: number, window: { firstMs: number|null, lastMs: number|null } }} evidence
 * @returns {string}
 */
function corpusSentence(category, occurrences, evidence) {
  const bits = [`surfaced ${occurrences} times`];
  const stories = storySpan(evidence.storyCount);
  if (stories) bits.push(stories);
  const when = windowPhrase(evidence.window);
  if (when) bits.push(when);
  return `Recurring friction category "${category}" ${bits.join(' ')}.`;
}

/**
 * Plain text (no headings) so the heredoc matches what an operator pastes.
 * The trigger is a separate fact from where the occurrences happened.
 *
 * @param {{
 *   anchor: { label: string, trigger: string },
 *   category: string,
 *   occurrences: number,
 *   source: "framework"|"consumer",
 *   evidence: {
 *     tools: string[], surfaces: string[], reasons: string[],
 *     storyIds: number[], storyCount: number, fingerprint: string,
 *     window: { firstMs: number|null, lastMs: number|null },
 *   },
 * }} args
 * @returns {string}
 */
function renderIssueBody({ anchor, category, occurrences, source, evidence }) {
  const facts = [
    `${anchor.trigger}: ${anchor.label}`,
    evidenceLine('Emitted by', evidence.tools),
    evidenceLine('Surface', evidence.surfaces),
    reasonsLine(evidence.reasons),
    storiesLine(evidence.storyIds, evidence.storyCount),
    evidence.fingerprint ? `Shape fingerprint: ${evidence.fingerprint}` : null,
  ].filter((line) => line !== null);
  return [
    corpusSentence(category, occurrences, evidence),
    '',
    ...facts,
    '',
    `Source classification: ${source}.`,
    '',
    'Captured by the follow-up composer. Triage and either:',
    `- File a follow-on Story to address the underlying ${source} gap, or`,
    `- Close with "wontfix" and document the rationale on ${anchor.label}.`,
  ].join('\n');
}

/**
 * Body goes via `--body-file -` heredoc so multi-line content survives quoting.
 *
 * @param {{
 *   repo: string,
 *   title: string,
 *   metaLabel: "framework-gap"|"consumer-improvement",
 *   category: string,
 *   body: string,
 * }} args
 * @returns {string}
 */
function renderIssueCommand({ repo, title, metaLabel, category, body }) {
  const labels = `meta::${metaLabel},friction::${category}`;
  // PowerShell agents convert the heredoc to `--body`.
  return [
    `gh issue create --repo ${repo} --title "${title}" --label "${labels}" --body-file - <<EOF`,
    body,
    'EOF',
  ].join('\n');
}

/**
 * `in <anchor>` only when the corpus is confined to the run's Stories;
 * otherwise `across M Stories (<first> → <last>)`. Retitling is de-dupe safe:
 * the graduator's marker excludes the title.
 *
 * @param {{
 *   category: string,
 *   occurrences: number,
 *   anchorLabel: string,
 *   confined: boolean,
 *   evidence: { storyCount: number, window: { firstMs: number|null, lastMs: number|null } },
 * }} args
 * @returns {string}
 */
function renderIssueTitle({
  category,
  occurrences,
  anchorLabel,
  confined,
  evidence,
}) {
  const stem = `Friction: ${category} recurred ${occurrences} times`;
  if (confined) return `${stem} in ${anchorLabel}`;
  const stories = storySpan(evidence.storyCount);
  const span = windowSpan(evidence.window);
  return [stem, stories, span ? `(${span})` : ''].filter(Boolean).join(' ');
}

/**
 * An empty corpus counts as confined.
 *
 * @param {number[]} storyIds
 * @param {Set<number>} anchorStoryIds
 * @returns {boolean}
 */
function isCorpusConfined(storyIds, anchorStoryIds) {
  return storyIds.every((id) => anchorStoryIds.has(id));
}

/**
 * @param {{
 *   anchor: { label: string, trigger: string, storyIds: Set<number> },
 *   category: string,
 *   occurrences: number,
 *   source: "framework"|"consumer",
 *   frameworkRepo: string,
 *   consumerRepo: string,
 *   evidence: object,
 * }} args
 * @returns {RoutedItem}
 */
function buildRoutedItem({
  anchor,
  category,
  occurrences,
  source,
  frameworkRepo,
  consumerRepo,
  evidence,
}) {
  const title = renderIssueTitle({
    category,
    occurrences,
    anchorLabel: anchor.label,
    confined: isCorpusConfined(evidence.storyIds, anchor.storyIds),
    evidence,
  });
  const body = renderIssueBody({
    anchor,
    category,
    occurrences,
    source,
    evidence,
  });
  const repo = source === 'framework' ? frameworkRepo : consumerRepo;
  const metaLabel =
    source === 'framework' ? 'framework-gap' : 'consumer-improvement';
  const command = renderIssueCommand({
    repo,
    title,
    metaLabel,
    category,
    body,
  });
  return { category, occurrences, source, title, body, command };
}

/**
 * @param {unknown} input
 * @returns {{
 *   anchor: { label: string, trigger: string, storyIds: Set<number> },
 *   frameworkRepo: string,
 *   consumerRepo: string,
 *   signals: FrictionSignal[],
 *   unresolvedBlockedEvents: BlockedEvent[],
 * } | null}
 */
function normalizeAnchorKind(kind) {
  return kind === 'story' || kind === 'run' ? kind : 'story';
}

/**
 * Defaults to the anchor itself, so story scope is confined by construction.
 *
 * @param {unknown} raw
 * @param {number} anchorId
 * @returns {Set<number>}
 */
function anchorStoryIdSet(raw, anchorId) {
  const ids = new Set();
  for (const value of Array.isArray(raw) ? raw : []) {
    const id = Number(value);
    if (Number.isInteger(id) && id > 0) ids.add(id);
  }
  return ids.size > 0 ? ids : new Set([anchorId]);
}

function normaliseInput(input) {
  if (input === null || typeof input !== 'object') return null;
  const record = /** @type {RoutedProposalsInput} */ (input);
  const anchorId = Number(record.anchorId);
  if (!Number.isInteger(anchorId) || anchorId <= 0) return null;
  const frameworkRepo = asString(record.frameworkRepo);
  const consumerRepo = asString(record.consumerRepo);
  if (!frameworkRepo || !consumerRepo) return null;
  const anchorKind = normalizeAnchorKind(record.anchorKind);
  return {
    anchor: {
      label: formatAnchor(anchorKind, anchorId, asString(record.runToken)),
      trigger: formatTriggerLabel(anchorKind),
      storyIds: anchorStoryIdSet(record.anchorStoryIds, anchorId),
    },
    frameworkRepo,
    consumerRepo,
    signals: Array.isArray(record.signals) ? record.signals : [],
    unresolvedBlockedEvents: Array.isArray(record.unresolvedBlockedEvents)
      ? record.unresolvedBlockedEvents
      : [],
  };
}

function blockedForceMap(unresolvedBlockedEvents) {
  /** @type {Map<string, { source: "framework"|"consumer" }>} */
  const blockedForceActionable = new Map();
  for (const evt of unresolvedBlockedEvents) {
    if (evt === null || typeof evt !== 'object') continue;
    const category = asString(evt.category);
    if (category.length === 0) continue;
    const source = evt.source === 'framework' ? 'framework' : 'consumer';
    if (!blockedForceActionable.has(category)) {
      blockedForceActionable.set(category, { source });
    }
  }
  return blockedForceActionable;
}

function pushRouted(buckets, source, item) {
  if (source === 'framework') buckets.framework.push(item);
  else buckets.consumer.push(item);
}

function routeCategoryBuckets({
  byCategory,
  blockedForceActionable,
  anchor,
  frameworkRepo,
  consumerRepo,
}) {
  /** @type {RoutedProposals} */
  const buckets = { framework: [], consumer: [], discarded: [] };
  for (const entry of byCategory.values()) {
    const { category, total } = entry;
    const force = blockedForceActionable.get(category);
    const source = force ? force.source : dominantSource(entry);
    if (
      !isActionableFriction(total, force) ||
      !hasPublishableStoryEvidence(entry)
    ) {
      buckets.discarded.push({
        category,
        occurrences: total,
        source,
        ...describeBucket(entry),
      });
      continue;
    }
    pushRouted(
      buckets,
      source,
      buildRoutedItem({
        anchor,
        category,
        occurrences: total,
        source,
        frameworkRepo,
        consumerRepo,
        evidence: describeEvidence(entry),
      }),
    );
  }
  for (const [category, info] of blockedForceActionable) {
    if (byCategory.has(category)) continue;
    pushRouted(
      buckets,
      info.source,
      buildRoutedItem({
        anchor,
        category,
        occurrences: 0,
        source: info.source,
        frameworkRepo,
        consumerRepo,
        evidence: emptyEvidence(),
      }),
    );
  }
  buckets.framework.sort((a, b) => a.category.localeCompare(b.category));
  buckets.consumer.sort((a, b) => a.category.localeCompare(b.category));
  buckets.discarded.sort((a, b) => a.category.localeCompare(b.category));
  return buckets;
}

/**
 * @param {RoutedProposalsInput} input
 * @returns {RoutedProposals}
 */
export function composeRoutedProposals(input) {
  const normalised = normaliseInput(input);
  if (normalised === null) return emptyResult();
  const {
    anchor,
    frameworkRepo,
    consumerRepo,
    signals,
    unresolvedBlockedEvents,
  } = normalised;

  return routeCategoryBuckets({
    byCategory: aggregateByCategory(netOutRecoveredIncidents(signals)),
    blockedForceActionable: blockedForceMap(unresolvedBlockedEvents),
    anchor,
    frameworkRepo,
    consumerRepo,
  });
}

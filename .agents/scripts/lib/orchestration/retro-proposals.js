/**
 * lib/orchestration/retro-proposals.js — pure composer that turns
 * aggregated source-tagged friction signals into three routed proposal
 * sections (framework, consumer, discarded).
 *
 * Epic #2547 / Story #2558 / Tech Spec #2550. Consumes per-Story signals
 * already source-tagged by `signals-writer.appendSignal` and yields a
 * three-way split that the retro composer renders above the
 * `<!-- retro-complete: ... -->` marker. The former "memory updates"
 * pane was deleted in the Epic #4406 signal-contract cutover (it had no
 * producer — no writer ever emitted the record it rendered).
 *
 * Heuristic:
 *   - **Actionable** (renders as a pre-drafted `gh issue create` shell
 *     command): a friction `category` with **≥ 2** occurrences across the
 *     Epic, OR an `agent::blocked` event whose root cause was not
 *     resolved by Epic close (the caller supplies these as
 *     `unresolvedBlockedEvents`).
 *   - **Discarded**: a friction category with exactly 1 occurrence and
 *     no follow-on signal (no companion `agent::blocked`).
 *
 * Routing:
 *   - Each actionable item is routed to `framework` or `consumer` based
 *     on the dominant `source` tag for that category. "Dominant" means
 *     the source with the higher count; ties resolve to whichever source
 *     contributed the first occurrence so the ordering is deterministic.
 *
 * Determinism:
 *   - Output arrays are sorted by `category` ASC so a given input always
 *     yields byte-identical markdown (Story #2558 AC).
 *
 * The module is pure: no I/O, no provider calls, no time-dependent state.
 *
 * @typedef {Object} FrictionSignal
 * @property {string} category   Free-form bucket (e.g. `"lint-loop"`).
 * @property {"framework"|"consumer"} source
 * @property {number} [storyId]  Emitting Story id (used to net out recovered
 *                               `story-blocked` incidents — Story #4622).
 * @property {object} [details]  Kind-specific payload; a `story-blocked`
 *                               record with `details.recovered === true` is a
 *                               recovery marker.
 *
 * @typedef {Object} BlockedEvent
 * @property {number} ticketId
 * @property {"framework"|"consumer"} source
 * @property {string} [category]
 * @property {string} [summary]
 *
 * @typedef {Object} RoutedProposalsInput
 * @property {number}                anchorId      Story or run/Epic id in titles.
 * @property {'story'|'run'}  [anchorKind]    Wording in titles/bodies (default `story`).
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
 * @property {string} command       The pre-drafted `gh issue create` line.
 *
 * @typedef {Object} DiscardedItem
 * @property {string} category
 * @property {number} occurrences
 * @property {"framework"|"consumer"} source
 *
 * @typedef {Object} RoutedProposals
 * @property {RoutedItem[]}     framework
 * @property {RoutedItem[]}     consumer
 * @property {DiscardedItem[]}  discarded
 */

import {
  isRecoveredBlockSignal,
  RUNTIME_FRICTION_CATEGORIES,
} from '../observability/runtime-friction.js';

/**
 * Empty result helper — returned for zero-input callers so the consumer
 * never needs to defensively spread undefineds.
 *
 * @returns {RoutedProposals}
 */
function emptyResult() {
  return { framework: [], consumer: [], discarded: [] };
}

/**
 * Normalise a stringy input to a trimmed string, or empty.
 *
 * @param {unknown} value
 * @returns {string}
 */
function asString(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

/**
 * Net transient (self-resolved) blocks out of the signal stream before it is
 * aggregated (Story #4622).
 *
 * A `blocked → active` recovery emits a `story-blocked` record carrying
 * `details.recovered === true`. When a Story has such a marker, its block was
 * transient — lease contention or a stale label read under concurrent
 * shared-checkout pressure (swarm-os friction #581) that cleared on a later
 * beat — not a terminal HITL pause. This drops **every** `story-blocked`
 * record for such a Story (both the original block and its recovery marker),
 * so the retro counts only Stories still parked at `agent::blocked`.
 *
 * The netting is by `storyId`, not 1:1 pairing: a Story that ever recovered
 * from a block in the run is treated as non-terminal for the whole run. That
 * is a deliberate coarsening — the aggregate is a routing heuristic, not an
 * incident ledger, and the signal stream carries no reliable ordering to
 * reconstruct interleaved block/recover cycles. Non-`story-blocked` records
 * and Stories with no recovery marker pass through untouched.
 *
 * @param {FrictionSignal[]} signals
 * @returns {FrictionSignal[]}
 */
function netOutRecoveredBlocks(signals) {
  const recoveredStoryIds = new Set();
  for (const sig of signals) {
    if (isRecoveredBlockSignal(sig) && Number.isInteger(sig.storyId)) {
      recoveredStoryIds.add(sig.storyId);
    }
  }
  if (recoveredStoryIds.size === 0) return signals;
  return signals.filter((sig) => {
    if (sig === null || typeof sig !== 'object') return true;
    const isBlocked =
      sig.category === RUNTIME_FRICTION_CATEGORIES.STORY_BLOCKED;
    return !(isBlocked && recoveredStoryIds.has(sig.storyId));
  });
}

/**
 * Aggregate friction signals by `category`, tracking per-source counts and
 * arrival order so we can pick a dominant source deterministically.
 *
 * Records with a missing/invalid `category` are skipped (no silent
 * "" bucket). Records with an unknown `source` default to `"consumer"`
 * — that matches the source-classifier's safe default.
 *
 * @param {FrictionSignal[]} signals
 * @returns {Map<string, {
 *   category: string,
 *   total: number,
 *   bySource: { framework: number, consumer: number },
 *   firstSource: "framework"|"consumer",
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
      };
      out.set(category, entry);
    }
    entry.total += 1;
    entry.bySource[source] += 1;
  }
  return out;
}

/**
 * Resolve the dominant source for an aggregated category. Ties resolve to
 * `firstSource` so byte-identical inputs always produce byte-identical
 * routing.
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
 * @returns {string}
 */
function formatAnchor(kind, id) {
  if (kind === 'story') return `Story #${id}`;
  if (kind === 'run') return `plan-run ${id}`;
  return `Epic #${id}`;
}

/** Story scope promotes single-occurrence friction; run keeps ≥2. */
function isActionableFriction(total, force, anchorKind) {
  const threshold = anchorKind === 'story' ? 1 : 2;
  return total >= threshold || Boolean(force);
}

/**
 * Render the issue body. Plain text — no markdown headings — so the
 * pre-drafted `gh issue create --body-file` heredoc remains a faithful
 * representation of what the operator would paste.
 *
 * @param {{
 *   anchorId: number,
 *   anchorKind: 'story'|'run',
 *   category: string,
 *   occurrences: number,
 *   source: "framework"|"consumer",
 * }} args
 * @returns {string}
 */
function renderIssueBody({
  anchorId,
  anchorKind,
  category,
  occurrences,
  source,
}) {
  const anchor = formatAnchor(anchorKind, anchorId);
  return [
    `Recurring friction category "${category}" surfaced ${occurrences} times during ${anchor}.`,
    '',
    `Source classification: ${source}.`,
    '',
    'Captured by the follow-up composer. Triage and either:',
    `- File a follow-on Story to address the underlying ${source} gap, or`,
    `- Close with "wontfix" and document the rationale on ${anchor}.`,
  ].join('\n');
}

/**
 * Compose the pre-drafted `gh issue create` shell command for an actionable
 * item. The command is rendered verbatim — operators copy-paste it as-is.
 *
 * The body is supplied via `--body-file -` and a trailing heredoc so the
 * multi-line content survives shell quoting on every platform.
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
  // Heredoc form keeps multi-line bodies safe under POSIX shells; agents
  // running on PowerShell convert it to a `--body` flag if needed.
  return [
    `gh issue create --repo ${repo} --title "${title}" --label "${labels}" --body-file - <<EOF`,
    body,
    'EOF',
  ].join('\n');
}

/**
 * Build an actionable RoutedItem for a category.
 *
 * @param {{
 *   anchorId: number,
 *   anchorKind: 'story'|'run',
 *   category: string,
 *   occurrences: number,
 *   source: "framework"|"consumer",
 *   frameworkRepo: string,
 *   consumerRepo: string,
 * }} args
 * @returns {RoutedItem}
 */
function buildRoutedItem({
  anchorId,
  anchorKind,
  category,
  occurrences,
  source,
  frameworkRepo,
  consumerRepo,
}) {
  const anchor = formatAnchor(anchorKind, anchorId);
  const title = `Friction: ${category} recurred ${occurrences} times in ${anchor}`;
  const body = renderIssueBody({
    anchorId,
    anchorKind,
    category,
    occurrences,
    source,
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
 * Validate that the input shape is sane and extract typed arrays. Returns
 * `null` when input is unusable (caller short-circuits to `emptyResult`).
 *
 * @param {unknown} input
 * @returns {{
 *   anchorId: number,
 *   anchorKind: 'story'|'run',
 *   frameworkRepo: string,
 *   consumerRepo: string,
 *   signals: FrictionSignal[],
 *   unresolvedBlockedEvents: BlockedEvent[],
 * } | null}
 */
function normalizeAnchorKind(kind) {
  return kind === 'story' || kind === 'run' ? kind : 'story';
}

function normaliseInput(input) {
  if (input === null || typeof input !== 'object') return null;
  const record = /** @type {RoutedProposalsInput} */ (input);
  const anchorId = Number(record.anchorId);
  if (!Number.isInteger(anchorId) || anchorId <= 0) return null;
  const frameworkRepo = asString(record.frameworkRepo);
  const consumerRepo = asString(record.consumerRepo);
  if (!frameworkRepo || !consumerRepo) return null;
  return {
    anchorId,
    anchorKind: normalizeAnchorKind(record.anchorKind),
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
  anchorId,
  anchorKind,
  frameworkRepo,
  consumerRepo,
}) {
  /** @type {RoutedProposals} */
  const buckets = { framework: [], consumer: [], discarded: [] };
  for (const entry of byCategory.values()) {
    const { category, total } = entry;
    const force = blockedForceActionable.get(category);
    const source = force ? force.source : dominantSource(entry);
    if (!isActionableFriction(total, force, anchorKind)) {
      buckets.discarded.push({ category, occurrences: total, source });
      continue;
    }
    pushRouted(
      buckets,
      source,
      buildRoutedItem({
        anchorId,
        anchorKind,
        category,
        occurrences: total,
        source,
        frameworkRepo,
        consumerRepo,
      }),
    );
  }
  for (const [category, info] of blockedForceActionable) {
    if (byCategory.has(category)) continue;
    pushRouted(
      buckets,
      info.source,
      buildRoutedItem({
        anchorId,
        anchorKind,
        category,
        occurrences: 0,
        source: info.source,
        frameworkRepo,
        consumerRepo,
      }),
    );
  }
  buckets.framework.sort((a, b) => a.category.localeCompare(b.category));
  buckets.consumer.sort((a, b) => a.category.localeCompare(b.category));
  buckets.discarded.sort((a, b) => a.category.localeCompare(b.category));
  return buckets;
}

/**
 * Compose the four routed proposal sections from aggregated source-tagged
 * signals.
 *
 * Pure — no I/O, no time-dependent state, no provider calls. Returns an
 * object with three arrays:
 *   - `framework`: actionable items routed to the framework repo.
 *   - `consumer`: actionable items routed to the consumer repo.
 *   - `discarded`: single-occurrence friction with no follow-on signal.
 *
 * @param {RoutedProposalsInput} input
 * @returns {RoutedProposals}
 */
export function composeRoutedProposals(input) {
  const normalised = normaliseInput(input);
  if (normalised === null) return emptyResult();
  const {
    anchorId,
    anchorKind,
    frameworkRepo,
    consumerRepo,
    signals,
    unresolvedBlockedEvents,
  } = normalised;

  return routeCategoryBuckets({
    byCategory: aggregateByCategory(netOutRecoveredBlocks(signals)),
    blockedForceActionable: blockedForceMap(unresolvedBlockedEvents),
    anchorId,
    anchorKind,
    frameworkRepo,
    consumerRepo,
  });
}

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
 * Heuristic (uniform across anchors — Story #4649):
 *   - **Actionable** (renders as a pre-drafted `gh issue create` shell
 *     command): a friction `category` with **≥ 2** occurrences under the
 *     anchor, OR a blocked event whose root cause was never resolved (the
 *     caller supplies these as `unresolvedBlockedEvents`).
 *   - **Discarded**: a friction category under the threshold with no
 *     follow-on signal. Discarded is not silent — the caller still renders
 *     the bucket, so the event stays *recorded* without opening an issue.
 *   - **Netted out** before either decision: a category with a recovery
 *     marker for that Story (see `netOutRecoveredIncidents`) contributes
 *     nothing at all.
 *
 * `anchorKind` deliberately does NOT move the threshold. It used to — story
 * scope promoted singletons at `≥ 1` — which, since the v2 Epic collapse put
 * every close on a per-Story window of population 1, made *every* un-netted
 * friction event auto-file. Cleanly-shipped Stories accumulated "recurred 1
 * times" issues, which is how a warning channel gets tuned out. The signal
 * that carve-out was standing in for is served properly by
 * `unresolvedBlockedEvents`: a Story genuinely parked at `agent::blocked`
 * forces actionable at count 1, while one that blocked and self-resolved
 * nets out. `anchorKind` now only selects title/body wording.
 *
 * Routing:
 *   - Each actionable item is routed to `framework` or `consumer` based
 *     on the dominant `source` tag for that category. "Dominant" means
 *     the source with the higher count; ties resolve to whichever source
 *     contributed the first occurrence so the ordering is deterministic.
 *
 * Corpus vs. trigger (Story #4850):
 *   - The run-scope gather reduces over the **whole surviving recurrence
 *     window**, not the triggering run's own Stories — deliberately, because a
 *     systemic defect fires once per Story and scored 1 under the old per-run
 *     window (see `gatherRunFrictionSignals`). The composer therefore may NOT
 *     describe its corpus as "in <the triggering run>": it names the window it
 *     was reduced over (occurrences, distinct Stories, first-to-last dates) and
 *     carries the run as a separate labelled fact. When the corpus IS confined
 *     to the run's own Stories, the plain "in <anchor>" wording is kept — that
 *     is the common single-run case and it is not a false claim there.
 *
 * Publishable evidence (Story #4892):
 *   - A routed item's body is filed verbatim as a real GitHub issue, and its
 *     contributing-Story line is the recurrence claim a reader triages on. The
 *     ids used to be rendered with no validation at all, so a synthetic id
 *     from a test fixture reached a live ticket unchallenged: issue #4870 was
 *     auto-filed naming `#999999`, an id the framework reserves for fixtures,
 *     alongside one real Story. Contributing ids are therefore filtered
 *     through `isPublishableTicketId` before they can be counted or printed,
 *     and a bucket whose contributing ids are ALL unpublishable is discarded
 *     rather than routed — a proposal with no resolvable evidence must not
 *     auto-file at all. The filter is a resolvability bound, never a scope
 *     narrowing: a real Story from outside the triggering run is published
 *     exactly as before, which is the cross-run recurrence the window exists
 *     to produce.
 *
 * Determinism:
 *   - Output arrays are sorted by `category` ASC so a given input always
 *     yields byte-identical markdown (Story #2558 AC).
 *   - The rendered window is derived from the corpus's own timestamps, never
 *     from the clock, so the module stays pure and its output reproducible.
 *
 * The module is pure: no I/O, no provider calls, no time-dependent state.
 *
 * @typedef {Object} FrictionSignal
 * @property {string} category   Free-form bucket (e.g. `"lint-loop"`).
 * @property {"framework"|"consumer"} source
 * @property {number} [storyId]  Emitting Story id (used to net out recovered
 *                               incidents — Story #4622 / #4649).
 * @property {string} [tool]     Emitting tool (`emitter.tool`) — descriptive
 *                               roll-up legibility only, never routing.
 * @property {string|null} [ts]  ISO-8601 emit time (Story #4850), carried by
 *                               `normalizeGatheredSignal`; `null` when the row
 *                               carried none a `Date` could read.
 * @property {object} [details]  Kind-specific payload; a record with
 *                               `details.recovered === true` is a recovery
 *                               marker for its own category.
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
 * @property {string}                [runToken]    The triggering run's own token
 *   (`plan-run::<id>` / `adhoc-<ids>`) — Story #4850. `run-epilogue.js` used to
 *   splice this in by regex over the rendered title and body *after* the fact;
 *   it is an input now, so the composer never emits a token the caller then has
 *   to rewrite.
 * @property {Array<number|string>}  [anchorStoryIds] The triggering run's own
 *   Story ids. Decides whether the corpus is confined to the run (the anchor is
 *   then a true scope) or spans Stories outside it (the anchor is then only the
 *   trigger). Defaults to `[anchorId]`.
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
 * @property {string[]} tools        Emitting tools, sorted (Story #4824).
 * @property {string} fingerprint    Stable 8-hex shape token (Story #4824).
 * @property {number} storyCount     Distinct publishable Stories the bucket
 *                                   spans — the cross-run recurrence count.
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
 * Epoch milliseconds for a signal's `ts`, or `null` when it carries none a
 * `Date` can read. Pure, so the composer stays time-independent: the window it
 * renders is a property of the corpus, never of the clock.
 *
 * @param {unknown} ts
 * @returns {number|null}
 */
function tsMillis(ts) {
  if (typeof ts !== 'string') return null;
  const ms = Date.parse(ts.trim());
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Key a signal into its netting bucket: one `(category, storyId)` pair.
 *
 * @param {string} category
 * @param {number} storyId
 * @returns {string}
 */
function incidentKey(category, storyId) {
  return `${category}\u0000${storyId}`;
}

/**
 * Net transient (self-resolved) incidents out of the signal stream before it
 * is aggregated (Story #4622, generalized by Story #4649).
 *
 * A recovery emits a record in the SAME category carrying
 * `details.recovered === true` — `agent::blocked → active` for
 * `story-blocked`, a confirmed land for `close-failed`. When a Story has such
 * a marker, that incident was transient: lease contention or a stale label
 * read under concurrent shared-checkout pressure (swarm-os friction #581), a
 * close that failed once and succeeded on retry. This drops **every** record
 * in that category for that Story (both the original incident and its
 * recovery marker), so the retro counts only incidents that never resolved.
 *
 * The netting is per `(category, storyId)`, not 1:1 pairing: a Story that
 * ever recovered from an incident in the run is treated as non-terminal for
 * that category for the whole run. That is a deliberate coarsening — the
 * aggregate is a routing heuristic, not an incident ledger, and the signal
 * stream carries no reliable ordering to reconstruct interleaved
 * incident/recover cycles. Keying on the category (rather than netting a
 * Story wholesale) is what keeps a recovered close from also cancelling that
 * Story's unrelated `story-blocked`. Records for other categories, and
 * Stories with no recovery marker, pass through untouched.
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
 * Derive the unresolved-block events for a signal stream (Story #4649).
 *
 * This is what replaces the retired story-scope threshold carve-out. A
 * `story-blocked` record whose Story has no companion recovery marker is a
 * Story still parked at `agent::blocked` — a human owes it a decision, and
 * that is worth filing at a single occurrence. One that recovered is netted
 * out by {@link netOutRecoveredIncidents} and produces no event here, so the
 * two mechanisms agree by construction.
 *
 * Callers previously passed a hardcoded `[]`, which left
 * `blockedForceActionable` permanently empty and made the carve-out the only
 * thing that could file anything at story scope.
 *
 * Pure. Sorted by `ticketId` so the routed output stays deterministic.
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
 * Fingerprint the *shape* of a friction bucket (Story #4824) — the emitting
 * tools plus the `details` key set, hashed to a short stable token.
 *
 * Deliberately over the detail **keys**, never their values: a `reason` names
 * the file or command that failed and differs on every occurrence, so
 * hashing values would mint a fresh fingerprint per event and identify
 * nothing. The keys plus the emitting tool are what make two occurrences "the
 * same defect".
 *
 * Descriptive only. Routing and de-duplication stay keyed on `category`, so a
 * fingerprint can never split one filed issue into two.
 *
 * @param {string} category
 * @param {string[]} tools       Sorted, de-duplicated emitter tools.
 * @param {string[]} detailKeys  Sorted, de-duplicated `details` keys.
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
 * Every reason text one signal's `details` carries, read from BOTH shapes the
 * emitters actually write.
 *
 * Two keys because two emitter conventions, and the divergence was silent: the
 * degradation emitters write a singular `details.reason` string, while the
 * light path's refusal emitter (`light-escalation.recordScopeFriction`) writes
 * `details.reasons` — an **array**, because one backstop verdict can object on
 * sensitivity and magnitude in the same pass. Reading only the singular key is
 * why every `light-scope-rejected` follow-up rendered with no `Reason:` line
 * at all (issue #5237), which defeated Story #4837's whole intent for that
 * emitter: the filed issue named a count and a category, and the refusal text
 * that would have told a reader which ceiling fired stayed in the ledger.
 *
 * Non-string members are skipped rather than coerced — `String(value)` would
 * put `[object Object]` in a live issue body.
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
 * Widen a bucket's first-to-last window to include one instant. A row with no
 * usable `ts` widens nothing — it is counted in `total` but cannot date the
 * corpus, so it must not be able to shrink the range either.
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
 * Aggregate friction signals by `category`, tracking per-source counts and
 * arrival order so we can pick a dominant source deterministically.
 *
 * Records with a missing/invalid `category` are skipped (no silent
 * "" bucket). Records with an unknown `source` default to `"consumer"`
 * — that matches the source-classifier's safe default.
 *
 * `category` is deliberately still the aggregation unit (Story #4824): it is
 * what titles a filed issue and what the graduator's idempotency marker
 * fingerprints, so splitting the bucket by emitter would file N issues where
 * the loop is designed to file one. The emitter tools, `details` key set, and
 * the distinct Stories a bucket spans ride **on** the entry instead, purely
 * so a roll-up can name what it counted.
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
      // Two detail VALUES are carried through to the rendered body (Story
      // #4837): the surface that degraded and the reason text. They are what
      // turn "tool-degraded ×6" into "the scoped-lint gate could not execute
      // and failed open" — the thing a reader absent from the run needs.
      // Values never reach `detailKeys`, so the bucket fingerprint (hashed
      // over keys, deliberately) is untouched by them.
      const surface = asString(sig.details.surface);
      if (surface.length > 0) entry.surfaces.add(surface);
      for (const reason of collectReasons(sig.details)) {
        entry.reasons.add(reason);
      }
    }
    // An id that cannot be resolved to a real issue is tracked separately
    // rather than dropped: it must never be counted or printed as recurrence
    // evidence, but "this bucket's only contributing ids were synthetic" is
    // exactly what stops it auto-filing (see `hasPublishableStoryEvidence`).
    if (Number.isInteger(sig.storyId) && sig.storyId > 0) {
      if (isPublishableTicketId(sig.storyId)) entry.storyIds.add(sig.storyId);
      else entry.withheldStoryIds.add(sig.storyId);
    }
  }
  return out;
}

/**
 * Does this bucket carry story evidence a filed issue may cite (Story #4892)?
 *
 * Three cases, and the middle one is the point:
 *   - Some publishable id → yes, file it (the withheld ids are simply absent
 *     from the body).
 *   - Contributing ids, none publishable → **no**. Every id the bucket could
 *     cite is synthetic, so a filed issue would assert recurrence evidence
 *     that resolves to nothing. The bucket is discarded instead.
 *   - No contributing ids at all → yes. That is a bucket forced actionable by
 *     an unresolved block with no aggregated signals behind it; it never cited
 *     a Story, so there is nothing unresolvable about it.
 *
 * @param {{ storyIds: Set<number>, withheldStoryIds: Set<number> }} entry
 * @returns {boolean}
 */
function hasPublishableStoryEvidence(entry) {
  return entry.storyIds.size > 0 || entry.withheldStoryIds.size === 0;
}

/**
 * Project an aggregate entry's descriptive fields onto a `DiscardedItem`
 * (Story #4824).
 *
 * A roll-up that discards every candidate used to render as a bare
 * `` `category` ×1 `` per row, which is how a defect recurring once per Story
 * across eighteen consecutive Stories stayed invisible. The row now names the
 * emitting tools, the bucket fingerprint, and how many distinct Stories it
 * spans — the last is the cross-run count the widened recurrence window
 * exists to produce.
 *
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
 * The evidence an ACTIONABLE item's rendered body names (Story #4837).
 *
 * Story #4824 put the emitting tools, the shape fingerprint and the
 * distinct-Story span on the aggregate entry, but projected them only onto
 * the *discarded* rows — so the one bucket that actually became a GitHub
 * issue was rendered from a category and a count alone. Measured on issue
 * #4836: a `tool-degraded ×6` body that never named `native-review-lint`,
 * never named the `scoped-lint` surface, and never named the reason, so the
 * review gate that could not execute and failed open appeared nowhere in the
 * ticket opened about it.
 *
 * Every collection is sorted so the same input renders byte-identically —
 * the body is written to a live issue on every recurrence, and an unstable
 * ordering would rewrite it with no change of meaning.
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
    // Story #4850 — the corpus's own first-to-last span. Deliberately NOT
    // projected onto `describeBucket`: a discarded row is rendered from the
    // bucket shape, and the window belongs to the claim a *filed* issue makes.
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
 * Render a `label: value` evidence line, or `null` when there is nothing to
 * say. A missing field is omitted outright rather than rendered as "none":
 * an absent emitter is not the finding.
 *
 * @param {string} label
 * @param {string[]} values
 * @returns {string|null}
 */
function evidenceLine(label, values) {
  return values.length > 0 ? `${label}: ${values.join(', ')}` : null;
}

/**
 * Render the contributing-Story line: the distinct Stories that emitted into
 * this bucket. This is the cross-run recurrence evidence — the difference
 * between "happened six times somewhere" and "happened on these six Stories,
 * so it is not one bad afternoon".
 *
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
 * Render the reason texts the emitters supplied, capped so one pathological
 * bucket cannot produce an unreadable issue body.
 *
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
 * Name the triggering anchor. For a run that means its own token when the
 * caller supplied one (Story #4850) — `run-epilogue.js` previously let the
 * composer print the primary Story's numeric id as if it were the run id and
 * then rewrote it by regex, which meant the rendered text and the caller's
 * notion of the run could silently disagree.
 *
 * @param {'story'|'run'} kind
 * @param {number} id
 * @param {string} runToken
 * @returns {string}
 */
function formatAnchor(kind, id, runToken) {
  return kind === 'run' ? `plan-run ${runToken || id}` : `Story #${id}`;
}

/**
 * Label the evidence fact that names the triggering anchor.
 *
 * Tracks `anchorKind` for the same reason {@link formatAnchor} does. Story
 * #4850 introduced the fact with a fixed `Triggering run` label, which on the
 * story-scope path called a Story a run (`Triggering run: Story #7`) — the one
 * place in this file where the wording did not follow the anchor.
 *
 * @param {'story'|'run'} kind
 * @returns {string}
 */
function formatTriggerLabel(kind) {
  return kind === 'run' ? 'Triggering run' : 'Triggering Story';
}

/**
 * The UTC calendar day of an instant, or `''` when there is no instant.
 *
 * Day granularity on purpose: the window is triage context ("this has been
 * recurring for three weeks"), and a full timestamp would rewrite the live
 * issue body on every recurrence for no change of meaning.
 *
 * @param {number|null} ms
 * @returns {string}
 */
function isoDay(ms) {
  return ms === null ? '' : new Date(ms).toISOString().slice(0, 10);
}

/**
 * Render the corpus window as a prose phrase, or `''` when no row in the
 * bucket carried a readable `ts`. Omitting it is the honest degradation: an
 * undateable corpus must not be given a made-up range.
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
 * The same window as the compact span a title carries.
 *
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
 * `across N Stories`, or `''` when no Story could be attributed.
 *
 * @param {number} storyCount
 * @returns {string}
 */
function storySpan(storyCount) {
  if (!Number.isInteger(storyCount) || storyCount <= 0) return '';
  return `across ${storyCount} ${storyCount === 1 ? 'Story' : 'Stories'}`;
}

/**
 * Occurrences needed before a category routes on its own. Uniform across
 * anchors (Story #4649) — see the module header for why story scope no
 * longer promotes singletons.
 */
const ACTIONABLE_THRESHOLD = 2;

/** A category routes when it recurred, or when a block forces it. */
function isActionableFriction(total, force) {
  return total >= ACTIONABLE_THRESHOLD || Boolean(force);
}

/**
 * Render the opening sentence: what the corpus is, sized and dated by its own
 * contents (Story #4850).
 *
 * This line used to read `surfaced N times during <anchor>`, where `<anchor>`
 * was the run whose epilogue happened to fire. The corpus is the whole
 * surviving recurrence window (deliberately — see `gatherRunFrictionSignals`),
 * so on any systemic defect the sentence asserted a scope the evidence block
 * three lines below it already contradicted by listing foreign Stories. It now
 * describes the window it was actually reduced over; the triggering run is a
 * separate labelled fact, because that is what it is.
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
 * Render the issue body. Plain text — no markdown headings — so the
 * pre-drafted `gh issue create --body-file` heredoc remains a faithful
 * representation of what the operator would paste.
 *
 * The evidence block (Story #4837) is what makes the issue actionable by
 * someone who was not in the run: the emitting tool, the surface that
 * degraded, the reason the emitter gave, the distinct Stories it spans, and
 * the shape fingerprint that ties recurrences together. Absent fields are
 * omitted, so a bucket that genuinely carries no evidence renders as it
 * always did rather than as a wall of "unknown".
 *
 * The triggering anchor leads that block (Story #4850): it is what caused this
 * issue to be *filed now*, which is worth naming, and is exactly not the same
 * claim as its being where the occurrences happened. Its label tracks
 * `anchorKind` via {@link formatTriggerLabel}, so the story-scope path says
 * `Triggering Story` rather than calling a Story a run.
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
 * Render the issue title — the one line a human triages on, so it is the one
 * line that must not misname its own corpus (Story #4850).
 *
 * Two forms, selected by whether the corpus is *confined* to the triggering
 * run's own Stories:
 *
 *   - **Confined** → `recurred N times in <anchor>`. The anchor genuinely is
 *     the scope, and this is the common single-run case; hedging it would make
 *     every ordinary title longer and vaguer for no gain.
 *   - **Spanning** → `recurred N times across M Stories (<first> → <last>)`.
 *     The anchor is dropped from the *claim* entirely (it stays in the body as
 *     the triggering fact), because naming it here is the falsehood: the
 *     occurrences did not happen in it.
 *
 * Retitling is de-dupe safe — the graduator's idempotency marker is
 * category-fingerprint-only and anchor-free (Story #4837), and the title is
 * deliberately excluded from the hash.
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
 * Is every contributing Story one of the triggering run's own?
 *
 * A corpus with no attributable Story at all (a block forced actionable with no
 * aggregated signals) counts as confined: there is no foreign evidence to
 * contradict the anchor, so the plain wording stays.
 *
 * @param {number[]} storyIds
 * @param {Set<number>} anchorStoryIds
 * @returns {boolean}
 */
function isCorpusConfined(storyIds, anchorStoryIds) {
  return storyIds.every((id) => anchorStoryIds.has(id));
}

/**
 * Build an actionable RoutedItem for a category.
 *
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
 * Validate that the input shape is sane and extract typed arrays. Returns
 * `null` when input is unusable (caller short-circuits to `emptyResult`).
 *
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
 * The triggering run's own Story ids as a set, defaulting to the anchor itself.
 *
 * The default is what keeps story-scope capture byte-identical: one Story's
 * stream can only carry its own id, so the corpus is confined by construction
 * and the wording never hedges.
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
        // Forced actionable by an unresolved block with no aggregated
        // signals behind it — there is no bucket to describe.
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

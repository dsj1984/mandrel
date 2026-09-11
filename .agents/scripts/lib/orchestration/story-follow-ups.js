/**
 * story-follow-ups.js — capture actionable follow-ups from a landed Story.
 *
 * Replaces the unwired Epic retro as the default closeout for v2: after a
 * Story merges, read its standalone `signals.ndjson` friction stream, compose
 * routed proposals, auto-file follow-up issues (when enabled), and upsert a
 * structured `follow-ups` comment on the Story.
 *
 * @module lib/orchestration/story-follow-ups
 */

import { signalsFile } from '../config/temp-paths.js';
import { graduateRetroProposals } from '../feedback-loop/retro-proposals-graduator.js';
import {
  DEFAULT_FRAMEWORK_REPO,
  formatRepoSlug,
  resolveOwnershipRepos,
} from '../github/framework-repo.js';
import { Logger } from '../Logger.js';
import { normalizeGatheredSignal } from '../observability/runtime-friction.js';
import {
  forEachLine,
  forEachSignalStreamLine,
} from '../observability/signals-writer.js';
import {
  composeRoutedProposals,
  deriveUnresolvedBlockedEvents,
} from './retro-proposals.js';
import { upsertStructuredComment } from './ticketing.js';

const FOLLOW_UPS_COMMENT_TYPE = 'follow-ups';

/** Milliseconds in one day — the unit `frictionWindowDays` is expressed in. */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Window bound applied when `frictionWindowDays` is unset. */
const DEFAULT_FRICTION_WINDOW_DAYS = 30;

/**
 * How many days back the run-scope recurrence window reaches (Story #4850).
 *
 * Defaults to 30 rather than to "unbounded": the widened cross-run window
 * exists to let a once-per-Story defect reach the ≥ 2 threshold, and 30 days is
 * long enough for that while short enough that a defect fixed last month stops
 * re-routing. An absent, non-integer, or sub-1 value takes the default — the
 * runtime AJV in `config-settings-schema-delivery.js` rejects those at load, so
 * reaching this fallback means the config never went through the validator.
 *
 * @param {object} [config]
 * @returns {number}
 */
function resolveFrictionWindowDays(config) {
  const raw = config?.delivery?.feedbackLoop?.frictionWindowDays;
  const days = Number(raw);
  return Number.isInteger(days) && days >= 1
    ? days
    : DEFAULT_FRICTION_WINDOW_DAYS;
}

/**
 * Resolve the follow-up ownership buckets for the retro composer and the
 * graduator walk.
 *
 * Routing itself lives in `github/framework-repo.js` — this is the slug-shaped
 * adapter the composer wants (`composeRoutedProposals` renders slugs in prose)
 * plus the `{owner, repo}` map `graduate()` routes on. The `platform` bucket
 * has **no default**: an unconfigured shared-infra repo stays `null` so a
 * caller reports it rather than filing platform-owned work somewhere plausible.
 *
 * @param {object} [config]
 * @returns {{ frameworkRepo: string, consumerRepo: string, platform: (string|null), currentRepo: { owner: string, repo: string }, repos: { consumer: object|null, framework: object|null, platform: object|null } }}
 */
export function resolveFollowUpRepos(config) {
  const repos = resolveOwnershipRepos(config);
  const consumerRepo = formatRepoSlug(repos.consumer) ?? DEFAULT_FRAMEWORK_REPO;
  // `resolveOwnershipRepos` always resolves the framework bucket (it defaults
  // to the mirror constant), and both slugs above are well-formed by
  // construction — so neither the render nor the split can yield a blank half.
  const frameworkRepo = formatRepoSlug(repos.framework);
  const [cOwner, cRepo] = consumerRepo.split('/');
  const currentRepo = { owner: cOwner, repo: cRepo };
  return {
    frameworkRepo,
    consumerRepo,
    platform: formatRepoSlug(repos.platform),
    currentRepo,
    repos: {
      consumer: currentRepo,
      framework: repos.framework,
      platform: repos.platform,
    },
  };
}

/**
 * Gather the Story's friction signals for the composer.
 *
 * **`storyId` and `details` are load-bearing (Story #4649).** This function
 * used to flatten every record to `{ category, source }`, which silently
 * dropped exactly the two fields `netOutRecoveredIncidents` keys on — so the
 * Story #4622 recovery-netting could never fire on real data, and every
 * transient friction event survived to be auto-filed. The composer's unit
 * tests passed throughout, because they fed it synthetic signals carrying
 * both fields that no production path ever produced. Preserve them.
 *
 * The record's own `storyId` is preferred over the argument so a stream that
 * carries foreign rows attributes each one correctly; the argument is the
 * fallback for records written before the field existed.
 *
 * @param {number} storyId
 * @param {object} [config]
 * @returns {Promise<Array<{ category: string, source: 'framework'|'consumer', storyId: number, details: object }>>}
 */
export async function gatherStoryFrictionSignals(storyId, config) {
  const signals = [];
  await forEachLine(
    null,
    storyId,
    (parsed) => {
      const signal = normalizeGatheredSignal(parsed, storyId);
      if (signal) signals.push(signal);
    },
    config,
  );
  return signals;
}

/**
 * Identity of one physical signal row, for de-duplication.
 *
 * `eventId` is minted by every producer (`diagnose-friction.js` and
 * `runtime-friction.js` both `crypto.randomUUID()` it), so it is the primary
 * key. A row predating the field falls back to its physical `file:line`,
 * which is equally stable — the same row read through two passes over the
 * same tree yields the same coordinates.
 *
 * @param {unknown} parsed
 * @param {string} file
 * @param {number} lineNumber
 * @returns {string}
 */
function signalIdentity(parsed, file, lineNumber) {
  const eventId =
    parsed !== null &&
    typeof parsed === 'object' &&
    typeof (/** @type {Record<string, unknown>} */ (parsed).eventId) ===
      'string'
      ? /** @type {string} */ (
          /** @type {Record<string, unknown>} */ (parsed).eventId
        ).trim()
      : '';
  return eventId.length > 0 ? `event:${eventId}` : `row:${file}:${lineNumber}`;
}

/**
 * Gather friction signals for the run-scoped roll-up, over the **whole
 * surviving recurrence window** rather than the run's own Stories
 * (Story #4824).
 *
 * The recurrence threshold in `retro-proposals.js` is ≥ 2 occurrences, and
 * the window it was measured over was one run's Story ids. A defect that
 * fires exactly **once per Story** — which is what a systemic framework
 * defect looks like — therefore scored 1 on every Story and was discarded as
 * a singleton, forever. Eighteen consecutive Stories filed nothing.
 *
 * So the gather reduces over every `signals.ndjson` still present under the
 * configured temp root: `<tempRoot>/standalone/stories/story-<sid>/` and
 * `<tempRoot>/run-<eid>/stories/story-<sid>/`. Temp-tree auto-purge
 * shortening that window is acceptable — a short window under-counts, and
 * therefore fails toward *not* filing, which is the safe direction.
 *
 * The run's own Stories are still gathered explicitly first. The discovery
 * walk resolves through the identical path helpers, so it is provably a
 * superset; the explicit pass makes "never fewer signals than before" a
 * property of the code rather than of an argument about path resolution.
 * {@link signalIdentity} de-duplicates the overlap, so one event can never be
 * counted twice and inflate a singleton into a fabricated recurrence.
 *
 * Homed beside {@link gatherStoryFrictionSignals} on purpose: the two used to
 * be independent copies of the same loop in two modules, and they drifted in
 * exactly the way that made the recovery-netting unreachable (Story #4649).
 * One reader, one normalizer, no second place to forget a field.
 *
 * Unusable ids are skipped rather than throwing — a roll-up must not fail the
 * epilogue over one malformed entry.
 *
 * **Bounded by age, not by run (Story #4850).** Widening the window to the
 * whole surviving temp tree also made it unbounded in *time*: a defect fixed
 * weeks ago kept its occurrences on disk and kept re-routing forever, burying
 * a genuine new regression underneath a historical ledger. Rows older than
 * `delivery.feedbackLoop.frictionWindowDays` (default 30) are excluded, as are
 * rows carrying no `ts` a `Date` can read — excluding an undateable row is the
 * direction that fails toward under-counting, and under-counting fails toward
 * not filing. Both exclusions are **counted and reported**, so a caller can
 * tell a bounded window from an unbounded one without reading prose.
 *
 * A recovery marker is written after the incident it cancels, so a marker can
 * never fall outside a window its incident is inside — the netting cannot be
 * broken by the age floor.
 *
 * @param {Array<number|string>} storyIds The run's own Stories.
 * @param {object} [config]
 * @param {{ now?: number }} [clock] Injected epoch-ms seam so a test can pin
 *   the window without touching the system clock.
 * @returns {Promise<{
 *   signals: Array<{ category: string, source: 'framework'|'consumer', storyId: number, ts: string|null, details: object }>,
 *   window: { days: number, cutoff: string, excludedStale: number, excludedUnparseable: number },
 * }>}
 */
export async function gatherRunFrictionSignals(
  storyIds,
  config,
  { now = Date.now() } = {},
) {
  const days = resolveFrictionWindowDays(config);
  const cutoffMs = now - days * MS_PER_DAY;
  const signals = [];
  const seen = new Set();
  let excludedStale = 0;
  let excludedUnparseable = 0;
  const take = (parsed, fallbackStoryId, identity) => {
    if (seen.has(identity)) return;
    seen.add(identity);
    const signal = normalizeGatheredSignal(parsed, fallbackStoryId);
    if (!signal) return;
    const ms = signal.ts === null ? Number.NaN : Date.parse(signal.ts);
    if (!Number.isFinite(ms)) {
      excludedUnparseable += 1;
      return;
    }
    if (ms < cutoffMs) {
      excludedStale += 1;
      return;
    }
    signals.push(signal);
  };

  for (const raw of Array.isArray(storyIds) ? storyIds : []) {
    const sid = Number(raw);
    if (!Number.isInteger(sid) || sid <= 0) continue;
    const file = signalsFile(null, sid, config);
    await forEachLine(
      null,
      sid,
      (parsed, lineNumber) =>
        take(parsed, sid, signalIdentity(parsed, file, lineNumber)),
      config,
    );
  }

  await forEachSignalStreamLine(
    (parsed, { storyId, file, lineNumber }) =>
      take(parsed, storyId, signalIdentity(parsed, file, lineNumber)),
    config,
  );

  return {
    signals,
    window: {
      days,
      cutoff: new Date(cutoffMs).toISOString(),
      excludedStale,
      excludedUnparseable,
    },
  };
}

/**
 * Render the empty-roll-up line.
 *
 * Story #4578 — an empty roll-up over a multi-Story run must NOT read as
 * success. The pre-#4578 text ("No friction signals — nothing to follow up")
 * was *truthful* about the stream and *false* about the run: a 7-Story
 * delivery containing a mid-run git outage, a parked worker, and a
 * four-round acceptance critic rendered byte-identically to a genuinely
 * clean run. An operator cannot tell "nothing went wrong" from "the
 * telemetry never fired", and the second is likeliest exactly when the run
 * went worst.
 *
 * So the line is a function of `storyCount`:
 *   - `storyCount <= 1` → the honest, quiet reading is retained. A single
 *     Story that emitted nothing plausibly *was* clean, and crying wolf on
 *     every clean Story is how a warning channel gets tuned out.
 *   - `storyCount > 1`  → zero signals across N Stories is a **claim**, and
 *     the surrounding text says so and names the two readings, rather than
 *     asserting the flattering one.
 *
 * This mirrors the sibling precedent in `run-epilogue.js`'s
 * `renderDiffLines`, which refuses to let an unresolvable base diff render
 * as "0 changed files".
 *
 * @param {number} storyCount
 * @returns {string[]}
 */
function renderEmptyRollupLines(storyCount) {
  if (storyCount <= 1) {
    return ['_No friction signals — nothing to follow up._'];
  }
  return [
    `> ⚠️ **0 friction signals across ${storyCount} Stories — this is a claim, not a clean bill of health.**`,
    '> Either the run was genuinely friction-free, or telemetry never fired.',
    '> An empty stream is indistinguishable from a clean run, and it is least',
    '> likely to fill exactly when a run is going badly and the agent is busy.',
    '> The runtime emits friction from its own observables (`agent::blocked`',
    '> transitions, failed closes, exhausted merge waits) — so zero here also',
    '> means none of those fired. If the run had friction you can name, that',
    '> gap is itself the follow-up worth filing.',
  ];
}

/**
 * Skip reasons that are a deliberate outcome rather than a broken loop. A
 * roll-up whose every proposal was skipped for one of these filed nothing
 * *on purpose*; anything else is the loop failing quietly.
 */
const BENIGN_SKIP_REASONS = new Set([
  'already-filed',
  'toggle-disabled',
  'cross-repo-deferred',
  'cap-reached',
  'no-actionable-proposals',
]);

/**
 * Summarize a category corpus for the "name what you saw" lines. Pure.
 *
 * @param {Array<{ category?: string }>} signals
 * @returns {Array<{ category: string, occurrences: number }>}
 */
export function summarizeSignalCategories(signals) {
  const counts = new Map();
  for (const sig of Array.isArray(signals) ? signals : []) {
    if (sig === null || typeof sig !== 'object') continue;
    const category =
      typeof sig.category === 'string' ? sig.category.trim() : '';
    if (category.length === 0) continue;
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([category, occurrences]) => ({ category, occurrences }))
    .sort((a, b) => a.category.localeCompare(b.category));
}

/**
 * Classify what a roll-up's own numbers say about it — the reporting-layer
 * assertion Story #4828 adds. Pure, so the run epilogue's step result and the
 * rendered comment cannot disagree about whether a roll-up succeeded.
 *
 * Two suspect shapes, both of which previously rendered as success:
 *
 *   - `zeroProposals` — signals were gathered and **nothing** came out, not
 *     even a below-threshold row. That is the third instance of the failure
 *     mode Story #4578 fixed for the zero-signal case and Story #4824 for the
 *     all-discarded case: an all-empty routed result is silence, and a routing
 *     regression is exactly what it looks like.
 *   - `unfiledProposals` — proposals cleared the threshold and none were
 *     filed for a reason that is not a deliberate one. This is what actually
 *     happened in Story #4828: `gh issue create` rejected every call over an
 *     absent label, the error landed in a bucket nobody rendered, and the
 *     roll-up reported `filed: 0`.
 *
 * @param {object} args
 * @param {number} args.signalCount
 * @param {number} args.proposalCount   framework + consumer
 * @param {number} args.discardedCount
 * @param {number} args.filedCount
 * @param {string[]} [args.filingErrors]
 * @param {Array<{ reason?: string }>} [args.filingSkipped]
 * @returns {{ zeroProposals: boolean, unfiledProposals: boolean, blockingSkipReasons: string[] }}
 */
export function assessRollupOutcome({
  signalCount,
  proposalCount,
  discardedCount,
  filedCount,
  filingErrors = [],
  filingSkipped = [],
}) {
  const blockingSkipReasons = [
    ...new Set(
      (Array.isArray(filingSkipped) ? filingSkipped : [])
        .map((entry) => (typeof entry?.reason === 'string' ? entry.reason : ''))
        .filter((reason) => reason && !BENIGN_SKIP_REASONS.has(reason)),
    ),
  ].sort();
  const errors = Array.isArray(filingErrors) ? filingErrors : [];
  return {
    zeroProposals:
      signalCount > 0 && proposalCount === 0 && discardedCount === 0,
    unfiledProposals:
      proposalCount > 0 &&
      filedCount === 0 &&
      (errors.length > 0 || blockingSkipReasons.length > 0),
    blockingSkipReasons,
  };
}

/**
 * Render the "N signals in, zero proposals out" warning (Story #4828).
 *
 * @param {number} signalCount
 * @param {Array<{ category: string, occurrences: number }>} categories
 * @returns {string[]}
 */
function renderZeroProposalLines(signalCount, categories) {
  const named =
    categories.length > 0
      ? categories.map((c) => `\`${c.category}\` ×${c.occurrences}`).join(', ')
      : '_none — every gathered signal carried an unusable category_';
  return [
    `> ⚠️ **${signalCount} friction signals gathered, 0 proposals produced — a routing outcome, not a clean run.**`,
    `> Categories seen: ${named}.`,
    '> Nothing cleared the actionable threshold AND nothing was recorded below',
    '> it, so every signal was netted out as recovered or dropped in routing.',
    '> A regression in routing renders byte-identically to this, which is why',
    '> the roll-up states it rather than rendering silence.',
  ];
}

/**
 * Render the "proposals cleared the threshold but none were filed" warning
 * (Story #4828).
 *
 * @param {number} proposalCount
 * @param {string[]} filingErrors
 * @param {string[]} blockingSkipReasons
 * @returns {string[]}
 */
function renderUnfiledProposalLines(
  proposalCount,
  filingErrors,
  blockingSkipReasons,
) {
  const lines = [
    `> ⚠️ **${proposalCount} actionable proposal(s) reached the filer and none were filed.**`,
    '> Auto-file is on, so this is the feedback loop failing, not declining.',
  ];
  if (blockingSkipReasons.length > 0) {
    lines.push(`> Skipped: ${blockingSkipReasons.join(', ')}.`);
  }
  for (const error of filingErrors) {
    lines.push(`> ${error}`);
  }
  return lines;
}

/**
 * Render one discarded (below-threshold) roll-up row (Story #4824).
 *
 * The pre-#4824 row was `` `category` ×N `` and nothing else. That is exactly
 * how a defect firing once per Story stayed invisible for eighteen
 * consecutive Stories: an operator reading "×1" cannot tell a one-off from a
 * systemic defect whose window was too narrow to see it recur. The row now
 * names the emitting tools, the bucket fingerprint, and the number of
 * distinct Stories it spans — the cross-run count the widened recurrence
 * window produces.
 *
 * Every added field is optional so a caller passing a hand-built proposals
 * object (or an older persisted one) still renders.
 *
 * @param {{ category: string, occurrences: number, tools?: string[], fingerprint?: string, storyCount?: number }} item
 * @returns {string}
 */
function renderDiscardedItem(item) {
  const parts = [`\`${item.category}\` ×${item.occurrences}`];
  if (Number.isInteger(item.storyCount) && item.storyCount > 0) {
    const plural = item.storyCount === 1 ? 'Story' : 'Stories';
    parts.push(`across ${item.storyCount} ${plural}`);
  }
  if (Array.isArray(item.tools) && item.tools.length > 0) {
    parts.push(`via ${item.tools.map((t) => `\`${t}\``).join(', ')}`);
  }
  if (typeof item.fingerprint === 'string' && item.fingerprint.length > 0) {
    parts.push(`fingerprint \`${item.fingerprint}\``);
  }
  return parts.join(' — ');
}

/**
 * Normalize the two loosely-typed inputs into the four buckets every section
 * renderer reads. Absorbs the optional-chain / nullish-coalesce cluster that
 * otherwise all lands on `buildFollowUpsCommentBody` (Story #4926).
 *
 * @param {object|null|undefined} proposals
 * @param {object|null|undefined} graduated
 * @returns {{ filed: object[], framework: object[], consumer: object[],
 *   discarded: object[], filingErrors: string[] }}
 */
function normalizeRollupBuckets(proposals, graduated) {
  const asArray = (value) => (Array.isArray(value) ? value : []);
  return {
    filed: asArray(graduated?.filed),
    framework: asArray(proposals?.framework),
    consumer: asArray(proposals?.consumer),
    discarded: asArray(proposals?.discarded),
    filingErrors: asArray(graduated?.errors),
  };
}

/**
 * Render the "**Filed**" section, or nothing when no proposal was filed.
 *
 * @param {object[]} filed
 * @returns {string[]}
 */
function renderFiledSection(filed) {
  if (filed.length === 0) return [];
  return [
    '**Filed**',
    ...filed.map(
      (item) =>
        `- ${item.source}: ${item.title}${item.url ? ` — ${item.url}` : ''}`,
    ),
    '',
  ];
}

/**
 * Render the "**Actionable (not auto-filed)**" fallback — the command stanzas
 * an operator runs by hand when auto-filing produced nothing.
 *
 * @param {object[]} actionable framework + consumer, in that order
 * @param {object[]} filed
 * @returns {string[]}
 */
function renderActionableSection(actionable, filed) {
  if (actionable.length === 0 || filed.length > 0) return [];
  const lines = ['**Actionable (not auto-filed)**'];
  for (const item of actionable) {
    lines.push(`- ${item.source}: ${item.title}`, '', '```bash', item.command);
    lines.push('```');
  }
  lines.push('');
  return lines;
}

/**
 * Render the "**Below threshold (not filed)**" section.
 *
 * @param {object[]} discarded
 * @returns {string[]}
 */
function renderDiscardedSection(discarded) {
  if (discarded.length === 0) return [];
  return [
    '**Below threshold (not filed)**',
    ...discarded.map(
      (item) => `- ${item.source}: ${renderDiscardedItem(item)}`,
    ),
    '',
  ];
}

/**
 * Render the all-empty branch. Story #4828 — "no proposals" has two readings,
 * and only one of them is a quiet run. Signals gathered but nothing routed is
 * the third instance of the silence Stories #4578 and #4824 each fixed once.
 *
 * @param {{ empty: boolean, outcome: {zeroProposals: boolean},
 *   signalCount: number, categories: object[], storyCount: number }} args
 * @returns {string[]}
 */
function renderEmptySection({
  empty,
  outcome,
  signalCount,
  categories,
  storyCount,
}) {
  if (!empty) return [];
  return [
    ...(outcome.zeroProposals
      ? renderZeroProposalLines(signalCount, categories)
      : renderEmptyRollupLines(storyCount)),
    '',
  ];
}

/**
 * Build the machine-readable twin of the rendered prose. Every suspect flag
 * above has a field here so a caller never has to regex the body.
 *
 * @param {object} args
 * @returns {object}
 */
function buildRollupPayload({
  storyId,
  storyCount,
  signalCount,
  categories,
  buckets,
  empty,
  outcome,
}) {
  const { filed, framework, consumer, discarded, filingErrors } = buckets;
  return {
    storyId,
    storyCount,
    // Story #4828 — the corpus the roll-up actually read. Without it a
    // reader cannot tell "0 proposals because nothing recurred" from
    // "0 proposals because routing broke".
    signalCount,
    categories,
    framework: framework.map((i) => i.category),
    consumer: consumer.map((i) => i.category),
    // Story #4824 — the machine-readable twin of the row above. A bare
    // category list could not distinguish a genuine one-off from a
    // recurrence the window was too narrow to see, so the count, the
    // cross-Story span, and the shape fingerprint ride along.
    discarded: discarded.map((i) => ({
      category: i.category,
      occurrences: i.occurrences,
      storyCount: i.storyCount ?? null,
      fingerprint: i.fingerprint ?? null,
    })),
    filed: filed.map((i) => ({ category: i.category, url: i.url ?? null })),
    // Story #4578 — an empty roll-up over N>1 Stories is a claim worth
    // flagging, not a success. Machine-readable twin of the warning
    // prose so a caller need not regex the body.
    emptyRollupSuspect: storyCount > 1 && empty && signalCount === 0,
    // Story #4828 — the two remaining shapes that used to render as
    // success. Machine-readable twins of the warning prose above.
    zeroProposalSuspect: outcome.zeroProposals,
    unfiledProposalSuspect: outcome.unfiledProposals,
    filingErrors,
  };
}

/**
 * @param {{
 *   storyId: number,
 *   proposals: object,
 *   graduated: object,
 *   storyCount?: number,
 *   signalCount?: number,
 *   categories?: Array<{ category: string, occurrences: number }>,
 * }} args - `storyCount` (default 1) is how many Stories the roll-up spans;
 *   it decides whether an empty result reads as quiet or as a flagged claim.
 *   `signalCount` / `categories` (Story #4828) are what the roll-up actually
 *   gathered, so a zero-proposal or zero-filed outcome can name its own
 *   corpus instead of rendering as a clean run.
 * @returns {string}
 */
export function buildFollowUpsCommentBody({
  storyId,
  proposals,
  graduated,
  storyCount = 1,
  signalCount = 0,
  categories = [],
}) {
  const buckets = normalizeRollupBuckets(proposals, graduated);
  const { filed, framework, consumer, discarded } = buckets;
  const actionable = [...framework, ...consumer];
  const empty =
    filed.length === 0 && actionable.length === 0 && discarded.length === 0;
  const outcome = assessRollupOutcome({
    signalCount,
    proposalCount: actionable.length,
    discardedCount: discarded.length,
    filedCount: filed.length,
    filingErrors: graduated?.errors,
    filingSkipped: graduated?.skipped,
  });
  const lines = [
    '### follow-ups',
    '',
    `Actionable follow-ups captured from Story #${storyId} after merge.`,
    '',
    ...(outcome.unfiledProposals
      ? [
          ...renderUnfiledProposalLines(
            actionable.length,
            buckets.filingErrors,
            outcome.blockingSkipReasons,
          ),
          '',
        ]
      : []),
    ...renderFiledSection(filed),
    ...renderActionableSection(actionable, filed),
    ...renderDiscardedSection(discarded),
    ...renderEmptySection({
      empty,
      outcome,
      signalCount,
      categories,
      storyCount,
    }),
    '```json',
  ];
  lines.push(
    JSON.stringify(
      buildRollupPayload({
        storyId,
        storyCount,
        signalCount,
        categories,
        buckets,
        empty,
        outcome,
      }),
      null,
      2,
    ),
  );
  lines.push('```');
  return lines.join('\n');
}

/**
 * Capture and persist Story follow-ups. Never throws — the land must not
 * fail because follow-up filing flaked.
 *
 * Story #4543 retired the `captureFollowUpsAfterConfirm` action-gate wrapper
 * (and its `withConfirmFollowUps` sibling) that used to front this function.
 * Re-deriving "did the merge land?" from a confirmation envelope's `action`
 * field was the coupling that made close-and-land — the DEFAULT path — skip
 * capture entirely: the gate only opened on the standalone CLI's `done`, and
 * a belated manual confirm could not backfill because the Story was already
 * `agent::done` (confirm returns `noop`, the gate never opens). The shared
 * land tail (`single-story-close/phases/post-land.js`) now calls this
 * directly, after the merge is already confirmed.
 *
 * @param {object} args
 * @param {number} args.storyId
 * @param {object} args.provider
 * @param {object} [args.config]
 * @param {string} [args.cwd]
 * @param {(tag: string, msg: string) => void} [args.progress]
 * @returns {Promise<object>}
 */
export async function captureStoryFollowUps({
  storyId,
  provider,
  config,
  cwd,
  progress,
}) {
  const sid = Number(storyId);
  if (!Number.isInteger(sid) || sid <= 0) {
    return { ok: false, reason: 'invalid-story-id' };
  }
  try {
    const signals = await gatherStoryFrictionSignals(sid, config);
    const repos = resolveFollowUpRepos(config);
    const proposals = composeRoutedProposals({
      anchorId: sid,
      anchorKind: 'story',
      frameworkRepo: repos.frameworkRepo,
      consumerRepo: repos.consumerRepo,
      signals,
      // Derived, not hardcoded `[]` (Story #4649). This is the escape hatch
      // the retired story-scope threshold carve-out was standing in for: a
      // Story still parked at `agent::blocked` files at a single occurrence,
      // while one that blocked and self-resolved nets out entirely.
      unresolvedBlockedEvents: deriveUnresolvedBlockedEvents(signals),
    });
    const graduated = await graduateRetroProposals({
      epicId: sid,
      provider,
      config,
      currentRepo: repos.currentRepo,
      // The resolved bucket object, not a re-split of the slug: routing is
      // decided once in `github/framework-repo.js`.
      frameworkRepo: repos.repos.framework,
      platformRepo: repos.repos.platform,
      routedProposals: proposals,
      cwd,
    });
    const body = buildFollowUpsCommentBody({
      storyId: sid,
      proposals,
      graduated,
      signalCount: signals.length,
      categories: summarizeSignalCategories(signals),
    });
    await upsertStructuredComment(provider, sid, FOLLOW_UPS_COMMENT_TYPE, body);
    progress?.(
      'FOLLOW-UPS',
      `Captured follow-ups for Story #${sid} (filed=${graduated.filed?.length ?? 0}).`,
    );
    return {
      ok: true,
      storyId: sid,
      proposals,
      graduated,
      signalCount: signals.length,
    };
  } catch (err) {
    Logger.warn(
      `[story-follow-ups] capture failed for #${sid}: ${err?.message ?? err}`,
    );
    progress?.(
      'FOLLOW-UPS',
      `⚠️ Follow-up capture failed (close continues): ${err?.message ?? err}`,
    );
    return {
      ok: false,
      reason: 'capture-failed',
      error: String(err?.message ?? err),
    };
  }
}

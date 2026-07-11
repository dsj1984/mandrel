/**
 * phases/compose-body.js — retro Phase 2: compose the retro markdown body.
 *
 * Pure: given an aggregated counts/signals input, produce the retro
 * markdown body plus the compact/scorecard envelope. Selects the compact
 * (clean-manifest) or full retro shape via `isCleanManifest`.
 *
 * `normalizeInterventionCount` is exported so the post-and-mirror phase
 * can reuse the same clamping logic when forwarding the runtime's
 * `manualInterventions` count into the body composer.
 */

import { isCleanManifest } from '../../retro-heuristics.js';
import { classifyPerfSignals } from '../../retro-perf-heuristics.js';

/**
 * Pure: clamp a candidate count to a non-negative integer. Used to
 * normalize the `manualInterventions` count plumbed in from the
 * epic-run-state-store snapshot before it lands in the scorecard.
 * Non-finite, negative, or non-numeric values collapse to 0.
 */
export function normalizeInterventionCount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.trunc(value);
}

/**
 * Pure: does `routedProposals` carry at least one actionable item (a
 * framework- or consumer-routed `gh issue create` proposal)? Story #4417 —
 * the compact retro shape (and therefore the `automerge-verdict`
 * `cleanSprint: true` flag it drives) MUST be suppressed whenever an
 * actionable proposal exists, regardless of `forceFull` or the
 * comment-derived counts: the clean-sprint verdict is an auto-merge input
 * and must never read "clean" while actionable friction sits in the routed
 * proposals. Discarded (single-occurrence) items do NOT count — they are
 * the retro's explicit "nothing to file" bucket.
 *
 * @param {{ framework?: object[], consumer?: object[] } | null | undefined} routedProposals
 * @returns {boolean}
 */
export function hasActionableProposals(routedProposals) {
  if (
    !routedProposals ||
    typeof routedProposals !== 'object' ||
    Array.isArray(routedProposals)
  ) {
    return false;
  }
  const framework = Array.isArray(routedProposals.framework)
    ? routedProposals.framework
    : [];
  const consumer = Array.isArray(routedProposals.consumer)
    ? routedProposals.consumer
    : [];
  return framework.length > 0 || consumer.length > 0;
}

/**
 * Pure: derive the recurring-defect-class signal from the routed-proposal
 * sections (Story #4135 / Epic #4131, F11).
 *
 * The routed-proposals composer (`retro-proposals.js`) already split the
 * Epic's source-tagged friction into `framework` / `consumer` actionable
 * items — a category lands there only when it recurred ≥2 times across the
 * Epic OR was force-flagged by an unresolved `agent::blocked` event. Those
 * are exactly the **recurring classes** of review/deliver-caught issues F11
 * tracks, so we lift them verbatim rather than re-deriving a parallel
 * threshold. Each entry carries the `friction::<category>` label the
 * composer stamps onto its `gh issue create` command — that label is the
 * join key the `/plan` Phase 0 prior-feedback fetcher reads back to surface
 * recurring classes to the planner.
 *
 * Determinism: the two actionable arrays are already sorted by `category`
 * ASC by the composer; we concatenate framework-then-consumer and re-sort by
 * `category` so the merged signal is stable regardless of which source
 * contributed a class.
 *
 * No-op-safe: a null / non-object / shapeless `routedProposals` (or one with
 * empty actionable arrays) yields `[]` — the common clean-sprint case.
 *
 * @param {{ framework?: object[], consumer?: object[] } | null | undefined} routedProposals
 * @returns {Array<{ category: string, occurrences: number, source: 'framework'|'consumer', label: string }>}
 */
export function deriveDefectClasses(routedProposals) {
  if (
    !routedProposals ||
    typeof routedProposals !== 'object' ||
    Array.isArray(routedProposals)
  ) {
    return [];
  }
  const framework = Array.isArray(routedProposals.framework)
    ? routedProposals.framework
    : [];
  const consumer = Array.isArray(routedProposals.consumer)
    ? routedProposals.consumer
    : [];

  const out = [];
  for (const item of [...framework, ...consumer]) {
    if (!item || typeof item !== 'object') continue;
    const category =
      typeof item.category === 'string' ? item.category.trim() : '';
    if (category.length === 0) continue;
    const occurrences =
      typeof item.occurrences === 'number' && Number.isFinite(item.occurrences)
        ? item.occurrences
        : 0;
    const source = item.source === 'framework' ? 'framework' : 'consumer';
    out.push({
      category,
      occurrences,
      source,
      label: `friction::${category}`,
    });
  }
  out.sort((a, b) => a.category.localeCompare(b.category));
  return out;
}

/**
 * Pure: compose the retro markdown body. Exported for tests so they can
 * verify the body shape without round-tripping through a stub provider.
 *
 * Story #2289 adds `counts.interventions` — sourced from the
 * `manualInterventions` array on the `epic-run-state` snapshot (the
 * same list that disqualifies an Epic from auto-merge). Non-zero
 * interventions route to the full retro shape via `isCleanManifest`.
 *
 * @param {{
 *   epicId: number,
 *   epicTitle?: string,
 *   counts: { friction: number, parked: number, recuts: number, hitl: number, interventions?: number },
 *   storyPerfSummaries?: object[],
 *   epicPerfReport?: object|null,
 *   parkedFollowOns?: { recuts: object[], parked: object[] },
 *   timestamp?: string,
 *   forceFull?: boolean,
 * }} input
 * @returns {{ body: string, compact: boolean, scorecard: object }}
 */
export function composeRetroBody(input) {
  const {
    epicId,
    epicTitle = `Epic ${epicId}`,
    counts,
    storyPerfSummaries = [],
    epicPerfReport = null,
    parkedFollowOns = { recuts: [], parked: [] },
    routedProposals = null,
    timestamp = new Date().toISOString(),
    forceFull = false,
    perfThresholds = null,
  } = input;

  const interventions = normalizeInterventionCount(counts?.interventions);
  // Story #4417 — the compact shape requires BOTH a clean manifest AND zero
  // actionable routed proposals. The routed proposals and the counts are
  // derived from the same unified signals scan (gather-signals.js), so this
  // guard closes the window where the comment-derived counts read "clean"
  // while the ndjson-derived routed proposals hold an actionable item.
  const compact =
    !forceFull &&
    isCleanManifest({ ...counts, interventions }) &&
    !hasActionableProposals(routedProposals);
  const heading = `## 🪞 Sprint Retrospective — Epic #${epicId}: ${epicTitle}`;
  const generatedLine = `_Generated ${timestamp}_`;
  const scorecardRows = [
    `| agent::blocked Events Raised | ${counts.hitl} |`,
    `| Manual Interventions         | ${interventions} |`,
    `| Friction Events              | ${counts.friction} |`,
  ];
  const scorecard = {
    hitl: counts.hitl,
    friction: counts.friction,
    parked: counts.parked,
    recuts: counts.recuts,
    interventions,
  };
  const completeMarker = `<!-- retro-complete: ${timestamp} -->`;
  // Machine-readable auto-merge verdict trailer (Story #3901). The
  // Phase 8.5 `AutomergePredicate` reads `cleanSprint` from THIS trailer
  // — a parsed JSON boolean — rather than string-matching the human-facing
  // "🟢 Clean sprint" prose, which was a brittle emoji `.includes()` that
  // false-positived on any retro body that happened to quote the marker
  // and false-negatived on any compact-body copy edit. `cleanSprint`
  // tracks the compact shape exactly (a full/forced retro is never a
  // clean sprint); the scorecard is mirrored so the predicate can surface
  // the disqualifying counts without re-parsing the markdown table.
  const automergeTrailer = `<!-- automerge-verdict: ${JSON.stringify({
    cleanSprint: compact,
    scorecard,
  })} -->`;

  if (compact) {
    const body = [
      heading,
      '',
      generatedLine,
      '',
      '🟢 Clean sprint — zero friction, zero parked follow-ons, zero recuts, zero agent::blocked events, zero manual interventions.',
      '',
      '### Sprint Scorecard',
      '',
      '| Metric                       | Value |',
      '| ---------------------------- | ----- |',
      ...scorecardRows,
      '',
      '### Session Observations',
      '',
      '_Nothing notable beyond the scorecard._',
      '',
      '### Action Items for Next Epic',
      '',
      '_None._',
      '',
      completeMarker,
      automergeTrailer,
    ].join('\n');
    return { body, compact: true, scorecard };
  }

  // Full path — six sections.
  const hotspotLines =
    epicPerfReport &&
    Array.isArray(epicPerfReport.topHotspots) &&
    epicPerfReport.topHotspots.length > 0
      ? epicPerfReport.topHotspots.map(
          (h) =>
            `- \`${h.phase}\` — ${h.occurrences} occurrence(s), avg ratio ${
              typeof h.avgRatio === 'number' ? h.avgRatio.toFixed(2) : 'n/a'
            }`,
        )
      : ['_No epic-perf-report available._'];

  const parkedLines =
    parkedFollowOns.parked.length > 0
      ? parkedFollowOns.parked.map(
          (p) =>
            `- Adopt or close parked follow-on #${p.storyId ?? p.id ?? '?'}`,
        )
      : [];
  const recutLines =
    parkedFollowOns.recuts.length > 0
      ? parkedFollowOns.recuts.map(
          (r) => `- Recut #${r.storyId ?? r.id ?? '?'} attributed to manifest`,
        )
      : [];
  const legacyActionItems = [...parkedLines, ...recutLines];
  const legacyActionItemsBody =
    legacyActionItems.length > 0 ? legacyActionItems.join('\n') : '_None._';

  // Story #2558 — routed-proposals mode. When routedProposals is supplied
  // AND any of the three buckets is non-empty, render the three explicit
  // sections in deterministic order ABOVE the retro-complete marker:
  //   1. Proposed issues — consumer repo
  //   2. Proposed issues — framework repo
  //   3. One-off / discarded
  // Otherwise the legacy "Action Items for Next Epic" section renders.
  const routedSectionsBlock = renderRoutedSections(routedProposals);

  const actionSection =
    routedSectionsBlock === null
      ? ['### Action Items for Next Epic', '', legacyActionItemsBody]
      : routedSectionsBlock;

  // Story #3042 — Performance Signals + Recommended Follow-Ons. Both
  // sections are emitted only when (1) the persisted epic-perf-report is
  // present AND (2) `classifyPerfSignals` returns at least one signal.
  // Otherwise the entire pair is suppressed so the retro stays compact.
  const perfReportForHeuristics = epicPerfReport
    ? { ...epicPerfReport, storyPerfSummaries }
    : null;
  const perfSignals = perfReportForHeuristics
    ? classifyPerfSignals(perfReportForHeuristics, perfThresholds)
    : [];
  const perfSignalsSection = renderPerfSignalsSection(perfSignals);
  const followOnsSection = renderFollowOnsSection(perfSignals);

  const body = [
    heading,
    '',
    generatedLine,
    '',
    '### Sprint Scorecard',
    '',
    '| Metric                       | Value |',
    '| ---------------------------- | ----- |',
    ...scorecardRows,
    '',
    '### What Went Well',
    '',
    '_(populate from execution telemetry — extracted retro module emits a placeholder; deeper analysis is the operator follow-up.)_',
    '',
    '### What Could Be Improved',
    '',
    '#### Top hotspots',
    '',
    ...hotspotLines,
    '',
    '### Architectural Debt',
    '',
    '_(no automated detection in v5.40.0 — operator review required.)_',
    '',
    '### Protocol Optimization Recommendations (Self-Healing)',
    '',
    '_(operator follow-up.)_',
    '',
    ...actionSection,
    '',
    ...perfSignalsSection,
    ...followOnsSection,
    completeMarker,
    automergeTrailer,
  ].join('\n');
  return { body, compact: false, scorecard };
}

/**
 * Pure: render the `## Performance Signals` section. Returns `[]` (so the
 * caller can spread it conditionally) when no signal trips. The renderer
 * emits one bullet per signal, naming the kind, the offending wave(s),
 * the observed value, and the threshold that produced the signal.
 *
 * @param {Array<object>} signals
 * @returns {string[]}
 */
function renderPerfSignalsSection(signals) {
  if (!Array.isArray(signals) || signals.length === 0) return [];
  const lines = ['## Performance Signals', ''];
  for (const s of signals) {
    lines.push(`- ${describeSignal(s)}`);
  }
  lines.push('');
  return lines;
}

/**
 * Pure: render the `## Recommended Follow-Ons` section. One stanza per
 * signal, each carrying a Conventional-Commits-shaped title and a body
 * including the suggested `meta::framework-gap` label.
 *
 * Each stanza is a `gh issue create` command operators can paste directly:
 * the title is in Conventional-Commits form, and the body names the
 * trigger metric so the planner has the context for triage.
 *
 * @param {Array<object>} signals
 * @returns {string[]}
 */
function renderFollowOnsSection(signals) {
  if (!Array.isArray(signals) || signals.length === 0) return [];
  const lines = ['## Recommended Follow-Ons', ''];
  for (const s of signals) {
    const title = followOnTitle(s);
    const body = followOnBody(s);
    lines.push(`- **${title}**`);
    lines.push('');
    lines.push('```sh');
    lines.push(
      `gh issue create --title ${shellEscape(title)} --label meta::framework-gap --body ${shellEscape(body)}`,
    );
    lines.push('```');
    lines.push('');
  }
  return lines;
}

/**
 * Human-readable one-liner for a perf signal — used as the bullet text
 * under `## Performance Signals`. Pure; signal kinds it doesn't know
 * collapse to a generic shape so the renderer never produces empty
 * strings for forward-compatible signal kinds.
 *
 * @param {object} s
 * @returns {string}
 */
function describeSignal(s) {
  if (!s || typeof s !== 'object') return 'unknown perf signal';
  if (s.kind === 'low-utilisation') {
    const pct = formatPercent(s.utilisation);
    const thr = formatPercent(s.threshold);
    return `low-utilisation: wave ${s.waveIndex} ran at ${pct} (threshold ${thr})`;
  }
  if (s.kind === 'high-bootstrap-share') {
    const pct = formatPercent(s.share);
    const thr = formatPercent(s.threshold);
    return `high-bootstrap-share: story-init consumed ${pct} of Story execution time (threshold ${thr})`;
  }
  if (s.kind === 'cap-binding-run') {
    return `cap-binding-run: waves ${s.fromWaveIndex}–${s.toWaveIndex} (${s.runLength} consecutive waves) saturated the concurrency cap`;
  }
  return `${s.kind ?? 'unknown'} perf signal`;
}

/**
 * Conventional-Commits-shaped title for a perf signal's follow-on. Pure.
 *
 * @param {object} s
 * @returns {string}
 */
function followOnTitle(s) {
  if (!s || typeof s !== 'object')
    return 'perf: investigate unknown perf signal';
  if (s.kind === 'low-utilisation') {
    return `perf(epic-deliver): investigate low utilisation in wave ${s.waveIndex}`;
  }
  if (s.kind === 'high-bootstrap-share') {
    return 'perf(story-init): reduce bootstrap share of Story execution time';
  }
  if (s.kind === 'cap-binding-run') {
    return `perf(deliver-runner): raise concurrency cap to break ${s.runLength}-wave cap-binding run`;
  }
  return `perf: investigate ${s.kind} signal`;
}

/**
 * Body for the paste-ready follow-on stanza. Includes the trigger metric
 * so the planner has the context for triage.
 *
 * @param {object} s
 * @returns {string}
 */
function followOnBody(s) {
  const trigger = describeSignal(s);
  return [
    `Auto-suggested by retro-perf-heuristics (Story #3042).`,
    ``,
    `Trigger: ${trigger}.`,
    ``,
    `Apply the meta::framework-gap label so /plan Phase 0 surfaces it on the next planning pass.`,
  ].join('\n');
}

function formatPercent(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 'n/a';
  return `${(n * 100).toFixed(1)}%`;
}

/**
 * Minimal POSIX shell-quote for the `gh issue create` paste-ready
 * command. We single-quote and escape embedded single quotes so the
 * stanza works under bash/zsh/PowerShell-Core. The retro body is
 * read-only documentation, so the quoting is a UX convenience, not a
 * security boundary — but the helper is total nonetheless.
 *
 * @param {string} s
 * @returns {string}
 */
function shellEscape(s) {
  const str = String(s ?? '');
  return `'${str.replace(/'/g, `'\\''`)}'`;
}

/**
 * Render the body lines (everything below a section heading and its trailing
 * blank) for a "proposed issues" bucket — the consumer and framework sections
 * share this shape. Empty buckets collapse to a single `_None._`; populated
 * buckets emit, per item, either the **filed issue reference** (when the
 * retro auto-filer already filed it — Story #4418, stamped as
 * `item.filedIssue`) or the paste-ready fenced `gh issue create` stanza (the
 * toggle-OFF / filing-skipped fallback).
 *
 * @param {object[]} items
 * @returns {string[]}
 */
function renderIssueBucket(items) {
  if (items.length === 0) return ['_None._'];
  const lines = [];
  for (const item of items) {
    lines.push(`- **${item.title ?? item.category}**`);
    lines.push('');
    if (item.filedIssue && item.filedIssue.url) {
      const ref = Number.isInteger(item.filedIssue.number)
        ? `#${item.filedIssue.number}`
        : 'issue';
      lines.push(`  Filed: [${ref}](${item.filedIssue.url})`);
    } else {
      lines.push('```sh');
      lines.push(String(item.command ?? ''));
      lines.push('```');
    }
    lines.push('');
  }
  return lines;
}

/**
 * Render the body lines for the "one-off / discarded" bucket — one bullet per
 * discarded class naming its occurrence count and source, or `_None._`.
 *
 * @param {object[]} items
 * @returns {string[]}
 */
function renderDiscardedBucket(items) {
  if (items.length === 0) return ['_None._'];
  return items.map(
    (d) =>
      `- \`${d.category}\` (${d.occurrences ?? 1} occurrence, source: ${d.source ?? 'consumer'})`,
  );
}

/**
 * Descriptor table for the three routed-proposal sections, in deterministic
 * emit order (consumer → framework → discarded). Each descriptor pairs a
 * heading, the `routedProposals` field it reads, and a body renderer.
 * {@link renderRoutedSections} walks the table once, so reordering or adding a
 * section is a data edit here rather than another copy-pasted emit block.
 *
 * The former "Proposed memory updates" section was deleted in the Epic
 * #4406 signal-contract cutover — no writer ever produced the memory-pane
 * records it rendered.
 *
 * @type {Array<{ heading: string, field: string, renderBucket: (items: object[]) => string[] }>}
 */
const ROUTED_SECTIONS = [
  {
    heading: '### Proposed issues — consumer repo',
    field: 'consumer',
    renderBucket: renderIssueBucket,
  },
  {
    heading: '### Proposed issues — framework repo',
    field: 'framework',
    renderBucket: renderIssueBucket,
  },
  {
    heading: '### One-off / discarded',
    field: 'discarded',
    renderBucket: renderDiscardedBucket,
  },
];

/**
 * Pure: render the four routed-proposal sections in deterministic order.
 * Returns `null` when `routedProposals` is absent or fully empty — the
 * caller falls back to the legacy "Action Items for Next Epic" section so
 * back-compat callers see no shape change.
 *
 * @param {{ framework: object[], consumer: object[], memory: object[], discarded: object[] } | null} routedProposals
 * @returns {string[] | null}
 */
function renderRoutedSections(routedProposals) {
  if (
    !routedProposals ||
    typeof routedProposals !== 'object' ||
    Array.isArray(routedProposals)
  ) {
    return null;
  }
  const buckets = ROUTED_SECTIONS.map((section) => {
    const items = Array.isArray(routedProposals[section.field])
      ? routedProposals[section.field]
      : [];
    return { section, items };
  });
  if (buckets.every(({ items }) => items.length === 0)) {
    return null;
  }

  // Each section renders as `[heading, '', ...body]`; a single blank-line
  // separator sits between consecutive sections (no trailing separator after
  // the last), reproducing the original hand-unrolled push sequence exactly.
  const out = [];
  for (const { section, items } of buckets) {
    if (out.length > 0) out.push('');
    out.push(section.heading, '', ...section.renderBucket(items));
  }
  return out;
}

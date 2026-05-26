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
 *   counts: { friction: number, parked: number, recuts: number, hotfixes: number, hitl: number, interventions?: number },
 *   storyPerfSummaries?: object[],
 *   epicPerfReport?: object|null,
 *   parkedFollowOns?: { recuts: object[], parked: object[] },
 *   tasksTotal?: number,
 *   tasksFirstTry?: number,
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
    epicPerfReport = null,
    parkedFollowOns = { recuts: [], parked: [] },
    routedProposals = null,
    tasksTotal = 0,
    tasksFirstTry = 0,
    timestamp = new Date().toISOString(),
    forceFull = false,
  } = input;

  const interventions = normalizeInterventionCount(counts?.interventions);
  const compact = !forceFull && isCleanManifest({ ...counts, interventions });
  const heading = `## 🪞 Sprint Retrospective — Epic #${epicId}: ${epicTitle}`;
  const generatedLine = `_Generated ${timestamp}_`;
  const scorecardRows = [
    `| Total Tasks                  | ${tasksTotal} |`,
    `| Tasks Completed First Try    | ${tasksFirstTry} |`,
    `| Tasks Requiring Hotfix       | ${counts.hotfixes} |`,
    `| agent::blocked Events Raised | ${counts.hitl} |`,
    `| Manual Interventions         | ${interventions} |`,
    `| Friction Events              | ${counts.friction} |`,
  ];
  const scorecard = {
    totalTasks: tasksTotal,
    tasksFirstTry,
    hotfixes: counts.hotfixes,
    hitl: counts.hitl,
    friction: counts.friction,
    parked: counts.parked,
    recuts: counts.recuts,
    interventions,
  };
  const completeMarker = `<!-- retro-complete: ${timestamp} -->`;

  if (compact) {
    const body = [
      heading,
      '',
      generatedLine,
      '',
      '🟢 Clean sprint — zero friction, zero parked follow-ons, zero recuts, zero hotfixes, zero agent::blocked events, zero manual interventions.',
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
  // AND any of the four buckets is non-empty, render the four explicit
  // sections in deterministic order ABOVE the retro-complete marker:
  //   1. Proposed issues — consumer repo
  //   2. Proposed issues — framework repo
  //   3. Proposed memory updates
  //   4. One-off / discarded
  // Otherwise the legacy "Action Items for Next Epic" section renders.
  const routedSectionsBlock = renderRoutedSections(routedProposals);

  const actionSection =
    routedSectionsBlock === null
      ? ['### Action Items for Next Epic', '', legacyActionItemsBody]
      : routedSectionsBlock;

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
    completeMarker,
  ].join('\n');
  return { body, compact: false, scorecard };
}

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
  const framework = Array.isArray(routedProposals.framework)
    ? routedProposals.framework
    : [];
  const consumer = Array.isArray(routedProposals.consumer)
    ? routedProposals.consumer
    : [];
  const memory = Array.isArray(routedProposals.memory)
    ? routedProposals.memory
    : [];
  const discarded = Array.isArray(routedProposals.discarded)
    ? routedProposals.discarded
    : [];
  if (
    framework.length === 0 &&
    consumer.length === 0 &&
    memory.length === 0 &&
    discarded.length === 0
  ) {
    return null;
  }

  const out = [];
  out.push('### Proposed issues — consumer repo');
  out.push('');
  if (consumer.length === 0) {
    out.push('_None._');
  } else {
    for (const item of consumer) {
      out.push(`- **${item.title ?? item.category}**`);
      out.push('');
      out.push('```sh');
      out.push(String(item.command ?? ''));
      out.push('```');
      out.push('');
    }
  }
  out.push('');
  out.push('### Proposed issues — framework repo');
  out.push('');
  if (framework.length === 0) {
    out.push('_None._');
  } else {
    for (const item of framework) {
      out.push(`- **${item.title ?? item.category}**`);
      out.push('');
      out.push('```sh');
      out.push(String(item.command ?? ''));
      out.push('```');
      out.push('');
    }
  }
  out.push('');
  out.push('### Proposed memory updates');
  out.push('');
  if (memory.length === 0) {
    out.push('_None._');
  } else {
    out.push('update your memory with the following insights:');
    out.push('');
    for (const m of memory) {
      out.push(`- ${m.insight}`);
    }
  }
  out.push('');
  out.push('### One-off / discarded');
  out.push('');
  if (discarded.length === 0) {
    out.push('_None._');
  } else {
    for (const d of discarded) {
      out.push(
        `- \`${d.category}\` (${d.occurrences ?? 1} occurrence, source: ${d.source ?? 'consumer'})`,
      );
    }
  }
  return out;
}

/**
 * summary.js — plan-persist terminal summary (Epic #4474, PR3).
 *
 * Owns the single `plan-summary` structured comment the collapsed persist
 * surface upserts at terminal success, closing with the dry-run wave table.
 * This replaces two retired round-trips of the 12-phase pipeline:
 *
 *   - the Phase 9 plan-time `dispatch-manifest` comment, whose claimed
 *     consumer ("Wave Completeness Gate, /deliver Step 0.5") does not exist
 *     — the live manifest is written at deliver time by `wave-record-io.js`
 *     (#4474 design §3: DROP, keep the wave table as summary text only);
 *   - the Phase 12 notify round-trip ("informational — no webhook for
 *     planning").
 *
 * The wave table is computed from the validated ticket set's `depends_on`
 * slug edges via the same `computeStoryWaves` layering the deliver-time
 * dispatch pipeline uses, so the preview matches what `/deliver` will
 * actually fan out (barring later manual ticket edits).
 *
 * @module lib/orchestration/plan-persist/summary
 */

import { computeStoryWaves } from '../dependency-analyzer.js';

/**
 * Structured-comment type for the persist summary. Registered in
 * `ticketing/reads.js` `STRUCTURED_COMMENT_TYPES`; upsert-idempotent so a
 * `--force`/`--resume` re-persist replaces the prior summary in place.
 */
export const PLAN_SUMMARY_COMMENT_TYPE = 'plan-summary';

/**
 * Compute the dry-run wave assignment for a validated ticket set.
 *
 * Adapts the slug-keyed ticket shape onto `computeStoryWaves`' storyGroups
 * contract (slug → { storyId, tasks: [] }; explicit deps from `depends_on`).
 * Under the 2-tier hierarchy Stories carry no tasks, so all edges are
 * explicit.
 *
 * @param {Array<{ slug: string, title?: string, depends_on?: string[] }>} tickets
 * @returns {Array<{ wave: number, stories: Array<{ slug: string, title: string }> }>}
 *   Waves in execution order.
 */
export function buildWaveTable(tickets) {
  const list = Array.isArray(tickets) ? tickets : [];
  if (list.length === 0) return [];
  const storyGroups = new Map();
  const explicitDeps = new Map();
  for (const t of list) {
    storyGroups.set(t.slug, { storyId: t.slug, tasks: [] });
    explicitDeps.set(
      t.slug,
      (t.depends_on ?? []).filter((dep) => typeof dep === 'string'),
    );
  }
  const assignment = computeStoryWaves(storyGroups, explicitDeps);
  const byWave = new Map();
  for (const t of list) {
    const wave = assignment.get(t.slug) ?? 0;
    if (!byWave.has(wave)) byWave.set(wave, []);
    byWave.get(wave).push({ slug: t.slug, title: t.title ?? t.slug });
  }
  return [...byWave.keys()]
    .sort((a, b) => a - b)
    .map((wave) => ({ wave, stories: byWave.get(wave) }));
}

/**
 * Render the dry-run wave table as GitHub-flavoured markdown.
 *
 * @param {ReturnType<typeof buildWaveTable>} waveTable
 * @returns {string[]} markdown lines
 */
function renderWaveTableLines(waveTable) {
  if (!Array.isArray(waveTable) || waveTable.length === 0) {
    return ['_No stories to wave (empty plan)._'];
  }
  const rows = waveTable.map(
    ({ wave, stories }) =>
      `| ${wave + 1} | ${stories.map((s) => `\`${s.slug}\``).join(', ')} |`,
  );
  return ['| Wave | Stories |', '| --- | --- |', ...rows];
}

/**
 * Build the `plan-summary` structured-comment body: risk + routing +
 * freshness + healthcheck receipts, closing with the mode-specific tail —
 * the dry-run wave table for fan-out/amend, or the single-delivery routing
 * record `{ deliveryShape, sliceCount, routingReasons }` (Epic #4474 PR4)
 * for the spec-only mode.
 *
 * @param {{
 *   epicId: number,
 *   ticketCount: number,
 *   planningRisk: { overallLevel?: string, gateDecision?: string },
 *   reviewRouting: { decision?: string },
 *   freshness?: { stale?: number, ambiguous?: number },
 *   healthcheck?: { ok?: boolean, waived?: boolean, skipped?: boolean },
 *   waveTable: ReturnType<typeof buildWaveTable>,
 *   mode?: 'fan-out'|'single'|'amend',
 *   planMetricsLine?: string|null,
 *   single?: { deliveryShape: 'single', sliceCount: number|null, routingReasons: string[] }|null,
 *   amend?: {
 *     closed: Array<{ slug: string, issueNumber: number }>,
 *     recreated: Array<{ slug: string, oldIssueNumber: number, issueNumber: number }>,
 *     created: Array<{ slug: string, issueNumber: number }>,
 *     keptCount: number,
 *   }|null,
 * }} input
 * @returns {string}
 */
export function buildPlanSummaryCommentBody({
  epicId,
  ticketCount,
  planningRisk,
  reviewRouting,
  freshness,
  healthcheck,
  waveTable,
  mode = 'fan-out',
  planMetricsLine = null,
  single = null,
  amend = null,
}) {
  const freshnessLine =
    (freshness?.stale ?? 0) > 0 || (freshness?.ambiguous ?? 0) > 0
      ? `- ⚠️ Spec freshness: ${freshness.stale} stale / ${freshness.ambiguous} ambiguous reference(s) — see the spec-freshness comment.`
      : '- Spec freshness: clean.';
  const healthcheckLine = healthcheck?.skipped
    ? '- Healthcheck: skipped (test seam).'
    : healthcheck?.ok
      ? '- Healthcheck: passed.'
      : `- Healthcheck: failed, waived by operator label.`;

  const headLine =
    mode === 'single'
      ? `- Single-delivery plan (\`delivery::single\`): no Story tree — the Delivery Slicing table is the audit trail.`
      : `- ${ticketCount} Story ticket(s) persisted across ${waveTable.length} wave(s).`;

  const amendLines = amend
    ? [
        `- Amend delta: ${amend.created.length} added, ${amend.recreated.length} modified (closed + recreated), ${amend.closed.length} closed, ${amend.keptCount} kept untouched.`,
      ]
    : [];

  const tail =
    mode === 'single'
      ? [
          '#### Delivery routing record',
          '',
          '```json',
          JSON.stringify(
            {
              deliveryShape: 'single',
              sliceCount: single?.sliceCount ?? null,
              routingReasons: single?.routingReasons ?? [],
            },
            null,
            2,
          ),
          '```',
          '',
          '_Marker is inert until #4475 lands the deliver-side reader — `/deliver` still treats this Epic as fan-out until then._',
        ]
      : [
          '#### Dry-run wave table',
          '',
          ...renderWaveTableLines(waveTable),
          '',
          '_Preview only — the authoritative dispatch manifest is written at deliver time (`wave-record-io.js`)._',
        ];

  return [
    `### 📋 Plan Summary — Epic #${epicId} is \`agent::ready\``,
    '',
    headLine,
    ...amendLines,
    `- Risk: ${planningRisk?.overallLevel ?? 'unknown'} · ${planningRisk?.gateDecision ?? 'unknown'} (review routing: ${reviewRouting?.decision ?? 'unknown'}).`,
    freshnessLine,
    healthcheckLine,
    // G2 measurement receipt (Epic #4474 PR1/PR7): the plan-CLI invocation
    // ledger roll-up (turns-per-plan proxy, per-mode counts, critic skips)
    // rides the summary comment so the cohort reader never has to pull the
    // temp ledger off the runner's disk. Omitted when the ledger is empty.
    ...(typeof planMetricsLine === 'string' && planMetricsLine.length > 0
      ? [`- ${planMetricsLine}`]
      : []),
    '',
    ...tail,
  ].join('\n');
}

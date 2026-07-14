/**
 * summary.js — plan-persist terminal summary (v2 Stage 3).
 *
 * Upserts a single `plan-summary` structured comment on the primary Story
 * at terminal success. Carries risk / routing receipts and the dry-run
 * `depends_on` ordering table for the rare N>1 plan.
 *
 * @module lib/orchestration/plan-persist/summary
 */

import { computeStoryWaves } from '../dependency-analyzer.js';

/**
 * Structured-comment type for the persist summary.
 */
export const PLAN_SUMMARY_COMMENT_TYPE = 'plan-summary';

/**
 * Compute the dry-run wave assignment for a validated ticket set.
 *
 * @param {Array<{ slug: string, title?: string, depends_on?: string[] }>} tickets
 * @returns {Array<{ wave: number, stories: Array<{ slug: string, title: string }> }>}
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
 * @param {ReturnType<typeof buildWaveTable>} waveTable
 * @returns {string[]}
 */
function renderWaveTableLines(waveTable) {
  if (!Array.isArray(waveTable) || waveTable.length === 0) {
    return ['_No stories to sequence (empty plan)._'];
  }
  const rows = waveTable.map(
    ({ wave, stories }) =>
      `| ${wave + 1} | ${stories.map((s) => `\`${s.slug}\``).join(', ')} |`,
  );
  return ['| Order | Stories |', '| --- | --- |', ...rows];
}

/**
 * Build the `plan-summary` structured-comment body.
 *
 * @param {object} input
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
  mode = 'stories',
  planMetricsLine = null,
  stories = null,
  planRunLabel = null,
  // legacy unused knobs kept so older test call sites don't crash mid-migration
  single = null,
  amend = null,
}) {
  void mode;
  void single;
  void amend;

  const freshnessLine =
    (freshness?.stale ?? 0) > 0 || (freshness?.ambiguous ?? 0) > 0
      ? `- ⚠️ Spec freshness: ${freshness.stale} stale / ${freshness.ambiguous} ambiguous reference(s).`
      : '- Spec freshness: clean.';
  const healthcheckLine = healthcheck?.skipped
    ? '- Healthcheck: skipped (v2 flat Story persist — ticket validators are the gate).'
    : healthcheck?.ok
      ? '- Healthcheck: passed.'
      : `- Healthcheck: failed, waived by operator label.`;

  const storyList =
    Array.isArray(stories) && stories.length > 0
      ? stories.map((s) => `#${s.id} (\`${s.slug}\`)`).join(', ')
      : `${ticketCount} Story(ies)`;

  const waiverLines = planningRisk?.acceptanceWaivedReason
    ? [
        `- ⚠️ Acceptance disposition auto-waived to \`not-applicable\` — ${planningRisk.acceptanceWaivedReason}`,
      ]
    : [];

  const runLine = planRunLabel
    ? `- Plan-run label: \`${planRunLabel}\` (N>1 — deliver with \`/deliver --run\` once Stage 4 wires it).`
    : '- Plan-run: single Story (default).';

  return [
    `### 📋 Plan Summary — Story #${epicId} is \`agent::ready\``,
    '',
    `- ${ticketCount} Story ticket(s) persisted: ${storyList}.`,
    runLine,
    `- Risk: ${planningRisk?.overallLevel ?? 'unknown'} · ${planningRisk?.gateDecision ?? 'unknown'} (review routing: ${reviewRouting?.decision ?? 'unknown'}).`,
    ...waiverLines,
    freshnessLine,
    healthcheckLine,
    ...(typeof planMetricsLine === 'string' && planMetricsLine.length > 0
      ? [`- ${planMetricsLine}`]
      : []),
    '',
    '#### Delivery order (`depends_on`)',
    '',
    ...renderWaveTableLines(waveTable),
    '',
    '_Preview only — Stage 4 sequences multi-Story runs; N=1 delivers via `/deliver <storyId>`._',
  ].join('\n');
}

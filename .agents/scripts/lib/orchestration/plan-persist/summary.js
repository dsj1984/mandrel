/**
 * summary.js — plan-persist terminal summary (v2 Stage 3).
 *
 * Upserts a single `plan-summary` structured comment on the primary Story
 * at terminal success. Carries the persist receipts — including whether the
 * operator forced a review stop — and the dry-run `depends_on` ordering table
 * for the rare N>1 plan.
 *
 * Story #4542 removed the risk / review-routing line: no risk level, gate
 * decision, or acceptance disposition is computed at plan time any more, so
 * reporting one here would document a mechanism that does not run.
 *
 * @module lib/orchestration/plan-persist/summary
 */

import { computeStoryWaves } from '../dependency-analyzer.js';
import { renderPredictedSerialisationLines } from './wave-serialisation.js';

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
 * Render the shared-editor collisions beside the wave table (Story #5045).
 *
 * The wave table is a promise about parallelism — "these Stories can run
 * together". `computeSharedEditorFindings` knows exactly where that promise
 * breaks down: a path two same-wave Stories both write will conflict on every
 * merge after the first. Until now those findings degraded to a `Logger.warn`
 * on stderr and were discarded, so the comment carried the optimistic half of
 * the analysis and none of the caveat. Rendering them here puts the promise
 * and its known exceptions on one durable surface.
 *
 * Advisory by default and labelled as such — `planning.failOnSharedEditors`
 * is the knob that makes a collision refuse the plan, and it stays off.
 *
 * @param {object[]|null} conflictFindings
 * @returns {string[]} Lines to splice after the wave table, or `[]`.
 */
function renderSharedEditorLines(conflictFindings) {
  const shared = (
    Array.isArray(conflictFindings) ? conflictFindings : []
  ).filter((finding) => finding?.kind === 'shared-editor');
  if (shared.length === 0) return [];
  const rows = shared
    .slice()
    .sort((a, b) => String(a.path).localeCompare(String(b.path)))
    .map(
      (finding) =>
        `| \`${finding.path}\` | ${(finding.storySlugs ?? [])
          .map((slug) => `\`${slug}\``)
          .join(', ')} |`,
    );
  return [
    '',
    `#### ⚠️ Known collisions (${shared.length} shared file(s))`,
    '',
    '| Path | Stories in the same order |',
    '| --- | --- |',
    ...rows,
    '',
    '_These Stories are scheduled to run together **and** write the same ' +
      'file — expect a merge conflict on every landing after the first. Add a ' +
      '`depends_on` edge to serialize them, or move the shared edit into one ' +
      'Story. Advisory: `planning.failOnSharedEditors` turns this into a ' +
      'refusal and is off by default._',
  ];
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
  forceReview = false,
  freshness,
  healthcheck,
  waveTable,
  mode = 'stories',
  planMetricsLine = null,
  stories = null,
  conflictFindings = null,
  waveCollisions = null,
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

  // The only planning-time review gate left (Story #4542): an explicit
  // operator flag, never a value derived from a self-authored risk verdict.
  const reviewLines = forceReview
    ? ['- ⚠️ Review: operator-forced via `--force-review`.']
    : [];

  // The exact command to run — Story #4540. This comment is posted to
  // GitHub on every plan, so it is the operator's primary instruction: it
  // must name real ids, not a batch token that no longer exists.
  const deliverCommand =
    Array.isArray(stories) && stories.length > 0
      ? `/mandrel-deliver ${stories.map((s) => s.id).join(' ')}`
      : '/mandrel-deliver <storyId> [<storyId> ...]';

  return [
    `### 📋 Plan Summary — Story #${epicId} is \`agent::ready\``,
    '',
    `- ${ticketCount} Story ticket(s) persisted: ${storyList}.`,
    ...reviewLines,
    freshnessLine,
    healthcheckLine,
    ...(typeof planMetricsLine === 'string' && planMetricsLine.length > 0
      ? [`- ${planMetricsLine}`]
      : []),
    '',
    '#### Delivery order (`depends_on`)',
    '',
    ...renderWaveTableLines(waveTable),
    ...renderPredictedSerialisationLines(waveCollisions),
    ...renderSharedEditorLines(conflictFindings),
    '',
    `_Deliver with \`${deliverCommand}\` — \`/mandrel-deliver\` resolves the dependency graph from live state, so edges may point at Stories from earlier plan runs._`,
  ].join('\n');
}

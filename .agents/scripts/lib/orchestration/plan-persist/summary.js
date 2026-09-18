/**
 * The plan summary — the whole body of each Story's `story-plan-state`
 * comment: created Stories, delivery order, and the deliver command.
 *
 * @module lib/orchestration/plan-persist/summary
 */

import { computeStoryWaves } from '../dependency-analyzer.js';
import { renderPredictedSerialisationLines } from './wave-serialisation.js';

/**
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
 * Same-wave Stories writing one path — the caveat to the wave table's
 * parallelism promise, kept on the same durable surface. Advisory.
 *
 * @param {object[]|null} conflictFindings
 * @returns {string[]}
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
  // Unused; accepted so older call sites don't crash.
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

  // An explicit operator flag, never derived from a risk verdict.
  const reviewLines = forceReview
    ? ['- ⚠️ Review: operator-forced via `--force-review`.']
    : [];

  // The operator's primary instruction: must name real ids.
  const deliverCommand =
    Array.isArray(stories) && stories.length > 0
      ? `/mandrel-deliver ${stories.map((s) => s.id).join(' ')}`
      : '/mandrel-deliver <storyId> [<storyId> ...]';

  return [
    `#### 📋 Plan Summary — Story #${epicId} is \`agent::ready\``,
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

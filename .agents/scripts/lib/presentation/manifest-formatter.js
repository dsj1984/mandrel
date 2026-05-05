/**
 * manifest-formatter.js
 *
 * Pure Markdown / console rendering for dispatch and story manifests. No fs
 * access, no provider calls, no config I/O. Callers that need injected values
 * (e.g. `renderStoryManifestMarkdown`'s script-path hints) pass them via `opts`.
 *
 * The facade `manifest-renderer.js` re-exports from this module and owns the
 * one impure helper that reads config to build the options bag.
 */

import { createHash } from 'node:crypto';
import { AGENT_LABELS } from '../label-constants.js';

// ---------------------------------------------------------------------------
// Pure render helpers (Story #484 — exported for direct fixture testing)
// ---------------------------------------------------------------------------

/**
 * Compute aggregate progress numbers for a dispatch manifest. Pure — derives
 * everything from the manifest fields it is given.
 *
 * @param {object} manifest
 * @returns {{
 *   taskPct: number,
 *   doneTasks: number,
 *   totalTasks: number,
 *   doneStories: number,
 *   totalStories: number,
 *   storyWaveCount: number,
 * }}
 */
export function computeProgress(manifest) {
  const summary = manifest?.summary ?? {};
  const storyManifest = manifest?.storyManifest ?? [];

  const allStoryItems = storyManifest.filter(
    (s) => s.type === 'story' && s.storyId !== '__ungrouped__',
  );
  const doneStories = allStoryItems.filter(
    (s) =>
      s.tasks.length > 0 &&
      s.tasks.every((t) => t.status === AGENT_LABELS.DONE),
  ).length;

  const storyWaveSet = new Set(
    storyManifest.map((s) => s.earliestWave).filter((w) => w !== -1),
  );

  return {
    taskPct: summary.progressPercent ?? 0,
    doneTasks: summary.doneTasks ?? 0,
    totalTasks: summary.totalTasks ?? 0,
    doneStories,
    totalStories: allStoryItems.length,
    storyWaveCount: storyWaveSet.size || 1,
  };
}

/**
 * Render a fixed-width unicode progress bar, e.g. `█████░░░░░░░░░░░░░░░`.
 *
 * @param {number} percent  0..100
 * @param {object} [opts]
 * @param {number} [opts.width=20]  Total cells in the bar.
 * @returns {string}
 */
export function renderProgressBar(percent, opts = {}) {
  const width = opts.width ?? 20;
  const pct = Math.max(0, Math.min(100, Number(percent) || 0));
  const filled = Math.round((pct / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

/**
 * Render the "## Wave Summary" section for a manifest's wave-eligible items
 * (Stories only — Features are containers and excluded by the caller).
 *
 * @param {object[]} waveEligible
 * @returns {string} Markdown block, or empty string when nothing to render.
 */
export function renderWaveSections(waveEligible) {
  if (!waveEligible || waveEligible.length === 0) return '';

  const waveStats = new Map();
  for (const s of waveEligible) {
    const w = s.earliestWave ?? -1;
    if (!waveStats.has(w)) {
      waveStats.set(w, { stories: 0, tasks: 0, done: 0 });
    }
    const stat = waveStats.get(w);
    stat.stories++;
    stat.tasks += s.tasks.length;
    stat.done += s.tasks.filter((t) => t.status === AGENT_LABELS.DONE).length;
  }

  const sortedWaves = [...waveStats.keys()].sort((a, b) => a - b);
  const lines = [
    '## Wave Summary',
    '',
    '| Wave | Stories | Progress | Tasks | Status |',
    '| :--- | :--- | :--- | :--- | :--- |',
  ];

  for (const w of sortedWaves) {
    const stat = waveStats.get(w);
    const isDone = stat.tasks > 0 && stat.done === stat.tasks;
    const waveLabel = w === -1 ? 'Ungrouped' : `Wave ${w}`;
    const isReady =
      w === 0 ||
      sortedWaves
        .filter((sw) => sw < w)
        .every((sw) => {
          const swStat = waveStats.get(sw);
          return swStat.done === swStat.tasks;
        });

    const statusLabel = isDone
      ? '✅ Done'
      : isReady
        ? '🚀 Ready'
        : '⏳ Blocked';
    const wavePct =
      stat.tasks > 0 ? Math.round((stat.done / stat.tasks) * 100) : 0;
    const waveBar = renderProgressBar(wavePct, { width: 10 });
    lines.push(
      `| ${waveLabel} | ${stat.stories} | ${waveBar} ${wavePct}% | ${stat.done}/${stat.tasks} | ${statusLabel} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Render the "## Execution Plan" wave-grouped Story table plus the
 * "## Feature Containers" informational table.
 *
 * @param {object[]} storyManifest
 * @returns {string} Markdown block, or empty string when nothing to render.
 */
export function renderStoryTable(storyManifest) {
  if (!storyManifest || storyManifest.length === 0) return '';

  const waveStories = storyManifest.filter((s) => s.type !== 'feature');
  const featureItems = storyManifest.filter((s) => s.type === 'feature');

  const waveGroups = new Map();
  for (const story of waveStories) {
    const w = story.earliestWave ?? -1;
    if (!waveGroups.has(w)) waveGroups.set(w, []);
    waveGroups.get(w).push(story);
  }

  const sortedWaves = [...waveGroups.keys()].sort((a, b) => a - b);
  const lines = ['## Execution Plan', ''];

  for (const waveIdx of sortedWaves) {
    const stories = waveGroups.get(waveIdx);
    const waveLabel = waveIdx === -1 ? 'Ungrouped' : `Wave ${waveIdx}`;
    const parallelHint =
      stories.length > 1
        ? ` — ✅ ${stories.length} stories can run in parallel`
        : '';

    lines.push(`### ${waveLabel}${parallelHint}`);
    lines.push('');
    lines.push('| | Story | Title | Tasks |');
    lines.push('| :--- | :--- | :--- | :--- |');

    for (const s of stories) {
      const allDone =
        s.tasks.length > 0 &&
        s.tasks.every((t) => t.status === AGENT_LABELS.DONE);
      const storyCheckbox = allDone ? '✅' : '⬜';
      lines.push(
        `| ${storyCheckbox} | #${s.storyId} | ${s.storySlug} | ${s.tasks.length} |`,
      );
    }
    lines.push('');
  }

  if (featureItems.length > 0) {
    lines.push('## Feature Containers');
    lines.push('');
    lines.push(
      '> Features are organizational groupings and are **not directly executable**.',
    );
    lines.push('> Execute the Stories within each Feature instead.');
    lines.push('');
    lines.push('| Feature | Title | Child Tasks |');
    lines.push('| :--- | :--- | :--- |');
    for (const f of featureItems) {
      lines.push(`| #${f.storyId} | ${f.storySlug} | ${f.tasks.length} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Dispatch manifest (Epic-level) Markdown
// ---------------------------------------------------------------------------

function renderStoryDetailsSection(storyManifest) {
  const lines = ['## Story Details', ''];
  for (const story of storyManifest) {
    const typeLabel =
      (story.type || 'story').charAt(0).toUpperCase() +
      (story.type || 'story').slice(1);
    const storyLabel =
      story.storyId === '__ungrouped__'
        ? 'Ungrouped Tasks'
        : `${typeLabel} #${story.storyId}: ${story.storySlug}`;
    const isFeature = story.type === 'feature';

    lines.push(`### ${storyLabel}`);
    lines.push('');
    lines.push(`- **Branch:** \`${story.branchName}\``);
    if (isFeature) {
      lines.push('- **Type:** Feature (container — not directly executable)');
    } else {
      lines.push(
        `- **Wave:** ${story.earliestWave === -1 ? 'N/A' : story.earliestWave}`,
      );
    }
    lines.push('');
    lines.push('**Tasks (execution order):**');
    lines.push('');

    for (const task of story.tasks) {
      const isDone = task.status === AGENT_LABELS.DONE;
      const checkbox = isDone ? '[x]' : '[ ]';
      const deps =
        task.dependencies && task.dependencies.length > 0
          ? ` _(blocked by: ${task.dependencies.map((d) => `#${d}`).join(', ')})_`
          : '';
      lines.push(`- ${checkbox} **#${task.taskId}** — ${task.taskSlug}${deps}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

let _lastManifestRef = null;
let _lastManifestHash = null;
let _lastManifestOutput = null;

function hashManifest(manifest) {
  return createHash('sha1')
    .update(JSON.stringify(manifest ?? null))
    .digest('hex');
}

/**
 * Clear the content-hash cache for `formatManifestMarkdown`. Intended for tests
 * and for callers that mutate manifest objects in place between renders.
 */
export function __resetManifestFormatterCache() {
  _lastManifestRef = null;
  _lastManifestHash = null;
  _lastManifestOutput = null;
}

export function formatManifestMarkdown(manifest) {
  // Fast path: same manifest instance as last call (progress-reporter reuses
  // the same object across ticks when nothing has changed).
  if (manifest === _lastManifestRef && _lastManifestOutput !== null) {
    return _lastManifestOutput;
  }
  // Slow path: content-hash comparison for cases where the caller built a
  // fresh manifest object with identical content.
  const hash = hashManifest(manifest);
  if (hash === _lastManifestHash && _lastManifestOutput !== null) {
    _lastManifestRef = manifest;
    return _lastManifestOutput;
  }
  const output = _formatManifestMarkdownUncached(manifest);
  _lastManifestRef = manifest;
  _lastManifestHash = hash;
  _lastManifestOutput = output;
  return output;
}

function _formatManifestMarkdownUncached(manifest) {
  const { epicId, epicTitle, summary, storyManifest, dryRun, generatedAt } =
    manifest;
  const progress = computeProgress(manifest);
  const lines = [];

  // --- Header ---
  lines.push(`# 📋 Dispatch Manifest — Epic #${epicId}`);
  lines.push('');
  lines.push(`> **${epicTitle}**`);
  lines.push('');

  lines.push('## 🤖 Agent Operating Procedures');
  lines.push('');
  lines.push(
    '> 1. **Identify**: Start with the lowest available wave where `Status` is `🚀 Ready`.',
  );
  lines.push(
    '> 2. **Select**: Pick a Story from the **Execution Plan** that is not yet `✅`.',
  );
  lines.push('> 3. **Execute**: Run `/epic-execute [STORY_ID]`.');
  lines.push(
    '> 4. **Repeat**: Continue iterating on execution until all stories and waves are complete',
  );
  lines.push('> 5. **Close**: Run `/epic-close`');
  lines.push('');

  lines.push('| Field | Value |');
  lines.push('| :--- | :--- |');
  lines.push(`| Generated | ${generatedAt} |`);
  lines.push(`| Mode | ${dryRun ? '🔍 Dry Run' : '🚀 Live Dispatch'} |`);
  lines.push(
    `| Progress | **${summary.doneTasks}/${summary.totalTasks}** tasks (${summary.progressPercent}%) |`,
  );
  const storyCount = (storyManifest ?? []).filter(
    (s) => s.storyId !== '__ungrouped__' && s.type === 'story',
  ).length;
  const featureCount = (storyManifest ?? []).filter(
    (s) => s.type === 'feature',
  ).length;
  lines.push(`| Stories | ${storyCount} |`);
  if (featureCount > 0)
    lines.push(`| Features (containers) | ${featureCount} |`);
  lines.push(
    `| Execution Waves | ${progress.storyWaveCount} _(${summary.totalWaves} task-level waves)_ |`,
  );
  lines.push(`| Dispatched | ${summary.dispatched} |`);
  lines.push('');

  // --- Hero Progress Bar ---
  const pct = progress.taskPct;
  const bar = renderProgressBar(pct);
  const statusEmoji = pct === 100 ? '🎉' : pct >= 50 ? '🔥' : '🏗️';
  lines.push(`## ${statusEmoji} Sprint Progress`);
  lines.push('');
  lines.push('```');
  lines.push(
    `  ${bar}  ${pct}%  (${summary.doneTasks}/${summary.totalTasks} tasks)`,
  );
  lines.push('```');
  lines.push('');
  lines.push(
    `> **Stories:** ${progress.doneStories}/${progress.totalStories} complete · **Tasks:** ${summary.doneTasks}/${summary.totalTasks} complete`,
  );
  lines.push('');

  // --- Wave Summary Table (Stories only — Features are containers) ---
  const allItems =
    manifest.storyManifest ||
    manifest.stories ||
    manifest.summary?.stories ||
    [];
  const waveEligible = allItems.filter((s) => s.type !== 'feature');
  const waveBlock = renderWaveSections(waveEligible);
  if (waveBlock) lines.push(waveBlock);

  lines.push('---');
  lines.push('');

  // --- Story Dispatch Table grouped by wave + Feature Containers + Details ---
  if (storyManifest && storyManifest.length > 0) {
    const tableBlock = renderStoryTable(storyManifest);
    if (tableBlock) lines.push(tableBlock);

    lines.push('---');
    lines.push('');

    lines.push(renderStoryDetailsSection(storyManifest));
  }

  // --- Agent Telemetry ---
  /* node:coverage ignore next */
  if (manifest.agentTelemetry) {
    lines.push('## 📈 Agent Telemetry & Diagnostics');
    lines.push('');
    lines.push(
      `- **Total Friction Events:** ${manifest.agentTelemetry.totalFriction}`,
    );
    if (manifest.agentTelemetry.recentFriction.length > 0) {
      lines.push('- **Active Issues & Friction:**');
      for (const item of manifest.agentTelemetry.recentFriction) {
        const safeMessage = item.message
          .replace(/\s+/g, ' ')
          .replace(/\n/g, ' ')
          .trim();
        lines.push(`  - Task **#${item.taskId}**: ${safeMessage}`);
      }
    } else {
      lines.push('- **Active Issues:** None recorded.');
    }
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  // --- Execution instructions ---
  lines.push('## How to Execute');
  lines.push('');
  lines.push('1. Pick a Story from the next ready wave (🚀 status above).');
  lines.push('2. Run: `/epic-execute #[Story ID]`');
  lines.push('');
  lines.push(
    '> **Tip:** Story closure and dashboard refresh are handled automatically by `story-close.js`. ' +
      'Check the updated `temp/` manifest files after closing a story.',
  );
  lines.push('');

  return lines.join('\n');
}

// Backward-compat alias (existing callers and tests import this name).
export const renderManifestMarkdown = formatManifestMarkdown;

// ---------------------------------------------------------------------------
// Story-execution manifest Markdown
// ---------------------------------------------------------------------------

/**
 * Format the per-story execution manifest. Pure: caller must supply
 * `opts.settings` (typically the resolved agentSettings bag) so we can cite
 * the canonical `story-init.js` / `story-close.js` paths without
 * touching `resolveConfig` (fs).
 *
 * `scriptsRoot` lives under `settings.paths.*` post-Epic #773 Story 9 (it
 * was a flat agentSettings key prior). The fallback string keeps the
 * formatter usable in tiny test fixtures that omit the paths block.
 *
 * @param {object} manifest
 * @param {{ settings: { paths?: { scriptsRoot?: string }, commands?: { validate?: string, test?: string } } }} opts
 * @returns {string}
 */
export function formatStoryManifestMarkdown(manifest, opts = {}) {
  const settings = opts.settings ?? {};
  const scriptsRoot = settings.paths?.scriptsRoot ?? '.agents/scripts';
  const commands = settings.commands ?? {};
  const validateCmd = commands.validate ?? 'npm run lint';
  const testCmd = commands.test ?? 'npm test';

  const lines = [];
  lines.push(`# 📚 Story Execution Manifest`);
  lines.push('');
  lines.push(`> **Generated:** ${manifest.generatedAt}`);
  lines.push('');

  for (const story of manifest.stories) {
    lines.push(`## Story #${story.storyId}: ${story.storyTitle}`);
    lines.push(`- **Epic Branch:** \`${story.epicBranch}\``);
    lines.push(`- **Story Branch:** \`${story.branchName}\``);
    lines.push('');
    lines.push('**Tasks (execution order):**');
    for (const task of story.tasks) {
      const isDone = task.status === AGENT_LABELS.DONE;
      const checkbox = isDone ? '[x]' : '[ ]';
      const deps =
        task.dependencies && task.dependencies.length > 0
          ? ` _(blocked by: ${task.dependencies.map((d) => `#${d}`).join(', ')})_`
          : '';
      lines.push(`- ${checkbox} **#${task.taskId}** — ${task.title}${deps}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('## Execution Steps');
  lines.push('');

  const initPath = `${scriptsRoot}/story-init.js`;
  const closePath = `${scriptsRoot}/story-close.js`;

  lines.push(
    `1. \`node ${initPath} --story <storyId>\` (bootstraps branch, transitions tasks)`,
  );
  lines.push('2. Implement each Task sequentially and commit after each one.');
  lines.push(`3. Run \`${validateCmd}\` and \`${testCmd}\` to validate.`);
  lines.push(
    `4. \`node <main-repo>/${closePath} --story <storyId> --cwd <main-repo>\` (merges, cleans up, closes tickets)`,
  );
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Story dispatch table (CLI output)
// ---------------------------------------------------------------------------

/**
 * Print the CLI Story Dispatch Table. Writes to the supplied `logger.log`
 * channel (defaults to `console.log`). Keeping the sink injectable makes the
 * function testable without capturing stdout.
 *
 * @param {object[]} storyManifest
 * @param {{ logger?: { log: (line: string) => void } }} [opts]
 */
/* node:coverage ignore next */
export function printStoryDispatchTable(storyManifest, opts = {}) {
  const log = opts.logger?.log ?? ((line) => console.log(line));
  if (!storyManifest || storyManifest.length === 0) return;

  // Split into wave-eligible Stories and Feature containers
  const stories = storyManifest.filter((s) => s.type !== 'feature');
  const features = storyManifest.filter((s) => s.type === 'feature');

  log(
    '\n┌─────────┬──────────────────────────────────────┬──────┬────────────┬──────────────┐',
  );
  log(
    '│                           📋 STORY DISPATCH TABLE                            │',
  );
  log(
    '├─────────┼──────────────────────────────────────┼──────┼──────────────┤',
  );
  log(
    '│ Story   │ Title                                │ Wave │ Tasks        │',
  );
  log(
    '├─────────┼──────────────────────────────────────┼──────┼──────────────┤',
  );

  for (const story of stories) {
    const id =
      story.storyId === '__ungrouped__' ? '(none)' : `#${story.storyId}`;
    const title = (story.storySlug ?? '').substring(0, 36).padEnd(36);
    const wave = (
      story.earliestWave === -1 ? '-' : String(story.earliestWave)
    ).padEnd(4);
    const taskCount = `${story.tasks.length} task(s)`.padEnd(12);
    log(`│ ${id.padEnd(7)} │ ${title} │ ${wave} │ ${taskCount} │`);
  }

  log(
    '└─────────┴──────────────────────────────────────┴──────┴──────────────┘',
  );
  log('');
  log('  💡 Stories in the same [Wave] can be executed in parallel.');
  log('  💡 Use /epic-execute #[Story ID] to execute a Story.');

  if (features.length > 0) {
    log('');
    log('  📦 Feature Containers (not directly executable):');
    for (const f of features) {
      log(
        `     #${f.storyId} — ${f.storySlug} (${f.tasks.length} orphaned tasks)`,
      );
    }
  }
  log('');
}

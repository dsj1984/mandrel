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
import { Logger } from '../Logger.js';
import { AGENT_LABELS } from '../label-constants.js';
// ---------------------------------------------------------------------------
// Pure render helpers (Story #484 — exported for direct fixture testing)
// ---------------------------------------------------------------------------

/**
 * Pick the per-Story symbol for the wave-grouped Story table:
 *   🚧 — at least one task is `agent::blocked`
 *   ✅ — every task is `agent::done`
 *   🔄 — some task is `agent::done` or `agent::executing` (not all done)
 *   ⬜ — nothing started yet (planning-time default)
 *
 * Pure: derives state from `s.tasks[].status` only. The runtime fills those
 * statuses from current GitHub labels via `resolveAndDispatch` so the symbol
 * advances as `dashboardRefreshPhase` re-renders after each Story merge.
 *
 * @param {{ tasks: Array<{ status?: string }> }} story
 * @returns {string}
 */
export function deriveStorySymbol(story) {
  const tasks = story?.tasks ?? [];
  if (tasks.length === 0) return '⬜';
  const blocked = tasks.some((t) => t.status === AGENT_LABELS.BLOCKED);
  if (blocked) return '🚧';
  const done = tasks.filter((t) => t.status === AGENT_LABELS.DONE).length;
  if (done === tasks.length) return '✅';
  if (done > 0 || tasks.some((t) => t.status === AGENT_LABELS.EXECUTING)) {
    return '🔄';
  }
  return '⬜';
}

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
 * Derive a GitHub-flavoured Markdown anchor slug from a heading's visible text.
 *
 * GitHub's slug algorithm (per `jch/html-pipeline`'s TocFilter) is:
 *   1. Lowercase the text.
 *   2. Strip emojis and other non-letter/digit/space/hyphen Unicode.
 *   3. Replace runs of whitespace with a single hyphen.
 *   4. Trim leading/trailing hyphens.
 *
 * Used by both the Wave Summary TOC and the per-wave H2 emission so the
 * link `href` and the anchor stay in lock-step. Exporting this from the
 * formatter (rather than a utility module) keeps the TOC ↔ H2 contract
 * inside one file — drift here would manifest as broken jump-links in the
 * rendered manifest.
 *
 * @param {string} text
 * @returns {string}
 */
export function slugifyHeading(text) {
  const raw = String(text ?? '');
  // Lowercase, then drop anything that isn't a letter, digit, space, or hyphen.
  // The Unicode property escapes match the GitHub behaviour for accented chars
  // (kept) and emoji / punctuation (dropped).
  const stripped = raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]+/gu, '')
    .trim();
  // Collapse any run of whitespace (or pre-existing hyphens) into a single
  // hyphen and strip the boundaries.
  return stripped.replace(/[\s-]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Build the visible H2 text for a wave row, e.g. `🚀 Wave 0`. The status
 * word lives only in the Wave Summary TOC; the H2 carries the emoji as a
 * visual anchor and nothing else, so the per-wave section reads cleanly
 * top-to-bottom without echoing the table.
 *
 * @param {string} waveLabel e.g. `Wave 0` or `Ungrouped`
 * @param {string} emoji     e.g. `🚀`, `⏳`, `✅`
 * @returns {string}
 */
export function waveHeadingText(waveLabel, emoji) {
  return `${emoji} ${waveLabel}`;
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
 * Derive the per-wave status label and emoji used by both the TOC table and
 * the per-wave H2 heading. Single source of truth so the TOC link slug and
 * the H2 anchor stay in lock-step.
 *
 * @param {number} waveIdx                — current wave index (or -1)
 * @param {Map<number, { tasks: number, done: number }>} waveStats
 * @param {number[]} sortedWaves          — every wave index in ascending order
 * @returns {{ emoji: string, word: string, label: string }}
 */
export function deriveWaveStatus(waveIdx, waveStats, sortedWaves) {
  const stat = waveStats.get(waveIdx);
  const isDone = stat && stat.tasks > 0 && stat.done === stat.tasks;
  if (isDone) return { emoji: '✅', word: 'Done', label: '✅ Done' };
  const isReady =
    waveIdx === 0 ||
    sortedWaves
      .filter((sw) => sw < waveIdx)
      .every((sw) => {
        const swStat = waveStats.get(sw);
        return swStat.done === swStat.tasks;
      });
  return isReady
    ? { emoji: '🚀', word: 'Ready', label: '🚀 Ready' }
    : { emoji: '⏳', word: 'Blocked', label: '⏳ Blocked' };
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
    '| Wave | Status | Stories | Tasks |',
    '| :--- | :--- | :--- | :--- |',
  ];

  for (const w of sortedWaves) {
    const stat = waveStats.get(w);
    const waveLabel = w === -1 ? 'Ungrouped' : `Wave ${w}`;
    const status = deriveWaveStatus(w, waveStats, sortedWaves);
    // The TOC cell links into the matching per-wave H2 section. Both sides
    // call `waveHeadingText` + `slugifyHeading` so the anchor stays correct.
    const headingText = waveHeadingText(waveLabel, status.emoji);
    const anchor = slugifyHeading(headingText);
    const waveCell = `[${waveLabel}](#${anchor})`;
    lines.push(
      `| ${waveCell} | ${status.label} | ${stat.stories} | ${stat.done}/${stat.tasks} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Render the bottom collapsed `<details>` block carrying the operating
 * procedures and the full symbol legend (Story #1194 Task #1214). This is
 * the only HTML the manifest emits by AC — every other section is plain
 * Markdown.
 *
 * @param {number|string} epicId  the Epic id used to substitute `/epic-deliver` examples.
 * @returns {string}
 */
export function renderProceduresAndLegendDetails(epicId) {
  const lines = [];
  lines.push(
    '<details><summary>🤖 Agent Operating Procedures &amp; symbol reference</summary>',
  );
  lines.push('');
  lines.push('### Operating Procedures');
  lines.push('');
  lines.push(
    `1. **Deliver**: Run \`/epic-deliver ${epicId}\`. The runner iterates waves in order, fans Stories out in parallel via \`/story-execute\`, and only pauses when the Epic flips to \`agent::blocked\`.`,
  );
  lines.push(
    '2. **Resume (granular, optional)**: Re-running `/epic-deliver` resumes from the checkpointed wave. To re-drive a single Story, run `/story-execute <storyId>`. Re-runs are checkpoint-idempotent.',
  );
  lines.push(
    `3. **Close**: \`/epic-deliver ${epicId}\` runs close-validation, code-review, retro, and PR-create in its tail. Operators merge the PR via the GitHub UI.`,
  );
  lines.push('');
  lines.push('### Symbol legend');
  lines.push('');
  lines.push('| Symbol | Meaning |');
  lines.push('| :--- | :--- |');
  lines.push('| ⬜ | Pending — no Tasks started |');
  lines.push('| 🔄 | In-flight — at least one Task done or executing |');
  lines.push('| ✅ | Done — every Task complete |');
  lines.push('| 🚧 | Blocked — at least one Task is `agent::blocked` |');
  lines.push('| 🚀 Ready | Wave is unblocked and ready to dispatch |');
  lines.push('| ⏳ Blocked | Wave is gated on a prior wave still completing |');
  lines.push('| `█` / `░` | Progress bar: filled / remaining cells |');
  lines.push('| `*(after #N)*` | Task callout: depends on in-Story Task #N |');
  lines.push('');
  lines.push('</details>');
  return lines.join('\n');
}

/**
 * Topologically sort a Story's Tasks by their `dependencies` (in-Story
 * `depends_on` ids). Stable: ties resolve in the original declaration order
 * so a Story with no edges renders Tasks exactly as authored. Cross-Story
 * dependencies (ids that aren't in the same `tasks[]`) are ignored — the
 * runtime resolves those at the wave-ordering layer.
 *
 * Pure / O(n + e) — Kahn's algorithm with a deterministic tie-breaker.
 *
 * @param {Array<{ taskId: number|string, dependencies?: Array<number|string> }>} tasks
 * @returns {Array} same task objects, sorted root → blocked-last.
 */
export function topoSortTasks(tasks) {
  if (!tasks || tasks.length === 0) return [];
  // Build the in-Story id set first so we can ignore cross-Story deps.
  const idSet = new Set(tasks.map((t) => String(t.taskId)));
  const order = new Map();
  tasks.forEach((t, idx) => {
    order.set(String(t.taskId), idx);
  });

  const inDegree = new Map();
  const adj = new Map();
  for (const t of tasks) {
    const tid = String(t.taskId);
    if (!inDegree.has(tid)) inDegree.set(tid, 0);
    if (!adj.has(tid)) adj.set(tid, []);
    for (const dep of t.dependencies ?? []) {
      const did = String(dep);
      if (!idSet.has(did)) continue; // cross-Story edge: skip
      inDegree.set(tid, (inDegree.get(tid) ?? 0) + 1);
      if (!adj.has(did)) adj.set(did, []);
      adj.get(did).push(tid);
    }
  }

  // Ready queue ordered by original declaration index for determinism.
  const ready = tasks
    .map((t) => String(t.taskId))
    .filter((tid) => (inDegree.get(tid) ?? 0) === 0)
    .sort((a, b) => order.get(a) - order.get(b));

  const out = [];
  const byId = new Map(tasks.map((t) => [String(t.taskId), t]));
  while (ready.length > 0) {
    const tid = ready.shift();
    out.push(byId.get(tid));
    for (const next of adj.get(tid) ?? []) {
      inDegree.set(next, inDegree.get(next) - 1);
      if (inDegree.get(next) === 0) {
        // Insert by original declaration order to preserve stability.
        let i = 0;
        while (i < ready.length && order.get(ready[i]) < order.get(next)) i++;
        ready.splice(i, 0, next);
      }
    }
  }

  // Cycle fallback: append any leftover tasks in original order so we never
  // silently drop work. The Tech Spec forbids cycles within a Story, but
  // this keeps the renderer robust if upstream validation drifts.
  if (out.length < tasks.length) {
    for (const t of tasks) {
      if (!out.includes(t)) out.push(t);
    }
  }
  return out;
}

/**
 * Compute per-Story aggregates for the nested wave layout: a 0..100 progress
 * percent and the done/total task counts. Pure — derived from `story.tasks[]`.
 *
 * @param {{ tasks?: Array<{ status?: string }> }} story
 * @returns {{ pct: number, done: number, total: number }}
 */
export function computeStoryProgress(story) {
  const tasks = story?.tasks ?? [];
  const total = tasks.length;
  const done = tasks.filter((t) => t.status === AGENT_LABELS.DONE).length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return { pct, done, total };
}

/**
 * Render one `## <emoji> Wave N` section per wave with nested per-Story H3
 * headings and inline checkbox Task lists. The TOC links from
 * `renderWaveSections` jump straight into these H2 anchors.
 *
 * @param {object[]} storyManifest
 * @returns {string} Markdown block, or empty string when nothing to render.
 */
export function renderNestedWaveSections(storyManifest) {
  if (!storyManifest || storyManifest.length === 0) return '';

  const waveStories = storyManifest.filter((s) => s.type !== 'feature');
  const featureItems = storyManifest.filter((s) => s.type === 'feature');

  const waveGroups = new Map();
  const waveStats = new Map();
  for (const story of waveStories) {
    const w = story.earliestWave ?? -1;
    if (!waveGroups.has(w)) {
      waveGroups.set(w, []);
      waveStats.set(w, { stories: 0, tasks: 0, done: 0 });
    }
    waveGroups.get(w).push(story);
    const stat = waveStats.get(w);
    stat.stories++;
    stat.tasks += story.tasks.length;
    stat.done += story.tasks.filter(
      (t) => t.status === AGENT_LABELS.DONE,
    ).length;
  }

  const sortedWaves = [...waveGroups.keys()].sort((a, b) => a - b);
  const lines = [];

  for (const waveIdx of sortedWaves) {
    const stories = waveGroups.get(waveIdx);
    const stat = waveStats.get(waveIdx);
    const waveLabel = waveIdx === -1 ? 'Ungrouped' : `Wave ${waveIdx}`;
    const status = deriveWaveStatus(waveIdx, waveStats, sortedWaves);

    // The H2 text and slug must match `renderWaveSections` exactly so the
    // TOC links land on the right anchor.
    lines.push(`## ${waveHeadingText(waveLabel, status.emoji)}`);
    lines.push('');

    // Single-line wave summary. Add a context-specific tail only when it
    // tells the reader something the table doesn't: which wave is gating
    // a Blocked one, or that a Ready wave fans out in parallel.
    let tail = '';
    if (status.word === 'Blocked') {
      const priorWaves = sortedWaves.filter((sw) => sw < waveIdx);
      const lastPrior = priorWaves[priorWaves.length - 1];
      if (lastPrior !== undefined) tail = ` · gated on Wave ${lastPrior}`;
    } else if (status.word === 'Ready' && stories.length > 1) {
      tail = ` · ${stories.length} run in parallel`;
    }
    lines.push(
      `> ${stories.length} stor${stories.length === 1 ? 'y' : 'ies'} · ${stat.done}/${stat.tasks} tasks${tail}`,
    );
    lines.push('');

    for (const story of stories) {
      const sp = computeStoryProgress(story);
      const symbol = deriveStorySymbol(story);
      const titleCandidate = story.storyTitle || story.storySlug || '';
      lines.push(
        `### ${symbol} #${story.storyId} — ${titleCandidate} · ${sp.done}/${sp.total} tasks`,
      );
      lines.push('');

      if (story.tasks.length === 0) {
        lines.push('_(no tasks)_');
      } else {
        // Order Tasks root → blocked-last so the manifest reads in
        // execution order. We then annotate each Task that has any
        // in-Story dependency with the most recent dep (Story #1194 Task
        // #1213) — "most recent" is defined as the dep with the largest
        // position in the sorted list (the one whose work has to land
        // last for this Task to unblock).
        const sortedTasks = topoSortTasks(story.tasks);
        const inStoryIds = new Set(story.tasks.map((t) => String(t.taskId)));
        const positionInSort = new Map(
          sortedTasks.map((t, idx) => [String(t.taskId), idx]),
        );
        for (const task of sortedTasks) {
          const isDone = task.status === AGENT_LABELS.DONE;
          const checkbox = isDone ? '[x]' : '[ ]';
          const taskTitle = task.taskSlug || task.title || '';
          const inStoryDeps = (task.dependencies ?? []).filter((d) =>
            inStoryIds.has(String(d)),
          );
          let suffix = '';
          if (inStoryDeps.length > 0) {
            // Pick the dep that appears latest in the sorted order — that's
            // the one whose completion actually unblocks this Task.
            const latest = inStoryDeps.reduce((a, b) =>
              (positionInSort.get(String(a)) ?? -1) >
              (positionInSort.get(String(b)) ?? -1)
                ? a
                : b,
            );
            suffix = ` *(after #${latest})*`;
          }
          lines.push(`- ${checkbox} #${task.taskId} — ${taskTitle}${suffix}`);
        }
      }
      lines.push('');
    }
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
  const { epicId, epicTitle, summary, storyManifest, generatedAt } = manifest;
  const progress = computeProgress(manifest);
  const lines = [];

  // --- Header ---
  // Title + subtitle + a single meta line that folds the timestamp and the
  // task / story / wave totals together. The Wave Summary table (next)
  // breaks the totals down per wave, so a hero progress block here would
  // just echo the same numbers a third time.
  lines.push(`# 📋 Dispatch Manifest — Epic #${epicId}`);
  lines.push('');
  lines.push(`> **${epicTitle}**`);
  lines.push('');
  const waveCount = progress.storyWaveCount;
  lines.push(
    `_Generated ${generatedAt} · ${summary.doneTasks}/${summary.totalTasks} tasks · ${progress.doneStories}/${progress.totalStories} stories · ${waveCount} wave${waveCount === 1 ? '' : 's'}_`,
  );
  lines.push('');

  // --- Top <details> block: operating procedures + full symbol legend.
  // Sits directly under the meta line so an operator opening the manifest
  // sees the run-instructions and the symbol key before scrolling the wave
  // tables. The only HTML in the document; collapsed by default.
  lines.push(renderProceduresAndLegendDetails(epicId));
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

  // --- Per-wave H2 sections nesting Stories (H3) and Tasks (checkbox lists)
  if (storyManifest && storyManifest.length > 0) {
    const nestedBlock = renderNestedWaveSections(storyManifest);
    if (nestedBlock) lines.push(nestedBlock);
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

  return lines.join('\n');
}

// Backward-compat alias (existing callers and tests import this name).
export const renderManifestMarkdown = formatManifestMarkdown;

// ---------------------------------------------------------------------------
// Dual entry points: fromManifest / fromSpec (Epic #1182 Story #1501)
//
// `fromManifest` is the canonical-by-name alias for `formatManifestMarkdown` —
// the legacy entry point that consumes a fully-resolved dispatch manifest
// (GH issue numbers, agent::* statuses, summary totals) and emits Markdown.
// It is preserved unchanged for non-spec callers (the dispatcher's
// pre-Story #1501 path, every existing test, the manifest-renderer facade).
//
// `fromSpec` is the new entry point that takes a structural spec (the
// `.agents/epics/<epic-id>.yaml` shape returned by `lib/spec/loader.js#loadSpec`)
// plus a state mapping (the sibling `<epic-id>.state.json` shape returned
// by `loadState`) and projects a manifest-shaped object, then funnels it
// back through `formatManifestMarkdown`. Funnelling — rather than
// open-coding the Markdown emit a second time — is the round-trip
// byte-identity guarantee: any drift in the renderer affects both
// entry points equally.
//
// Per Tech Spec #1483, agent::* status labels do not live in the spec.
// `fromSpec` reads `state.mapping[slug].lastObservedAgentState` when
// present and falls back to `agent::ready` for un-mapped Stories/Tasks.
// Slug→issue-number resolution falls back to a deterministic
// `slug:<slug>` sentinel so the renderer never trips on a missing id
// (the rendered output annotates these so the operator can spot un-
// materialised entries at a glance).
// ---------------------------------------------------------------------------

/**
 * Canonical alias for `formatManifestMarkdown`. Existing callers should
 * migrate to this name; the underlying function is unchanged.
 */
export const fromManifest = formatManifestMarkdown;

/**
 * Build a manifest-shaped object from a spec entry. Mirrors the contract
 * produced by `lib/orchestration/manifest-builder.js#buildManifest` so
 * `formatManifestMarkdown` (the renderer that backs `fromManifest`)
 * accepts it without modification.
 *
 * Slug→issue-number resolution prefers `state.mapping[slug].issueNumber`
 * when present and falls back to a deterministic `slug:<slug>` sentinel
 * so the renderer never sees a null id. Status labels prefer
 * `state.mapping[slug].lastObservedAgentState` and fall back to
 * `agent::ready` per Tech Spec #1483.
 *
 * Pure — does not touch fs or the network. Caller supplies `state` from
 * `lib/spec/loader.js#loadState`.
 *
 * @param {object} spec — parsed epic-spec (see `lib/spec/loader.js`).
 * @param {{
 *   state?: { mapping?: Record<string, { issueNumber?: number|null, lastObservedAgentState?: string|null }> },
 *   generatedAt?: string,
 *   executor?: string,
 *   dryRun?: boolean,
 *   agentTelemetry?: object|null,
 * }} [opts]
 * @returns {object} manifest object matching the shape `formatManifestMarkdown` consumes.
 */
export function buildManifestFromSpec(spec, opts = {}) {
  const state = opts.state ?? null;
  const mapping =
    state && typeof state.mapping === 'object' && state.mapping !== null
      ? state.mapping
      : {};

  const resolveId = (slug) => {
    const entry = mapping[slug];
    const id =
      entry && typeof entry.issueNumber === 'number' ? entry.issueNumber : null;
    return id ?? `slug:${slug}`;
  };
  const resolveStatus = (slug) => {
    const entry = mapping[slug];
    return entry && typeof entry.lastObservedAgentState === 'string'
      ? entry.lastObservedAgentState
      : 'agent::ready';
  };

  const epicId =
    spec?.epic && typeof spec.epic.id === 'number' ? spec.epic.id : null;
  const epicTitle =
    spec?.epic && typeof spec.epic.title === 'string' ? spec.epic.title : '';

  const features = Array.isArray(spec?.features) ? spec.features : [];

  // Project each spec Story into a storyManifest entry. Tasks within a
  // Story carry their slug-derived id + the spec-author title as the
  // task slug so the rendered `- [ ] #id — slug` line is stable across
  // re-incarnations (no GH issue number drift bleeds through into the
  // diff). Per-Story `earliestWave` mirrors `story.wave` directly —
  // spec waves are authoritative; the dependency analyzer is bypassed.
  const storyManifest = [];
  let totalTasks = 0;
  let doneTasks = 0;
  const waveSet = new Set();

  for (const feature of features) {
    const stories = Array.isArray(feature?.stories) ? feature.stories : [];
    for (const story of stories) {
      if (!story || typeof story !== 'object') continue;
      const storyTasks = Array.isArray(story.tasks) ? story.tasks : [];
      const tasks = [];
      for (const t of storyTasks) {
        if (!t || typeof t !== 'object') continue;
        const status = resolveStatus(t.slug);
        if (status === AGENT_LABELS.DONE) doneTasks++;
        totalTasks++;
        tasks.push({
          taskId: resolveId(t.slug),
          taskSlug: t.slug ?? '',
          status,
          dependencies: [], // Tasks have no dependsOn surface in the spec.
        });
      }

      const wave = Number.isInteger(story.wave) ? story.wave : -1;
      if (wave >= 0) waveSet.add(wave);

      storyManifest.push({
        storyId: resolveId(story.slug),
        storyTitle: story.title ?? '',
        storySlug: story.slug ?? '',
        type: 'story',
        branchName:
          typeof resolveId(story.slug) === 'number'
            ? `story-${resolveId(story.slug)}`
            : `story-${story.slug}`,
        earliestWave: wave,
        tasks,
      });
    }
  }

  const progressPercent =
    totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;

  return {
    schemaVersion: '1.0.0',
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    epicId,
    epicTitle,
    executor: opts.executor ?? 'spec',
    dryRun: opts.dryRun ?? false,
    summary: {
      totalTasks,
      doneTasks,
      progressPercent,
      totalWaves: waveSet.size,
      dispatched: 0,
    },
    waves: [],
    storyManifest,
    dispatched: [],
    agentTelemetry: opts.agentTelemetry ?? null,
  };
}

/**
 * Render a Markdown dispatch manifest from a structural spec. Funnels
 * through `formatManifestMarkdown` so the output is byte-identical to
 * `fromManifest` when given an equivalent manifest fixture (the round-
 * trip parity AC for Story #1501).
 *
 * @param {object} spec — parsed epic-spec.
 * @param {Parameters<typeof buildManifestFromSpec>[1]} [opts]
 * @returns {string}
 */
export function fromSpec(spec, opts = {}) {
  const manifest = buildManifestFromSpec(spec, opts);
  // Bust the cache so callers that toggle between fromSpec / fromManifest
  // in the same process don't get a stale render from a content-hash
  // collision on a different manifest instance.
  __resetManifestFormatterCache();
  return formatManifestMarkdown(manifest);
}

// ---------------------------------------------------------------------------
// Story-execution manifest Markdown
// ---------------------------------------------------------------------------

/**
 * Format the per-story execution manifest. Pure: caller must supply
 * `opts.agentSettings` (the resolved `agentSettings` bag) so we can cite the
 * canonical `story-init.js` / `story-close.js` paths without touching
 * `resolveConfig` (fs).
 *
 * `scriptsRoot` lives under `agentSettings.paths.*` post-Epic #773 Story 9
 * (it was a flat agentSettings key prior). The fallback string keeps the
 * formatter usable in tiny test fixtures that omit the paths block.
 *
 * @param {object} manifest
 * @param {{ agentSettings: { paths?: { scriptsRoot?: string }, commands?: { validate?: string, test?: string } } }} opts
 * @returns {string}
 */
export function formatStoryManifestMarkdown(manifest, opts = {}) {
  const agentSettings = opts.agentSettings ?? {};
  const scriptsRoot = agentSettings.paths?.scriptsRoot ?? '.agents/scripts';
  const commands = agentSettings.commands ?? {};
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
 * channel (defaults to `Logger.info`). Keeping the sink injectable makes the
 * function testable without capturing stdout.
 *
 * @param {object[]} storyManifest
 * @param {{ logger?: { log: (line: string) => void } }} [opts]
 */
/* node:coverage ignore next */
export function printStoryDispatchTable(storyManifest, opts = {}) {
  const log = opts.logger?.log ?? ((line) => Logger.info(line));
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
  log('  💡 Use /epic-deliver #[Story ID] to execute a Story.');

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

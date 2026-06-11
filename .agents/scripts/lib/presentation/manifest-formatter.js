/**
 * manifest-formatter.js
 *
 * Wiring facade for the dispatch-manifest presentation layer. Composes:
 *   - `manifest-builder.js`        — spec → manifest projection.
 *   - `manifest-helpers.js`        — small pure helpers (progress, slug,
 *                                    wave-status, topo sort, …).
 *   - `manifest-render-waves.js`   — per-wave H2 sections + Story H3 list.
 *   - `manifest-procedures.js`     — bottom `<details>` block.
 *   - `manifest-story-views.js`    — story-execution manifest + CLI table.
 *
 * Exposes `formatManifestMarkdown` (memoised on per-input content hash)
 * plus `fromManifest` / `fromSpec` entry points, and re-exports every
 * symbol the older monolithic formatter used to host so existing
 * imports off this path keep resolving without change.
 *
 * Pure: no fs / provider / config I/O. Callers that need injected values
 * (e.g. `renderStoryManifestMarkdown`'s script-path hints) pass them via
 * `opts`. The outer façade `manifest-renderer.js` re-exports this module
 * and owns the one impure helper that reads config to build the options
 * bag.
 */

import { createHash } from 'node:crypto';
import { buildManifestFromSpec } from './manifest-builder.js';
import {
  computeProgress,
  deriveStorySymbol,
  deriveWaveStatus,
  renderProgressBar,
  renderWaveSections,
  slugifyHeading,
  waveHeadingText,
} from './manifest-helpers.js';
import { renderProceduresAndLegendDetails } from './manifest-procedures.js';
import {
  renderConcurrencyHazards,
  renderNestedWaveSections,
} from './manifest-render-waves.js';
import {
  formatStoryManifestMarkdown,
  printStoryDispatchTable,
} from './manifest-story-views.js';

// Re-export every name that used to live in this file so external
// call-sites and tests keep importing them from here without a path
// change (Story #1849 split).
export {
  buildManifestFromSpec,
  computeProgress,
  deriveStorySymbol,
  deriveWaveStatus,
  formatStoryManifestMarkdown,
  printStoryDispatchTable,
  renderConcurrencyHazards,
  renderNestedWaveSections,
  renderProceduresAndLegendDetails,
  renderProgressBar,
  renderWaveSections,
  slugifyHeading,
  waveHeadingText,
};

// ---------------------------------------------------------------------------
// Dispatch manifest (Epic-level) Markdown — memoised public entry
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
 * Clear the content-hash cache for `formatManifestMarkdown`. Intended
 * for tests and for callers that mutate manifest objects in place
 * between renders.
 */
export function __resetManifestFormatterCache() {
  _lastManifestRef = null;
  _lastManifestHash = null;
  _lastManifestOutput = null;
}

export function formatManifestMarkdown(manifest) {
  // Fast path: same manifest instance as last call (progress-reporter
  // reuses the same object across ticks when nothing has changed).
  if (manifest === _lastManifestRef && _lastManifestOutput !== null) {
    return _lastManifestOutput;
  }
  // Slow path: content-hash comparison for cases where the caller built
  // a fresh manifest object with identical content.
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
  const lines = [
    ...renderManifestHeader(manifest),
    ...renderManifestBody(manifest),
  ];
  /* node:coverage ignore next */
  if (manifest.agentTelemetry) {
    lines.push(...renderManifestTelemetry(manifest.agentTelemetry));
  }
  return lines.join('\n');
}

/**
 * Private: emit the manifest header — title, subtitle, the single
 * `_Generated …_` meta line, and the operating-procedures `<details>`
 * block that sits directly under the meta. Pure.
 *
 * @param {object} manifest
 * @returns {string[]}
 */
function renderManifestHeader(manifest) {
  const { epicId, epicTitle, generatedAt } = manifest;
  const progress = computeProgress(manifest);
  const waveCount = progress.storyWaveCount;
  return [
    `# 📋 Dispatch Manifest — Epic #${epicId}`,
    '',
    `> **${epicTitle}**`,
    '',
    `_Generated ${generatedAt} · ${progress.doneStories}/${progress.totalStories} stories · ${waveCount} wave${waveCount === 1 ? '' : 's'}_`,
    '',
    renderProceduresAndLegendDetails(epicId),
    '',
  ];
}

/**
 * Private: emit the Wave Summary table plus the per-wave H2 sections.
 *
 * @param {object} manifest
 * @returns {string[]}
 */
function renderManifestBody(manifest) {
  const allItems =
    manifest.storyManifest ||
    manifest.stories ||
    manifest.summary?.stories ||
    [];
  const waveEligible = allItems;
  const lines = [];
  const waveBlock = renderWaveSections(waveEligible);
  if (waveBlock) lines.push(waveBlock);
  const storyManifest = manifest.storyManifest;
  if (storyManifest && storyManifest.length > 0) {
    const nestedBlock = renderNestedWaveSections(storyManifest);
    if (nestedBlock) lines.push(nestedBlock);
  }
  // Cross-Story concurrency hazards block — only emitted when the caller
  // attaches `concurrencyFindings` to the manifest (i.e. `/plan`
  // Phase 9 dispatcher dry-run forwards the validator's findings array).
  // Absent for live progress-reporter manifests where the block would
  // duplicate Story-level state already shown above.
  if (manifest.concurrencyFindings !== undefined) {
    const hazardsBlock = renderConcurrencyHazards(manifest.concurrencyFindings);
    if (hazardsBlock) lines.push(hazardsBlock);
  }
  return lines;
}

/**
 * Private: emit the agent-telemetry trailer (friction count + recent
 * friction list) when the manifest carries one. Under the 2-tier
 * hierarchy (Epic #3163) friction records are Story-scoped, so each
 * recent-friction item is keyed by its `storyId`.
 *
 * @param {{ totalFriction: number, recentFriction: Array<{ message: string, storyId: number|string }> }} agentTelemetry
 * @returns {string[]}
 */
/* node:coverage ignore next */
function renderManifestTelemetry(agentTelemetry) {
  const lines = [
    '## 📈 Agent Telemetry & Diagnostics',
    '',
    `- **Total Friction Events:** ${agentTelemetry.totalFriction}`,
  ];
  if (agentTelemetry.recentFriction.length > 0) {
    lines.push('- **Active Issues & Friction:**');
    for (const item of agentTelemetry.recentFriction) {
      const safeMessage = item.message
        .replace(/\s+/g, ' ')
        .replace(/\n/g, ' ')
        .trim();
      lines.push(`  - Story **#${item.storyId}**: ${safeMessage}`);
    }
  } else {
    lines.push('- **Active Issues:** None recorded.');
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  return lines;
}

// Backward-compat alias (existing callers and tests import this name).
export const renderManifestMarkdown = formatManifestMarkdown;

// ---------------------------------------------------------------------------
// Dual entry points: fromManifest / fromSpec (Epic #1182 Story #1501)
// ---------------------------------------------------------------------------

/**
 * Canonical alias for `formatManifestMarkdown`. Existing callers should
 * migrate to this name; the underlying function is unchanged.
 */
export const fromManifest = formatManifestMarkdown;

/**
 * Render a Markdown dispatch manifest from a structural spec. Funnels
 * through `formatManifestMarkdown` so the output is byte-identical to
 * `fromManifest` when given an equivalent manifest fixture (round-trip
 * parity AC for Story #1501).
 *
 * @param {object} spec — parsed epic-spec.
 * @param {Parameters<typeof buildManifestFromSpec>[1]} [opts]
 * @returns {string}
 */
export function fromSpec(spec, opts = {}) {
  const manifest = buildManifestFromSpec(spec, opts);
  // Bust the cache so callers toggling fromSpec / fromManifest in the
  // same process don't get a stale render from a content-hash collision
  // on a different manifest instance.
  __resetManifestFormatterCache();
  return formatManifestMarkdown(manifest);
}

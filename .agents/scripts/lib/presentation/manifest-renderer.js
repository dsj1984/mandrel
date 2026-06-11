/**
 * manifest-renderer.js
 *
 * Facade that composes the presentation layer:
 *   - `manifest-formatter.js`    — pure Markdown / CLI rendering.
 *   - `manifest-persistence.js`  — write manifests to `temp/`.
 *   - GitHub comment upserts     — `postManifestEpicComment` / `postParkedFollowOnsComment`.
 *
 * Keeps every export that external callers consume today so the split is
 * internal: dispatcher.js and tests all continue to import from this path.
 */

import { resolveConfig } from '../config-resolver.js';
import { TYPE_LABELS } from '../label-constants.js';
import {
  classifyStoriesAgainstManifest,
  renderParkedFollowOnsComment,
} from '../orchestration/parked-follow-ons.js';
import { upsertStructuredComment } from '../orchestration/ticketing.js';
import { renderManifestFromManifest } from './dispatch-manifest-render.js';
import {
  buildManifestFromSpec,
  formatManifestMarkdown,
  formatStoryManifestMarkdown,
  fromManifest,
  fromSpec,
  printStoryDispatchTable,
  renderManifestMarkdown,
} from './manifest-formatter.js';
import { persistManifest } from './manifest-persistence.js';

export {
  buildManifestFromSpec,
  formatManifestMarkdown,
  fromManifest,
  fromSpec,
  persistManifest,
  printStoryDispatchTable,
  renderManifestMarkdown,
};

/**
 * Backwards-compatible Markdown renderer for story-execution manifests.
 * Resolves config internally to cite the canonical script paths. The pure
 * variant lives at `manifest-formatter.js::formatStoryManifestMarkdown` — new
 * call-sites should prefer that and inject the canonical `config` bag
 * explicitly.
 *
 * @param {object} manifest
 * @returns {string}
 */
export function renderStoryManifestMarkdown(manifest) {
  const config = resolveConfig();
  return formatStoryManifestMarkdown(manifest, { config });
}

/**
 * Pure: a manifest qualifies for an Epic comment upsert when it exists, is
 * not a story-execution dry-run, and carries an epicId.
 *
 * @param {unknown} manifest
 */
export function isEpicManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') return false;
  return manifest.type !== 'story-execution' && Boolean(manifest.epicId);
}

/**
 * Pure: a provider can upsert a comment when it is non-nullish and exposes a
 * callable `postComment`.
 *
 * @param {unknown} provider
 */
export function providerCanPostComment(provider) {
  return Boolean(provider) && typeof provider?.postComment === 'function';
}

/**
 * Classify whether `(manifest, provider)` are eligible for an Epic comment
 * upsert. Returns `null` when eligible, otherwise the skip-reason string.
 *
 * @param {unknown} manifest
 * @param {unknown} provider
 * @returns {null | 'not-an-epic-manifest' | 'no-provider'}
 */
export function classifyEpicCommentEligibility(manifest, provider) {
  if (!isEpicManifest(manifest)) return 'not-an-epic-manifest';
  if (!providerCanPostComment(provider)) return 'no-provider';
  return null;
}

/**
 * Persist the Epic's dispatch manifest as a structured comment on the Epic
 * issue. Idempotent — replaces any existing `dispatch-manifest` comment.
 * No-op in dry-run-only story manifests (no epicId).
 *
 * @param {object} manifest
 * @param {import('../ITicketingProvider.js').ITicketingProvider} provider
 * @returns {Promise<{ posted: boolean, reason?: string }>}
 */
export async function postManifestEpicComment(manifest, provider) {
  const skipReason = classifyEpicCommentEligibility(manifest, provider);
  if (skipReason) return { posted: false, reason: skipReason };

  // Body rendering lives in the pure `dispatch-manifest-render.js`
  // helper so the wave-runner's in-process refresh hop can produce a
  // byte-identical body without spawning `dispatcher.js --dry-run`.
  const body = renderManifestFromManifest(manifest);

  try {
    await upsertStructuredComment(
      provider,
      manifest.epicId,
      'dispatch-manifest',
      body,
    );
    return { posted: true };
  } catch (err) {
    process.stderr.write(
      `[Dispatcher] Failed to persist dispatch-manifest comment to Epic #${manifest.epicId}: ${err.message}\n`,
    );
    return { posted: false, reason: err.message };
  }
}

/**
 * Classify Stories under the Epic against the frozen dispatch manifest and
 * upsert a `parked-follow-ons` structured comment on the Epic. Idempotent.
 *
 * @param {object} manifest
 * @param {import('../ITicketingProvider.js').ITicketingProvider} provider
 * @returns {Promise<{ posted: boolean, recuts: number, parked: number, reason?: string }>}
 */
export async function postParkedFollowOnsComment(manifest, provider) {
  const skipReason = classifyEpicCommentEligibility(manifest, provider);
  if (skipReason) {
    return { posted: false, recuts: 0, parked: 0, reason: skipReason };
  }

  const storyManifest = manifest.storyManifest ?? [];
  const manifestStoryIds = storyManifest
    .filter((s) => s.storyId !== '__ungrouped__')
    .map((s) => Number(s.storyId))
    .filter((n) => Number.isFinite(n));

  let storiesUnderEpic = [];
  try {
    const all = await provider.getTickets(manifest.epicId);
    if (all) {
      provider.primeTicketCache(all);
    }
    storiesUnderEpic = (all ?? []).filter((t) =>
      (t.labels ?? []).includes(TYPE_LABELS.STORY),
    );
  } catch (err) {
    return { posted: false, recuts: 0, parked: 0, reason: err.message };
  }

  const classification = classifyStoriesAgainstManifest(
    manifestStoryIds,
    storiesUnderEpic,
  );
  const body = renderParkedFollowOnsComment(manifest.epicId, classification);

  try {
    await upsertStructuredComment(
      provider,
      manifest.epicId,
      'parked-follow-ons',
      body,
    );
    return {
      posted: true,
      recuts: classification.recuts.length,
      parked: classification.parked.length,
    };
  } catch (err) {
    process.stderr.write(
      `[Dispatcher] Failed to persist parked-follow-ons comment to Epic #${manifest.epicId}: ${err.message}\n`,
    );
    return {
      posted: false,
      recuts: classification.recuts.length,
      parked: classification.parked.length,
      reason: err.message,
    };
  }
}

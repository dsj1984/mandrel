/**
 * planning-corpus.js — corpus-aware context for the standalone-Story
 * planning path (Story #4432).
 *
 * `/plan --seed` drafts a standalone Story from the seed, the body
 * template, and a title-only duplicate scan. This module assembles the
 * inherited context (`corpusContext`) for `story-plan.js`'s
 * `--emit-context` envelope:
 *
 *   1. `docsDigest` — the same per-project docs digest
 *      `orchestration/docs-digest.js` builds for `/deliver` Story
 *      children, reused here so the standalone path gets the same
 *      compact outline instead of re-reading the whole docs set.
 *      `null` when `project.docsContextFiles` is not configured.
 *   2. `relevantSections` — always `[]`. This field previously carried
 *      ranked Tech Spec excerpts mined from open Epics. v2.0.0 removed
 *      the Epic tier, and the provider's Epic-list surface was reduced
 *      to a `return []` stub, which made the entire ranking pipeline a
 *      permanent no-op. The pipeline has been removed; the field is
 *      retained so the envelope shape stays stable for its consumers.
 */

import { buildDocsDigest } from './orchestration/docs-digest.js';

/**
 * Assemble the `corpusContext` field of the story-plan context envelope.
 *
 * @param {{
 *   docsContextFiles?: string[],
 *   docsRoot?: string,
 * }} opts
 * @returns {Promise<{ docsDigest: string|null, relevantSections: Array<object> }>}
 */
export async function buildCorpusContext({ docsContextFiles, docsRoot }) {
  const docsDigest = await buildDocsDigest({ docsContextFiles, docsRoot });
  return { docsDigest, relevantSections: [] };
}

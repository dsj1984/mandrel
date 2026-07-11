/**
 * planning-corpus.js — corpus-aware context for the standalone-Story
 * planning path (Story #4432).
 *
 * `/plan --idea` previously drafted a standalone Story from a blank
 * slate: the seed, the body template, and a title-only duplicate scan.
 * For a change request that is really a small delta against an
 * already-delivered surface, that blank slate throws away context the
 * project already has — the docs digest and the relevant Tech Spec
 * sections of existing Epics that cover the touched area.
 *
 * This module assembles that inherited context (`corpusContext`) for
 * `story-plan.js`'s `--emit-context` envelope:
 *
 *   1. `docsDigest` — the same per-project docs digest
 *      `orchestration/docs-digest.js` builds for `/deliver` Story
 *      children, reused here so the standalone path gets the same
 *      compact outline instead of re-reading the whole docs set.
 *      `null` when `project.docsContextFiles` is not configured.
 *   2. `relevantSections` — a ranked list of existing Epic Tech Spec
 *      (or lede, when no Tech Spec region exists) excerpts that overlap
 *      with the seed, so the draft can build on prior art instead of
 *      re-deriving it.
 *
 * The Epic list surface (`provider.getEpics`) maps every issue through
 * `issueToEpicListItem`, which deliberately omits `body` (a list-scale
 * payload trim). Body content therefore requires an **explicit**,
 * bounded per-candidate fetch via `provider.getEpic(id)` — never a
 * silent assumption that the list response carries prose to score
 * against.
 *
 * Relevance scoring reuses the same `tokenize` / `overlapScore` Jaccard
 * primitives `duplicate-search.js` exports for Epic-dedupe and
 * `story-plan.js` reuses for Story-dedupe — one matcher, three
 * consumers, no forked scoring logic.
 */

import { overlapScore, tokenize } from './duplicate-search.js';
import { extractEpicSection, hasEpicSection } from './epic-body-sections.js';
import { Logger } from './Logger.js';
import { buildDocsDigest } from './orchestration/docs-digest.js';

/** Top-K Epics kept after the cheap title-only ranking pass. */
const DEFAULT_CORPUS_MAX_CANDIDATES = 5;

/**
 * Bound on the explicit per-candidate body fetch. Keeps corpus-context
 * assembly at a fixed, small number of GitHub reads regardless of how
 * many open Epics the repo carries.
 */
export const DEFAULT_CORPUS_BODY_FETCH_TOP_K = 3;

/** Minimum Jaccard overlap for a section excerpt to be worth surfacing. */
const DEFAULT_CORPUS_MIN_SCORE = 0.1;

/** Max relevant-section excerpts returned in the envelope. */
const DEFAULT_CORPUS_MAX_SECTIONS = 5;

/** Excerpt length cap (chars) so one oversized Tech Spec doesn't blow the envelope. */
const EXCERPT_MAX_CHARS = 600;

/**
 * Page-scan cap passed to `provider.getEpics({ state: 'open', pageCap })`.
 * The corpus lookup only ever ranks the list down to a top-5 shortlist
 * (`DEFAULT_CORPUS_MAX_CANDIDATES`), so there is no need to inherit
 * `paginateRest`'s full default ceiling (50 pages / 5000 items) to build
 * it — a bounded scan keeps this call a fixed, small number of GitHub
 * reads regardless of how many open Epics the repo carries.
 */
const CORPUS_EPICS_PAGE_CAP = 5;

/**
 * Rank open Epics by title-overlap with the seed. This is the cheap
 * first pass over the list surface (title only — `issueToEpicListItem`
 * has no `body`), used solely to pick the bounded top-K candidates
 * worth an explicit body fetch. It is not the final relevance signal;
 * `extractRelevantSections` re-scores against actual section content.
 *
 * @param {{ seed: string, epics: Array<{ id:number, title:string }>, maxResults?: number }} opts
 * @returns {Array<{ id:number, title:string, score:number }>}
 */
export function rankCandidateEpics({
  seed,
  epics,
  maxResults = DEFAULT_CORPUS_MAX_CANDIDATES,
}) {
  if (!seed || typeof seed !== 'string') {
    throw new Error('rankCandidateEpics: seed must be a non-empty string');
  }
  if (!Array.isArray(epics)) {
    throw new Error('rankCandidateEpics: epics must be an array');
  }
  const seedTokens = tokenize(seed);
  if (seedTokens.size === 0) return [];

  const ranked = [];
  for (const epic of epics) {
    if (!epic || typeof epic.title !== 'string') continue;
    const score = overlapScore(seedTokens, tokenize(epic.title));
    ranked.push({
      id: epic.id,
      title: epic.title,
      score: Number(score.toFixed(4)),
    });
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, maxResults);
}

/**
 * Fetch full bodies for the top-K ranked candidates via the single-issue
 * read (`provider.getEpic`), which — unlike the `getEpics` list mapper —
 * does carry `body`. This is the explicit, bounded fetch the corpus
 * lookup performs instead of assuming the list surface already has
 * prose to score: a candidate never contributes a relevant section
 * without this round-trip resolving its body.
 *
 * A single candidate's fetch failing (deleted issue, transient error) is
 * non-fatal — it is dropped from the result rather than aborting corpus
 * assembly for every other candidate. Failures are logged via
 * `Logger.debug` (stderr) so they are visible under
 * `AGENT_LOG_LEVEL=verbose` triage without violating the friction-
 * telemetry posture in `.agents/instructions.md` §1.H of never silently
 * swallowing an error.
 *
 * The bounded candidate slice is fetched concurrently
 * (`Promise.allSettled`) rather than sequentially — `topK` is a fixed
 * small ceiling (default 3), so this is a bounded fan-out, not an
 * unbounded one, and it removes the serial network-latency stacking a
 * plain `for`-await loop would otherwise incur.
 *
 * @param {{ provider: object, candidates: Array<{ id:number, title:string }>, topK?: number }} opts
 * @returns {Promise<Array<{ id:number, title:string, body:string }>>}
 */
export async function fetchCandidateBodies({
  provider,
  candidates,
  topK = DEFAULT_CORPUS_BODY_FETCH_TOP_K,
}) {
  if (!provider || typeof provider.getEpic !== 'function') return [];
  if (!Array.isArray(candidates) || candidates.length === 0) return [];

  const bounded = candidates.slice(0, topK);
  const settled = await Promise.allSettled(
    bounded.map(async (candidate) => {
      const epic = await provider.getEpic(candidate.id);
      return {
        id: candidate.id,
        title: candidate.title ?? epic?.title ?? '',
        body: epic?.body ?? '',
      };
    }),
  );

  const results = [];
  for (let i = 0; i < settled.length; i += 1) {
    const outcome = settled[i];
    if (outcome.status === 'fulfilled') {
      results.push(outcome.value);
      continue;
    }
    // Best-effort: one candidate failing to resolve must not abort
    // corpus-context assembly for the rest — but the failure is still
    // surfaced for triage rather than silently swallowed.
    Logger.debug(
      `[planning-corpus] fetchCandidateBodies: candidate #${bounded[i].id} failed to resolve: ${outcome.reason?.message ?? outcome.reason}`,
    );
  }
  return results;
}

/**
 * Extract a scoreable excerpt from an Epic body: the managed Tech Spec
 * region when present (the folded `## Delivery Slicing` section, #4324),
 * otherwise the ideation lede — the prose before the first `##` heading
 * — so a plain-body Epic still contributes something to score.
 *
 * @param {string} body
 * @returns {{ kind:'techSpec'|'lede', content:string }}
 */
function extractScoreableExcerpt(body) {
  if (hasEpicSection(body, 'techSpec')) {
    return { kind: 'techSpec', content: extractEpicSection(body, 'techSpec') };
  }
  const lede = (body ?? '').split(/^##\s+/m)[0].trim();
  return { kind: 'lede', content: lede };
}

/**
 * Rank existing-Epic body excerpts (Tech Spec section, or lede) by
 * overlap with the seed. Reuses the same `tokenize` / `overlapScore`
 * primitives as the title-ranking pass above and as
 * `duplicate-search.js` — one matcher shared across every corpus /
 * dedupe surface.
 *
 * @param {{ seed:string, epicBodies: Array<{ id:number, title:string, body:string }>, maxResults?: number, minScore?: number }} opts
 * @returns {Array<{ epicId:number, epicTitle:string, section:'techSpec'|'lede', score:number, excerpt:string }>}
 */
export function extractRelevantSections({
  seed,
  epicBodies,
  maxResults = DEFAULT_CORPUS_MAX_SECTIONS,
  minScore = DEFAULT_CORPUS_MIN_SCORE,
}) {
  if (!seed || typeof seed !== 'string') {
    throw new Error('extractRelevantSections: seed must be a non-empty string');
  }
  if (!Array.isArray(epicBodies)) {
    throw new Error('extractRelevantSections: epicBodies must be an array');
  }
  const seedTokens = tokenize(seed);
  if (seedTokens.size === 0) return [];

  const ranked = [];
  for (const epic of epicBodies) {
    if (!epic) continue;
    const { kind, content } = extractScoreableExcerpt(epic.body ?? '');
    if (!content) continue;
    const score = overlapScore(seedTokens, tokenize(content));
    if (score < minScore) continue;
    ranked.push({
      epicId: epic.id,
      epicTitle: epic.title ?? null,
      section: kind,
      score: Number(score.toFixed(4)),
      excerpt: content.slice(0, EXCERPT_MAX_CHARS),
    });
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, maxResults);
}

/**
 * Assemble the `corpusContext` field of the story-plan context envelope.
 * Pure orchestration over the three helpers above plus `buildDocsDigest`
 * — no I/O beyond what `provider` and the docs-digest reader perform.
 *
 * `relevantSections` is `[]` (not an error) when the provider has no
 * `getEpics` surface, the seed tokenizes to nothing, or no candidate
 * clears `minScore` — the standalone-Story draft path degrades to
 * exactly today's blank-slate behavior in that case.
 *
 * @param {{
 *   seed: string,
 *   provider?: { getEpics?: Function, getEpic?: Function },
 *   docsContextFiles?: string[],
 *   docsRoot?: string,
 *   maxCandidates?: number,
 *   bodyFetchTopK?: number,
 *   maxSections?: number,
 *   minScore?: number,
 * }} opts
 * @returns {Promise<{ docsDigest: string|null, relevantSections: Array<object> }>}
 */
export async function buildCorpusContext({
  seed,
  provider,
  docsContextFiles,
  docsRoot,
  maxCandidates = DEFAULT_CORPUS_MAX_CANDIDATES,
  bodyFetchTopK = DEFAULT_CORPUS_BODY_FETCH_TOP_K,
  maxSections = DEFAULT_CORPUS_MAX_SECTIONS,
  minScore = DEFAULT_CORPUS_MIN_SCORE,
}) {
  const docsDigest = await buildDocsDigest({ docsContextFiles, docsRoot });

  let relevantSections = [];
  if (provider && typeof provider.getEpics === 'function') {
    // A single candidate-listing call failing (rate limit, transient
    // network error, provider outage) must not abort the whole
    // `--emit-context` envelope build — degrade to an empty candidate
    // list instead of letting the rejection propagate out of the
    // caller's `Promise.all` and take down the rest of the envelope
    // (body template, tech-stack summary, docs digest) with it.
    let epics = [];
    try {
      epics = await provider.getEpics({
        state: 'open',
        pageCap: CORPUS_EPICS_PAGE_CAP,
      });
    } catch (err) {
      Logger.debug(
        `[planning-corpus] buildCorpusContext: provider.getEpics failed, degrading to an empty candidate list: ${err?.message ?? err}`,
      );
      epics = [];
    }
    const ranked = rankCandidateEpics({
      seed,
      epics: Array.isArray(epics) ? epics : [],
      maxResults: maxCandidates,
    });
    const bodies = await fetchCandidateBodies({
      provider,
      candidates: ranked,
      topK: bodyFetchTopK,
    });
    relevantSections = extractRelevantSections({
      seed,
      epicBodies: bodies,
      maxResults: maxSections,
      minScore,
    });
  }

  return { docsDigest, relevantSections };
}

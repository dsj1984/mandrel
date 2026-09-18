import { parse as parseStoryBody } from '../story-body/story-body.js';
import { collectStoryAssumptionEntries } from './file-assumptions.js';
import { computeStoryReachability } from './story-reachability.js';

/**
 * Parse a serialized string body so the passes see the production shape. An
 * unparseable string yields `body: null` rather than throwing mid-validation.
 *
 * @param {object} story
 * @returns {object} A shallow clone of `story` with a structured `body`.
 */
function normalizeStoryBody(story) {
  const body = story?.body;
  if (typeof body === 'string') {
    if (body.trim().length === 0) return { ...story, body: null };
    try {
      return { ...story, body: parseStoryBody(body).body };
    } catch {
      return { ...story, body: null };
    }
  }
  return story;
}

/**
 * Cross-Story `shared-editor` findings: a path written by two or more Stories
 * that no `depends_on` chain orders. Pure; every finding is advisory.
 *
 * @typedef {object} SharedEditorFinding
 * @property {'shared-editor'} kind
 * @property {'hard'|'soft'}   severity
 * @property {string}          path
 * @property {string[]}        storySlugs
 *
 * @typedef {SharedEditorFinding} ConflictFinding
 */

const SOFT = 'soft';

/** `exists` and `references` are reads, never producers. */
const WRITE_IMPLYING_ASSUMPTIONS = Object.freeze(
  new Set(['creates', 'refactors-existing', 'deletes']),
);

function collectStoryProducerPaths(story) {
  const paths = new Set();

  for (const entry of collectStoryAssumptionEntries(story)) {
    if (entry.source !== 'changes') continue;
    if (!WRITE_IMPLYING_ASSUMPTIONS.has(entry.assumption)) continue;
    paths.add(entry.path);
  }

  return Array.from(paths);
}

function storySlugOf(story) {
  return story.slug;
}

/**
 * `Map<path, Array<{storySlug, taskSlug}>>`; `taskSlug` is the Story's own
 * slug, kept for shape compatibility.
 */
function indexProducers(stories) {
  const producers = new Map();
  for (const story of stories) {
    for (const path of collectStoryProducerPaths(story)) {
      const entry = { storySlug: storySlugOf(story), taskSlug: story.slug };
      const existing = producers.get(path);
      if (existing) existing.push(entry);
      else producers.set(path, [entry]);
    }
  }
  return producers;
}

function inSameWave(reach, slugA, slugB) {
  if (slugA === slugB) return false;
  const a = reach.get(slugA);
  const b = reach.get(slugB);
  if (a?.has(slugB)) return false;
  if (b?.has(slugA)) return false;
  return true;
}

/** Stories ordered by an explicit chain are not flagged. */
function computeSharedEditorFindings(producers, reach, severity) {
  const findings = [];
  for (const [path, entries] of producers.entries()) {
    const distinct = Array.from(new Set(entries.map((e) => e.storySlug)));
    if (distinct.length < 2) continue;
    const cluster = new Set();
    for (let i = 0; i < distinct.length; i += 1) {
      for (let j = i + 1; j < distinct.length; j += 1) {
        if (inSameWave(reach, distinct[i], distinct[j])) {
          cluster.add(distinct[i]);
          cluster.add(distinct[j]);
        }
      }
    }
    if (cluster.size === 0) continue;
    findings.push({
      kind: 'shared-editor',
      severity,
      path,
      storySlugs: Array.from(cluster).sort(),
    });
  }
  return findings;
}

/**
 * @param {object}    input
 * @param {object[]}  input.stories
 * @returns {ConflictFinding[]}
 */
export function computeConflictFindings({ stories } = {}) {
  const storyList = (stories ?? []).map(normalizeStoryBody);
  const producers = indexProducers(storyList);
  const reach = computeStoryReachability(storyList);
  return computeSharedEditorFindings(producers, reach, SOFT);
}

/**
 * Re-run over the assembled bodies persist actually writes — validation runs
 * before assembly folds top-level fields into the body.
 *
 * @param {{ stories: Array<{ slug: string, title: string, body: string, depends_on?: string[] }> }} args
 * @returns {ConflictFinding[]}
 */
export function computeAssembledConflictFindings({ stories } = {}) {
  return computeConflictFindings({
    stories: (Array.isArray(stories) ? stories : []).map((story) => ({
      slug: story.slug,
      title: story.title,
      body: story.body,
      depends_on: Array.isArray(story.depends_on) ? story.depends_on : [],
    })),
  });
}

/**
 * Lets the post-assembly pass report only genuinely new findings.
 * The separator is written as the `\u0000` escape and never as a raw byte — a
 * literal NUL would make git classify this file as binary and drop its diffs.
 *
 * @param {object} finding
 * @returns {string}
 */
export function conflictFindingKey(finding) {
  return [
    finding?.kind ?? '',
    finding?.path ?? '',
    Array.isArray(finding?.storySlugs)
      ? [...finding.storySlugs].sort().join(',')
      : (finding?.storySlug ?? ''),
    finding?.producer?.storySlug ?? '',
    finding?.consumer?.storySlug ?? '',
    finding?.consumer?.sourceField ?? '',
  ].join('\u0000');
}

/** SSOT for which finding kinds are cross-Story conflicts. */
export const CONFLICT_KINDS = Object.freeze(new Set(['shared-editor']));

/** Every finding is soft now; the name survives for its importers. */
export function renderHardConflictError(finding) {
  if (finding.kind === 'shared-editor') {
    const stories = finding.storySlugs.map((s) => `"${s}"`).join(', ');
    return `Shared-editor conflict: "${finding.path}" is written by ${finding.storySlugs.length} concurrent Stories (${stories}). Add depends_on chains between them or split the edits into a dedicated late-wave wiring Story.`;
  }
  if (typeof finding.message === 'string' && finding.message.length > 0) {
    return finding.message;
  }
  return `Conflict finding ${finding.kind} on path "${finding.path ?? '<unknown>'}".`;
}

// Internal helpers exposed for unit tests; not part of the public surface.
export const _internal = {
  collectStoryProducerPaths,
  WRITE_IMPLYING_ASSUMPTIONS,
  indexProducers,
  computeStoryReachability,
  inSameWave,
  computeSharedEditorFindings,
};

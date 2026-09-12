import { parse as parseStoryBody } from '../story-body/story-body.js';
import { collectStoryAssumptionEntries } from './file-assumptions.js';
import { computeStoryReachability } from './story-reachability.js';

/**
 * Normalize a Story so its `body` is the structured object the conflict
 * passes scan, mirroring `validateAcFreshness` /
 * `collectStoryAssumptionEntries` (Story #3302) and the sizing gate's
 * `resolveStoryBody` (Story #4271).
 *
 * The decomposer emits `body` as the canonical serialized **string**, but
 * the conflict passes (`indexConsumers`, `computeMissingBddScaffoldFindings`,
 * and the producer path scan in `collectStoryProducerPaths`) historically
 * read `story.body` only when it was already an object — so on the
 * production string shape the `implicit-cross-story-dep` and
 * `missing-bdd-scaffold` findings emitted nothing. Parsing the body once at the entry point and
 * threading the normalized Story through every pass restores parity.
 *
 * `collectStoryAssumptionEntries` already parses string bodies itself, so a
 * normalized object body round-trips through it unchanged. The returned Story
 * keeps every other field (notably `slug` and `depends_on`) intact.
 *
 *   - **string body** → parsed via `parseStoryBody`; an unparseable string
 *     yields `body: null` (the passes degrade to "no structured signal",
 *     never throw mid-validation).
 *   - **object body** → returned verbatim.
 *   - **null / other** → `body: null`.
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
 * Cross-Story path-conflict & implicit-dependency findings.
 *
 * Two related gaps in the original decomposition validator motivate this
 * module:
 *
 *   1. The legacy freshness gate only audits paths under
 *      `.agents/scripts | lib | tests` and operates on individual Tasks. A
 *      decomposition that produces multiple Wave-0 Stories each editing the
 *      same shared file (e.g. `.github/workflows/quality.yml`) sails through
 *      validation, but parallel dispatch produces merge conflicts on every
 *      Story-to-Epic close after the first.
 *
 *   2. The validator's `depends_on` graph only honors explicit slug links.
 *      A Story whose Task `verify` block reads a file produced by a Task in
 *      a different Story has no dependency expressed, even though the
 *      consumer Story would fail execution-time verification when run in
 *      the same wave as the producer.
 *
 * Both gaps share a single underlying mechanism — a path-keyed graph across
 * all Tasks in the spec — which is why detection lives in one module.
 *
 * The module is pure: it consumes the already-normalized ticket array (with
 * lifted Task→Story `depends_on` deps applied) and returns a structured
 * findings array. Severity is `'soft'` by default; the caller's policy
 * flags upgrade findings to `'hard'`, which routes them through
 * `renderHardConflictError` and into the validator's `errors[]` channel.
 *
 * @typedef {object} SharedEditorFinding
 * @property {'shared-editor'} kind
 * @property {'hard'|'soft'}   severity
 * @property {string}          path        Producer path written by ≥2 Stories.
 * @property {string[]}        storySlugs  Story slugs in the conflict cluster.
 *
 * @typedef {object} ImplicitCrossStoryDepFinding
 * @property {'implicit-cross-story-dep'} kind
 * @property {'hard'|'soft'}   severity
 * @property {string}          path        Path consumed without a depends_on link.
 * @property {{ storySlug: string, taskSlug: string }} producer
 * @property {{ storySlug: string, taskSlug: string, sourceField: 'acceptance'|'verify' }} consumer
 *
 * @typedef {SharedEditorFinding | ImplicitCrossStoryDepFinding} ConflictFinding
 */

/**
 * Every conflict class is advisory (`'soft'`) since Story #5312: the
 * `planning.failOnSharedEditors` / `requireExplicitCrossStoryDeps` /
 * `failOnRegistryConflicts` / `failOnLargeFanOut` upgrade knobs are gone,
 * along with the registry and fan-out findings they gated. A finding is a
 * line in the plan summary the operator reads, never a refusal.
 */
const SOFT = 'soft';

/**
 * Assumptions that imply a *write* to a path — and therefore make the Story
 * a producer for shared-editor / implicit-dep purposes. `exists` declares a
 * read-only dependency (and `references` reads are likewise not writes), so
 * neither produces a `shared-editor` conflict.
 */
const WRITE_IMPLYING_ASSUMPTIONS = Object.freeze(
  new Set(['creates', 'refactors-existing', 'deletes']),
);

/**
 * Collect the write-implying producer paths a single Story declares.
 *
 * Uses object-form `{ path, assumption }` entries via
 * `collectStoryAssumptionEntries` (the same extractor the Phase-8
 * file-assumption gate uses), keeping only `changes`-sourced entries
 * whose assumption writes the path (`creates` / `refactors-existing` /
 * `deletes`). `exists` reads and `references` entries are dropped.
 *
 * Returns a de-duplicated array of producer paths for the Story.
 */
function collectStoryProducerPaths(story) {
  const paths = new Set();

  for (const entry of collectStoryAssumptionEntries(story)) {
    if (entry.source !== 'changes') continue;
    if (!WRITE_IMPLYING_ASSUMPTIONS.has(entry.assumption)) continue;
    paths.add(entry.path);
  }

  return Array.from(paths);
}

/**
 * Resolve the Story-identifying slug for a 2-tier Story. A Story is its
 * own implementation unit (Epic #3238) — there is no parent Task — so the
 * producer/consumer indices key on the Story's own `slug`.
 */
function storySlugOf(story) {
  return story.slug;
}

/**
 * Build the producers index — `Map<path, Array<{storySlug, taskSlug}>>` —
 * by walking every Story's declared writes. Only object-form
 * `{ path, assumption }` entries count as producers via
 * `collectStoryProducerPaths`; only write-implying assumptions count.
 *
 * `taskSlug` is retained in the entry shape for finding/render
 * compatibility; in the 2-tier model it carries the Story's own slug since
 * the Story is the implementation unit.
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

/**
 * Build the consumers index — `Array<{path, storySlug, taskSlug, sourceField}>`.
 *
 * For each Task, scan `body.acceptance` and `body.verify` joined text for
 * literal substring occurrences of any known producer path. Only producer
 * paths are matched (intersect-then-test), so free-text path-like tokens
 * that no one writes never produce false positives.
 *
 * A Story is not its own consumer — entries whose producer is the same
 * Story are skipped to keep the surface focused on cross-Story signal.
 */
function indexConsumers(stories, producers) {
  const consumers = [];
  if (producers.size === 0) return consumers;
  const producerPaths = Array.from(producers.keys()).sort(
    (a, b) => b.length - a.length,
  );
  for (const story of stories) {
    const body = story.body;
    if (!body || typeof body !== 'object') continue;
    for (const sourceField of ['acceptance', 'verify']) {
      const items = Array.isArray(body[sourceField]) ? body[sourceField] : [];
      if (items.length === 0) continue;
      const joined = items.map((it) => String(it ?? '')).join('\n');
      for (const path of producerPaths) {
        if (!joined.includes(path)) continue;
        const producerEntries = producers.get(path) ?? [];
        if (producerEntries.some((p) => p.taskSlug === story.slug)) continue;
        consumers.push({
          path,
          storySlug: storySlugOf(story),
          taskSlug: story.slug,
          sourceField,
        });
      }
    }
  }
  return consumers;
}

function inSameWave(reach, slugA, slugB) {
  if (slugA === slugB) return false;
  const a = reach.get(slugA);
  const b = reach.get(slugB);
  if (a?.has(slugB)) return false;
  if (b?.has(slugA)) return false;
  return true;
}

/**
 * Emit one `shared-editor` finding per path that is written by Tasks in
 * two or more distinct Stories where no `depends_on` path orders the
 * Stories relative to one another. Stories serialized by an explicit chain
 * are not flagged — the operator already accepted the merge order.
 */
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
 * Emit one `implicit-cross-story-dep` finding per consumer entry whose
 * producer Story is not transitively reachable from the consumer Story.
 *
 * Multiple producers per path are possible — the finding pins the *first*
 * producer in declaration order (sufficient signal; the operator typically
 * fixes the missing `depends_on` by linking to whichever Story they
 * recognize). Consumers already covered by a transitive dependency to
 * *some* producer are silently allowed even if other producers exist.
 */
function computeImplicitDepFindings(consumers, producers, reach, severity) {
  const findings = [];
  for (const consumer of consumers) {
    const producerEntries = producers.get(consumer.path) ?? [];
    if (producerEntries.length === 0) continue;
    const reachable = reach.get(consumer.storySlug) ?? new Set();
    const alreadyDependsOnSome = producerEntries.some(
      (p) => p.storySlug === consumer.storySlug || reachable.has(p.storySlug),
    );
    if (alreadyDependsOnSome) continue;
    const producer = producerEntries[0];
    findings.push({
      kind: 'implicit-cross-story-dep',
      severity,
      path: consumer.path,
      producer: {
        storySlug: producer.storySlug,
        taskSlug: producer.taskSlug,
      },
      consumer: {
        storySlug: consumer.storySlug,
        taskSlug: consumer.taskSlug,
        sourceField: consumer.sourceField,
      },
    });
  }
  return findings;
}

/**
 * Compute `missing-bdd-scaffold` findings (Story #3857).
 *
 * The features-first delivery model requires every `.feature` file a Story
 * verifies against to already exist when that Story runs. When a Story's
 * `verify[]` references a `.feature` path that another Story declares with
 * `assumption: "creates"`, the consumer is correct only if the producer
 * lands in an *earlier* wave — otherwise the consumer's `verify[]` runs
 * against a file that does not yet exist and verification fails mid-delivery.
 *
 * A finding fires for each consumer/producer pair where:
 *   - the path ends in `.feature`,
 *   - a *different* Story declares that path as `assumption: "creates"`, and
 *   - the consumer Story does not transitively `depends_on` the producer
 *     (i.e. they share a wave, or the producer runs later).
 *
 * The finding is advisory (`'soft'`) — it is a nudge to add a `depends_on`
 * link to the wave-0 scaffold Story (or to the producing Story), not a hard
 * block. The remediation is the same shape as `implicit-cross-story-dep`:
 * order the consumer after the producer so the scaffold lands first.
 *
 * @param {object[]} stories
 * @param {Map<string, Set<string>>} reach  Transitive predecessor sets.
 * @param {'soft'|'hard'} severity
 * @returns {object[]} `missing-bdd-scaffold` findings.
 */
function computeMissingBddScaffoldFindings(stories, reach, severity) {
  // Index every `.feature` path declared `creates` to its producing Story.
  // A path may be created by more than one Story (unusual); pin the first in
  // declaration order, mirroring the implicit-dep finding's single-producer
  // shape.
  const featureCreators = new Map(); // path -> storySlug (first creator)
  for (const story of stories) {
    const body = story?.body;
    if (!body || typeof body !== 'object') continue;
    const changes = Array.isArray(body.changes) ? body.changes : [];
    for (const change of changes) {
      if (
        change === null ||
        typeof change !== 'object' ||
        change.assumption !== 'creates' ||
        typeof change.path !== 'string' ||
        !change.path.endsWith('.feature')
      )
        continue;
      if (!featureCreators.has(change.path)) {
        featureCreators.set(change.path, storySlugOf(story));
      }
    }
  }
  if (featureCreators.size === 0) return [];

  const creatorPaths = Array.from(featureCreators.keys()).sort(
    (a, b) => b.length - a.length,
  );
  const findings = [];
  const seen = new Set(); // dedupe `${consumerSlug}::${path}` pairs
  for (const story of stories) {
    const body = story?.body;
    if (!body || typeof body !== 'object') continue;
    const verifyItems = Array.isArray(body.verify) ? body.verify : [];
    if (verifyItems.length === 0) continue;
    const joined = verifyItems.map((it) => String(it ?? '')).join('\n');
    const consumerSlug = storySlugOf(story);
    for (const path of creatorPaths) {
      if (!joined.includes(path)) continue;
      const producerSlug = featureCreators.get(path);
      // A Story that creates the file it verifies is fine — no cross-Story gap.
      if (producerSlug === consumerSlug) continue;
      // Producer already runs in an earlier wave → consumer is correctly
      // ordered, scaffold lands first, no finding.
      const reachable = reach.get(consumerSlug) ?? new Set();
      if (reachable.has(producerSlug)) continue;
      const key = `${consumerSlug}::${path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        kind: 'missing-bdd-scaffold',
        severity,
        path,
        producer: { storySlug: producerSlug },
        consumer: { storySlug: consumerSlug, sourceField: 'verify' },
      });
    }
  }
  return findings;
}

/**
 * Public entry point. Walks the normalized ticket spec once and returns
 * the structured cross-Story findings array. Every finding is `'soft'`
 * (Story #5312) — an advisory line for the plan summary, never an
 * `errors[]` entry.
 *
 * @param {object}    input
 * @param {object[]}  input.stories
 * @returns {ConflictFinding[]}
 */
export function computeConflictFindings({ stories } = {}) {
  // Story #4271: normalize every Story's body to its structured object form
  // once, up front, so the canonical serialized **string** shape the
  // decomposer emits is scanned at parity with the pre-serialize object
  // shape across every conflict pass.
  const storyList = (stories ?? []).map(normalizeStoryBody);
  const producers = indexProducers(storyList);
  const consumers = indexConsumers(storyList, producers);
  const reach = computeStoryReachability(storyList);
  return [
    ...computeSharedEditorFindings(producers, reach, SOFT),
    ...computeImplicitDepFindings(consumers, producers, reach, SOFT),
    ...computeMissingBddScaffoldFindings(storyList, reach, SOFT),
  ];
}

/**
 * Re-run the cross-Story conflict passes over the **assembled** Story bodies —
 * the artifact persist actually writes (Story #5045).
 *
 * `validateTickets` runs before `assemblePlanStories`, over the raw
 * `stories.json` payload, so plan-time conflict analysis never saw what got
 * persisted. That is not a cosmetic ordering nit: the canonical authoring shape
 * carries `acceptance[]` / `verify[]` at the ticket's **top level**, and it is
 * assembly's `syncContractFieldFromTopLevel` that folds them into the body.
 * `indexConsumers` scans `body.acceptance` / `body.verify` for producer paths —
 * so on the real payload it scanned two empty arrays, and every
 * `implicit-cross-story-dep` and `missing-bdd-scaffold` finding was silently
 * unreachable. Running the passes again over the serialized bodies restores
 * them.
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
 * Stable identity for one conflict finding, so the post-assembly pass can be
 * diffed against the raw pass and only the genuinely-new findings reported
 * (Story #5045). Without it the two passes announce the same shared-editor
 * collision twice per run, which is how a warning channel gets discounted.
 *
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

/**
 * The finding kinds that are genuinely **cross-Story conflicts** — the SSOT
 * for that question (Story #4907).
 *
 * The persist soft-finding surface announces a conflict as a conflict and
 * every other soft kind as the advisory it is, and the summary comment
 * renders only the shared-editor class beside the wave table. A second copy
 * of this list is how readers drift apart, so it is defined exactly once and
 * imported.
 */
export const CONFLICT_KINDS = Object.freeze(
  new Set([
    'shared-editor',
    'implicit-cross-story-dep',
    'missing-bdd-scaffold',
  ]),
);

/**
 * Render a conflict finding as a human-readable line. Every finding is soft
 * since Story #5312, so this feeds the dry-run warning list and the plan
 * summary rather than an `errors[]` channel; the name survives because every
 * caller imports it.
 */
export function renderHardConflictError(finding) {
  if (finding.kind === 'shared-editor') {
    const stories = finding.storySlugs.map((s) => `"${s}"`).join(', ');
    return `Shared-editor conflict: "${finding.path}" is written by ${finding.storySlugs.length} concurrent Stories (${stories}). Add depends_on chains between them or split the edits into a dedicated late-wave wiring Story.`;
  }
  if (finding.kind === 'implicit-cross-story-dep') {
    return `Implicit cross-Story dependency: Story "${finding.consumer.storySlug}" references "${finding.path}" (produced by Story "${finding.producer.storySlug}") via body.${finding.consumer.sourceField}, but Story "${finding.consumer.storySlug}" has no depends_on link to Story "${finding.producer.storySlug}". Add depends_on: ["${finding.producer.storySlug}"] to the consumer Story or remove the reference.`;
  }
  if (finding.kind === 'missing-bdd-scaffold') {
    return `Missing BDD scaffold: Story "${finding.consumer.storySlug}" verifies against "${finding.path}" (created by Story "${finding.producer.storySlug}") via body.${finding.consumer.sourceField}, but "${finding.consumer.storySlug}" has no depends_on path to "${finding.producer.storySlug}" — the .feature file is scaffolded in the same wave (or later), so verification runs before the file exists. Add depends_on: ["${finding.producer.storySlug}"] to the consumer Story so the scaffold lands in an earlier wave.`;
  }
  // Findings from other passes carry their own message — render it rather
  // than a shape-blind generic line, so the soft surface
  // (`surfaceSoftConflictFindings`) stays legible for every kind.
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
  indexConsumers,
  computeStoryReachability,
  inSameWave,
  computeSharedEditorFindings,
  computeImplicitDepFindings,
  computeMissingBddScaffoldFindings,
};

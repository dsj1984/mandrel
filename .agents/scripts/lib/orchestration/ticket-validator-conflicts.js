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
 * the conflict passes (`indexConsumers`, `indexAssumptionEntries`,
 * `computeMissingBddScaffoldFindings`, and the producer path scan in
 * `collectStoryProducerPaths`) historically read `story.body` only when it
 * was already an object — so on the production string shape the
 * `implicit-cross-story-dep`, `fan-out`, registry, and `missing-bdd-scaffold`
 * findings emitted nothing. Parsing the body once at the entry point and
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

const DEFAULT_POLICY = Object.freeze({
  failOnSharedEditors: false,
  requireExplicitCrossStoryDeps: false,
  failOnRegistryConflicts: false,
  failOnMissingBddScaffold: false,
  largeFanOutThreshold: 10,
  registries: null, // null = use DEFAULT_REGISTRY_PATTERNS
  fanOutCounter: null, // null = no fan-out probe (skip)
});

/**
 * Default cross-cutting registry / barrel files. Story #2962 — these are
 * files whose primary purpose is to wire siblings together (registries,
 * handler maps, listener barrels). When two or more concurrent Stories
 * either edit the registry directly OR create sibling files that need
 * registration in it, the registry edits collide on every Story-to-Epic
 * close after the first.
 *
 * Patterns support two shapes:
 *   - exact path  — `lib/orchestration/lifecycle/listeners/index.js`
 *   - `**` suffix — `**\/listeners/index.js` (matches any depth)
 */
export const DEFAULT_REGISTRY_PATTERNS = Object.freeze([
  'lib/orchestration/lifecycle/listeners/index.js',
  '**/listeners/index.js',
  '**/handlers/index.js',
]);

function matchRegistryPattern(path, pattern) {
  if (pattern.startsWith('**/')) {
    const tail = pattern.slice(3);
    return path === tail || path.endsWith(`/${tail}`);
  }
  return path === pattern;
}

function isRegistryPath(path, patterns) {
  for (const p of patterns) if (matchRegistryPattern(path, p)) return true;
  return false;
}

function parentDirOf(path) {
  const idx = path.lastIndexOf('/');
  return idx <= 0 ? '' : path.slice(0, idx);
}

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
 * Index every object-form `body.changes` entry by `{ path, assumption }`
 * along with its parent Task/Story so the registry-and-fan-out passes can
 * reason about creates/deletes without re-walking the ticket array.
 */
function indexAssumptionEntries(stories) {
  const entries = [];
  for (const story of stories) {
    const body = story?.body;
    if (!body || typeof body !== 'object') continue;
    const changes = Array.isArray(body.changes) ? body.changes : [];
    for (const change of changes) {
      if (
        change === null ||
        typeof change !== 'object' ||
        typeof change.path !== 'string' ||
        change.path.length === 0
      )
        continue;
      entries.push({
        path: change.path,
        assumption: change.assumption ?? null,
        storySlug: storySlugOf(story),
        taskSlug: story.slug,
      });
    }
  }
  return entries;
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
 * Compute `cross-cutting-registries` findings (Story #2962).
 *
 * A registry/barrel file (e.g. `lib/orchestration/lifecycle/listeners/index.js`)
 * collides whenever two or more concurrent Stories either
 *
 *   (a) directly edit the registry file, OR
 *   (b) create a new sibling file in the same directory that the registry
 *       would have to wire up.
 *
 * For each known registry pattern (`patterns`), we collect every Story whose
 * Tasks satisfy (a) or (b). When ≥2 such Stories sit in the same wave (no
 * transitive `depends_on` between them), emit a single finding keyed by the
 * registry path.
 */
function computeRegistryFindings({
  stories,
  reach,
  patterns,
  producers,
  assumptionEntries,
  severity,
}) {
  const findings = [];
  // Build the matching registry path set from producer & creator paths.
  const registryHits = new Map(); // registryPath -> Map<storySlug, producers[]>
  function bump(registryPath, entry) {
    let perStory = registryHits.get(registryPath);
    if (!perStory) {
      perStory = new Map();
      registryHits.set(registryPath, perStory);
    }
    const existing = perStory.get(entry.storySlug) ?? [];
    existing.push(entry);
    perStory.set(entry.storySlug, existing);
  }
  // (a) direct registry edits — object-form `{ path, assumption }` entries
  // from `indexAssumptionEntries` (and the producer index built from them).
  for (const [path, entries] of producers.entries()) {
    if (!isRegistryPath(path, patterns)) continue;
    for (const e of entries) {
      bump(path, {
        storySlug: e.storySlug,
        taskSlug: e.taskSlug,
        path,
        reason: 'edits-registry',
      });
    }
  }
  for (const e of assumptionEntries) {
    if (!isRegistryPath(e.path, patterns)) continue;
    bump(e.path, {
      storySlug: e.storySlug,
      taskSlug: e.taskSlug,
      path: e.path,
      reason: 'edits-registry',
    });
  }
  // (b) sibling creates that would require registration in a registry.
  // A registry path's parent dir defines its "registration scope" — any
  // new file in that scope is a wiring candidate.
  const scopeByRegistry = new Map();
  for (const story of stories) {
    const body = story?.body;
    if (!body || typeof body !== 'object') continue;
    for (const change of body.changes ?? []) {
      if (
        change === null ||
        typeof change !== 'object' ||
        change.assumption !== 'creates' ||
        typeof change.path !== 'string'
      )
        continue;
      const childParent = parentDirOf(change.path);
      if (!childParent) continue;
      for (const reg of registryRegistry(
        producers,
        assumptionEntries,
        patterns,
        scopeByRegistry,
      )) {
        if (reg.parentDir !== childParent) continue;
        bump(reg.path, {
          storySlug: storySlugOf(story),
          taskSlug: story.slug,
          path: change.path,
          reason: 'creates-sibling',
        });
      }
    }
  }
  for (const [registryPath, perStory] of registryHits.entries()) {
    const stories = Array.from(perStory.keys());
    if (stories.length < 2) continue;
    const cluster = new Set();
    for (let i = 0; i < stories.length; i += 1) {
      for (let j = i + 1; j < stories.length; j += 1) {
        if (inSameWave(reach, stories[i], stories[j])) {
          cluster.add(stories[i]);
          cluster.add(stories[j]);
        }
      }
    }
    if (cluster.size === 0) continue;
    const clusterSlugs = Array.from(cluster).sort();
    const producerList = [];
    for (const slug of clusterSlugs) {
      for (const p of perStory.get(slug) ?? []) producerList.push(p);
    }
    findings.push({
      kind: 'cross-cutting-registries',
      severity,
      registryPath,
      storySlugs: clusterSlugs,
      producers: producerList,
    });
  }
  return findings;
}

/**
 * Resolve the set of registry paths that should be considered in scope for
 * the sibling-create check. We treat any path that already matches a
 * registry pattern (whether produced by a Task or not — the path exists in
 * the project) as in-scope. To stay path-knowledge-free at plan time, we
 * only consider patterns that are explicit paths (no `**`) or that match a
 * path produced by some Task in the spec.
 */
function registryRegistry(producers, assumptionEntries, patterns, cache) {
  if (cache.size > 0) return cache.values();
  // Explicit (no-glob) patterns: always in scope as their own path.
  for (const pat of patterns) {
    if (pat.startsWith('**/')) continue;
    cache.set(pat, { path: pat, parentDir: parentDirOf(pat) });
  }
  // Glob patterns: in scope iff some Task in the spec references a matching
  // path via changes (edits or creates). Avoids false positives when a
  // glob pattern doesn't apply to this repo at all.
  for (const path of producers.keys()) {
    if (cache.has(path)) continue;
    if (isRegistryPath(path, patterns)) {
      cache.set(path, { path, parentDir: parentDirOf(path) });
    }
  }
  for (const e of assumptionEntries) {
    if (cache.has(e.path)) continue;
    if (isRegistryPath(e.path, patterns)) {
      cache.set(e.path, { path: e.path, parentDir: parentDirOf(e.path) });
    }
  }
  return cache.values();
}

/**
 * Normalize a fan-out probe result into `{ count, files, probe }`.
 *
 * The production probe reports its referencing files and the exact command
 * that found them so an operator can reproduce the figure (Story #4547).
 * A bare number stays valid — injected test counters and any consumer
 * counter written against the Story #2962 contract keep working, they just
 * carry no audit trail.
 */
function normalizeFanOutProbe(result) {
  if (typeof result === 'number') {
    return { count: result, files: [], probe: null };
  }
  if (result === null || typeof result !== 'object') {
    return { count: 0, files: [], probe: null };
  }
  const files = Array.isArray(result.files) ? result.files : [];
  const count = Number.isFinite(result.count) ? result.count : files.length;
  return { count, files, probe: result.probe ?? null };
}

/**
 * Index the basenames this spec *creates*, so a deletion that is really one
 * half of a move can be told apart from a genuine wide-coupling removal.
 */
function indexCreatedBasenames(assumptionEntries) {
  const byBasename = new Map();
  for (const entry of assumptionEntries) {
    if (entry.assumption !== 'creates') continue;
    const base = entry.path.slice(entry.path.lastIndexOf('/') + 1);
    if (!byBasename.has(base)) byBasename.set(base, entry.path);
  }
  return byBasename;
}

/**
 * Compute `fan-out-warning` findings (Story #2962, reworked in #4547).
 *
 * For each `body.changes` entry whose `assumption` is `"deletes"`, probe the
 * files at the base branch that genuinely import or require the deleted
 * module. When that count exceeds the configured `largeFanOutThreshold`,
 * emit a finding carrying the referencing files and the probe that produced
 * them.
 *
 * The finding also records whether the deletion is **rename-shaped** — the
 * same spec creates a file with the deleted module's basename elsewhere —
 * because the remedy diverges: a move wants its importers repointed in one
 * Story, not a subsystem-by-subsystem migration split across several.
 *
 * The default severity is always `'soft'` — the persist gate enforces a
 * hard refusal via the `--allow-large-fan-out` operator flag, since the
 * planner cannot reduce call sites by re-prompting. Severity may still be
 * upgraded to `'hard'` via `failOnLargeFanOut` for callers that want the
 * standard `errors[]` path (e.g. CI dry-runs).
 */
function computeFanOutFindings({
  assumptionEntries,
  threshold,
  counter,
  severity,
}) {
  if (typeof counter !== 'function') return [];
  if (!Number.isFinite(threshold) || threshold < 0) return [];
  const findings = [];
  const cache = new Map();
  const createdBasenames = indexCreatedBasenames(assumptionEntries);
  for (const entry of assumptionEntries) {
    if (entry.assumption !== 'deletes') continue;
    let probed = cache.get(entry.path);
    if (probed === undefined) {
      probed = normalizeFanOutProbe(counter({ path: entry.path }));
      cache.set(entry.path, probed);
    }
    if (probed.count <= threshold) continue;
    const base = entry.path.slice(entry.path.lastIndexOf('/') + 1);
    const renameTarget = createdBasenames.get(base);
    findings.push({
      kind: 'fan-out-warning',
      severity,
      taskSlug: entry.taskSlug,
      storySlug: entry.storySlug,
      path: entry.path,
      callSiteCount: probed.count,
      callSites: probed.files,
      probe: probed.probe,
      renameShaped: renameTarget !== undefined && renameTarget !== entry.path,
      renameTarget: renameTarget === entry.path ? null : (renameTarget ?? null),
      threshold,
    });
  }
  return findings;
}

/**
 * Public entry point. Walks the normalized ticket spec once and returns
 * the structured cross-Story findings array. The caller's `policy` flags
 * decide whether each finding class lands as `'soft'` (advisory, won't
 * trigger re-decompose) or `'hard'` (rendered into `errors[]`).
 *
 * @param {object}    input
 * @param {object[]}  input.stories
 * @param {object}    [input.policy]
 * @param {boolean}   [input.policy.failOnSharedEditors=false]
 * @param {boolean}   [input.policy.requireExplicitCrossStoryDeps=false]
 * @param {boolean}   [input.policy.failOnRegistryConflicts=false]
 * @param {boolean}   [input.policy.failOnMissingBddScaffold=false]
 * @param {boolean}   [input.policy.failOnLargeFanOut=false]
 * @param {number}    [input.policy.largeFanOutThreshold=10]
 * @param {string[]}  [input.policy.registries]  Registry patterns (defaults to DEFAULT_REGISTRY_PATTERNS).
 * @param {(arg: { path: string }) => number} [input.policy.fanOutCounter] Optional probe; when omitted the fan-out pass is skipped.
 * @returns {ConflictFinding[]}
 */
export function computeConflictFindings({ stories, policy } = {}) {
  const merged = { ...DEFAULT_POLICY, ...(policy ?? {}) };
  // Story #4271: normalize every Story's body to its structured object form
  // once, up front, so the canonical serialized **string** shape the
  // decomposer emits is scanned at parity with the pre-serialize object
  // shape across every conflict pass.
  const storyList = (stories ?? []).map(normalizeStoryBody);
  const producers = indexProducers(storyList);
  const consumers = indexConsumers(storyList, producers);
  const reach = computeStoryReachability(storyList);
  const assumptionEntries = indexAssumptionEntries(storyList);
  const sharedSeverity = merged.failOnSharedEditors ? 'hard' : 'soft';
  const implicitSeverity = merged.requireExplicitCrossStoryDeps
    ? 'hard'
    : 'soft';
  const registrySeverity = merged.failOnRegistryConflicts ? 'hard' : 'soft';
  const fanOutSeverity = merged.failOnLargeFanOut ? 'hard' : 'soft';
  const bddScaffoldSeverity = merged.failOnMissingBddScaffold ? 'hard' : 'soft';
  const patterns =
    Array.isArray(merged.registries) && merged.registries.length > 0
      ? merged.registries
      : DEFAULT_REGISTRY_PATTERNS;
  return [
    ...computeSharedEditorFindings(producers, reach, sharedSeverity),
    ...computeImplicitDepFindings(
      consumers,
      producers,
      reach,
      implicitSeverity,
    ),
    ...computeRegistryFindings({
      stories: storyList,
      reach,
      patterns,
      producers,
      assumptionEntries,
      severity: registrySeverity,
    }),
    ...computeFanOutFindings({
      assumptionEntries,
      threshold: merged.largeFanOutThreshold,
      counter: merged.fanOutCounter,
      severity: fanOutSeverity,
    }),
    ...computeMissingBddScaffoldFindings(storyList, reach, bddScaffoldSeverity),
  ];
}

/**
 * Render the audit trail behind a fan-out finding's number, so an operator
 * can check the figure rather than trust it (Story #4547).
 *
 * Every importer is named — the list is deliberately **not** truncated. A
 * gate that fires at 100 importers is precisely when the operator needs the
 * list, and a `…and 109 more` tail would leave the figure uncheckable in
 * exactly the case the gate exists for. This message is a fail-closed stop,
 * not a log line; its length is the point.
 *
 * The probe is reported as what it is — the *candidate* net, which each hit
 * is then re-resolved against. It will report at least as many lines as the
 * gate counts files, so labelling it as the thing that produced the number
 * would send an operator chasing a discrepancy that is by design.
 *
 * Returns `''` for a bare-number counter, which carries no audit trail.
 */
export function renderFanOutEvidence(finding) {
  const files = Array.isArray(finding.callSites) ? finding.callSites : [];
  const parts = [];
  if (files.length > 0) {
    parts.push(`    Importers (${files.length}):`);
    for (const file of files) parts.push(`      ${file}`);
  }
  if (finding.probe) {
    parts.push(
      `    Candidate probe (each hit re-resolved against its importer's directory):`,
      `      ${finding.probe}`,
    );
  }
  return parts.length > 0 ? `\n${parts.join('\n')}` : '';
}

/**
 * Render the remedy that actually fits the finding. A rename-shaped
 * deletion has nowhere to split to — the importers just need repointing at
 * the path the same plan creates — so telling the operator to split it
 * across Stories leaves the override as the only exit, which is exactly the
 * habit that defeats the gate (Story #4547).
 */
export function renderFanOutRemedy(finding) {
  if (finding.renameShaped && finding.renameTarget) {
    return (
      `This deletion is rename-shaped: the same plan creates "${finding.renameTarget}" under the same basename. ` +
      `Repoint the importer(s) at the new path inside this Story — a move has no subsystems to split across — ` +
      `then rerun --allow-large-fan-out.`
    );
  }
  return (
    `Split the deletion into a subsystem-by-subsystem migration across multiple Stories, ` +
    `or rerun --allow-large-fan-out after confirming the deletion is intentional.`
  );
}

/**
 * Render a `'hard'`-severity conflict finding as a human-readable error
 * message. Used by the validator when policy flags upgrade a finding to
 * the AC-visible `errors[]` channel.
 */
export function renderHardConflictError(finding) {
  if (finding.kind === 'shared-editor') {
    const stories = finding.storySlugs.map((s) => `"${s}"`).join(', ');
    return `Shared-editor conflict: "${finding.path}" is written by ${finding.storySlugs.length} concurrent Stories (${stories}). Add depends_on chains between them or split the edits into a dedicated late-wave wiring Story.`;
  }
  if (finding.kind === 'implicit-cross-story-dep') {
    return `Implicit cross-Story dependency: Story "${finding.consumer.storySlug}" references "${finding.path}" (produced by Story "${finding.producer.storySlug}") via body.${finding.consumer.sourceField}, but Story "${finding.consumer.storySlug}" has no depends_on link to Story "${finding.producer.storySlug}". Add depends_on: ["${finding.producer.storySlug}"] to the consumer Story or remove the reference.`;
  }
  if (finding.kind === 'cross-cutting-registries') {
    const stories = finding.storySlugs.map((s) => `"${s}"`).join(', ');
    return `Cross-cutting registry conflict: ${finding.storySlugs.length} concurrent Stories (${stories}) edit or register into "${finding.registryPath}". Add depends_on chains between them so the registry updates serialize, or split the registration into a dedicated late-wave wiring Story.`;
  }
  if (finding.kind === 'fan-out-warning') {
    return (
      `Large fan-out: Story "${finding.storySlug}" deletes "${finding.path}" ` +
      `with ${finding.callSiteCount} importer(s) on the base branch (threshold ${finding.threshold}). ` +
      `${renderFanOutRemedy(finding)}${renderFanOutEvidence(finding)}`
    );
  }
  if (finding.kind === 'missing-bdd-scaffold') {
    return `Missing BDD scaffold: Story "${finding.consumer.storySlug}" verifies against "${finding.path}" (created by Story "${finding.producer.storySlug}") via body.${finding.consumer.sourceField}, but "${finding.consumer.storySlug}" has no depends_on path to "${finding.producer.storySlug}" — the .feature file is scaffolded in the same wave (or later), so verification runs before the file exists. Add depends_on: ["${finding.producer.storySlug}"] to the consumer Story so the scaffold lands in an earlier wave.`;
  }
  // Findings from other passes (sizing, spec-word-budget) carry their own
  // message — render it rather than a shape-blind generic line, so the soft
  // surface (`surfaceSoftConflictFindings`) stays legible for every kind.
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
  indexAssumptionEntries,
  computeRegistryFindings,
  computeFanOutFindings,
  matchRegistryPattern,
  isRegistryPath,
  parentDirOf,
  DEFAULT_POLICY,
  DEFAULT_REGISTRY_PATTERNS,
};

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
const DEFAULT_REGISTRY_PATTERNS = Object.freeze([
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
 * Extract the path-shaped head from a single `body.changes` bullet.
 *
 * Conventional shape is `"<path>: <verb> <object>"`; we slice on the first
 * colon and return the head when it contains a slash or a dot, otherwise
 * `null`. Mirrors the heuristic in `ticket-validator-sizing.js` so producer
 * extraction and `fileCount` accounting agree on what counts as a path.
 */
function extractChangeBulletPath(bullet) {
  if (typeof bullet !== 'string') return null;
  const colonIdx = bullet.indexOf(':');
  if (colonIdx <= 0) return null;
  const head = bullet.slice(0, colonIdx).trim();
  if (!/[\\/.]/.test(head)) return null;
  return head;
}

function storySlugOf(task) {
  return task.parent_slug;
}

/**
 * Build the producers index — `Map<path, Array<{storySlug, taskSlug}>>` —
 * by walking every Task's `body.changes` array. Paths are extracted from
 * the colon-split head; bullets without a path-shaped head are skipped.
 */
function indexProducers(tasks) {
  const producers = new Map();
  for (const task of tasks) {
    const body = task.body;
    if (!body || typeof body !== 'object') continue;
    const changes = Array.isArray(body.changes) ? body.changes : [];
    const seenInTask = new Set();
    for (const bullet of changes) {
      const path = extractChangeBulletPath(bullet);
      if (!path) continue;
      if (seenInTask.has(path)) continue;
      seenInTask.add(path);
      const entry = { storySlug: storySlugOf(task), taskSlug: task.slug };
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
 * A Task is not its own consumer — entries whose producer is the same Task
 * are skipped to keep the surface focused on cross-Task signal.
 */
function indexConsumers(tasks, producers) {
  const consumers = [];
  if (producers.size === 0) return consumers;
  const producerPaths = Array.from(producers.keys()).sort(
    (a, b) => b.length - a.length,
  );
  for (const task of tasks) {
    const body = task.body;
    if (!body || typeof body !== 'object') continue;
    for (const sourceField of ['acceptance', 'verify']) {
      const items = Array.isArray(body[sourceField]) ? body[sourceField] : [];
      if (items.length === 0) continue;
      const joined = items.map((it) => String(it ?? '')).join('\n');
      for (const path of producerPaths) {
        if (!joined.includes(path)) continue;
        const producerEntries = producers.get(path) ?? [];
        if (producerEntries.some((p) => p.taskSlug === task.slug)) continue;
        consumers.push({
          path,
          storySlug: storySlugOf(task),
          taskSlug: task.slug,
          sourceField,
        });
      }
    }
  }
  return consumers;
}

/**
 * Compute transitive predecessor sets over the story-level `depends_on`
 * graph. The returned map is `Map<storySlug, Set<storySlug>>`, where the
 * set contains every story reachable by following `depends_on` edges from
 * the key (i.e. every story the key transitively depends on).
 *
 * BFS, no cycles assumed — callers must run `assertAcyclic` first.
 */
function computeStoryReachability(stories) {
  const reach = new Map();
  for (const story of stories) reach.set(story.slug, new Set());
  for (const story of stories) {
    const visited = reach.get(story.slug);
    const stack = [...(story.depends_on ?? [])];
    while (stack.length > 0) {
      const next = stack.pop();
      if (!reach.has(next)) continue;
      if (visited.has(next)) continue;
      visited.add(next);
      const nextStory = stories.find((s) => s.slug === next);
      if (nextStory && Array.isArray(nextStory.depends_on)) {
        for (const dep of nextStory.depends_on) stack.push(dep);
      }
    }
  }
  return reach;
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
function indexAssumptionEntries(tasks) {
  const entries = [];
  for (const task of tasks) {
    const body = task?.body;
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
        storySlug: storySlugOf(task),
        taskSlug: task.slug,
      });
    }
  }
  return entries;
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
  tasks,
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
  // (a) direct registry edits — accept both legacy string-form producers
  // (from `indexProducers`) and modern object-form `{ path, assumption }`
  // entries (from `indexAssumptionEntries`).
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
  for (const task of tasks) {
    const body = task?.body;
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
          storySlug: storySlugOf(task),
          taskSlug: task.slug,
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
 * Compute `fan-out-warning` findings (Story #2962).
 *
 * For each `body.changes` entry whose `assumption` is `"deletes"` (or
 * `"refactors-existing"` when the planner declared a symbol replacement),
 * count the number of distinct files in the base branch that reference
 * the deleted module via its basename. When the count exceeds the
 * configured `largeFanOutThreshold`, emit a finding.
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
  for (const entry of assumptionEntries) {
    if (entry.assumption !== 'deletes') continue;
    let count = cache.get(entry.path);
    if (count === undefined) {
      count = counter({ path: entry.path }) ?? 0;
      cache.set(entry.path, count);
    }
    if (count <= threshold) continue;
    findings.push({
      kind: 'fan-out-warning',
      severity,
      taskSlug: entry.taskSlug,
      storySlug: entry.storySlug,
      path: entry.path,
      callSiteCount: count,
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
 * @param {object[]}  input.tasks
 * @param {object[]}  input.stories
 * @param {object}    [input.policy]
 * @param {boolean}   [input.policy.failOnSharedEditors=false]
 * @param {boolean}   [input.policy.requireExplicitCrossStoryDeps=false]
 * @param {boolean}   [input.policy.failOnRegistryConflicts=false]
 * @param {boolean}   [input.policy.failOnLargeFanOut=false]
 * @param {number}    [input.policy.largeFanOutThreshold=10]
 * @param {string[]}  [input.policy.registries]  Registry patterns (defaults to DEFAULT_REGISTRY_PATTERNS).
 * @param {(arg: { path: string }) => number} [input.policy.fanOutCounter] Optional probe; when omitted the fan-out pass is skipped.
 * @returns {ConflictFinding[]}
 */
export function computeConflictFindings({ tasks, stories, policy } = {}) {
  const merged = { ...DEFAULT_POLICY, ...(policy ?? {}) };
  const taskList = tasks ?? [];
  const producers = indexProducers(taskList);
  const consumers = indexConsumers(taskList, producers);
  const reach = computeStoryReachability(stories ?? []);
  const assumptionEntries = indexAssumptionEntries(taskList);
  const sharedSeverity = merged.failOnSharedEditors ? 'hard' : 'soft';
  const implicitSeverity = merged.requireExplicitCrossStoryDeps
    ? 'hard'
    : 'soft';
  const registrySeverity = merged.failOnRegistryConflicts ? 'hard' : 'soft';
  const fanOutSeverity = merged.failOnLargeFanOut ? 'hard' : 'soft';
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
      tasks: taskList,
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
  ];
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
    return `Implicit cross-Story dependency: Task "${finding.consumer.taskSlug}" in Story "${finding.consumer.storySlug}" references "${finding.path}" (produced by Task "${finding.producer.taskSlug}" in Story "${finding.producer.storySlug}") via body.${finding.consumer.sourceField}, but Story "${finding.consumer.storySlug}" has no depends_on link to Story "${finding.producer.storySlug}". Add depends_on: ["${finding.producer.storySlug}"] to the consumer Story or remove the reference.`;
  }
  if (finding.kind === 'cross-cutting-registries') {
    const stories = finding.storySlugs.map((s) => `"${s}"`).join(', ');
    return `Cross-cutting registry conflict: ${finding.storySlugs.length} concurrent Stories (${stories}) edit or register into "${finding.registryPath}". Add depends_on chains between them so the registry updates serialize, or split the registration into a dedicated late-wave wiring Story.`;
  }
  if (finding.kind === 'fan-out-warning') {
    return `Large fan-out: Task "${finding.taskSlug}" in Story "${finding.storySlug}" deletes "${finding.path}" with ${finding.callSiteCount} call site(s) on the base branch (threshold ${finding.threshold}). Split into a subsystem-by-subsystem migration across multiple Stories, or rerun --allow-large-fan-out after confirming the deletion is intentional.`;
  }
  return `Conflict finding ${finding.kind} on path "${finding.path ?? '<unknown>'}".`;
}

// Internal helpers exposed for unit tests; not part of the public surface.
export const _internal = {
  extractChangeBulletPath,
  indexProducers,
  indexConsumers,
  computeStoryReachability,
  inSameWave,
  computeSharedEditorFindings,
  computeImplicitDepFindings,
  indexAssumptionEntries,
  computeRegistryFindings,
  computeFanOutFindings,
  matchRegistryPattern,
  isRegistryPath,
  parentDirOf,
  DEFAULT_POLICY,
  DEFAULT_REGISTRY_PATTERNS,
};

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
});

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
 * @returns {ConflictFinding[]}
 */
export function computeConflictFindings({ tasks, stories, policy } = {}) {
  const merged = { ...DEFAULT_POLICY, ...(policy ?? {}) };
  const producers = indexProducers(tasks ?? []);
  const consumers = indexConsumers(tasks ?? [], producers);
  const reach = computeStoryReachability(stories ?? []);
  const sharedSeverity = merged.failOnSharedEditors ? 'hard' : 'soft';
  const implicitSeverity = merged.requireExplicitCrossStoryDeps
    ? 'hard'
    : 'soft';
  return [
    ...computeSharedEditorFindings(producers, reach, sharedSeverity),
    ...computeImplicitDepFindings(
      consumers,
      producers,
      reach,
      implicitSeverity,
    ),
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
  return `Conflict finding ${finding.kind} on path "${finding.path}".`;
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
  DEFAULT_POLICY,
};

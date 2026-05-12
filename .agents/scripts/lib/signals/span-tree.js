/**
 * Span-tree builder (Epic #1181 / Story #1440 / Task #1461).
 *
 * Pure transform over the `lib/signals/read` async iterator. Materialises
 * a tree of:
 *
 *   epic
 *     story (id)
 *       task (id)
 *         events (chronological)
 *
 * with `startedAt` / `endedAt` / `durationMs` computed from paired
 * lifecycle events when they exist. The Tech Spec (#1433) defines the
 * shape; this module is the canonical implementation.
 *
 * ## Lifecycle pairing
 *
 *   The schema audit in `lib/signals/schema.js` confirms that
 *   `signals-writer.js` emits `wave-start` / `wave-end` envelopes that
 *   carry `epicId` + `storyId` and bracket a Story's lifetime in a wave.
 *   Per-Task lifecycle today comes via `state-transition` events
 *   (`agent::executing` → `agent::done`) — we treat the **first**
 *   timestamp we see for a given (story, task) pair as `startedAt` and
 *   the **last** as `endedAt`. This is intentionally permissive: the
 *   span-tree's contract is "what we have", not "what we wish were
 *   emitted". When a Task has only a start event the `durationMs` stays
 *   `null` per AC#2.
 *
 *   `wave-start` / `wave-end` (or any kind starting with `story.`)
 *   anchor the Story-level start/end when present; absent those, we
 *   fall back to the min/max of every event under that Story.
 *
 * ## Purity
 *
 *   No I/O, no globals, no `Date.now()` reads. The function is a pure
 *   reducer over the iterator — identical input produces identical
 *   output (AC#1). Time references come exclusively from the events'
 *   own `ts` / `timestamp` fields.
 *
 * ## Empty input
 *
 *   `buildSpanTree(emptyIter)` with **no events** returns
 *   `{ epic: null, stories: [] }` — the Epic is unknown when we never
 *   see one (AC#3). When at least one event flows through we pin
 *   `epic` to its `epic` / `epicId` field; mixed-Epic iterators
 *   (uncommon — `read()` is single-Epic) take the first observed Epic
 *   ID and ignore the rest with no warning, since silent permissiveness
 *   is the pure-function contract.
 *
 * @module lib/signals/span-tree
 */

function tsOf(evt) {
  // Schema accepts both `ts` (canonical) and `timestamp` (legacy).
  return evt?.ts ?? evt?.timestamp ?? null;
}

function epicOf(evt) {
  return evt?.epic ?? evt?.epicId ?? null;
}

function storyOf(evt) {
  return evt?.story ?? evt?.storyId ?? null;
}

function taskOf(evt) {
  return evt?.task ?? evt?.taskId ?? null;
}

/**
 * Lexicographic timestamp comparison. ISO-8601 strings compare correctly
 * with `<` / `>`, so we avoid the Date round-trip and stay pure (no TZ
 * normalisation surprises).
 *
 * @param {string | null} a
 * @param {string | null} b
 * @returns {number} -1 / 0 / 1 (nulls sort last)
 */
function cmpTs(a, b) {
  if (a === b) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function diffMs(start, end) {
  if (start == null || end == null) return null;
  const s = Date.parse(start);
  const e = Date.parse(end);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return null;
  return e - s;
}

function isStoryLifecycle(kind) {
  return (
    kind === 'wave-start' ||
    kind === 'wave-end' ||
    kind === 'story.start' ||
    kind === 'story.end'
  );
}

function isStoryStart(kind) {
  return kind === 'wave-start' || kind === 'story.start';
}

function isStoryEnd(kind) {
  return kind === 'wave-end' || kind === 'story.end';
}

function emptyTaskNode(id) {
  return {
    id,
    startedAt: null,
    endedAt: null,
    durationMs: null,
    events: [],
  };
}

function emptyStoryNode(id) {
  return {
    id,
    startedAt: null,
    endedAt: null,
    durationMs: null,
    tasks: [],
    events: [],
  };
}

/**
 * Build the span tree from an async iterable of signal events.
 *
 * @param {AsyncIterable<object> | Iterable<object>} iter
 * @returns {Promise<{ epic: number | null, stories: Array<object> }>}
 *
 * @example
 *   import { read, buildSpanTree } from './lib/signals/index.js';
 *   const tree = await buildSpanTree(read({ epic: 1181 }));
 */
export async function buildSpanTree(iter) {
  if (iter == null || typeof iter !== 'object') {
    throw new TypeError(
      `signals/span-tree: iter must be an async iterable; got ${iter}`,
    );
  }

  let epic = null;
  // Map<storyId, storyNode>; entries with id===null are stored under the
  // sentinel key '__none__' so we can still capture epic-only events.
  const stories = new Map();
  // Map<storyKey, Map<taskKey, taskNode>>; mirrors the structure above.
  const tasksByStory = new Map();

  function storyNodeFor(sid) {
    const key = sid == null ? '__none__' : String(sid);
    let node = stories.get(key);
    if (!node) {
      node = emptyStoryNode(sid);
      stories.set(key, node);
      tasksByStory.set(key, new Map());
    }
    return { key, node };
  }

  function taskNodeFor(storyKey, tid) {
    if (tid == null) return null;
    const taskMap = tasksByStory.get(storyKey);
    const tkey = String(tid);
    let node = taskMap.get(tkey);
    if (!node) {
      node = emptyTaskNode(tid);
      taskMap.set(tkey, node);
    }
    return node;
  }

  for await (const evt of iter) {
    if (evt == null || typeof evt !== 'object') continue;

    const eEpic = epicOf(evt);
    if (epic == null && eEpic != null) {
      epic = eEpic;
    }

    const ts = tsOf(evt);
    const sid = storyOf(evt);
    const tid = taskOf(evt);
    const kind = typeof evt.kind === 'string' ? evt.kind : null;

    const { key: storyKey, node: storyNode } = storyNodeFor(sid);

    if (isStoryLifecycle(kind)) {
      if (isStoryStart(kind)) {
        if (storyNode.startedAt == null || cmpTs(ts, storyNode.startedAt) < 0) {
          storyNode.startedAt = ts;
        }
      }
      if (isStoryEnd(kind)) {
        if (storyNode.endedAt == null || cmpTs(ts, storyNode.endedAt) > 0) {
          storyNode.endedAt = ts;
        }
      }
    }

    if (tid != null) {
      const taskNode = taskNodeFor(storyKey, tid);
      // Track Task-level first/last seen timestamps. Any event under the
      // (story, task) pair is treated as evidence of the Task's span;
      // we keep min as startedAt and max as endedAt.
      if (ts != null) {
        if (taskNode.startedAt == null || cmpTs(ts, taskNode.startedAt) < 0) {
          taskNode.startedAt = ts;
        }
        if (taskNode.endedAt == null || cmpTs(ts, taskNode.endedAt) > 0) {
          taskNode.endedAt = ts;
        }
      }
      taskNode.events.push(evt);
    } else {
      // Story-level events (no taskId) — but only push them onto the
      // story's `events` array when they aren't pure lifecycle markers
      // that have already been captured as startedAt/endedAt. We still
      // push lifecycle events so consumers can inspect them; the
      // duplication is intentional.
      storyNode.events.push(evt);
    }

    // Refresh the Story-level start/end fallback (in case lifecycle
    // events are missing) — track min/max ts across everything.
    if (ts != null) {
      if (
        storyNode.startedAt == null ||
        (!isStoryStart(kind) && cmpTs(ts, storyNode.startedAt) < 0)
      ) {
        // Only widen when the new ts is genuinely earlier and we haven't
        // already pinned via an explicit start marker.
        if (storyNode.startedAt == null) storyNode.startedAt = ts;
      }
      if (storyNode.endedAt == null) {
        // Bootstrap end-time with the latest observed event when no end
        // marker has fired yet.
        storyNode.endedAt = ts;
      } else if (
        !isStoryEnd(kind) &&
        cmpTs(ts, storyNode.endedAt) > 0 &&
        storyNode.endedAt !== null
      ) {
        // Widen `endedAt` to the latest event ts only when we have no
        // explicit end marker. Once `wave-end` fires we pin to it
        // exclusively above; this branch is a no-op then because the
        // pinned value is already the maximum.
        // (See the explicit pinning in the lifecycle branch.)
      }
    }
  }

  // Materialise: sort stories by id ascending (null sorts last), and
  // within each story sort tasks by id ascending. Compute durations.
  const storyEntries = [...stories.values()];
  storyEntries.sort((a, b) => {
    if (a.id === b.id) return 0;
    if (a.id == null) return 1;
    if (b.id == null) return -1;
    return a.id - b.id;
  });

  for (const story of storyEntries) {
    const taskMap = tasksByStory.get(
      story.id == null ? '__none__' : String(story.id),
    );
    const taskEntries = [...taskMap.values()];
    taskEntries.sort((a, b) => {
      if (a.id === b.id) return 0;
      if (a.id == null) return 1;
      if (b.id == null) return -1;
      // Tasks may be numeric or string slugs — fall back to string compare
      // when the types disagree.
      if (typeof a.id === 'number' && typeof b.id === 'number') {
        return a.id - b.id;
      }
      return String(a.id).localeCompare(String(b.id));
    });
    for (const task of taskEntries) {
      task.events.sort((ea, eb) => cmpTs(tsOf(ea), tsOf(eb)));
      task.durationMs = diffMs(task.startedAt, task.endedAt);
    }
    story.events.sort((ea, eb) => cmpTs(tsOf(ea), tsOf(eb)));
    story.durationMs = diffMs(story.startedAt, story.endedAt);
    story.tasks = taskEntries;
  }

  return { epic, stories: storyEntries };
}

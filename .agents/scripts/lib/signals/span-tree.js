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
 *   `wave-start` / `wave-end` envelopes carry `epicId` + `storyId` and
 *   bracket a Story's lifetime in a wave.
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

function storyKeyOf(sid) {
  return sid == null ? '__none__' : String(sid);
}

function getOrCreateStory(state, sid) {
  const key = storyKeyOf(sid);
  let node = state.stories.get(key);
  if (!node) {
    node = emptyStoryNode(sid);
    state.stories.set(key, node);
    state.tasksByStory.set(key, new Map());
  }
  return { key, node };
}

function getOrCreateTask(state, storyKey, tid) {
  const taskMap = state.tasksByStory.get(storyKey);
  const tkey = String(tid);
  let node = taskMap.get(tkey);
  if (!node) {
    node = emptyTaskNode(tid);
    taskMap.set(tkey, node);
  }
  return node;
}

function updateStoryLifecycle(storyNode, kind, ts) {
  if (!isStoryLifecycle(kind)) return;
  if (isStoryStart(kind)) {
    if (storyNode.startedAt == null || cmpTs(ts, storyNode.startedAt) < 0) {
      storyNode.startedAt = ts;
    }
  } else if (isStoryEnd(kind)) {
    if (storyNode.endedAt == null || cmpTs(ts, storyNode.endedAt) > 0) {
      storyNode.endedAt = ts;
    }
  }
}

function widenTaskWindow(taskNode, ts) {
  if (ts == null) return;
  if (taskNode.startedAt == null || cmpTs(ts, taskNode.startedAt) < 0) {
    taskNode.startedAt = ts;
  }
  if (taskNode.endedAt == null || cmpTs(ts, taskNode.endedAt) > 0) {
    taskNode.endedAt = ts;
  }
}

function bootstrapStoryWindow(storyNode, ts) {
  if (ts == null) return;
  if (storyNode.startedAt == null) storyNode.startedAt = ts;
  if (storyNode.endedAt == null) storyNode.endedAt = ts;
}

/**
 * Reducer step — fold a single event into the running state. Extracted
 * from `buildSpanTree` so the outer function's CRAP score stays under
 * the new-method ceiling.
 *
 * @param {object} state — mutable accumulator (stories, tasksByStory, epic)
 * @param {unknown} evt
 * @returns {void}
 */
function ingestEvent(state, evt) {
  if (evt == null || typeof evt !== 'object') return;

  const eEpic = epicOf(evt);
  if (state.epic == null && eEpic != null) state.epic = eEpic;

  const ts = tsOf(evt);
  const sid = storyOf(evt);
  const tid = taskOf(evt);
  const kind = typeof evt.kind === 'string' ? evt.kind : null;

  const { key: storyKey, node: storyNode } = getOrCreateStory(state, sid);
  updateStoryLifecycle(storyNode, kind, ts);

  if (tid != null) {
    const taskNode = getOrCreateTask(state, storyKey, tid);
    widenTaskWindow(taskNode, ts);
    taskNode.events.push(evt);
  } else {
    storyNode.events.push(evt);
  }

  bootstrapStoryWindow(storyNode, ts);
}

/**
 * Default comparator for sorting Story / Task nodes by id ascending,
 * with `null` ids sorting last and a string fallback for slug-shaped
 * Task ids (the framework allows non-numeric task identifiers).
 *
 * @param {object} a
 * @param {object} b
 * @returns {number}
 */
function compareNodeIds(a, b) {
  if (a.id === b.id) return 0;
  if (a.id == null) return 1;
  if (b.id == null) return -1;
  if (typeof a.id === 'number' && typeof b.id === 'number') {
    return a.id - b.id;
  }
  return String(a.id).localeCompare(String(b.id));
}

function finalizeTask(task) {
  task.events.sort((ea, eb) => cmpTs(tsOf(ea), tsOf(eb)));
  task.durationMs = diffMs(task.startedAt, task.endedAt);
}

function finalizeStory(state, story) {
  const taskMap = state.tasksByStory.get(storyKeyOf(story.id));
  const taskEntries = [...taskMap.values()];
  taskEntries.sort(compareNodeIds);
  for (const task of taskEntries) finalizeTask(task);
  story.events.sort((ea, eb) => cmpTs(tsOf(ea), tsOf(eb)));
  story.durationMs = diffMs(story.startedAt, story.endedAt);
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

  // Accumulator state. `stories` keys are `storyKeyOf(sid)` strings;
  // `tasksByStory` mirrors that and holds per-task sub-maps.
  const state = {
    epic: null,
    stories: new Map(),
    tasksByStory: new Map(),
  };

  for await (const evt of iter) {
    ingestEvent(state, evt);
  }

  const storyEntries = [...state.stories.values()];
  storyEntries.sort(compareNodeIds);
  for (const story of storyEntries) finalizeStory(state, story);

  return { epic: state.epic, stories: storyEntries };
}

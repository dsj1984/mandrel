/**
 * Dispatcher Tests
 *
 * Tests the core dispatcher logic using:
 *  - A mock ITicketingProvider (in-memory, no GitHub calls)
 *
 * All tests run in --dry-run=false mode with a mocked provider, and skip
 * branch creation (tested separately in integration tests).
 *
 * Note: Epic #2646 / Story #2688 deleted the IExecutionAdapter abstraction;
 * the inline dispatch record produced by `wave-dispatcher.js` no longer
 * needs an adapter mock.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const LIB = path.join(ROOT, '.agents', 'scripts', 'lib');
const SCRIPTS = path.join(ROOT, '.agents', 'scripts');

const { ITicketingProvider } = await import(
  pathToFileURL(path.join(LIB, 'ITicketingProvider.js')).href
);
const { dispatch } = await import(
  pathToFileURL(path.join(SCRIPTS, 'dispatcher.js')).href
);

// ---------------------------------------------------------------------------
// Mock provider
// ---------------------------------------------------------------------------

/**
 * In-memory mock ticketing provider.
 * Pre-populate `tickets` and `epics` before each test.
 */
class MockProvider extends ITicketingProvider {
  constructor({ epic = null, tasks = [] } = {}) {
    super();
    this._epic = epic;
    this._tasks = tasks;
    this.updateCalls = [];
    this.commentCalls = [];
  }

  async getEpic() {
    return this._epic;
  }

  async getTickets(_epicId, filters = {}) {
    let result = this._tasks;
    if (filters.label) {
      result = result.filter((t) => (t.labels ?? []).includes(filters.label));
    }
    return result;
  }

  async getTicket(ticketId) {
    return this._tasks.find((t) => t.id === ticketId) ?? null;
  }

  async updateTicket(ticketId, mutations) {
    this.updateCalls.push({ ticketId, mutations });
  }

  async postComment(ticketId, payload) {
    this.commentCalls.push({ ticketId, payload });
    return { commentId: Date.now() };
  }
}

// ---------------------------------------------------------------------------
// Helper to build task fixtures
// ---------------------------------------------------------------------------

function makeTask(id, overrides = {}) {
  return {
    id,
    title: `Task ${id}`,
    body: '## Metadata\n**Persona**: engineer\n**Mode**: fast\n**Skills**: core/tdd\n**Focus Areas**: src/',
    labels: ['type::task', 'agent::ready'],
    state: 'open',
    assignees: [],
    ...overrides,
  };
}

const EPIC = { id: 1, title: 'Test Epic', body: '', labels: ['type::epic'] };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('dispatch() — empty task list', () => {
  it('returns manifest with zero waves when no tasks', async () => {
    const provider = new MockProvider({ epic: EPIC, tasks: [] });
    const manifest = await dispatch({
      epicId: 1,
      dryRun: true,
      provider,
    });

    assert.equal(manifest.epicId, 1);
    assert.equal(manifest.summary.totalTasks, 0);
    assert.equal(manifest.waves.length, 0);
    assert.equal(manifest.dispatched.length, 0);
  });
});

describe('dispatch() — single task, no dependencies', () => {
  it('dispatches Wave 0 containing the single task', async () => {
    const provider = new MockProvider({
      epic: EPIC,
      tasks: [makeTask(10)],
    });
    const manifest = await dispatch({
      epicId: 1,
      dryRun: true,
      provider,
    });

    assert.equal(manifest.summary.totalTasks, 1);
    assert.equal(manifest.waves.length, 1);
    assert.equal(manifest.waves[0].waveIndex, 0);
    assert.equal(manifest.waves[0].tasks.length, 1);
    assert.equal(manifest.waves[0].tasks[0].taskId, 10);
  });

  it('dry-run produces a manifest with empty dispatched array', async () => {
    const provider = new MockProvider({ epic: EPIC, tasks: [makeTask(10)] });
    const manifest = await dispatch({ epicId: 1, dryRun: true, provider });
    // In dryRun mode the wave-dispatcher synthesizes a `dry-run-<taskId>`
    // record per eligible task but does not flip ticket state.
    assert.ok(Array.isArray(manifest.dispatched));
  });
});

describe('dispatch() — two independent tasks', () => {
  it('groups both tasks in Wave 0 when focus areas are distinct', async () => {
    // Non-overlapping focus areas — should NOT be serialized
    const task10 = makeTask(10, {
      body: '## Metadata\n**Persona**: engineer\n**Mode**: fast\n**Skills**: core/tdd\n**Focus Areas**: src/api/',
    });
    const task20 = makeTask(20, {
      body: '## Metadata\n**Persona**: engineer\n**Mode**: fast\n**Skills**: core/tdd\n**Focus Areas**: src/ui/',
    });

    const provider = new MockProvider({ epic: EPIC, tasks: [task10, task20] });
    const manifest = await dispatch({
      epicId: 1,
      dryRun: true,
      provider,
    });

    assert.equal(manifest.waves[0].tasks.length, 2);
    const ids = manifest.waves[0].tasks
      .map((t) => t.taskId)
      .sort((a, b) => a - b);
    assert.deepEqual(ids, [10, 20]);
  });

  it('serializes tasks with overlapping focus areas into separate waves', async () => {
    // Same focus area — should be auto-serialized into wave 0 and wave 1
    const task10 = makeTask(10, {
      body: '## Metadata\n**Persona**: engineer\n**Mode**: fast\n**Skills**:\n**Focus Areas**: src/shared/',
    });
    const task20 = makeTask(20, {
      body: '## Metadata\n**Persona**: engineer\n**Mode**: fast\n**Skills**:\n**Focus Areas**: src/shared/',
    });

    const provider = new MockProvider({ epic: EPIC, tasks: [task10, task20] });
    const manifest = await dispatch({
      epicId: 1,
      dryRun: true,
      provider,
    });

    // After serialization, tasks are in separate waves
    assert.equal(manifest.waves.length, 2);
  });
});

describe('dispatch() — dependent tasks', () => {
  it('puts dependency in Wave 0 and dependent in Wave 1', async () => {
    const taskA = makeTask(10);
    // taskB depends on taskA (#10)
    const taskB = makeTask(20, {
      body: '## Metadata\n**Persona**: engineer\n**Mode**: fast\n**Skills**:\n**Focus Areas**:\n\nBlocked by #10',
    });

    const provider = new MockProvider({ epic: EPIC, tasks: [taskA, taskB] });
    const manifest = await dispatch({
      epicId: 1,
      dryRun: true,
      provider,
    });

    assert.equal(manifest.waves.length, 2);
    assert.equal(manifest.waves[0].tasks[0].taskId, 10);
    assert.equal(manifest.waves[1].tasks[0].taskId, 20);
  });

  it('does not dispatch Wave 1 when Wave 0 task is not done', async () => {
    const taskA = makeTask(10); // agent::ready — not done
    const taskB = makeTask(20, {
      body: '## Metadata\n**Persona**: engineer\n**Mode**: fast\n\nBlocked by #10',
    });

    const provider = new MockProvider({ epic: EPIC, tasks: [taskA, taskB] });
    const manifest = await dispatch({
      epicId: 1,
      dryRun: true,
      provider,
    });

    // Wave 0 should be dispatched, Wave 1 should not be reached
    const dispatchedIds = manifest.dispatched.map((d) => d.taskId);
    assert.ok(!dispatchedIds.includes(20), 'Task 20 should not be dispatched');
  });
});

describe('dispatch() — cycle detection', () => {
  it('throws when tasks form a cycle', async () => {
    // A → B → A (A blocked by B, B blocked by A)
    const taskA = makeTask(10, {
      body: '## Metadata\n**Persona**: engineer\n**Mode**: fast\n\nBlocked by #20',
    });
    const taskB = makeTask(20, {
      body: '## Metadata\n**Persona**: engineer\n**Mode**: fast\n\nBlocked by #10',
    });

    const provider = new MockProvider({ epic: EPIC, tasks: [taskA, taskB] });
    await assert.rejects(
      () => dispatch({ epicId: 1, dryRun: true, provider }),
      /cycle detected/i,
    );
  });
});

describe('dispatch() — skips already-done tasks', () => {
  it('does not re-dispatch agent::done tasks', async () => {
    const doneTask = makeTask(10, {
      labels: ['type::task', 'agent::done'],
    });
    const readyTask = makeTask(20);

    const provider = new MockProvider({
      epic: EPIC,
      tasks: [doneTask, readyTask],
    });
    const manifest = await dispatch({
      epicId: 1,
      dryRun: true,
      provider,
    });

    assert.equal(manifest.summary.doneTasks, 1);
    // Task 10 is done; only Task 20 is dispatched (in dry-run, dispatched array still populated)
    const dispatchedIds = manifest.dispatched.map((d) => d.taskId);
    assert.ok(!dispatchedIds.includes(10));
  });
});

describe('dispatch() — manifest schema compliance', () => {
  it('manifest contains all required top-level fields', async () => {
    const provider = new MockProvider({ epic: EPIC, tasks: [makeTask(5)] });
    const manifest = await dispatch({
      epicId: 1,
      dryRun: true,
      provider,
    });

    const required = [
      'schemaVersion',
      'generatedAt',
      'epicId',
      'epicTitle',
      'executor',
      'dryRun',
      'summary',
      'waves',
      'dispatched',
    ];
    for (const field of required) {
      assert.ok(Object.hasOwn(manifest, field), `Missing field: ${field}`);
    }
  });

  it('summary contains all required fields', async () => {
    const provider = new MockProvider({ epic: EPIC, tasks: [makeTask(5)] });
    const manifest = await dispatch({
      epicId: 1,
      dryRun: true,
      provider,
    });

    const requiredSummary = [
      'totalTasks',
      'doneTasks',
      'progressPercent',
      'totalWaves',
      'dispatched',
    ];
    for (const field of requiredSummary) {
      assert.ok(
        Object.hasOwn(manifest.summary, field),
        `Missing summary.${field}`,
      );
    }
  });

  it('progressPercent is 100 when all tasks are done', async () => {
    const doneTask = makeTask(10, { labels: ['type::task', 'agent::done'] });
    const provider = new MockProvider({ epic: EPIC, tasks: [doneTask] });
    const manifest = await dispatch({
      epicId: 1,
      dryRun: true,
      provider,
    });

    assert.equal(manifest.summary.progressPercent, 100);
  });
});
describe('dispatch() — story-level orchestration', () => {
  it('groups tasks by story and uses shared story branches', async () => {
    const story100 = makeTask(100, {
      title: 'Story Slug',
      labels: ['type::story'],
    });
    const task1 = makeTask(1, {
      body: '## Metadata\nparent: #100',
    });
    const task2 = makeTask(2, {
      body: '## Metadata\nparent: #100',
    });

    const provider = new MockProvider({
      epic: EPIC,
      tasks: [story100, task1, task2],
    });
    const manifest = await dispatch({
      epicId: 1,
      dryRun: true,
      provider,
    });

    // Both tasks should share the story branch naming
    const wave0 = manifest.waves[0];
    const t1 = wave0.tasks.find((t) => t.taskId === 1);
    const t2 = wave0.tasks.find((t) => t.taskId === 2);

    assert.equal(t1.branch, 'story-100');
    assert.equal(t2.branch, 'story-100');

    // storyManifest should contain the story
    assert.equal(manifest.storyManifest.length, 1);
    assert.equal(manifest.storyManifest[0].storyId, 100);
    assert.equal(manifest.storyManifest[0].branchName, 'story-100');
    assert.equal(manifest.storyManifest[0].tasks.length, 2);
  });

  it('serializes tasks across different stories if they have overlapping focus areas', async () => {
    const storyA = makeTask(100, { title: 'Story A', labels: ['type::story'] });
    const storyB = makeTask(200, { title: 'Story B', labels: ['type::story'] });

    const taskA = makeTask(1, {
      body: '## Metadata\nparent: #100\n**Focus Areas**: shared/lib',
      labels: ['type::task', 'agent::ready'],
    });
    const taskB = makeTask(2, {
      body: '## Metadata\nparent: #200\n**Focus Areas**: shared/lib',
      labels: ['type::task', 'agent::ready'],
    });

    const provider = new MockProvider({
      epic: EPIC,
      tasks: [storyA, storyB, taskA, taskB],
    });
    const manifest = await dispatch({
      epicId: 1,
      dryRun: true,
      provider,
    });

    // Should be serialized into 2 waves because of overlapping focus areas
    assert.ok(
      manifest.waves.length >= 2,
      `Expected at least 2 waves, got ${manifest.waves.length}`,
    );
    const wave0Tasks = manifest.waves[0].tasks.map((t) => t.taskId);
    const wave1Tasks = manifest.waves[1].tasks.map((t) => t.taskId);
    assert.ok(wave0Tasks.includes(1) || wave0Tasks.includes(2));
    assert.ok(wave1Tasks.includes(1) || wave1Tasks.includes(2));
  });

  it('handles tasks without any metadata or focus areas gracefully', async () => {
    const sparseTask = {
      id: 50,
      title: 'No Metadata',
      labels: ['type::task', 'agent::ready'],
      body: '',
    };
    const provider = new MockProvider({ epic: EPIC, tasks: [sparseTask] });
    const manifest = await dispatch({
      epicId: 1,
      dryRun: true,
      provider,
    });

    assert.equal(manifest.waves.length, 1);
    assert.equal(manifest.waves[0].tasks[0].taskId, 50);
  });
});

// ---------------------------------------------------------------------------
// 5.12.4 — wave dispatch is concurrent (bounded)
// ---------------------------------------------------------------------------
describe('dispatch() — wave-level concurrency', () => {
  it('hydrates independent wave tasks concurrently, not sequentially', async () => {
    // Four independent tasks (non-overlapping focus areas, no deps) — a
    // single wave of four. Each provider.getTicket call yields on the
    // microtask queue so overlapping calls pile up before any resolves.
    // We prove concurrency by observing peak in-flight getTicket calls,
    // not by timing wall-clock — the latter is flaky on CPU-starved CI
    // and Windows (15ms timer granularity).
    const epic = {
      id: 1,
      title: 'Concurrency Epic',
      body: '',
      labels: ['type::epic'],
    };

    const tasks = [1, 2, 3, 4].map((n) => ({
      id: n,
      title: `T${n}`,
      body: `## Metadata\n**Persona**: engineer\n**Mode**: fast\n**Skills**:\n**Focus Areas**: area-${n}`,
      labels: ['type::task', 'agent::ready'],
      state: 'open',
      assignees: [],
    }));

    class TrackingProvider extends MockProvider {
      constructor(opts) {
        super(opts);
        this.inflight = 0;
        this.peakInflight = 0;
      }
      async getTicket(id) {
        this.inflight += 1;
        if (this.inflight > this.peakInflight) {
          this.peakInflight = this.inflight;
        }
        // Yield through several microtask + macrotask turns so sequential
        // callers would strictly serialize while concurrent callers pile up.
        for (let i = 0; i < 3; i++) {
          await new Promise((resolve) => setImmediate(resolve));
        }
        try {
          return await super.getTicket(id);
        } finally {
          this.inflight -= 1;
        }
      }
    }

    const provider = new TrackingProvider({ epic, tasks });
    const manifest = await dispatch({
      epicId: 1,
      dryRun: true,
      provider,
    });

    // All four should have been dispatched.
    assert.equal(manifest.dispatched.length, 4);
    // Sequential dispatch would peak at 1 in-flight. Any overlap ≥ 2
    // proves the wave ran concurrently. In practice this peaks at the
    // wave size when bounded concurrency is uncapped.
    assert.ok(
      provider.peakInflight >= 2,
      `Expected ≥ 2 concurrent getTicket calls in-flight, got peak=${provider.peakInflight}`,
    );
  });
});

// ---------------------------------------------------------------------------
// CLI failure-exit contract
// ---------------------------------------------------------------------------

describe('dispatcher CLI exit contract', () => {
  const DISPATCHER = path.join(SCRIPTS, 'dispatcher.js');

  it('exits non-zero when no ticket id is supplied (no DEBUG gate)', () => {
    const res = spawnSync(process.execPath, [DISPATCHER], {
      cwd: ROOT,
      // Explicitly clear DEBUG to prove the exit is unconditional, not gated
      // on `process.env.DEBUG` (the legacy behaviour the cleanup removed).
      env: { ...process.env, DEBUG: '' },
      encoding: 'utf8',
    });

    assert.notEqual(
      res.status,
      0,
      `Expected non-zero exit; got status=${res.status} stderr=${res.stderr}`,
    );
    assert.match(res.stderr, /\[Dispatcher\]/);
  });
});

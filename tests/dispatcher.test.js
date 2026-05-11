/**
 * Dispatcher Tests
 *
 * Tests the core dispatcher logic using:
 *  - A mock ITicketingProvider (in-memory, no GitHub calls)
 *  - A mock IExecutionAdapter (records dispatches, no side effects)
 *
 * All tests run in --dry-run=false mode with mocked provider/adapter,
 * and skip branch creation (tested separately in integration tests).
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
const { IExecutionAdapter } = await import(
  pathToFileURL(path.join(LIB, 'IExecutionAdapter.js')).href
);
const { dispatch } = await import(
  pathToFileURL(path.join(SCRIPTS, 'dispatcher.js')).href
);
const { extractFrontmatter } = await import(
  pathToFileURL(path.join(LIB, 'audit-suite', 'frontmatter.js')).href
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
// Mock adapter
// ---------------------------------------------------------------------------

class MockAdapter extends IExecutionAdapter {
  constructor() {
    super();
    this.dispatches = [];
  }

  get executorId() {
    return 'mock';
  }

  async dispatchTask(taskDispatch) {
    this.dispatches.push(taskDispatch);
    return { dispatchId: `mock-${taskDispatch.taskId}`, status: 'dispatched' };
  }

  async getTaskStatus(dispatchId) {
    return { dispatchId, status: 'pending' };
  }

  async cancelTask() {}
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
    const adapter = new MockAdapter();

    const manifest = await dispatch({
      epicId: 1,
      dryRun: true,
      provider,
      adapter,
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
    const adapter = new MockAdapter();

    const manifest = await dispatch({
      epicId: 1,
      dryRun: true,
      provider,
      adapter,
    });

    assert.equal(manifest.summary.totalTasks, 1);
    assert.equal(manifest.waves.length, 1);
    assert.equal(manifest.waves[0].waveIndex, 0);
    assert.equal(manifest.waves[0].tasks.length, 1);
    assert.equal(manifest.waves[0].tasks[0].taskId, 10);
  });

  it('dry-run does not call adapter.dispatchTask()', async () => {
    const provider = new MockProvider({ epic: EPIC, tasks: [makeTask(10)] });
    const adapter = new MockAdapter();

    await dispatch({ epicId: 1, dryRun: true, provider, adapter });
    // In dryRun mode dispatcher logs but doesn't call adapter.dispatchTask
    assert.equal(adapter.dispatches.length, 0);
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
    const adapter = new MockAdapter();

    const manifest = await dispatch({
      epicId: 1,
      dryRun: true,
      provider,
      adapter,
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
    const adapter = new MockAdapter();

    const manifest = await dispatch({
      epicId: 1,
      dryRun: true,
      provider,
      adapter,
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
    const adapter = new MockAdapter();

    const manifest = await dispatch({
      epicId: 1,
      dryRun: true,
      provider,
      adapter,
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
    const adapter = new MockAdapter();

    const manifest = await dispatch({
      epicId: 1,
      dryRun: true,
      provider,
      adapter,
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
    const adapter = new MockAdapter();

    await assert.rejects(
      () => dispatch({ epicId: 1, dryRun: true, provider, adapter }),
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
    const adapter = new MockAdapter();

    const manifest = await dispatch({
      epicId: 1,
      dryRun: true,
      provider,
      adapter,
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
    const adapter = new MockAdapter();

    const manifest = await dispatch({
      epicId: 1,
      dryRun: true,
      provider,
      adapter,
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
    const adapter = new MockAdapter();

    const manifest = await dispatch({
      epicId: 1,
      dryRun: true,
      provider,
      adapter,
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
    const adapter = new MockAdapter();

    const manifest = await dispatch({
      epicId: 1,
      dryRun: true,
      provider,
      adapter,
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
    const adapter = new MockAdapter();

    const manifest = await dispatch({
      epicId: 1,
      dryRun: true,
      provider,
      adapter,
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
    const adapter = new MockAdapter();

    const manifest = await dispatch({
      epicId: 1,
      dryRun: true,
      provider,
      adapter,
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
    const adapter = new MockAdapter();

    const manifest = await dispatch({
      epicId: 1,
      dryRun: true,
      provider,
      adapter,
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
    const adapter = new MockAdapter();

    const manifest = await dispatch({
      epicId: 1,
      dryRun: true,
      provider,
      adapter,
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

// ---------------------------------------------------------------------------
// Story #1325 — dispatchModel contract fixture
//
// Locks in the dispatch contract behaviour for s-epic-deliver-dispatchmodel:
//   1. A fixture workflow with `dispatchModel: haiku` produces a dispatch
//      plan where every Agent call carries `model: 'haiku'`.
//   2. A fixture workflow with NO `dispatchModel` produces a dispatch plan
//      where every Agent call carries NO `model:` argument (today's
//      behaviour preserved — the call inherits the parent's model).
//   3. A per-call body literal `model:` wins over the workflow's
//      `dispatchModel` (precedence rule).
//
// The "renderer" tested here is the precedence rule documented inline in
// `.agents/workflows/epic-deliver.md` Phase 2a §"Dispatch-model resolution"
// and in `.agents/workflows/README.md` §"Precedence". It is a pure data
// derivation — no IO, no provider, no adapter — and is encoded inline as
// `renderDispatchPlan()` below so the contract is asserted at test time
// without coupling to a not-yet-existent harness implementation. The host
// LLM running `epic-deliver` Phase 2a applies the same precedence when it
// composes parallel Agent calls.
// ---------------------------------------------------------------------------

/**
 * Pure: resolve the `model:` argument for a single Agent call given the
 * workflow-level frontmatter `dispatchModel` and an optional per-call
 * override literal.
 *
 * Precedence (highest wins):
 *   1. perCallOverride (literal in the Agent call body)
 *   2. workflowFrontmatter.dispatchModel
 *   3. undefined  → emit NO `model:` argument (inherit parent)
 *
 * @param {Record<string, string>} workflowFrontmatter
 * @param {string | undefined} perCallOverride
 * @returns {string | undefined}
 */
function resolveDispatchModel(workflowFrontmatter, perCallOverride) {
  if (perCallOverride !== undefined && perCallOverride !== null) {
    return perCallOverride;
  }
  const fmValue = workflowFrontmatter?.dispatchModel;
  if (fmValue) return fmValue;
  return undefined;
}

/**
 * Pure: simulate the dispatch plan a workflow body would emit. Each entry
 * in `stories` is one parallel Agent call. The returned plan mirrors the
 * shape `epic-deliver.md` Phase 2a composes: one entry per Story, with
 * `model` either set to a hint or omitted entirely (NOT `null`/`undefined`
 * — omitted) so the call inherits the parent's model.
 *
 * @param {string} workflowContent
 * @param {Array<{ storyId: number, perCallModel?: string }>} stories
 * @returns {Array<{ storyId: number, subagent_type: string, model?: string }>}
 */
function renderDispatchPlan(workflowContent, stories) {
  const fm = extractFrontmatter(workflowContent);
  return stories.map(({ storyId, perCallModel }) => {
    const call = { storyId, subagent_type: 'general-purpose' };
    const resolved = resolveDispatchModel(fm, perCallModel);
    if (resolved !== undefined) {
      call.model = resolved;
    }
    return call;
  });
}

describe('dispatch-model contract — workflow fixtures', () => {
  it('dispatchModel: haiku → every Agent call carries model: "haiku"', () => {
    const fixture =
      '---\n' +
      'description: Fan out the audit-* suite in one parallel turn.\n' +
      'recommendedModel: opus\n' +
      'dispatchModel: haiku\n' +
      '---\n' +
      '\n' +
      '# Body — Phase 2a fan-out\n';

    const plan = renderDispatchPlan(fixture, [
      { storyId: 101 },
      { storyId: 102 },
      { storyId: 103 },
    ]);

    assert.equal(plan.length, 3);
    for (const call of plan) {
      assert.equal(
        call.model,
        'haiku',
        `Story ${call.storyId} expected model: 'haiku', got ${JSON.stringify(call.model)}`,
      );
      assert.equal(call.subagent_type, 'general-purpose');
    }
  });

  it('unset dispatchModel → no model: argument on any Agent call (parent inheritance preserved)', () => {
    const fixture =
      '---\n' +
      'description: Baseline workflow with no model hints.\n' +
      '---\n' +
      '\n' +
      '# Body — Phase 2a fan-out\n';

    const plan = renderDispatchPlan(fixture, [
      { storyId: 201 },
      { storyId: 202 },
    ]);

    assert.equal(plan.length, 2);
    for (const call of plan) {
      assert.equal(
        Object.hasOwn(call, 'model'),
        false,
        `Story ${call.storyId} must not carry a model key when dispatchModel is unset`,
      );
      // Today's behaviour byte-equivalent: subagent_type is still set, no
      // model argument is emitted at all.
      assert.equal(call.subagent_type, 'general-purpose');
    }
  });

  it('per-call body literal model: wins over workflow dispatchModel', () => {
    const fixture =
      '---\n' +
      'description: Fan-out with workflow-level dispatchModel.\n' +
      'dispatchModel: haiku\n' +
      '---\n';

    const plan = renderDispatchPlan(fixture, [
      { storyId: 301 }, // inherits workflow's haiku
      { storyId: 302, perCallModel: 'opus' }, // override wins
      { storyId: 303 }, // inherits workflow's haiku
    ]);

    assert.equal(plan[0].model, 'haiku');
    assert.equal(plan[1].model, 'opus');
    assert.equal(plan[2].model, 'haiku');
  });

  it('recommendedModel alone (no dispatchModel) → no model: argument emitted', () => {
    // recommendedModel is advisory only — it must NEVER feed the
    // dispatcher. This guards against a future regression where someone
    // wires recommendedModel into the dispatch path.
    const fixture =
      '---\n' +
      'description: Advisory-only workflow.\n' +
      'recommendedModel: opus\n' +
      '---\n';

    const plan = renderDispatchPlan(fixture, [{ storyId: 401 }]);

    assert.equal(Object.hasOwn(plan[0], 'model'), false);
  });
});

/**
 * Dispatcher Tests
 *
 * Tests the core dispatcher logic using:
 *  - A mock ITicketingProvider (in-memory, no GitHub calls)
 *
 * All tests run in --dry-run=false mode with a mocked provider, and skip
 * branch creation (tested separately in integration tests).
 *
 * Note: Epic #3163 / Story #3205 removed the Task-tier dispatch runtime;
 * `dispatch()` is now 3-tier-only and emits a Story-level wave plan. The
 * legacy Task-tier cases below are skipped under TODO(#3209).
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
});

// ---------------------------------------------------------------------------
// 3-tier hierarchy — Story-level wave computation
// (Epic #3078 Story #3128 — dispatch-engine + dependency-analyzer)
// ---------------------------------------------------------------------------

function makeStoryTicket(id, overrides = {}) {
  return {
    id,
    title: `Story ${id}`,
    body: '',
    labels: ['type::story', 'agent::ready'],
    state: 'open',
    assignees: [],
    ...overrides,
  };
}

describe('dispatch() — 3-tier hierarchy (Story-level wave plan)', () => {
  it('emits waves[].stories[] keyed by storyId when no Tasks are present', async () => {
    const story100 = makeStoryTicket(100, { title: 'First Story' });
    const story200 = makeStoryTicket(200, { title: 'Second Story' });
    const provider = new MockProvider({
      epic: EPIC,
      tasks: [story100, story200],
    });

    const manifest = await dispatch({ epicId: 1, dryRun: true, provider });

    assert.equal(
      manifest.hierarchy,
      '3-tier',
      'manifest should declare 3-tier hierarchy',
    );
    assert.ok(Array.isArray(manifest.waves), 'waves must be present');
    // Independent Stories collapse into a single wave.
    assert.equal(manifest.waves.length, 1);
    assert.ok(
      Array.isArray(manifest.waves[0].stories),
      'wave entries must be Stories, not Tasks',
    );
    const storyIds = manifest.waves[0].stories
      .map((s) => s.storyId)
      .sort((a, b) => a - b);
    assert.deepEqual(storyIds, [100, 200]);
    // Summary uses Story counts under 3-tier.
    assert.equal(manifest.summary.totalStories, 2);
  });

  it('respects cross-Story `blocked by` edges when assigning waves', async () => {
    const storyA = makeStoryTicket(100, { title: 'Independent Story' });
    const storyB = makeStoryTicket(200, {
      title: 'Dependent Story',
      body: 'blocked by #100',
    });
    const provider = new MockProvider({
      epic: EPIC,
      tasks: [storyA, storyB],
    });

    const manifest = await dispatch({ epicId: 1, dryRun: true, provider });

    assert.equal(manifest.hierarchy, '3-tier');
    assert.equal(
      manifest.waves.length,
      2,
      'dependent Story should land in a later wave',
    );
    assert.deepEqual(
      manifest.waves[0].stories.map((s) => s.storyId),
      [100],
    );
    assert.deepEqual(
      manifest.waves[1].stories.map((s) => s.storyId),
      [200],
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

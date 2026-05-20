import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ITicketingProvider } from '../.agents/scripts/lib/ITicketingProvider.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SCRIPTS = path.join(ROOT, '.agents', 'scripts');

const { dispatch } = await import(
  pathToFileURL(path.join(SCRIPTS, 'dispatcher.js')).href
);
const { cascadeCompletion, transitionTicketState } = await import(
  pathToFileURL(path.join(SCRIPTS, 'lib', 'orchestration', 'ticketing.js')).href
);

// ---------------------------------------------------------------------------
// Mock Provider and Adapter
// ---------------------------------------------------------------------------

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
    const t = this._tasks.find((t) => t.id === ticketId);
    if (!t) throw new Error(`Ticket ${ticketId} not found`);
    return t;
  }

  async updateTicket(ticketId, mutations) {
    this.updateCalls.push({ ticketId, mutations });

    const ticket = this._tasks.find((t) => t.id === ticketId);
    if (!ticket) return;

    if (mutations.labels) {
      const rm = mutations.labels.remove || [];
      const add = mutations.labels.add || [];
      let current = (ticket.labels || []).filter((l) => !rm.includes(l));
      current = [...new Set([...current, ...add])];
      ticket.labels = current;
    }

    if (mutations.body !== undefined) {
      ticket.body = mutations.body;
    }

    if (mutations.state !== undefined) {
      ticket.state = mutations.state;
    }
  }

  async postComment(ticketId, payload) {
    this.commentCalls.push({ ticketId, payload });
    return { commentId: Date.now() };
  }

  async getTicketDependencies(ticketId) {
    const ticket = await this.getTicket(ticketId);

    // Naively parse "blocked by #NNN"
    const blocksMatch = ticket.body.matchAll(/blocked by #(\d+)/gi);
    const blockedBy = [...blocksMatch].map((m) => Number.parseInt(m[1], 10));

    // Naively parse "parent: #NNN" to define what this block blocks (going up)
    const blocks = [];
    const parentMatch = ticket.body.match(/parent:\s*#(\d+)/i);
    if (parentMatch) {
      blocks.push(Number.parseInt(parentMatch[1], 10));
    }

    return { blocks, blockedBy };
  }

  async getSubTickets(parentId) {
    // Return tickets whose parent is parentId
    const children = this._tasks.filter((t) => {
      const pMatch = t.body.match(/parent:\s*#(\d+)/i);
      return pMatch && Number.parseInt(pMatch[1], 10) === parentId;
    });
    return children;
  }
}

const EPIC = {
  id: 10,
  title: 'Epic Title',
  body: 'Epic body',
  labels: ['type::epic'],
  linkedIssues: { prd: null, techSpec: null },
};

function makeTask(id, overrides = {}) {
  return {
    id,
    number: id, // REST fallback alias
    title: `Task ${id}`,
    labels: ['type::task'],
    assignees: [],
    state: 'open',
    body: '',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// E2E Test Suite
// ---------------------------------------------------------------------------

test('e2e-story-lifecycle — validates full flow from dispatch to story completion cascade', async (_t) => {
  // 1. Setup Hierarchy: Epic (10) -> Feature (20) -> Story (30) -> Tasks (31, 32)
  const feature20 = makeTask(20, {
    title: 'Feature Level',
    labels: ['type::feature'],
    body: '## Metadata\nparent: #10\n- [ ] #30',
  });

  const story30 = makeTask(30, {
    title: 'Story Level Test',
    labels: ['type::story'],
    body: '## Metadata\nparent: #20\nEpic: #10\n- [ ] #31\n- [ ] #32',
  });

  const task31 = makeTask(31, {
    title: 'Task A',
    labels: ['type::task', 'agent::ready'],
    body: '## Metadata\nparent: #30\nEpic: #10',
  });

  // Task 32 is blocked by 31 initially
  const task32 = makeTask(32, {
    title: 'Task B',
    labels: ['type::task', 'agent::ready'],
    body: '## Metadata\nparent: #30\nEpic: #10\nblocked by #31',
  });

  const provider = new MockProvider({
    epic: EPIC,
    tasks: [EPIC, feature20, story30, task31, task32],
  });

  // -------------------------------------------------------------------------
  // PHASE 1: Initial Dispatch
  // -------------------------------------------------------------------------
  const manifest1 = await dispatch({
    epicId: 10,
    dryRun: true,
    provider,
  });

  // Wave 0 should only contain task 31, since task 32 is blocked
  // Should only dispatch task 31
  assert.equal(manifest1.dispatched.length, 1);
  assert.equal(manifest1.dispatched[0].taskId, 31);

  // -------------------------------------------------------------------------
  // PHASE 2: Complete Task 31 and Cascade
  // -------------------------------------------------------------------------
  // Pretend agent finishes and transitions Task 31 to done
  await transitionTicketState(provider, 31, 'agent::done');
  await cascadeCompletion(provider, 31);

  // Assert Task 31 is done
  const t31 = await provider.getTicket(31);
  assert.ok(t31.labels.includes('agent::done'));
  assert.equal(t31.state, 'closed');

  // Story 30 should NOT be done yet because Task 32 is still open
  const s30After31 = await provider.getTicket(30);
  assert.ok(!s30After31.labels.includes('agent::done'));
  assert.equal(s30After31.state, 'open');

  // -------------------------------------------------------------------------
  // PHASE 3: Second Dispatch (Task 32 is unblocked)
  // -------------------------------------------------------------------------
  const manifest2 = await dispatch({
    epicId: 10,
    dryRun: true,
    provider,
  });

  // Wave 0 of the new dispatch should contain task 32
  // The new dispatch should dispatch task 32
  assert.equal(manifest2.dispatched.length, 1);
  assert.equal(manifest2.dispatched[0].taskId, 32);

  // -------------------------------------------------------------------------
  // PHASE 4: Complete Task 32 and Cascade
  // -------------------------------------------------------------------------
  await transitionTicketState(provider, 32, 'agent::done');
  await cascadeCompletion(provider, 32);

  // Assert Task 32 is done
  const t32 = await provider.getTicket(32);
  assert.ok(t32.labels.includes('agent::done'));

  // Assert Story 30 is now DONE because all its children (31, 32) are done
  const s30Final = await provider.getTicket(30);
  assert.ok(
    s30Final.labels.includes('agent::done'),
    'Story should be marked done',
  );
  assert.equal(s30Final.state, 'closed', 'Story should be closed');

  // Assert Feature 20 is now DONE because its only child (30) is done
  const f20Final = await provider.getTicket(20);
  assert.ok(
    f20Final.labels.includes('agent::done'),
    'Feature should be marked done',
  );
  assert.equal(f20Final.state, 'closed', 'Feature should be closed');
});

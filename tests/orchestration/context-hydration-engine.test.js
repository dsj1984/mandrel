import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from '../../.agents/scripts/lib/config-resolver.js';
import { envelopeToPrompt } from '../../.agents/scripts/lib/orchestration/context-envelope.js';
import {
  __resetContextCache,
  hydrateContext,
} from '../../.agents/scripts/lib/orchestration/context-hydration-engine.js';
import { legacyHydrate } from '../../.agents/scripts/lib/orchestration/context-hydration-engine.legacy.js';

class HierarchyProvider {
  constructor(tickets) {
    this.tickets = tickets;
    this.calls = [];
  }

  async getTicket(id) {
    this.calls.push(id);
    const t = this.tickets[id];
    if (!t) throw new Error(`Ticket #${id} not found`);
    return t;
  }
}

const baseTask = {
  id: 200,
  title: 'Child task',
  body: '> Epic: #1\n\nTask body for hydration',
  labels: [],
};

describe('hydrateContext — envelope return shape', () => {
  it('returns a ContextEnvelope; prose matches envelopeToPrompt', async () => {
    const provider = new HierarchyProvider({
      1: {
        id: 1,
        title: 'Epic',
        body: 'Epic Body',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      200: {
        id: 200,
        title: 'Child task',
        body: baseTask.body,
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
    });

    const envelope = await hydrateContext(
      baseTask,
      provider,
      'epic/1',
      'story-1',
      1,
    );

    assert.equal(envelope.schemaVersion, '1');
    assert.equal(envelope.task.id, 200);
    assert.ok(Array.isArray(envelope.sections));
    assert.ok(Array.isArray(envelope.provenance));

    const prompt = envelopeToPrompt(envelope);
    assert.ok(prompt.includes('Task body for hydration'));
    assert.ok(prompt.includes('Epic Body'));
  });

  it('records provenance for each fetched hierarchy ticket', async () => {
    const provider = new HierarchyProvider({
      1: {
        id: 1,
        title: 'Epic',
        body: 'Epic Body',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      5: {
        id: 5,
        title: 'Tech Spec',
        body: 'Spec Body',
        updatedAt: '2026-01-03T00:00:00.000Z',
      },
      9: {
        id: 9,
        title: 'Story',
        body: 'Story Body',
        updatedAt: '2026-01-04T00:00:00.000Z',
      },
      200: {
        id: 200,
        title: 'Child',
        body: '> Epic: #1\n> Tech Spec: #5\n> Story: #9\n\nDo work',
        updatedAt: '2026-01-05T00:00:00.000Z',
      },
    });

    const envelope = await hydrateContext(
      {
        id: 200,
        title: 'Child',
        body: '> Epic: #1\n> Tech Spec: #5\n> Story: #9\n\nDo work',
      },
      provider,
      'epic/1',
      'story-9',
      1,
    );

    assert.equal(envelope.provenance.length, 3);
    for (const snap of envelope.provenance) {
      assert.ok(typeof snap.id === 'number');
      assert.ok(snap.version);
      assert.match(snap.hash, /^[a-f0-9]{12}$/);
      assert.ok(snap.retrievedAt);
    }
    const ids = envelope.provenance.map((p) => p.id).sort((a, b) => a - b);
    assert.deepEqual(ids, [1, 5, 9]);
  });

  it('prose-legacy wraps legacyHydrate without running the envelope pipeline', async () => {
    const provider = new HierarchyProvider({
      1: { id: 1, title: 'Epic', body: 'Epic Body' },
    });

    const legacyString = await legacyHydrate(
      baseTask,
      provider,
      'epic/1',
      'story-1',
      1,
    );

    const tmp = mkdtempSync(path.join(tmpdir(), 'mandrel-hydration-'));
    writeFileSync(
      path.join(tmp, '.agentrc.json'),
      JSON.stringify({
        project: {
          paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
        },
        delivery: { hydration: { outputMode: 'prose-legacy' } },
      }),
    );

    const prevCwd = process.env.AP_AGENTRC_CWD;
    process.env.AP_AGENTRC_CWD = tmp;
    resolveConfig({ bustCache: true });
    __resetContextCache();

    try {
      const envelope = await hydrateContext(
        baseTask,
        provider,
        'epic/1',
        'story-1',
        1,
      );

      assert.equal(envelope.sections.length, 1);
      assert.equal(envelope.sections[0].name, 'taskInstructions');
      assert.equal(envelope.sections[0].content, legacyString);
      assert.deepEqual(envelope.provenance, []);
    } finally {
      process.env.AP_AGENTRC_CWD = prevCwd;
      resolveConfig({ bustCache: true });
      __resetContextCache();
    }
  });
});

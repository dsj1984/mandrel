import assert from 'node:assert/strict';
import fs, { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from '../../.agents/scripts/lib/config-resolver.js';
import { envelopeToPrompt } from '../../.agents/scripts/lib/orchestration/context-envelope.js';
import {
  __resetContextCache,
  buildSkillCapsuleSections,
  formatSkillCapsulesSection,
  hydrateContext,
} from '../../.agents/scripts/lib/orchestration/context-hydration-engine.js';
import { legacyHydrate } from '../../.agents/scripts/lib/orchestration/context-hydration-engine.legacy.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

function readSkillsIndex() {
  const indexPath = path.join(
    REPO_ROOT,
    '.agents',
    'skills',
    'skills.index.json',
  );
  return JSON.parse(fs.readFileSync(indexPath, 'utf8'));
}

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

class MockProvider {
  async getTicket(id) {
    if (id === 1) return { id: 1, title: 'Epic', body: 'Epic body' };
    if (id === 5) return { id: 5, title: 'Story', body: 'Story body' };
    throw new Error(`Ticket #${id} not found`);
  }
}

const baseTask = {
  id: 200,
  title: 'Child task',
  body: '> Epic: #1\n\nTask body for hydration',
  labels: [],
};

describe('buildSkillCapsuleSections', () => {
  it('loads capsules from skills.index.json with source metadata', () => {
    const skillsIndex = readSkillsIndex();
    const entries = buildSkillCapsuleSections(
      { skills: ['hydrate-context'], labels: [] },
      skillsIndex,
    );
    assert.equal(entries.length, 1);
    assert.equal(entries[0].skill, 'hydrate-context');
    assert.equal(entries[0].source, 'capsule');
    assert.ok(entries[0].capsule.startsWith('## Policy Capsule'));
    const rendered = formatSkillCapsulesSection(entries);
    assert.match(rendered, /\(source: capsule\)/);
  });

  it('honours skill::full with full-body-optin', () => {
    const skillsIndex = readSkillsIndex();
    const entries = buildSkillCapsuleSections(
      { skills: ['hydrate-context'], labels: ['skill::full', 'type::task'] },
      skillsIndex,
    );
    assert.equal(entries[0].source, 'full-body-optin');
    assert.ok(entries[0].capsule.startsWith('---'));
  });

  it('honours fullSkillBodies option for every skill', () => {
    const skillsIndex = readSkillsIndex();
    const entries = buildSkillCapsuleSections(
      { skills: ['hydrate-context'], labels: [] },
      skillsIndex,
      { fullSkillBodies: true },
    );
    assert.equal(entries[0].source, 'full-body-optin');
  });
});

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

describe('hydrateContext — skill capsule routing', () => {
  it('embeds per-skill source in the Activated Skills section', async () => {
    __resetContextCache();
    const provider = new MockProvider();
    const envelope = await hydrateContext(
      {
        id: 42,
        title: 'Capsule routing task',
        body: 'Epic: #1\nStory: #5\n\nDo work',
        persona: 'engineer',
        skills: ['hydrate-context'],
        labels: ['skill::hydrate-context', 'type::task'],
      },
      provider,
      'epic/1',
      'story-5',
      1,
    );
    const prompt = envelopeToPrompt(envelope);
    assert.match(prompt, /### Skill: hydrate-context \(source: capsule\)/);
    assert.match(prompt, /## Policy Capsule/);
    assert.doesNotMatch(
      prompt,
      /### Skill: hydrate-context\n---/,
      'must not dump raw SKILL frontmatter without source: capsule routing',
    );
  });
});

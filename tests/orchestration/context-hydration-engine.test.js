import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { envelopeToPrompt } from '../../.agents/scripts/lib/orchestration/context-envelope.js';
import {
  __resetContextCache,
  buildSkillCapsuleSections,
  extractStorySections,
  formatSkillCapsulesSection,
  hydrateContext,
} from '../../.agents/scripts/lib/orchestration/context-hydration-engine.js';

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
});

describe('extractStorySections — inline Story body parsing (3-tier)', () => {
  it('parses ## Acceptance and ## Verify checklists', () => {
    const body = [
      'Story narrative paragraph.',
      '',
      '## Acceptance',
      '- [ ] Hydrate Story body',
      '- [x] No regression in 4-tier',
      '',
      '## Verify',
      '- node --test foo.test.js',
      '- node --test bar.test.js',
    ].join('\n');
    const out = extractStorySections(body);
    assert.deepEqual(out.acceptance, [
      'Hydrate Story body',
      'No regression in 4-tier',
    ]);
    assert.deepEqual(out.verify, [
      'node --test foo.test.js',
      'node --test bar.test.js',
    ]);
  });

  it('prefers ## Acceptance Criteria over ## Acceptance when both exist', () => {
    const body = [
      '## Acceptance Criteria',
      '- canonical AC item',
      '',
      '## Acceptance',
      '- legacy AC item',
    ].join('\n');
    const out = extractStorySections(body);
    assert.deepEqual(out.acceptance, ['canonical AC item']);
  });

  it('returns empty arrays when sections are absent', () => {
    assert.deepEqual(extractStorySections('only narrative, no headings'), {
      acceptance: [],
      verify: [],
    });
    assert.deepEqual(extractStorySections(''), {
      acceptance: [],
      verify: [],
    });
  });
});

describe('hydrateContext — 3-tier Story body hydration', () => {
  it('emits acceptanceCriteria + verificationCommands sections from Story body when task carries type::story', async () => {
    const provider = new HierarchyProvider({
      1: {
        id: 1,
        title: 'Epic',
        body: 'Epic Body',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      300: {
        id: 300,
        title: 'Story 3-tier',
        body: '> Epic: #1\n\nStory narrative.\n\n## Acceptance\n- [ ] Inline AC #1\n- [ ] Inline AC #2\n\n## Verify\n- node --test tests/foo.test.js\n',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
    });

    const envelope = await hydrateContext(
      {
        id: 300,
        title: 'Story 3-tier',
        body: '> Epic: #1\n\nStory narrative.\n\n## Acceptance\n- [ ] Inline AC #1\n- [ ] Inline AC #2\n\n## Verify\n- node --test tests/foo.test.js\n',
        labels: ['type::story', 'persona::engineer'],
      },
      provider,
      'epic/1',
      'story-300',
      1,
    );

    const acSection = envelope.sections.find(
      (s) => s.name === 'acceptanceCriteria',
    );
    const verifySection = envelope.sections.find(
      (s) => s.name === 'verificationCommands',
    );
    assert.ok(acSection, 'acceptanceCriteria section must be emitted');
    assert.ok(verifySection, 'verificationCommands section must be emitted');
    assert.match(acSection.content, /Inline AC #1/);
    assert.match(acSection.content, /Inline AC #2/);
    assert.match(verifySection.content, /node --test tests\/foo\.test\.js/);
    assert.equal(acSection.source?.kind, 'ticket');
    assert.equal(acSection.source?.ref, '300');

    const prompt = envelopeToPrompt(envelope);
    assert.ok(prompt.includes('Inline AC #1'));
    assert.ok(prompt.includes('node --test tests/foo.test.js'));
  });

  it('does NOT emit acceptanceCriteria/verificationCommands when task is type::task (4-tier no regression)', async () => {
    const provider = new HierarchyProvider({
      1: {
        id: 1,
        title: 'Epic',
        body: 'Epic Body',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      400: {
        id: 400,
        title: 'Task 4-tier',
        body: '> Epic: #1\n\n## Acceptance\n- [ ] Task AC\n',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
    });

    const envelope = await hydrateContext(
      {
        id: 400,
        title: 'Task 4-tier',
        body: '> Epic: #1\n\n## Acceptance\n- [ ] Task AC\n',
        labels: ['type::task', 'persona::engineer'],
      },
      provider,
      'epic/1',
      'story-1',
      1,
    );

    assert.ok(
      !envelope.sections.some((s) => s.name === 'acceptanceCriteria'),
      'acceptanceCriteria MUST NOT be emitted for type::task in 4-tier mode',
    );
    assert.ok(
      !envelope.sections.some((s) => s.name === 'verificationCommands'),
      'verificationCommands MUST NOT be emitted for type::task in 4-tier mode',
    );
    // The taskInstructions section still carries the full body (no regression).
    const taskInst = envelope.sections.find(
      (s) => s.name === 'taskInstructions',
    );
    assert.ok(taskInst, 'taskInstructions still emitted in 4-tier');
    assert.match(taskInst.content, /Task AC/);
  });

  it('schema-identical shape: same envelope keys + section field shape between modes', async () => {
    const provider = new HierarchyProvider({
      1: {
        id: 1,
        title: 'Epic',
        body: 'E',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    const storyEnv = await hydrateContext(
      {
        id: 500,
        title: 'S',
        body: '> Epic: #1\n\n## Acceptance\n- ac\n\n## Verify\n- v\n',
        labels: ['type::story'],
      },
      provider,
      'epic/1',
      'story-500',
      1,
    );
    const taskEnv = await hydrateContext(
      {
        id: 501,
        title: 'T',
        body: '> Epic: #1\n\nbody',
        labels: ['type::task'],
      },
      provider,
      'epic/1',
      'story-1',
      1,
    );
    // Top-level keys identical
    assert.deepEqual(Object.keys(storyEnv).sort(), Object.keys(taskEnv).sort());
    // Section field shape identical (name/priority/content/source on every entry)
    const fieldShape = (s) =>
      ['name', 'priority', 'content', 'estimatedTokens'].every((k) => k in s);
    assert.ok(storyEnv.sections.every(fieldShape));
    assert.ok(taskEnv.sections.every(fieldShape));
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

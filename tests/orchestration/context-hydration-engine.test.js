import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fs from 'node:fs';
import {
  __resetContextCache,
  buildSkillCapsuleSections,
  formatSkillCapsulesSection,
  hydrateContext,
} from '../../.agents/scripts/lib/orchestration/context-hydration-engine.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

class MockProvider {
  async getTicket(id) {
    if (id === 1) return { id: 1, title: 'Epic', body: 'Epic body' };
    if (id === 5) return { id: 5, title: 'Story', body: 'Story body' };
    throw new Error(`Ticket #${id} not found`);
  }
}

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

describe('hydrateContext — skill capsule routing', () => {
  it('embeds per-skill source in the Activated Skills section', async () => {
    __resetContextCache();
    const provider = new MockProvider();
    const prompt = await hydrateContext(
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
    assert.match(prompt, /### Skill: hydrate-context \(source: capsule\)/);
    assert.match(prompt, /## Policy Capsule/);
    assert.doesNotMatch(
      prompt,
      /### Skill: hydrate-context\n---/,
      'must not dump raw SKILL frontmatter without source: capsule routing',
    );
  });
});

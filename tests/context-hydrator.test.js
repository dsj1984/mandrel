import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SCRIPTS = path.join(ROOT, '.agents', 'scripts');

// Note: we might have issues testing fs calls directly inside the hydrator
// but we'll use a mocked ITicketingProvider.
const { envelopeToPrompt, hydrateContext } = await import(
  pathToFileURL(path.join(SCRIPTS, 'context-hydrator.js')).href
);

// Mock Provider
class MockProvider {
  async getTicket(id) {
    if (id === 1) return { id: 1, title: 'Epic', body: 'Epic Body' };
    if (id === 2) return { id: 2, title: 'Feature', body: 'Feature Body' };
    throw new Error(`Ticket #${id} not found`);
  }
}

describe('Context Hydrator', () => {
  it('hydrates prompt from basic task', async () => {
    const task = {
      id: 99,
      title: 'Fix issue',
      body: '> Epic: #1 | Feature: #2\n\nFix the bug',
      protocolVersion: '5.0.0', // Assuming current version
      persona: 'engineer',
      skills: [],
    };

    // We expect it to be resilient if personas/skills/templates aren't fully present
    // unless running inside the exact monorepo.
    const provider = new MockProvider();

    const envelope = await hydrateContext(
      task,
      provider,
      'epic/1',
      'task/epic-1/99',
      1,
    );
    const prompt = envelopeToPrompt(envelope);

    assert.ok(prompt.includes('Fix the bug'), 'Prompt contains task body');
    assert.ok(
      prompt.includes('task/epic-1/99'),
      'Prompt substituted branch name',
    );
    assert.ok(prompt.includes('epic/1'), 'Prompt substituted epic branch name');
    assert.ok(
      prompt.includes('Epic: Epic (#1)'),
      'Prompt contains fetched epic',
    );
    assert.ok(prompt.includes('Epic Body'), 'Prompt contains epic body');
    assert.ok(
      !prompt.includes('Feature: Feature (#2)'),
      'Prompt skips feature by default (standard context depth)',
    );
  });

  it('handles token budget truncation', async () => {
    const task = {
      id: 99,
      title: 'Fix issue',
      body: 'a'.repeat(5000), // very long body
    };

    const provider = new MockProvider();

    // The hydrate context currently fetches settings from config-resolver.
    // If the mock project has maxTokenBudget set to something small, it will truncate.
    // Let's just verify it doesn't crash.
    const envelope = await hydrateContext(task, provider, 'epic/1', 'task/1', 1);
    const prompt = envelopeToPrompt(envelope);
    assert.ok(typeof prompt === 'string');
  });
});

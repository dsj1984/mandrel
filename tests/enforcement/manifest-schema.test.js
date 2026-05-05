import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { buildManifest } from '../../.agents/scripts/lib/orchestration/manifest-builder.js';
import { executeStory } from '../../.agents/scripts/lib/orchestration/story-executor.js';
import { parseTasks } from '../../.agents/scripts/lib/orchestration/task-fetcher.js';
import { MockProvider } from '../fixtures/mock-provider.js';

/**
 * Fixture-based AJV drift test for `.agents/schemas/dispatch-manifest.json`.
 *
 * Runs `buildManifest()` (epic-dispatch variant) and `executeStory()`
 * (story-execution variant) against representative inputs and validates the
 * output against the dispatch-manifest schema. The schema is the open-root
 * variant adopted in ADR 20260427-868a — the AJV drift test here is the
 * enforcement boundary.
 *
 * On failure, the assertion message is the verbatim AJV error list
 * (`{instancePath, schemaPath, keyword, params, message}` per error) so the
 * schema author / runtime author can see exactly which field/value broke.
 */

const SCHEMA_PATH = path.resolve('.agents/schemas/dispatch-manifest.json');

function loadValidator() {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf-8'));
  return ajv.compile(schema);
}

function formatErrors(errors) {
  return (errors ?? [])
    .map(
      (e) =>
        `  ${e.instancePath || '/'}: ${e.keyword} ${
          e.message ?? ''
        } ${JSON.stringify(e.params)}`,
    )
    .join('\n');
}

function assertValid(validator, payload, label) {
  const ok = validator(payload);
  assert.equal(
    ok,
    true,
    `[${label}] manifest failed schema validation:\n${formatErrors(
      validator.errors,
    )}\n--- payload ---\n${JSON.stringify(payload, null, 2)}`,
  );
}

describe('dispatch-manifest schema drift (AJV fixture)', () => {
  it('buildManifest() output validates as epic-dispatch', () => {
    const validator = loadValidator();

    const epic = {
      id: 50,
      title: 'Epic Fifty',
      body: '',
      labels: ['type::epic'],
    };
    const story = {
      id: 100,
      title: 'Story One Hundred',
      body: 'Epic: #50',
      labels: ['type::story', 'complexity::high'],
    };
    const taskTicket1 = {
      id: 101,
      title: 'Task A',
      state: 'open',
      labels: ['type::task', 'agent::ready'],
      body: 'parent: #100\n\nPersona: engineer\nMode: fast\nSkills: a, b\nFocus Areas: lib/x',
    };
    const taskTicket2 = {
      id: 102,
      title: 'Task B',
      state: 'open',
      labels: ['type::task', 'agent::ready'],
      body: 'parent: #100\nBlocked by: #101\n\nPersona: architect\nMode: planning\nSkills:\nFocus Areas:',
    };

    const tasks = parseTasks([taskTicket1, taskTicket2]);
    const allTickets = [epic, story, taskTicket1, taskTicket2];
    const waves = [[tasks[0]], [tasks[1]]];

    const manifest = buildManifest({
      epicId: 50,
      epic,
      tasks,
      allTickets,
      waves,
      dispatched: [
        { taskId: 101, dispatchId: 'dispatch-101', status: 'dispatched' },
      ],
      dryRun: false,
      adapter: { executorId: 'manual' },
      agentTelemetry: { runId: 'r-1', runner: 'epic-runner@5.30.0' },
    });

    assertValid(validator, manifest, 'epic-dispatch');

    assert.equal(manifest.storyManifest[0].storyTitle, 'Story One Hundred');
    assert.equal(manifest.storyManifest[0].type, 'story');
    assert.equal(manifest.storyManifest[0].tasks[0].status, 'agent::ready');
    assert.deepEqual(manifest.agentTelemetry, {
      runId: 'r-1',
      runner: 'epic-runner@5.30.0',
    });
  });

  it('buildManifest() output validates with default (null) agentTelemetry', () => {
    const validator = loadValidator();

    const epic = { id: 60, title: 'Epic Sixty', body: '', labels: [] };
    const tasks = parseTasks([]);

    const manifest = buildManifest({
      epicId: 60,
      epic,
      tasks,
      allTickets: [epic],
      waves: [],
      dispatched: [],
      dryRun: true,
      adapter: { executorId: 'manual' },
    });

    assertValid(validator, manifest, 'epic-dispatch (empty)');
    assert.equal(manifest.agentTelemetry, null);
  });

  it('executeStory() output validates as story-execution', async () => {
    const validator = loadValidator();

    const provider = new MockProvider({
      tickets: {
        700: {
          id: 700,
          title: 'Story Seven Hundred',
          state: 'open',
          labels: ['type::story'],
          body: 'Epic: #50',
        },
        701: {
          id: 701,
          title: 'Task Seven-One',
          state: 'open',
          labels: ['type::task', 'agent::ready'],
          body: 'parent: #700',
        },
      },
    });
    provider.getTickets = async () =>
      Object.values(provider.tickets).filter((t) =>
        t.labels.includes('type::task'),
      );

    const manifest = await executeStory({
      story: provider.tickets[700],
      provider,
      dryRun: false,
    });

    assertValid(validator, manifest, 'story-execution');
    assert.equal(manifest.type, 'story-execution');
    assert.equal(manifest.stories[0].storyTitle, 'Story Seven Hundred');
  });

  it('rejects an epic-dispatch manifest missing required summary', () => {
    const validator = loadValidator();

    const epic = { id: 70, title: 'Epic Seventy', body: '', labels: [] };
    const tasks = parseTasks([]);
    const manifest = buildManifest({
      epicId: 70,
      epic,
      tasks,
      allTickets: [epic],
      waves: [],
      dispatched: [],
      dryRun: true,
      adapter: { executorId: 'manual' },
    });

    delete manifest.summary;

    const ok = validator(manifest);
    assert.equal(ok, false, 'missing summary should fail validation');
    const messages = formatErrors(validator.errors);
    assert.match(messages, /summary/);
  });

  it('rejects a story-execution manifest with malformed tasks', () => {
    const validator = loadValidator();

    const bad = {
      type: 'story-execution',
      generatedAt: new Date().toISOString(),
      dryRun: false,
      stories: [
        {
          storyId: 800,
          storyTitle: 'Story Eight Hundred',
          epicId: 50,
          epicBranch: 'epic/50',
          branchName: 'story-800',
          tasks: [{ taskId: 'not-a-number', title: 'X', status: 'open' }],
        },
      ],
    };

    const ok = validator(bad);
    assert.equal(ok, false, 'non-integer taskId should fail validation');
  });
});

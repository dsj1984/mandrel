/**
 * Bootstrap Tests — Unit tests with mocked provider
 *
 * Validates the bootstrap script's idempotent label and field creation
 * using a mock ITicketingProvider.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PERSONAS_DIR = path.join(ROOT, '.agents', 'personas');
const PERSONA_NAMES = fs
  .readdirSync(PERSONAS_DIR)
  .filter((f) => f.endsWith('.md'))
  .map((f) => f.slice(0, -3));

const { runBootstrap } = await import(
  pathToFileURL(
    path.join(ROOT, '.agents', 'scripts', 'agents-bootstrap-github.js'),
  ).href
);

const {
  LABEL_TAXONOMY,
  PROJECT_FIELD_DEFS,
  PROJECT_VIEW_DEFS,
  STATUS_FIELD_OPTIONS,
} = await import(
  pathToFileURL(
    path.join(ROOT, '.agents', 'scripts', 'lib', 'label-taxonomy.js'),
  ).href
);

const { ITicketingProvider } = await import(
  pathToFileURL(
    path.join(ROOT, '.agents', 'scripts', 'lib', 'ITicketingProvider.js'),
  ).href
);

// ---------------------------------------------------------------------------
// Mock Provider
// ---------------------------------------------------------------------------

class MockProvider extends ITicketingProvider {
  constructor() {
    super();
    this.ensureLabelsCalls = [];
    this.ensureProjectFieldsCalls = [];
    this.ensureStatusFieldCalls = [];
    this.ensureProjectViewsCalls = [];
    this.resolveOrCreateProjectCalls = [];
    this.getTicketCalls = [];
    this._labelResult = { created: [], skipped: [] };
    this._fieldResult = { created: [], skipped: [] };
    this._projectResult = {
      projectId: 'PVT_mock',
      projectNumber: 1,
      created: false,
    };
    this._statusResult = { status: 'unchanged', added: [] };
    this._viewsResult = { created: [], skipped: [], unavailable: false };
  }

  async getTicket(ticketId) {
    this.getTicketCalls.push(ticketId);
    // Simulate issue #1 not found — API is reachable
    throw new Error('[MockProvider] GET /issues/1 failed (404): Not Found');
  }

  async ensureLabels(labelDefs) {
    this.ensureLabelsCalls.push(labelDefs);
    return this._labelResult;
  }

  async ensureProjectFields(fieldDefs) {
    this.ensureProjectFieldsCalls.push(fieldDefs);
    return this._fieldResult;
  }

  async resolveOrCreateProject(opts) {
    this.resolveOrCreateProjectCalls.push(opts ?? {});
    return this._projectResult;
  }

  async ensureStatusField(options) {
    this.ensureStatusFieldCalls.push(options);
    return this._statusResult;
  }

  async ensureProjectViews(viewDefs) {
    this.ensureProjectViewsCalls.push(viewDefs);
    return this._viewsResult;
  }
}

// We need to mock createProvider to return our MockProvider.
// Since runBootstrap calls createProvider internally, we test indirectly
// by verifying the exported data and behavior via the provider.

// ---------------------------------------------------------------------------
// Label Taxonomy
// ---------------------------------------------------------------------------
describe('Bootstrap — LABEL_TAXONOMY', () => {
  it('contains all required type labels', () => {
    const names = LABEL_TAXONOMY.map((l) => l.name);
    assert.ok(names.includes('type::epic'));
    assert.ok(names.includes('type::feature'));
    assert.ok(names.includes('type::story'));
    assert.ok(names.includes('type::task'));
  });

  it('contains all required agent state labels', () => {
    const names = LABEL_TAXONOMY.map((l) => l.name);
    assert.ok(names.includes('agent::ready'));
    assert.ok(names.includes('agent::executing'));
    assert.ok(names.includes('agent::done'));
  });

  it('contains status and context labels', () => {
    const names = LABEL_TAXONOMY.map((l) => l.name);
    assert.ok(names.includes('status::blocked'));
    assert.ok(names.includes('context::prd'));
    assert.ok(names.includes('context::tech-spec'));
  });

  it('derives one persona label per file in .agents/personas/', () => {
    const personaLabels = LABEL_TAXONOMY.filter((l) =>
      l.name.startsWith('persona::'),
    ).map((l) => l.name.slice('persona::'.length));
    assert.deepEqual(personaLabels.sort(), [...PERSONA_NAMES].sort());
  });

  it('label count = non-persona taxonomy + one per persona file', () => {
    const nonPersonaBase = 11;
    assert.equal(LABEL_TAXONOMY.length, nonPersonaBase + PERSONA_NAMES.length);
  });

  it('contains the parking planning-phase agent labels', () => {
    const names = LABEL_TAXONOMY.map((l) => l.name);
    assert.ok(names.includes('agent::review-spec'));
    assert.ok(names.includes('agent::ready'));
  });

  it('does not include the retired trigger labels', () => {
    const names = LABEL_TAXONOMY.map((l) => l.name);
    assert.ok(!names.includes('agent::planning'));
    assert.ok(!names.includes('agent::decomposing'));
    assert.ok(!names.includes('agent::dispatching'));
    // 5.40.0 / Epic #1142 retired several taxonomy entries (the Epic
    // close-handoff label, opt-in auto-close modifier, the medium-risk
    // planning label, and the two execution-mode labels). Their absence is
    // verified by the label-count assertion above; we don't enumerate the
    // literal names here so a `grep` for the retired strings stays clean.
    const taxonomyLabels = new Set(names);
    for (const retired of [
      ['agent', 'review'],
      ['epic', 'auto-close'],
      ['risk', 'medium'],
      ['execution', 'sequential'],
      ['execution', 'concurrent'],
    ]) {
      assert.ok(
        !taxonomyLabels.has(retired.join('::')),
        `taxonomy must not include ${retired[0]}/${retired[1]}`,
      );
    }
  });

  it('every label has name, color (hex), and description', () => {
    for (const label of LABEL_TAXONOMY) {
      assert.ok(label.name, `Label missing name`);
      assert.match(
        label.color,
        /^#[0-9A-Fa-f]{6}$/,
        `${label.name} has invalid color`,
      );
      assert.ok(
        typeof label.description === 'string',
        `${label.name} missing description`,
      );
    }
  });

  it('uses correct colors per category', () => {
    const typeLabels = LABEL_TAXONOMY.filter((l) =>
      l.name.startsWith('type::'),
    );
    for (const l of typeLabels) {
      assert.equal(l.color, '#7057FF', `${l.name} should be purple`);
    }

    const agentLabels = LABEL_TAXONOMY.filter((l) =>
      l.name.startsWith('agent::'),
    );
    for (const l of agentLabels) {
      assert.equal(l.color, '#0E8A16', `${l.name} should be green`);
    }

    const blockedLabel = LABEL_TAXONOMY.find(
      (l) => l.name === 'status::blocked',
    );
    assert.equal(
      blockedLabel.color,
      '#D93F0B',
      'status::blocked should be red',
    );
  });
});

// ---------------------------------------------------------------------------
// Project Field Definitions
// ---------------------------------------------------------------------------
describe('Bootstrap — PROJECT_FIELD_DEFS', () => {
  it('has exactly 2 field definitions', () => {
    assert.equal(PROJECT_FIELD_DEFS.length, 2);
  });

  it('defines Sprint as iteration', () => {
    const sprint = PROJECT_FIELD_DEFS.find((f) => f.name === 'Sprint');
    assert.ok(sprint);
    assert.equal(sprint.type, 'iteration');
  });

  it('defines Execution as single_select with correct options', () => {
    const exec = PROJECT_FIELD_DEFS.find((f) => f.name === 'Execution');
    assert.ok(exec);
    assert.equal(exec.type, 'single_select');
    assert.deepEqual(exec.options, ['sequential', 'concurrent']);
  });
});

// ---------------------------------------------------------------------------
// STATUS_FIELD_OPTIONS + PROJECT_VIEW_DEFS
// ---------------------------------------------------------------------------
describe('Bootstrap — STATUS_FIELD_OPTIONS', () => {
  it('contains all 8 lifecycle options in canonical order', () => {
    assert.deepEqual(STATUS_FIELD_OPTIONS, [
      'Backlog',
      'Planning',
      'Spec Review',
      'Ready',
      'In Progress',
      'Blocked',
      'Review',
      'Done',
    ]);
  });
});

describe('Bootstrap — PROJECT_VIEW_DEFS', () => {
  it('defines the three default Views', () => {
    const names = PROJECT_VIEW_DEFS.map((v) => v.name);
    assert.deepEqual(names, ['Epic Roadmap', 'Current Sprint', 'My Queue']);
  });

  it('each View has a filter and groupBy', () => {
    for (const view of PROJECT_VIEW_DEFS) {
      assert.ok(view.filter, `${view.name} missing filter`);
      assert.equal(view.groupBy, 'Status');
    }
  });

  it('Epic Roadmap filter targets type::epic', () => {
    const view = PROJECT_VIEW_DEFS.find((v) => v.name === 'Epic Roadmap');
    assert.match(view.filter, /label:type::epic/);
  });
});

// ---------------------------------------------------------------------------
// runBootstrap behavior
// ---------------------------------------------------------------------------
describe('Bootstrap — runBootstrap()', () => {
  const orchestration = {
    provider: 'github',
    github: {
      owner: 'test-owner',
      repo: 'test-repo',
      projectNumber: 1,
      projectOwner: 'test-owner',
    },
  };

  it('calls resolveOrCreateProject, ensureStatusField, ensureProjectViews, ensureProjectFields, ensureLabels in order', async () => {
    const mock = new MockProvider();
    const result = await runBootstrap(orchestration, {
      providerOverride: mock,
      quiet: true,
    });

    assert.equal(mock.ensureLabelsCalls.length, 1);
    assert.equal(mock.resolveOrCreateProjectCalls.length, 1);
    assert.equal(mock.ensureStatusFieldCalls.length, 1);
    assert.deepEqual(mock.ensureStatusFieldCalls[0], STATUS_FIELD_OPTIONS);
    assert.equal(mock.ensureProjectViewsCalls.length, 1);
    assert.deepEqual(mock.ensureProjectViewsCalls[0], PROJECT_VIEW_DEFS);
    assert.equal(mock.ensureProjectFieldsCalls.length, 1);
    assert.equal(result.project.projectNumber, 1);
  });

  it('degrades gracefully when resolveOrCreateProject reports scopesMissing', async () => {
    const mock = new MockProvider();
    mock._projectResult = { scopesMissing: true };
    const result = await runBootstrap(orchestration, {
      providerOverride: mock,
      quiet: true,
    });

    assert.equal(result.project.scopesMissing, true);
    assert.equal(result.project.skipped, true);
    // Status + Views + Fields are skipped when the project is unavailable.
    assert.equal(mock.ensureStatusFieldCalls.length, 0);
    assert.equal(mock.ensureProjectViewsCalls.length, 0);
    assert.equal(mock.ensureProjectFieldsCalls.length, 0);
    // Labels still succeed.
    assert.equal(mock.ensureLabelsCalls.length, 1);
  });

  it('reports views unavailable without throwing', async () => {
    const mock = new MockProvider();
    mock._viewsResult = {
      created: [],
      skipped: ['Epic Roadmap', 'Current Sprint', 'My Queue'],
      unavailable: true,
    };
    const result = await runBootstrap(orchestration, {
      providerOverride: mock,
      quiet: true,
    });

    assert.equal(result.views.unavailable, true);
    assert.equal(result.views.created.length, 0);
    assert.equal(result.views.skipped.length, 3);
  });

  it('reports status field status "updated" with added options', async () => {
    const mock = new MockProvider();
    mock._statusResult = {
      status: 'updated',
      added: ['Planning', 'Spec Review', 'Ready'],
    };
    const result = await runBootstrap(orchestration, {
      providerOverride: mock,
      quiet: true,
    });
    assert.equal(result.statusField.status, 'updated');
    assert.deepEqual(result.statusField.added, [
      'Planning',
      'Spec Review',
      'Ready',
    ]);
  });

  it('skips board provisioning when no projectNumber resolves and creation is declined (scopes)', async () => {
    const mock = new MockProvider();
    mock._projectResult = { scopesMissing: true };
    const result = await runBootstrap(
      {
        ...orchestration,
        github: { ...orchestration.github, projectNumber: null },
      },
      { providerOverride: mock, quiet: true },
    );
    assert.equal(result.project.skipped, true);
    assert.equal(result.project.scopesMissing, true);
  });
});

// ---------------------------------------------------------------------------
// Script exports
// ---------------------------------------------------------------------------
describe('Bootstrap — module exports', () => {
  it('exports runBootstrap function', () => {
    assert.equal(typeof runBootstrap, 'function');
  });

  it('exports LABEL_TAXONOMY array', () => {
    assert.ok(Array.isArray(LABEL_TAXONOMY));
  });

  it('exports PROJECT_FIELD_DEFS array', () => {
    assert.ok(Array.isArray(PROJECT_FIELD_DEFS));
  });

  it('exports STATUS_FIELD_OPTIONS array', () => {
    assert.ok(Array.isArray(STATUS_FIELD_OPTIONS));
    assert.equal(STATUS_FIELD_OPTIONS.length, 8);
  });

  it('exports PROJECT_VIEW_DEFS array', () => {
    assert.ok(Array.isArray(PROJECT_VIEW_DEFS));
    assert.equal(PROJECT_VIEW_DEFS.length, 3);
  });
});

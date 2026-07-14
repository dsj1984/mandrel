/**
 * Bootstrap Tests — Unit tests with mocked provider
 *
 * Validates the bootstrap script's idempotent label and field creation
 * using a mock ITicketingProvider.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

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
    // Stage 5 hard cutover — the type axis is Story-only.
    const typeLabels = names.filter((n) => n.startsWith('type::')).sort();
    assert.deepEqual(typeLabels, ['type::story']);
  });

  it('contains all required agent state labels', () => {
    const names = LABEL_TAXONOMY.map((l) => l.name);
    assert.ok(names.includes('agent::ready'));
    assert.ok(names.includes('agent::executing'));
    assert.ok(names.includes('agent::done'));
  });

  it('contains status labels; the context axis is fully retired', () => {
    const names = LABEL_TAXONOMY.map((l) => l.name);
    assert.ok(names.includes('status::blocked'));
    // Story #4314 retired `context::prd`; Story #4324 retired the rest of
    // the context axis (Tech Spec / Acceptance Spec now live as managed
    // sections of the Epic body) — no `context::*` label is provisioned.
    assert.ok(!names.includes('context::prd'));
    assert.ok(!names.includes('context::tech-spec'));
    assert.ok(!names.includes('context::acceptance-spec'));
    assert.equal(names.filter((n) => n.startsWith('context::')).length, 0);
  });

  it('keeps the acceptance::n-a waiver label (survives Story #4324)', () => {
    // The waiver survives the context-ticket fold with unchanged meaning:
    // it now waives the Epic body's `## Acceptance Table` section.
    const names = LABEL_TAXONOMY.map((l) => l.name);
    assert.ok(names.includes('acceptance::n-a'));
  });

  it('does not provision persona::* labels (concept deleted in v2)', () => {
    const personaLabels = LABEL_TAXONOMY.filter((l) =>
      l.name.startsWith('persona::'),
    );
    assert.deepEqual(personaLabels, []);
  });

  it('label count matches the Story-only taxonomy (no persona axis)', () => {
    // Story #2144 — added `agent::closing` to the taxonomy as the
    // intermediate state between executing and done.
    // Story #2921 (Epic #2880 F7) — added `planning::healthcheck-waived`
    // as the operator override for the post-plan readiness healthcheck.
    // Epic #3078 Task #3155 — `type::task` removed (2-tier hard cutover).
    // Story #3704 — removed `plan::acknowledged` (story-plan ack feature
    // retired in a hard cutover).
    // Story #4041 — removed the Feature tier label (2-tier hard cutover).
    // Story #4314 — removed the `context::prd` label (PRD artifact retired).
    // Story #4324 — removed `context::tech-spec` + `context::acceptance-spec`
    // (planning content folded into managed Epic-body sections).
    // Epic #4474 PR4 — added `delivery::single` (single-delivery routing
    // marker applied by plan-persist.js; inert until #4475).
    // v2 persona deletion — removed the `persona::*` axis entirely.
    const taxonomyBase = 10;
    assert.equal(LABEL_TAXONOMY.length, taxonomyBase);
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
  it('has exactly 1 field definition', () => {
    assert.equal(PROJECT_FIELD_DEFS.length, 1);
  });

  it('defines Execution as single_select with correct options', () => {
    const exec = PROJECT_FIELD_DEFS.find((f) => f.name === 'Execution');
    assert.ok(exec);
    assert.equal(exec.type, 'single_select');
    assert.deepEqual(exec.options, ['sequential', 'concurrent']);
  });
});

// ---------------------------------------------------------------------------
// STATUS_FIELD_OPTIONS
// ---------------------------------------------------------------------------
describe('Bootstrap — STATUS_FIELD_OPTIONS', () => {
  it('contains the three stock Status options in canonical order', () => {
    assert.deepEqual(STATUS_FIELD_OPTIONS, ['Todo', 'In Progress', 'Done']);
  });
});

// PROJECT_VIEW_DEFS was hard-cutover deleted in Story #4234.
describe('Bootstrap — PROJECT_VIEW_DEFS (deleted in Story #4234)', () => {
  it('is no longer exported from label-taxonomy.js', () => {
    assert.equal(PROJECT_VIEW_DEFS, undefined);
  });
});

// ---------------------------------------------------------------------------
// runBootstrap behavior
// ---------------------------------------------------------------------------
describe('Bootstrap — runBootstrap()', () => {
  const config = {
    provider: 'github',
    github: {
      owner: 'test-owner',
      repo: 'test-repo',
      projectNumber: 1,
      projectOwner: 'test-owner',
    },
  };

  it('calls resolveOrCreateProject, ensureStatusField, ensureProjectFields, ensureLabels in order when withProjectBoard: true', async () => {
    const mock = new MockProvider();
    const result = await runBootstrap(config, {
      providerOverride: mock,
      quiet: true,
      githubAdminApproved: true,
      withProjectBoard: true,
    });

    assert.equal(mock.ensureLabelsCalls.length, 1);
    assert.equal(mock.resolveOrCreateProjectCalls.length, 1);
    assert.equal(mock.ensureStatusFieldCalls.length, 1);
    assert.deepEqual(mock.ensureStatusFieldCalls[0], STATUS_FIELD_OPTIONS);
    assert.equal(mock.ensureProjectFieldsCalls.length, 1);
    assert.equal(result.project.projectNumber, 1);
  });

  it('skips board calls when withProjectBoard is not set (opt-in default off)', async () => {
    const mock = new MockProvider();
    const result = await runBootstrap(config, {
      providerOverride: mock,
      quiet: true,
      githubAdminApproved: true,
    });

    assert.equal(mock.ensureLabelsCalls.length, 1);
    assert.equal(mock.resolveOrCreateProjectCalls.length, 0);
    assert.equal(mock.ensureStatusFieldCalls.length, 0);
    assert.equal(mock.ensureProjectFieldsCalls.length, 0);
    assert.ok(result.labels);
  });

  it('degrades gracefully when resolveOrCreateProject reports scopesMissing', async () => {
    const mock = new MockProvider();
    mock._projectResult = { scopesMissing: true };
    const result = await runBootstrap(config, {
      providerOverride: mock,
      quiet: true,
      githubAdminApproved: true,
      withProjectBoard: true,
    });

    assert.equal(result.project.scopesMissing, true);
    assert.equal(result.project.skipped, true);
    // Status + Fields are skipped when the project is unavailable.
    assert.equal(mock.ensureStatusFieldCalls.length, 0);
    assert.equal(mock.ensureProjectFieldsCalls.length, 0);
    // Labels still succeed.
    assert.equal(mock.ensureLabelsCalls.length, 1);
  });

  it('reports status field status "updated" with added options', async () => {
    const mock = new MockProvider();
    mock._statusResult = {
      status: 'updated',
      added: ['Todo'],
    };
    const result = await runBootstrap(config, {
      providerOverride: mock,
      quiet: true,
      githubAdminApproved: true,
      withProjectBoard: true,
    });
    assert.equal(result.statusField.status, 'updated');
    assert.deepEqual(result.statusField.added, ['Todo']);
  });

  it('skips board provisioning when no projectNumber resolves and creation is declined (scopes)', async () => {
    const mock = new MockProvider();
    mock._projectResult = { scopesMissing: true };
    const result = await runBootstrap(
      {
        ...config,
        github: { ...config.github, projectNumber: null },
      },
      {
        providerOverride: mock,
        quiet: true,
        githubAdminApproved: true,
        withProjectBoard: true,
      },
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
    assert.equal(STATUS_FIELD_OPTIONS.length, 3);
  });

  it('does not export PROJECT_VIEW_DEFS (hard-cutover deleted in Story #4234)', () => {
    assert.equal(PROJECT_VIEW_DEFS, undefined);
  });
});

// ---------------------------------------------------------------------------
// Story #2018 (Bug 1) — verifyApiAccess() 404 detection.
//
// The original implementation matched on `err.message.includes('404')`,
// which doesn't fire for `gh-exec`-classified errors (their message is
// `gh-exec: resource not found`, no `'404'` substring). A fresh-repo
// bootstrap therefore fatal-failed on the preflight even though issue #1
// genuinely doesn't exist on a brand-new repo. The fix matches both the
// typed-error surface (`err.name === 'GhNotFoundError'`) and a richer set
// of message/stderr patterns.
// ---------------------------------------------------------------------------
describe('Bootstrap — verifyApiAccess() (Story #2018, Bug 1)', () => {
  let isApiAccessNotFoundError;
  let verifyApiAccess;

  it('loads the helpers', async () => {
    const mod = await import(
      pathToFileURL(
        path.join(ROOT, '.agents', 'scripts', 'agents-bootstrap-github.js'),
      ).href
    );
    isApiAccessNotFoundError = mod.isApiAccessNotFoundError;
    verifyApiAccess = mod.verifyApiAccess;
    assert.equal(typeof isApiAccessNotFoundError, 'function');
    assert.equal(typeof verifyApiAccess, 'function');
  });

  it('isApiAccessNotFoundError matches GhNotFoundError by name', () => {
    const err = new Error('gh-exec: resource not found');
    err.name = 'GhNotFoundError';
    err.stderr = 'HTTP 404: Not Found';
    assert.equal(isApiAccessNotFoundError(err), true);
  });

  it('isApiAccessNotFoundError matches the bare "resource not found" message', () => {
    const err = new Error('gh-exec: resource not found');
    assert.equal(isApiAccessNotFoundError(err), true);
  });

  it('isApiAccessNotFoundError matches legacy "failed (404)" phrasing', () => {
    const err = new Error('GET /issues/1 failed (404): Not Found');
    assert.equal(isApiAccessNotFoundError(err), true);
  });

  it('isApiAccessNotFoundError rejects auth/scope/transport errors', () => {
    const authErr = new Error('gh-exec: gh is not authenticated');
    authErr.name = 'GhAuthError';
    assert.equal(isApiAccessNotFoundError(authErr), false);

    const scopeErr = new Error('gh-exec: gh token is missing a required scope');
    scopeErr.name = 'GhScopeError';
    assert.equal(isApiAccessNotFoundError(scopeErr), false);

    const rateErr = new Error('gh-exec: gh API rate limit exceeded');
    rateErr.name = 'GhRateLimitError';
    assert.equal(isApiAccessNotFoundError(rateErr), false);
  });

  it('verifyApiAccess swallows GhNotFoundError', async () => {
    const provider = {
      async getTicket() {
        const err = new Error('gh-exec: resource not found');
        err.name = 'GhNotFoundError';
        throw err;
      },
    };
    await verifyApiAccess(provider); // must not throw
  });

  it('verifyApiAccess rethrows non-not-found errors', async () => {
    const provider = {
      async getTicket() {
        const err = new Error('gh-exec: gh is not authenticated');
        err.name = 'GhAuthError';
        throw err;
      },
    };
    await assert.rejects(
      verifyApiAccess(provider),
      /API access verification failed/,
    );
  });
});

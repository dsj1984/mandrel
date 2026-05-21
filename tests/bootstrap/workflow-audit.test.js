import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  auditProjectWorkflows,
  COMPATIBLE_WORKFLOWS,
  CONFLICTING_WORKFLOWS,
  classifyWorkflow,
  formatAuditSummary,
  reapConflictingWorkflows,
  resolveProjectIdByNumber,
} from '../../.agents/scripts/lib/bootstrap/workflow-audit.js';

function makeProvider({
  workflowsByProjectId = {},
  viewerProjectId = null,
  throwOnDelete = null,
} = {}) {
  const calls = { graphql: [] };
  return {
    calls,
    async graphql(query, vars) {
      calls.graphql.push({ query, vars });
      if (query.includes('viewer') && query.includes('projectV2')) {
        if (viewerProjectId === 'THROW') throw new Error('scope missing');
        return {
          viewer: {
            projectV2: viewerProjectId ? { id: viewerProjectId } : null,
          },
        };
      }
      if (query.includes('node(id:') || query.includes('node(id: $projectId')) {
        const nodes = workflowsByProjectId[vars.projectId] ?? [];
        return { node: { workflows: { nodes } } };
      }
      if (query.includes('deleteProjectV2Workflow')) {
        if (throwOnDelete?.includes(vars.workflowId)) {
          throw new Error(`mock-delete-failure for ${vars.workflowId}`);
        }
        return { deleteProjectV2Workflow: { projectV2: { id: 'PRJ' } } };
      }
      throw new Error(
        `unexpected graphql query in test: ${query.slice(0, 80)}`,
      );
    },
  };
}

describe('classifyWorkflow', () => {
  it('flags enabled conflicting workflows as conflicting', () => {
    for (const name of CONFLICTING_WORKFLOWS) {
      assert.equal(classifyWorkflow({ name, enabled: true }), 'conflicting');
    }
  });

  it('passes enabled compatible workflows as compatible', () => {
    for (const name of COMPATIBLE_WORKFLOWS) {
      assert.equal(classifyWorkflow({ name, enabled: true }), 'compatible');
    }
  });

  it('reports disabled conflicting workflows separately so reap is no-op', () => {
    assert.equal(
      classifyWorkflow({ name: 'Pull request merged', enabled: false }),
      'disabled-conflicting',
    );
  });

  it('classifies unknown enabled workflows as unknown', () => {
    assert.equal(
      classifyWorkflow({ name: 'Custom workflow', enabled: true }),
      'unknown',
    );
  });

  it('classifies unknown disabled workflows as disabled-other', () => {
    assert.equal(
      classifyWorkflow({ name: 'Custom workflow', enabled: false }),
      'disabled-other',
    );
  });
});

describe('auditProjectWorkflows', () => {
  it('partitions the project workflows into conflicting / compatible / unknown / disabled', async () => {
    const provider = makeProvider({
      workflowsByProjectId: {
        PRJ: [
          { id: 'w1', number: 1, name: 'Pull request merged', enabled: true },
          {
            id: 'w2',
            number: 2,
            name: 'Pull request linked to issue',
            enabled: true,
          },
          { id: 'w3', number: 3, name: 'Item closed', enabled: true },
          { id: 'w4', number: 4, name: 'Custom enabled', enabled: true },
          { id: 'w5', number: 5, name: 'Custom disabled', enabled: false },
        ],
      },
    });
    const audit = await auditProjectWorkflows({ provider, projectId: 'PRJ' });
    assert.equal(audit.total, 5);
    assert.deepEqual(
      audit.conflicting.map((w) => w.name),
      ['Pull request merged', 'Pull request linked to issue'],
    );
    assert.deepEqual(
      audit.compatible.map((w) => w.name),
      ['Item closed'],
    );
    assert.deepEqual(
      audit.unknown.map((w) => w.name),
      ['Custom enabled'],
    );
    assert.deepEqual(
      audit.disabled.map((w) => w.name),
      ['Custom disabled'],
    );
  });

  it('handles a project with no workflows gracefully', async () => {
    const provider = makeProvider({ workflowsByProjectId: { PRJ: [] } });
    const audit = await auditProjectWorkflows({ provider, projectId: 'PRJ' });
    assert.equal(audit.total, 0);
    assert.equal(audit.conflicting.length, 0);
  });

  it('rejects bad inputs', async () => {
    await assert.rejects(
      auditProjectWorkflows({ provider: {}, projectId: 'PRJ' }),
      /provider with graphql/,
    );
    await assert.rejects(
      auditProjectWorkflows({ provider: makeProvider(), projectId: '' }),
      /non-empty projectId/,
    );
  });
});

describe('reapConflictingWorkflows', () => {
  it('deletes every workflow in the audit.conflicting set in order', async () => {
    const provider = makeProvider();
    const audit = {
      conflicting: [
        { id: 'w1', name: 'Pull request merged', number: 1 },
        { id: 'w2', name: 'Pull request linked to issue', number: 2 },
      ],
    };
    const { reaped } = await reapConflictingWorkflows({ provider, audit });
    assert.deepEqual(
      reaped.map((r) => r.id),
      ['w1', 'w2'],
    );
    const deleteCalls = provider.calls.graphql.filter((c) =>
      c.query.includes('deleteProjectV2Workflow'),
    );
    assert.equal(deleteCalls.length, 2);
  });

  it('fails fast and names the surviving offenders when a delete throws', async () => {
    const provider = makeProvider({ throwOnDelete: ['w2'] });
    const audit = {
      conflicting: [
        { id: 'w1', name: 'Pull request merged', number: 1 },
        { id: 'w2', name: 'Pull request linked to issue', number: 2 },
        { id: 'w3', name: 'Unreached', number: 3 },
      ],
    };
    await assert.rejects(
      reapConflictingWorkflows({ provider, audit }),
      /Failed to delete workflow "Pull request linked to issue".*1 workflow\(s\) were already deleted before this failure: Pull request merged/s,
    );
  });

  it('rejects malformed inputs', async () => {
    await assert.rejects(
      reapConflictingWorkflows({ provider: {}, audit: { conflicting: [] } }),
      /provider with graphql/,
    );
    await assert.rejects(
      reapConflictingWorkflows({ provider: makeProvider(), audit: null }),
      /audit envelope with .conflicting/,
    );
  });
});

describe('resolveProjectIdByNumber', () => {
  it('returns the viewer project id for a known number', async () => {
    const provider = makeProvider({ viewerProjectId: 'PVT_abc' });
    const id = await resolveProjectIdByNumber({ provider, projectNumber: 1 });
    assert.equal(id, 'PVT_abc');
  });

  it('returns null when the viewer cannot see the project', async () => {
    const provider = makeProvider({ viewerProjectId: null });
    assert.equal(
      await resolveProjectIdByNumber({ provider, projectNumber: 99 }),
      null,
    );
  });

  it('returns null on GraphQL failure (degrades gracefully)', async () => {
    const provider = makeProvider({ viewerProjectId: 'THROW' });
    assert.equal(
      await resolveProjectIdByNumber({ provider, projectNumber: 1 }),
      null,
    );
  });

  it('rejects bad inputs', async () => {
    await assert.rejects(
      resolveProjectIdByNumber({ provider: {}, projectNumber: 1 }),
      /provider with graphql/,
    );
    await assert.rejects(
      resolveProjectIdByNumber({ provider: makeProvider(), projectNumber: 0 }),
      /positive integer projectNumber/,
    );
  });
});

describe('formatAuditSummary', () => {
  it('renders counts in a stable single-line shape', () => {
    const audit = {
      total: 5,
      conflicting: [{ name: 'a' }, { name: 'b' }],
      compatible: [{ name: 'c' }],
      unknown: [{ name: 'd' }],
      disabled: [{ name: 'e' }],
    };
    assert.equal(
      formatAuditSummary(audit),
      'workflows: 5 scanned — 2 conflicting, 1 compatible, 1 unknown, 1 disabled',
    );
  });
});

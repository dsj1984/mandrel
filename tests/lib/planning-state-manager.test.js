import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PlanningStateManager } from '../../.agents/scripts/lib/orchestration/planning-state-manager.js';
import { MockProvider } from '../fixtures/mock-provider.js';

describe('PlanningStateManager', () => {
  it('heals dangling artifact references in the Epic object', async () => {
    const provider = new MockProvider({
      tickets: {
        10: {
          id: 10,
          title: 'Epic',
          body: 'Some description',
          labels: ['type::epic'],
        },
        11: {
          id: 11,
          title: '[PRD] Epic',
          body: 'parent: #10',
          labels: ['context::prd'],
          state: 'open',
        },
        12: {
          id: 12,
          title: '[Tech Spec] Epic',
          body: 'parent: #10',
          labels: ['context::tech-spec'],
          state: 'open',
        },
      },
    });

    const mgr = new PlanningStateManager(provider);
    const epic = {
      id: 10,
      title: 'Epic',
      body: 'Some description',
      linkedIssues: { prd: null, techSpec: null },
    };

    await mgr.healAndCleanupArtifacts(epic);

    // Should have filled linkedIssues from open tickets
    assert.strictEqual(epic.linkedIssues.prd, 11);
    assert.strictEqual(epic.linkedIssues.techSpec, 12);
  });

  it('closes redundant artifacts and detaches them', async () => {
    const provider = new MockProvider({
      tickets: {
        10: { id: 10, title: 'Epic', body: '', labels: ['type::epic'] },
        11: {
          id: 11,
          title: 'PRD 1',
          labels: ['context::prd'],
          state: 'open',
        },
        12: {
          id: 12,
          title: 'PRD 2',
          labels: ['context::prd'],
          state: 'open',
        },
      },
      subTickets: {
        10: [11, 12],
      },
    });

    const mgr = new PlanningStateManager(provider);
    const epic = {
      id: 10,
      title: 'Epic',
      body: '',
      linkedIssues: { prd: 11, techSpec: null },
    };

    // 12 is redundant because 11 is canonical
    await mgr.healAndCleanupArtifacts(epic);

    assert.strictEqual(provider.tickets[12].state, 'closed');
    assert.strictEqual(provider.tickets[11].state, 'open');
    // Redundant should be removed from subTickets
    assert.ok(!provider.subTickets[10].includes(12));
    assert.ok(provider.subTickets[10].includes(11));
  });

  it('force re-plan: closes all and strips body', async () => {
    const provider = new MockProvider({
      tickets: {
        10: {
          id: 10,
          title: 'Epic',
          body: 'Desc\n\n## Planning Artifacts\n- [ ] PRD: #11\n- [ ] Tech Spec: #12\n',
          labels: ['type::epic'],
        },
        11: { id: 11, labels: ['context::prd'], state: 'open' },
        12: { id: 12, labels: ['context::tech-spec'], state: 'open' },
      },
      subTickets: {
        10: [11, 12],
      },
    });

    const mgr = new PlanningStateManager(provider);
    const epic = {
      id: 10,
      title: 'Epic',
      body: provider.tickets[10].body,
      linkedIssues: { prd: 11, techSpec: 12 },
    };

    await mgr.healAndCleanupArtifacts(epic, true); // force=true

    assert.strictEqual(provider.tickets[11].state, 'closed');
    assert.strictEqual(provider.tickets[12].state, 'closed');
    assert.strictEqual(epic.linkedIssues.prd, null);
    assert.strictEqual(epic.linkedIssues.techSpec, null);
    assert.ok(!epic.body.includes('## Planning Artifacts'));
  });

  it('redundant-cleanup path caps in-flight close/detach mutations at 3', async () => {
    // Build 1 canonical PRD + 8 redundant PRDs so the cleanup burst is
    // wider than the cap. Track peak in-flight updateTicket calls.
    const tickets = {
      10: { id: 10, title: 'Epic', body: '', labels: ['type::epic'] },
      11: {
        id: 11,
        title: 'Canonical PRD',
        labels: ['context::prd'],
        state: 'open',
      },
    };
    const subList = [11];
    for (let i = 0; i < 8; i++) {
      const id = 100 + i;
      tickets[id] = {
        id,
        title: `Redundant PRD ${i}`,
        labels: ['context::prd'],
        state: 'open',
      };
      subList.push(id);
    }
    const provider = new MockProvider({
      tickets,
      subTickets: { 10: subList },
    });

    let inFlight = 0;
    let peakInFlight = 0;
    const baseUpdate = provider.updateTicket.bind(provider);
    provider.updateTicket = async (id, mutations) => {
      inFlight++;
      if (inFlight > peakInFlight) peakInFlight = inFlight;
      await new Promise((r) => setTimeout(r, 10));
      const result = await baseUpdate(id, mutations);
      inFlight--;
      return result;
    };

    const mgr = new PlanningStateManager(provider);
    const epic = {
      id: 10,
      title: 'Epic',
      body: '',
      linkedIssues: { prd: 11, techSpec: null },
    };

    await mgr.healAndCleanupArtifacts(epic);

    assert.ok(
      peakInFlight <= 3,
      `expected peak in-flight close mutations <= 3 but observed ${peakInFlight}`,
    );
    // All 8 redundant PRDs should now be closed.
    for (let i = 0; i < 8; i++) {
      assert.strictEqual(provider.tickets[100 + i].state, 'closed');
    }
    assert.strictEqual(provider.tickets[11].state, 'open');
  });

  it('force re-plan path caps in-flight close mutations at 3', async () => {
    // 10 stale planning artifacts so the --force burst is wider than the cap.
    const tickets = {
      10: { id: 10, title: 'Epic', body: '', labels: ['type::epic'] },
    };
    const ids = [];
    for (let i = 0; i < 10; i++) {
      const id = 200 + i;
      tickets[id] = {
        id,
        title: `Stale PRD ${i}`,
        labels: ['context::prd'],
        state: 'open',
      };
      ids.push(id);
    }
    const provider = new MockProvider({
      tickets,
      subTickets: { 10: ids },
    });

    let inFlight = 0;
    let peakInFlight = 0;
    const baseUpdate = provider.updateTicket.bind(provider);
    provider.updateTicket = async (id, mutations) => {
      inFlight++;
      if (inFlight > peakInFlight) peakInFlight = inFlight;
      await new Promise((r) => setTimeout(r, 10));
      const result = await baseUpdate(id, mutations);
      inFlight--;
      return result;
    };

    const mgr = new PlanningStateManager(provider);
    const epic = {
      id: 10,
      title: 'Epic',
      body: '',
      linkedIssues: { prd: 200, techSpec: null },
    };

    await mgr.healAndCleanupArtifacts(epic, true); // force=true

    assert.ok(
      peakInFlight <= 3,
      `expected peak in-flight force-close mutations <= 3 but observed ${peakInFlight}`,
    );
    for (const id of ids) {
      assert.strictEqual(provider.tickets[id].state, 'closed');
    }
  });

  it('idempotently appends Planning Artifacts section to body', async () => {
    const provider = new MockProvider({
      tickets: {
        10: {
          id: 10,
          title: 'Epic',
          body: 'Base body',
          labels: ['type::epic'],
        },
      },
    });

    const mgr = new PlanningStateManager(provider);
    const epic = {
      id: 10,
      title: 'Epic',
      body: 'Base body',
      linkedIssues: { prd: 11, techSpec: 12 },
    };

    await mgr.healAndCleanupArtifacts(epic);

    assert.ok(epic.body.includes('## Planning Artifacts'));
    assert.ok(epic.body.includes('PRD: #11'));
    assert.ok(epic.body.includes('Tech Spec: #12'));

    const lastUpdate = provider.updates[provider.updates.length - 1];
    assert.strictEqual(lastUpdate.id, 10);
    assert.ok(lastUpdate.mutations.body.includes('## Planning Artifacts'));
  });

  describe('computeReviewReadiness', () => {
    function buildProvider({
      epicLabels = ['type::epic', 'agent::review-spec'],
      prd,
      techSpec,
      acceptanceSpec,
    } = {}) {
      const tickets = {
        10: { id: 10, title: 'Epic', body: '', labels: epicLabels },
      };
      if (prd) {
        tickets[11] = {
          id: 11,
          title: 'PRD',
          labels: ['context::prd'],
          state: prd,
        };
      }
      if (techSpec) {
        tickets[12] = {
          id: 12,
          title: 'Tech Spec',
          labels: ['context::tech-spec'],
          state: techSpec,
        };
      }
      if (acceptanceSpec) {
        tickets[13] = {
          id: 13,
          title: 'Acceptance Spec',
          labels: ['context::acceptance-spec'],
          state: acceptanceSpec,
        };
      }
      return new MockProvider({ tickets });
    }

    it('returns ready=true when PRD, Tech Spec, and Acceptance Spec are all closed', async () => {
      const provider = buildProvider({
        prd: 'closed',
        techSpec: 'closed',
        acceptanceSpec: 'closed',
      });
      const mgr = new PlanningStateManager(provider);
      const verdict = await mgr.computeReviewReadiness(10);
      assert.strictEqual(verdict.ready, true);
      assert.strictEqual(verdict.reason, 'all-context-closed');
      assert.deepStrictEqual(verdict.contexts, {
        prd: 'closed',
        techSpec: 'closed',
        acceptanceSpec: 'closed',
      });
    });

    it('returns ready=true when acceptance-spec is missing but the Epic carries acceptance::n-a', async () => {
      const provider = buildProvider({
        epicLabels: ['type::epic', 'agent::review-spec', 'acceptance::n-a'],
        prd: 'closed',
        techSpec: 'closed',
      });
      const mgr = new PlanningStateManager(provider);
      const verdict = await mgr.computeReviewReadiness(10);
      assert.strictEqual(verdict.ready, true);
      assert.strictEqual(verdict.reason, 'acceptance-waived');
      assert.strictEqual(verdict.contexts.acceptanceSpec, 'waived');
    });

    it('returns ready=false with reason "acceptance-spec-missing" when acceptance spec is absent and not waived', async () => {
      const provider = buildProvider({
        prd: 'closed',
        techSpec: 'closed',
      });
      const mgr = new PlanningStateManager(provider);
      const verdict = await mgr.computeReviewReadiness(10);
      assert.strictEqual(verdict.ready, false);
      assert.strictEqual(verdict.reason, 'acceptance-spec-missing');
    });

    it('returns ready=false with reason "acceptance-spec-open" when acceptance spec is still open', async () => {
      const provider = buildProvider({
        prd: 'closed',
        techSpec: 'closed',
        acceptanceSpec: 'open',
      });
      const mgr = new PlanningStateManager(provider);
      const verdict = await mgr.computeReviewReadiness(10);
      assert.strictEqual(verdict.ready, false);
      assert.strictEqual(verdict.reason, 'acceptance-spec-open');
    });

    it('returns ready=false with reason "prd-open" when PRD is still open, regardless of other axes', async () => {
      const provider = buildProvider({
        prd: 'open',
        techSpec: 'closed',
        acceptanceSpec: 'closed',
      });
      const mgr = new PlanningStateManager(provider);
      const verdict = await mgr.computeReviewReadiness(10);
      assert.strictEqual(verdict.ready, false);
      assert.strictEqual(verdict.reason, 'prd-open');
    });

    it('returns ready=false with reason "prd-missing" before any context tickets exist', async () => {
      const provider = buildProvider({});
      const mgr = new PlanningStateManager(provider);
      const verdict = await mgr.computeReviewReadiness(10);
      assert.strictEqual(verdict.ready, false);
      assert.strictEqual(verdict.reason, 'prd-missing');
    });

    describe('acceptance disposition waiver — Story #2792', () => {
      it('reports acceptance axis as waived when acceptance::n-a is present without a spec ticket', async () => {
        const provider = buildProvider({
          epicLabels: ['type::epic', 'agent::review-spec', 'acceptance::n-a'],
          prd: 'closed',
          techSpec: 'closed',
        });
        const mgr = new PlanningStateManager(provider);
        const verdict = await mgr.computeReviewReadiness(10);
        assert.strictEqual(verdict.ready, true);
        assert.strictEqual(verdict.reason, 'acceptance-waived');
        assert.strictEqual(verdict.contexts.acceptanceSpec, 'waived');
      });

      it('honours acceptance::n-a even when an open acceptance-spec ticket exists', async () => {
        const provider = buildProvider({
          epicLabels: ['type::epic', 'agent::review-spec', 'acceptance::n-a'],
          prd: 'closed',
          techSpec: 'closed',
          acceptanceSpec: 'open',
        });
        const mgr = new PlanningStateManager(provider);
        const verdict = await mgr.computeReviewReadiness(10);
        assert.strictEqual(verdict.ready, true);
        assert.strictEqual(verdict.reason, 'acceptance-waived');
        assert.strictEqual(verdict.contexts.acceptanceSpec, 'waived');
      });
    });
  });

  describe('flipEpicToReadyIfContextClosed', () => {
    it('flips the Epic from review-spec to ready when all context tickets are closed', async () => {
      const provider = new MockProvider({
        tickets: {
          10: {
            id: 10,
            title: 'Epic',
            body: '',
            labels: ['type::epic', 'agent::review-spec'],
          },
          11: {
            id: 11,
            title: 'PRD',
            labels: ['context::prd'],
            state: 'closed',
          },
          12: {
            id: 12,
            title: 'Tech Spec',
            labels: ['context::tech-spec'],
            state: 'closed',
          },
          13: {
            id: 13,
            title: 'Acceptance Spec',
            labels: ['context::acceptance-spec'],
            state: 'closed',
          },
        },
      });
      const mgr = new PlanningStateManager(provider);
      const result = await mgr.flipEpicToReadyIfContextClosed(10);
      assert.strictEqual(result.transitioned, true);
      assert.strictEqual(result.ready, true);
      const epic = await provider.getTicket(10);
      assert.ok(epic.labels.includes('agent::ready'));
      assert.ok(!epic.labels.includes('agent::review-spec'));
    });

    it('is a no-op when readiness is not yet satisfied', async () => {
      const provider = new MockProvider({
        tickets: {
          10: {
            id: 10,
            title: 'Epic',
            body: '',
            labels: ['type::epic', 'agent::review-spec'],
          },
          11: {
            id: 11,
            title: 'PRD',
            labels: ['context::prd'],
            state: 'open',
          },
        },
      });
      const mgr = new PlanningStateManager(provider);
      const result = await mgr.flipEpicToReadyIfContextClosed(10);
      assert.strictEqual(result.transitioned, false);
      assert.strictEqual(result.ready, false);
      const epic = await provider.getTicket(10);
      assert.ok(epic.labels.includes('agent::review-spec'));
      assert.ok(!epic.labels.includes('agent::ready'));
    });
  });
});

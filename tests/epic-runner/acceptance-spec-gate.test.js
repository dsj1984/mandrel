/**
 * Unit tests for the acceptance-spec start gate enforced by
 * `runSnapshotPhase` (Story #2101, Task #2108).
 *
 * The gate refuses to launch /epic-deliver when an Epic has neither the
 * `acceptance::n-a` waiver label nor an approved (closed)
 * `context::acceptance-spec` ticket.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runSnapshotPhase } from '../../.agents/scripts/lib/orchestration/epic-runner/phases/snapshot.js';

function buildProvider(tickets) {
  const byId = new Map(tickets.map((t) => [t.id, t]));
  return {
    async getTicket(id) {
      const t = byId.get(id);
      if (!t) throw new Error(`no ticket ${id}`);
      // Return a shallow clone so callers cannot mutate the fixture.
      return { ...t, labels: [...(t.labels ?? [])] };
    },
  };
}

describe('runSnapshotPhase — acceptance-spec start gate', () => {
  it('throws when no acceptance-spec is linked and acceptance::n-a is absent', async () => {
    const provider = buildProvider([
      { id: 9001, labels: ['type::epic', 'agent::executing'], body: '' },
    ]);
    await assert.rejects(
      () => runSnapshotPhase({ epicId: 9001, provider }, {}, {}),
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /Epic #9001 cannot launch/);
        assert.match(err.message, /no context::acceptance-spec is linked/);
        assert.match(err.message, /acceptance::n-a/);
        return true;
      },
    );
  });

  it('throws when the linked acceptance-spec ticket is still open', async () => {
    const provider = buildProvider([
      {
        id: 9002,
        labels: ['type::epic', 'agent::executing'],
        body: '## Planning Artifacts\n- [ ] Acceptance Spec: #9500\n',
      },
      {
        id: 9500,
        labels: ['type::ticket', 'context::acceptance-spec'],
        state: 'open',
      },
    ]);
    await assert.rejects(
      () => runSnapshotPhase({ epicId: 9002, provider }, {}, {}),
      (err) => {
        assert.match(err.message, /linked acceptance-spec #9500 is still open/);
        return true;
      },
    );
  });

  it('passes when acceptance::n-a label is present (waiver path)', async () => {
    const provider = buildProvider([
      {
        id: 9003,
        labels: ['type::epic', 'agent::executing', 'acceptance::n-a'],
        body: '',
      },
    ]);
    const result = await runSnapshotPhase({ epicId: 9003, provider }, {}, {});
    assert.equal(result.epic.id, 9003);
    assert.ok(result.epic.labels.includes('acceptance::n-a'));
  });

  it('passes when the linked acceptance-spec ticket is closed (approved)', async () => {
    const provider = buildProvider([
      {
        id: 9004,
        labels: ['type::epic', 'agent::executing'],
        body: '## Planning Artifacts\n- [x] Acceptance Spec: #9600\n',
      },
      {
        id: 9600,
        labels: ['type::ticket', 'context::acceptance-spec'],
        state: 'closed',
      },
    ]);
    const result = await runSnapshotPhase({ epicId: 9004, provider }, {}, {});
    assert.equal(result.epic.id, 9004);
  });

  it('honors a pre-populated `linkedIssues.acceptanceSpec` on the epic ticket', async () => {
    // The github provider's `getEpic` mapper attaches `linkedIssues`
    // directly; the gate must trust it over body parsing when present.
    const provider = buildProvider([
      {
        id: 9005,
        labels: ['type::epic'],
        body: '', // intentionally empty — the parsed body would say "no spec"
        linkedIssues: { prd: null, techSpec: null, acceptanceSpec: 9700 },
      },
      {
        id: 9700,
        labels: ['context::acceptance-spec'],
        state: 'closed',
      },
    ]);
    const result = await runSnapshotPhase({ epicId: 9005, provider }, {}, {});
    assert.equal(result.epic.id, 9005);
  });
});

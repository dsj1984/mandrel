/**
 * Unit tests for the (relaxed) acceptance-spec start gate enforced by
 * `runSnapshotPhase`.
 *
 * The gate refuses to launch /epic-deliver when an Epic has neither the
 * `acceptance::n-a` waiver label nor a linked `context::acceptance-spec`
 * ticket. Ticket state is **not** checked — presence is sufficient.
 * Closure is no longer required as the approval signal; the reviewer's
 * OK during /epic-plan Phase 7 is the approval contract.
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

  it('passes when the linked acceptance-spec ticket is still open (presence is enough)', async () => {
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
    const result = await runSnapshotPhase({ epicId: 9002, provider }, {}, {});
    assert.equal(result.epic.id, 9002);
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

  it('passes when the linked acceptance-spec ticket is closed', async () => {
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
      // Note: 9700 is not registered with the provider. The gate no longer
      // calls getTicket(acceptanceSpecId) — presence on the Epic is all
      // that's checked, so an unreachable spec id is irrelevant for this
      // gate. (The finalize-time reconciler still validates AC coverage
      // downstream.)
    ]);
    const result = await runSnapshotPhase({ epicId: 9005, provider }, {}, {});
    assert.equal(result.epic.id, 9005);
  });
});

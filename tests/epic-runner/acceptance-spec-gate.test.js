/**
 * Unit tests for the acceptance start gate enforced by `runSnapshotPhase`.
 *
 * Story #4324 folded the retired `context::acceptance-spec` ticket into the
 * Epic body: the gate refuses to launch /deliver when an Epic has neither
 * the `acceptance::n-a` waiver label nor an `## Acceptance Table` managed
 * section on its body. Section presence is sufficient — the reviewer's OK
 * during /plan Phase 7 is the approval contract; the gate does not inspect
 * the table's disposition contents.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { upsertEpicSection } from '../../.agents/scripts/lib/epic-body-sections.js';
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

/** Epic body carrying a well-formed `## Acceptance Table` managed section. */
function bodyWithAcceptanceTable(rows = '| AC-1 | outcome | f | s | new |') {
  return upsertEpicSection(
    '## Context\nEpic context.',
    'acceptanceTable',
    `## Acceptance Table\n| AC ID | Outcome | Feature File | Scenario | Disposition |\n| --- | --- | --- | --- | --- |\n${rows}`,
  );
}

describe('runSnapshotPhase — acceptance start gate', () => {
  it('throws when the acceptance-table section and acceptance::n-a are both absent', async () => {
    const provider = buildProvider([
      { id: 9001, labels: ['type::epic', 'agent::executing'], body: '' },
    ]);
    await assert.rejects(
      () => runSnapshotPhase({ epicId: 9001, provider }, {}, {}),
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /Epic #9001 cannot launch/);
        assert.match(err.message, /no ## Acceptance Table section/);
        assert.match(err.message, /acceptance::n-a/);
        return true;
      },
    );
  });

  it('passes when the Epic body carries the ## Acceptance Table managed section', async () => {
    const provider = buildProvider([
      {
        id: 9002,
        labels: ['type::epic', 'agent::executing'],
        body: bodyWithAcceptanceTable(),
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

  it('passes regardless of disposition contents (presence is enough)', async () => {
    // Rows already carrying close-time dispositions (satisfied / missing)
    // must not change the verdict — the gate checks section presence only.
    const provider = buildProvider([
      {
        id: 9004,
        labels: ['type::epic', 'agent::executing'],
        body: bodyWithAcceptanceTable(
          '| AC-1 | outcome | f | s | satisfied |\n| AC-2 | other | f | s | missing |',
        ),
      },
    ]);
    const result = await runSnapshotPhase({ epicId: 9004, provider }, {}, {});
    assert.equal(result.epic.id, 9004);
  });

  it('does not honor a legacy Planning Artifacts spec link (section or waiver only)', async () => {
    // Historical Epics linked a context::acceptance-spec ticket from the
    // retired `## Planning Artifacts` checklist. After the #4324 fold that
    // link no longer satisfies the gate — only the managed section (or the
    // waiver label) does. The legacy content must not crash the gate either.
    const provider = buildProvider([
      {
        id: 9005,
        labels: ['type::epic', 'agent::executing'],
        body: '## Planning Artifacts\n- [x] Acceptance Spec: #9700\n',
      },
    ]);
    await assert.rejects(
      () => runSnapshotPhase({ epicId: 9005, provider }, {}, {}),
      /no ## Acceptance Table section/,
    );
  });

  it('treats a malformed managed region (start marker without end) as absent', async () => {
    const provider = buildProvider([
      {
        id: 9006,
        labels: ['type::epic', 'agent::executing'],
        body: '<!-- mandrel:acceptance-table:start -->\n\n## Acceptance Table\n| AC-1 | x |\n',
      },
    ]);
    await assert.rejects(
      () => runSnapshotPhase({ epicId: 9006, provider }, {}, {}),
      /no ## Acceptance Table section/,
    );
  });
});

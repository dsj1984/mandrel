/**
 * Unit tests for the `/mandrel-plan --tickets` supersede close phase (Story #4535).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertSupersedePartition,
  buildSupersedeCommentBody,
  closeSupersededTickets,
  extractEnvelopeSourceTicketIds,
  normalizeSourceTicketIds,
  normalizeSupersedes,
  resolveSourceTicketIds,
  SUPERSEDE_CLOSE_REASON,
} from '../../../.agents/scripts/lib/orchestration/plan-persist/supersede-ops.js';

function story(slug, supersedes = []) {
  return { slug, supersedes };
}

/** A minimal `plan-context.js --tickets` envelope. */
function ticketsEnvelope(ids) {
  return {
    mode: 'tickets',
    sourceTickets: ids.map((id) => ({
      id,
      title: `source #${id}`,
      body: '',
      labels: [],
    })),
  };
}

describe('normalizeSupersedes', () => {
  it('accepts bare issue numbers (the documented number[] shape)', () => {
    assert.deepEqual(normalizeSupersedes({ supersedes: [4525, 4526] }, 'a'), [
      { id: 4525, note: null },
      { id: 4526, note: null },
    ]);
  });

  it('accepts { id, note } entries and carries the note', () => {
    assert.deepEqual(
      normalizeSupersedes(
        { supersedes: [{ id: 4529, note: 'The filed fix is inert.' }] },
        'a',
      ),
      [{ id: 4529, note: 'The filed fix is inert.' }],
    );
  });

  it('accepts "#123" / "123" string ids', () => {
    assert.deepEqual(normalizeSupersedes({ supersedes: ['#7', ' 8 '] }, 'a'), [
      { id: 7, note: null },
      { id: 8, note: null },
    ]);
  });

  it('treats an absent field as a no-op', () => {
    assert.deepEqual(normalizeSupersedes({}, 'a'), []);
    assert.deepEqual(normalizeSupersedes({ supersedes: null }, 'a'), []);
  });

  it('drops a blank note to null', () => {
    assert.deepEqual(
      normalizeSupersedes({ supersedes: [{ id: 1, note: '  ' }] }, 'a'),
      [{ id: 1, note: null }],
    );
  });

  it('rejects a non-array field', () => {
    assert.throws(
      () => normalizeSupersedes({ supersedes: 4525 }, 'a'),
      /non-array supersedes field/,
    );
  });

  it('rejects a non-positive / non-numeric id', () => {
    assert.throws(
      () => normalizeSupersedes({ supersedes: [0] }, 'a'),
      /invalid supersedes entry/,
    );
    assert.throws(
      () => normalizeSupersedes({ supersedes: ['nope'] }, 'a'),
      /invalid supersedes entry/,
    );
  });

  it('rejects the same id claimed twice by one Story', () => {
    assert.throws(
      () => normalizeSupersedes({ supersedes: [5, { id: 5 }] }, 'a'),
      /claims #5 twice/,
    );
  });
});

describe('normalizeSourceTicketIds', () => {
  it('parses a comma-separated CLI string and dedupes', () => {
    assert.deepEqual(
      normalizeSourceTicketIds('4525, #4526,4525'),
      [4525, 4526],
    );
  });

  it('returns [] for absent input', () => {
    assert.deepEqual(normalizeSourceTicketIds(undefined), []);
    assert.deepEqual(normalizeSourceTicketIds(null), []);
  });

  it('rejects a non-positive id', () => {
    assert.throws(
      () => normalizeSourceTicketIds('4525,-1'),
      /positive issue ids/,
    );
  });
});

describe('assertSupersedePartition', () => {
  it('passes a total 1:1 map', () => {
    assert.doesNotThrow(() =>
      assertSupersedePartition(
        [story('a', [{ id: 1 }]), story('b', [{ id: 2 }])],
        [1, 2],
      ),
    );
  });

  it('passes an N<sources fold (4525-4528 → one Story)', () => {
    assert.doesNotThrow(() =>
      assertSupersedePartition(
        [story('a', [{ id: 4525 }, { id: 4526 }, { id: 4527 }, { id: 4528 }])],
        [4525, 4526, 4527, 4528],
      ),
    );
  });

  it('passes a no-source / no-claim plan (seed mode)', () => {
    assert.doesNotThrow(() => assertSupersedePartition([story('a')], []));
  });

  it('rejects an unclaimed source ticket', () => {
    assert.throws(
      () => assertSupersedePartition([story('a', [{ id: 1 }])], [1, 2]),
      /#2 is not claimed by any Story/,
    );
  });

  it('rejects a source claimed by two Stories', () => {
    assert.throws(
      () =>
        assertSupersedePartition(
          [story('a', [{ id: 1 }]), story('b', [{ id: 1 }])],
          [1],
        ),
      /#1 is claimed by 2 Stories/,
    );
  });

  it('rejects a claim on a non-source ticket', () => {
    assert.throws(
      () =>
        assertSupersedePartition([story('a', [{ id: 1 }, { id: 99 }])], [1]),
      /#99, which was not passed to --tickets/,
    );
  });

  it('rejects any claim when no source tickets were passed', () => {
    assert.throws(
      () => assertSupersedePartition([story('a', [{ id: 1 }])], []),
      /was not passed to --tickets/,
    );
  });
});

describe('extractEnvelopeSourceTicketIds', () => {
  it('pulls the ids out of a --tickets envelope', () => {
    assert.deepEqual(
      extractEnvelopeSourceTicketIds(ticketsEnvelope([4525, 4526])),
      [4525, 4526],
    );
  });

  it('yields [] for a seed-mode envelope, a null envelope, and an empty set', () => {
    assert.deepEqual(extractEnvelopeSourceTicketIds({ mode: 'seed' }), []);
    assert.deepEqual(extractEnvelopeSourceTicketIds(null), []);
    assert.deepEqual(
      extractEnvelopeSourceTicketIds({ mode: 'tickets', sourceTickets: [] }),
      [],
    );
  });

  it('blames the envelope, not the flag, on a malformed id', () => {
    assert.throws(
      () =>
        extractEnvelopeSourceTicketIds({
          mode: 'tickets',
          sourceTickets: [{ id: 0 }],
        }),
      /plan-context envelope sourceTickets\[\] expects positive issue ids/,
    );
  });
});

describe('resolveSourceTicketIds', () => {
  // The Story #4554 regression: before the envelope was threaded through,
  // omitting --source-tickets left the id set empty, so the partition passed
  // vacuously and the close phase short-circuited on a run that had really
  // fetched source tickets.
  it('derives the ids from the envelope when no flag is passed', () => {
    assert.deepEqual(
      resolveSourceTicketIds({ envelope: ticketsEnvelope([4525, 4526]) }),
      { ids: [4525, 4526], origin: 'envelope' },
    );
  });

  it('lets an explicit --source-tickets value override the envelope', () => {
    assert.deepEqual(
      resolveSourceTicketIds({
        explicitIds: '4525',
        envelope: ticketsEnvelope([4525, 4526]),
      }),
      { ids: [4525], origin: 'flag' },
    );
  });

  it('honours the flag when there is no envelope at all (hand-driven run)', () => {
    assert.deepEqual(resolveSourceTicketIds({ explicitIds: '4525,4526' }), {
      ids: [4525, 4526],
      origin: 'flag',
    });
  });

  it('reports origin "none" when neither channel carries ids (seed mode)', () => {
    assert.deepEqual(resolveSourceTicketIds({ envelope: { mode: 'seed' } }), {
      ids: [],
      origin: 'none',
    });
    assert.deepEqual(resolveSourceTicketIds(), { ids: [], origin: 'none' });
  });

  it('an envelope-derived set still fail-closes the partition when a Story forgot supersedes[]', () => {
    // The whole point: deriving the ids turns the old silent no-op into the
    // existing loud partition error.
    const { ids } = resolveSourceTicketIds({
      envelope: ticketsEnvelope([4525]),
    });
    assert.throws(
      () => assertSupersedePartition([story('a')], ids),
      /#4525 is not claimed by any Story/,
    );
  });
});

describe('buildSupersedeCommentBody', () => {
  const story4530 = { id: 4530, title: 'feat(plan): close superseded' };

  it('names the specific Story, its labels, and the historical-record line', () => {
    const body = buildSupersedeCommentBody({
      story: story4530,
      sourceTicketIds: [4525, 4526],
    });
    assert.match(
      body,
      /\*\*Superseded by #4530\*\* — \*feat\(plan\): close superseded\*/,
    );
    assert.match(body, /`type::story`, `agent::ready`/);
    assert.match(body, /Planned via `\/mandrel-plan --tickets 4525,4526`/);
    assert.match(
      body,
      /preserved as the historical record; #4530 carries the delivery contract/,
    );
  });

  it('never names a plan-run label — Story #4540 retired it', () => {
    // This comment used to list the batch label alongside the type/state
    // labels for N>1. The label no longer exists, so the comment must not
    // advertise it for any N.
    for (const sourceTicketIds of [[4525], [4525, 4526]]) {
      const body = buildSupersedeCommentBody({
        story: story4530,
        sourceTicketIds,
      });
      assert.doesNotMatch(body, /plan-run/);
    }
  });

  it('renders the per-supersede note when present', () => {
    const body = buildSupersedeCommentBody({
      story: story4530,
      note: 'The `--changed-only` fix filed here is provably inert.',
      sourceTicketIds: [4529],
    });
    assert.match(
      body,
      /The `--changed-only` fix filed here is provably inert\./,
    );
  });
});

describe('closeSupersededTickets', () => {
  function provider({ states = {}, labels = {}, onUpdate } = {}) {
    const calls = { comments: [], updates: [] };
    return {
      calls,
      async getTicket(id) {
        const state = states[id];
        if (state === undefined) throw new Error(`not found: #${id}`);
        // `labels` is opt-in: the tickets that do not set it stay on the
        // no-agent-state path, which is the case that must issue no label
        // mutation at all.
        return labels[id] === undefined
          ? { id, state }
          : { id, state, labels: labels[id] };
      },
      async getTicketComments() {
        return [];
      },
      async postComment(issueNumber, payload) {
        calls.comments.push({ issueNumber, body: payload.body });
        return { id: calls.comments.length };
      },
      async updateTicket(id, mutations) {
        if (onUpdate) await onUpdate(id);
        calls.updates.push({ id, mutations });
      },
    };
  }

  const stories = [{ slug: 'a', supersedes: [{ id: 1, note: null }] }];
  const created = [{ slug: 'a', id: 500, title: 'Story A' }];

  it('closes with state_reason not_planned', async () => {
    const p = provider({ states: { 1: 'open' } });
    const report = await closeSupersededTickets({
      provider: p,
      stories,
      created,
      sourceTicketIds: [1],
    });
    assert.deepEqual(report.closed, [1]);
    assert.deepEqual(p.calls.updates, [
      {
        id: 1,
        mutations: { state: 'closed', state_reason: SUPERSEDE_CLOSE_REASON },
      },
    ]);
    assert.equal(SUPERSEDE_CLOSE_REASON, 'not_planned');
  });

  it('strips a stale agent::* label in the same call that closes (Story #5255)', async () => {
    // The defect: a Story re-planned out of `agent::blocked` was closed still
    // wearing the label, and `deriveParentState` read it as live work — which
    // pinned the ticket's container Epic open on every rollup thereafter.
    const p = provider({
      states: { 1: 'open' },
      labels: { 1: ['type::story', 'agent::blocked', 'audit::mobile'] },
    });
    const report = await closeSupersededTickets({
      provider: p,
      stories,
      created,
      sourceTicketIds: [1],
    });

    assert.deepEqual(report.closed, [1]);
    assert.equal(
      p.calls.updates.length,
      1,
      'one write, not a close then a fix',
    );
    const [{ id, mutations }] = p.calls.updates;
    assert.equal(id, 1);
    assert.equal(mutations.state, 'closed');
    assert.equal(mutations.state_reason, SUPERSEDE_CLOSE_REASON);
    assert.deepEqual(mutations.labels, { remove: ['agent::blocked'] });
    // The probe already paid for a fresh read; the label merge must reuse it
    // rather than making `updateTicket` fetch the issue a second time.
    assert.equal(mutations._ticketSnapshot.id, 1);
  });

  it('never rewrites the state to agent::done — a retired ticket was not delivered', async () => {
    const p = provider({
      states: { 1: 'open' },
      labels: { 1: ['agent::blocked'] },
    });
    await closeSupersededTickets({
      provider: p,
      stories,
      created,
      sourceTicketIds: [1],
    });
    const { mutations } = p.calls.updates[0];
    assert.deepEqual(mutations.labels.add ?? [], []);
    assert.ok(!JSON.stringify(mutations.labels).includes('agent::done'));
  });

  it('strips every agent::* label a source ticket carries, and nothing else', async () => {
    const p = provider({
      states: { 1: 'open' },
      labels: {
        1: ['type::story', 'agent::executing', 'agent::blocked', 'bug'],
      },
    });
    await closeSupersededTickets({
      provider: p,
      stories,
      created,
      sourceTicketIds: [1],
    });
    const { mutations } = p.calls.updates[0];
    assert.deepEqual([...mutations.labels.remove].sort(), [
      'agent::blocked',
      'agent::executing',
    ]);
  });

  it('attempts no label mutation when the source carries no agent state', async () => {
    const p = provider({
      states: { 1: 'open' },
      labels: { 1: ['type::story', 'bug'] },
    });
    const report = await closeSupersededTickets({
      provider: p,
      stories,
      created,
      sourceTicketIds: [1],
    });
    assert.deepEqual(report.closed, [1]);
    assert.deepEqual(p.calls.updates, [
      {
        id: 1,
        mutations: { state: 'closed', state_reason: SUPERSEDE_CLOSE_REASON },
      },
    ]);
  });

  it('reports a failed label strip on failed[] rather than throwing', async () => {
    const p = provider({
      states: { 1: 'open' },
      labels: { 1: ['agent::blocked'] },
      onUpdate: () => {
        throw new Error('label write rejected');
      },
    });
    const report = await closeSupersededTickets({
      provider: p,
      stories,
      created,
      sourceTicketIds: [1],
    });
    assert.deepEqual(report.failed, [
      { ticket: 1, reason: 'label write rejected' },
    ]);
    assert.deepEqual(report.closed, []);
  });

  it('skips an already-closed source with no writes at all (re-run idempotence)', async () => {
    // The label strip must not give a second run a reason to write: the
    // already-closed probe still short-circuits ahead of the comment and the
    // PATCH both.
    const p = provider({
      states: { 1: 'closed' },
      labels: { 1: ['agent::blocked'] },
    });
    const report = await closeSupersededTickets({
      provider: p,
      stories,
      created,
      sourceTicketIds: [1],
    });
    assert.deepEqual(report.skipped, [{ ticket: 1, reason: 'already-closed' }]);
    assert.deepEqual(report.closed, []);
    assert.deepEqual(p.calls.updates, []);
    assert.deepEqual(p.calls.comments, []);
  });

  it('short-circuits with no-source-tickets when none were passed', async () => {
    const p = provider();
    const report = await closeSupersededTickets({
      provider: p,
      stories,
      created,
      sourceTicketIds: [],
    });
    assert.equal(report.enabled, false);
    assert.equal(report.reason, 'no-source-tickets');
    assert.deepEqual(p.calls.updates, []);
  });

  it('never throws when the provider write fails', async () => {
    const p = provider({
      states: { 1: 'open' },
      onUpdate: () => {
        throw new Error('boom');
      },
    });
    const report = await closeSupersededTickets({
      provider: p,
      stories,
      created,
      sourceTicketIds: [1],
    });
    assert.deepEqual(report.failed, [{ ticket: 1, reason: 'boom' }]);
    assert.deepEqual(report.closed, []);
  });

  it('does not double-comment on a re-run (structured-comment marker)', async () => {
    // A source that stays open across runs (e.g. the close half failed the
    // first time) is the only vector that can double-comment — the marker
    // upsert must replace, not append.
    const comments = [];
    const p = {
      async getTicket(id) {
        return { id, state: 'open' };
      },
      async getTicketComments() {
        return comments.map((c) => ({ ...c }));
      },
      async postComment(issueNumber, payload) {
        comments.push({
          id: comments.length + 1,
          issueNumber,
          body: payload.body,
        });
        return { id: comments.length };
      },
      async deleteComment(id) {
        const idx = comments.findIndex((c) => c.id === id);
        if (idx >= 0) comments.splice(idx, 1);
      },
      async updateTicket() {
        throw new Error('close blocked');
      },
    };
    const args = { provider: p, stories, created, sourceTicketIds: [1] };

    await closeSupersededTickets(args);
    await closeSupersededTickets(args);

    assert.equal(comments.length, 1);
    assert.match(comments[0].body, /Superseded by #500/);
  });

  it('reports a Story that was never created rather than throwing', async () => {
    const p = provider({ states: { 1: 'open' } });
    const report = await closeSupersededTickets({
      provider: p,
      stories,
      created: [],
      sourceTicketIds: [1],
    });
    assert.deepEqual(report.skipped, [
      { ticket: 1, reason: 'story-not-created' },
    ]);
  });
});

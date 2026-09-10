/**
 * epic-candidates.test.js — the open-Epic candidate list (Story #5155).
 *
 * What matters here is the two properties an operator's Gate #3 decision
 * rests on: the list is **complete** (never thresholded — a hidden candidate
 * is how a plan silently opens a second container for one body of work), and
 * it **never fails the plan** (a triage signal degrades to empty, it does not
 * take the envelope down with it).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { findOpenEpicCandidates } from '../epic-candidates.js';

const SEED =
  'Add epic adoption so a later plan can join an existing container epic';

/**
 * An open container Epic in the **mapped** ticket shape `listTicketsByLabel`
 * returns — `id` is the issue number, not a database id.
 */
function epicIssue({ number, title, body = '', labels = ['type::epic'] }) {
  return { id: number, title, body, labels, state: 'open' };
}

/** A provider double over a fixed open-Epic list. */
function providerDouble({ epics = [], listThrows = false, titles = {} } = {}) {
  const calls = { list: 0, getTicket: [] };
  return {
    calls,
    listTicketsByLabel: async (args) => {
      calls.list++;
      if (listThrows) throw new Error('listing down');
      assert.equal(args.state, 'open');
      assert.equal(args.labels, 'type::epic');
      return epics;
    },
    getTicket: async (id) => {
      calls.getTicket.push(id);
      if (!(id in titles)) throw new Error(`no such ticket ${id}`);
      return { id, title: titles[id] };
    },
  };
}

describe('findOpenEpicCandidates — the complete list', () => {
  it('returns every open Epic, ranked by overlap, not just the good ones', async () => {
    const provider = providerDouble({
      epics: [
        epicIssue({
          number: 10,
          title: 'Unrelated billing rework',
          body: '## Goal\n\nInvoices and taxes.\n',
        }),
        epicIssue({
          number: 20,
          title: 'Epic adoption and container joins',
          body: '## Goal\n\nLet a later plan join an existing container epic.\n',
        }),
      ],
    });

    const out = await findOpenEpicCandidates({ seed: SEED, provider });

    assert.equal(out.length, 2, 'a weak candidate is still listed');
    assert.equal(out[0].id, 20, 'best overlap ranks first');
    assert.equal(out[1].id, 10);
    assert.ok(out[0].score > out[1].score);
  });

  it('carries the child ids read off the body checklist', async () => {
    const provider = providerDouble({
      epics: [
        epicIssue({
          number: 30,
          title: 'Container epic',
          body: '## Goal\n\nGroup it.\n\n## Stories\n\n- [x] #41\n- [ ] #42\n',
        }),
      ],
      titles: { 41: 'adopt an epic', 42: 'join a container' },
    });

    const [candidate] = await findOpenEpicCandidates({ seed: SEED, provider });

    assert.deepEqual(candidate.childIds, [41, 42]);
    assert.deepEqual(provider.calls.getTicket.sort(), [41, 42]);
  });

  it('scores on child titles, so a thin container still matches a concrete seed', async () => {
    const thin = {
      epics: [
        epicIssue({
          number: 40,
          title: 'Platform work',
          body: '## Goal\n\nMisc.\n\n## Stories\n\n- [ ] #51\n',
        }),
      ],
    };
    const withoutTitles = await findOpenEpicCandidates({
      seed: SEED,
      provider: providerDouble(thin),
    });
    const withTitles = await findOpenEpicCandidates({
      seed: SEED,
      provider: providerDouble({
        ...thin,
        titles: { 51: 'epic adoption for a later plan joining a container' },
      }),
    });

    assert.ok(
      withTitles[0].score > withoutTitles[0].score,
      'child titles carry the shared vocabulary the container itself lacks',
    );
  });

  it('ties break on ascending id so the same backlog renders the same order', async () => {
    const body = '## Goal\n\nIdentical.\n';
    const provider = providerDouble({
      epics: [
        epicIssue({ number: 77, title: 'Same', body }),
        epicIssue({ number: 12, title: 'Same', body }),
      ],
    });

    const out = await findOpenEpicCandidates({ seed: SEED, provider });

    assert.deepEqual(
      out.map((c) => c.id),
      [12, 77],
    );
  });
});

describe('findOpenEpicCandidates — degradation', () => {
  it('degrades to [] when the listing fails, never throwing at the planner', async () => {
    const provider = providerDouble({ listThrows: true });
    assert.deepEqual(
      await findOpenEpicCandidates({ seed: SEED, provider }),
      [],
    );
  });

  it('still lists an Epic whose children cannot be read', async () => {
    const provider = providerDouble({
      epics: [
        epicIssue({
          number: 60,
          title: 'Adoption epic',
          body: '## Goal\n\nJoin containers.\n\n## Stories\n\n- [ ] #61\n',
        }),
      ],
      // `titles` is empty, so every getTicket throws.
    });

    const out = await findOpenEpicCandidates({ seed: SEED, provider });

    assert.equal(
      out.length,
      1,
      'an unreadable child costs tokens, not the row',
    );
    assert.deepEqual(out[0].childIds, [61]);
  });

  it('drops an issue the label filter returned without the type::epic label', async () => {
    const provider = providerDouble({
      epics: [
        epicIssue({ number: 70, title: 'Adoption', labels: ['type::story'] }),
      ],
    });
    assert.deepEqual(
      await findOpenEpicCandidates({ seed: SEED, provider }),
      [],
    );
  });

  it('makes no provider call on an empty seed or an absent listing surface', async () => {
    const provider = providerDouble({ epics: [] });
    assert.deepEqual(
      await findOpenEpicCandidates({ seed: '  ', provider }),
      [],
    );
    assert.equal(provider.calls.list, 0);
    assert.deepEqual(
      await findOpenEpicCandidates({ seed: SEED, provider: {} }),
      [],
    );
  });
});

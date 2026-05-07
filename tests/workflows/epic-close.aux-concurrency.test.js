/**
 * epic-close — auxiliary-ticket close concurrency cap.
 *
 * Story #1087 / Task #1107: the auxiliary-ticket close burst at Epic close
 * (PRD + Tech Spec + Sprint Health dashboard) used to fan out via
 * `Promise.all`, which races the GitHub secondary rate limit on Epics with
 * many sub-issues. The fix replaces it with `concurrentMap(..., {
 * concurrency: 3 })`.
 *
 * This test wires a stub provider whose `updateTicket` records peak
 * in-flight calls and asserts the cap holds when the auxiliary list is
 * wider than 3.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { phaseFinalizeAuxiliaryTickets } from '../../.agents/scripts/epic-close.js';

function makeAuxTicket(id, kind) {
  if (kind === 'health') {
    return {
      id,
      title: `📉 Sprint Health: Aux ${id}`,
      labels: ['type::health'],
      state: 'open',
      body: '',
    };
  }
  return {
    id,
    title: `Aux ${kind} ${id}`,
    labels: [`context::${kind}`],
    state: 'open',
    body: '',
  };
}

describe('epic-close — auxiliary-ticket close concurrency cap', () => {
  it('caps in-flight auxiliary close mutations at 3', async () => {
    // Build 9 auxiliary tickets so the burst is wider than the cap.
    const auxiliaries = [];
    auxiliaries.push(makeAuxTicket(101, 'prd'));
    auxiliaries.push(makeAuxTicket(102, 'tech-spec'));
    for (let i = 0; i < 7; i++) {
      auxiliaries.push(makeAuxTicket(200 + i, 'health'));
    }

    let inFlight = 0;
    let peakInFlight = 0;
    const updates = [];

    const provider = {
      async getSubTickets() {
        return auxiliaries;
      },
      async getTicket(id) {
        const t = auxiliaries.find((x) => x.id === id);
        return t ? JSON.parse(JSON.stringify(t)) : null;
      },
      async getTickets() {
        return [];
      },
      async updateTicket(id, mutations) {
        inFlight++;
        if (inFlight > peakInFlight) peakInFlight = inFlight;
        await new Promise((r) => setTimeout(r, 10));
        const ticket = auxiliaries.find((x) => x.id === id);
        if (ticket && mutations.state) ticket.state = mutations.state;
        updates.push({ id, mutations });
        inFlight--;
      },
      async getSubIssues() {
        return [];
      },
      primeTicketCache() {},
      async postComment() {},
    };

    const warnings = [];
    await phaseFinalizeAuxiliaryTickets(provider, 1, warnings);

    assert.ok(
      peakInFlight <= 3,
      `expected peak in-flight close mutations <= 3 but observed ${peakInFlight}`,
    );
    // All 9 auxiliaries were closed (each toDone invokes updateTicket once
    // for the label/state mutation).
    const closeMutations = updates.filter(
      (u) => u.mutations.state === 'closed',
    );
    assert.equal(
      closeMutations.length,
      9,
      `expected 9 auxiliaries closed, got ${closeMutations.length}`,
    );
    assert.deepEqual(warnings, []);
  });
});

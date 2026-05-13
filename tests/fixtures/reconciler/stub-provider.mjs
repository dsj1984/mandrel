/**
 * tests/fixtures/reconciler/stub-provider.mjs — minimal in-memory
 * ITicketingProvider stub for the apply contract tests (Story #1494 /
 * Task #1520).
 *
 * The stub is deliberately leaner than `tests/fixtures/mock-provider.js`
 * (the legacy general-purpose mock used elsewhere): it only implements
 * the surface the apply pipeline calls — `createTicket`,
 * `updateTicket`, `addSubIssue`, `removeSubIssue` — and records every
 * invocation in a flat `calls` array so contract assertions can pattern-
 * match the exact order and arguments. Nothing else is implemented so
 * any accidental call to a non-apply method throws loudly.
 *
 * Issue numbers are minted from a monotonically incrementing counter
 * (`startingIssue`, default 9000) so tests can predict the IDs and the
 * sequence is stable across runs.
 */

import { ITicketingProvider } from '../../../.agents/scripts/lib/ITicketingProvider.js';

/**
 * @typedef {{kind: string, args: unknown[], result?: unknown}} StubCall
 */

export class StubProvider extends ITicketingProvider {
  /**
   * @param {{startingIssue?: number, failOn?: (call: StubCall) => boolean}} [opts]
   */
  constructor({ startingIssue = 9000, failOn = null } = {}) {
    super();
    this._next = startingIssue;
    this._failOn = failOn;
    /** @type {StubCall[]} */
    this.calls = [];
    /** @type {Map<number, {state: string, title: string, body: string, labels: string[]}>} */
    this.tickets = new Map();
  }

  _record(kind, args, result) {
    const call = { kind, args, result };
    this.calls.push(call);
    if (this._failOn?.(call)) {
      const err = new Error(`stub-provider: failOn(${kind})`);
      err.code = 'STUB_FAIL';
      throw err;
    }
  }

  async createTicket(parentId, ticketData) {
    const id = this._next++;
    this.tickets.set(id, {
      state: 'open',
      title: ticketData.title,
      body: ticketData.body ?? '',
      labels: [...(ticketData.labels ?? [])],
    });
    const result = { id, url: `https://stub/issue/${id}` };
    this._record('createTicket', [parentId, ticketData], result);
    return result;
  }

  async updateTicket(ticketId, mutations) {
    const existing = this.tickets.get(ticketId) ?? {
      state: 'open',
      title: '',
      body: '',
      labels: [],
    };
    if (mutations.title !== undefined) existing.title = mutations.title;
    if (mutations.body !== undefined) existing.body = mutations.body;
    if (mutations.state !== undefined) existing.state = mutations.state;
    if (mutations.labels) {
      const rm = new Set(mutations.labels.remove ?? []);
      const add = mutations.labels.add ?? [];
      existing.labels = [
        ...existing.labels.filter((l) => !rm.has(l)),
        ...add.filter((l) => !existing.labels.includes(l)),
      ];
    }
    this.tickets.set(ticketId, existing);
    this._record('updateTicket', [ticketId, mutations]);
  }

  async addSubIssue(parentId, childId) {
    this._record('addSubIssue', [parentId, childId]);
  }

  async removeSubIssue(parentId, childId) {
    this._record('removeSubIssue', [parentId, childId]);
  }
}

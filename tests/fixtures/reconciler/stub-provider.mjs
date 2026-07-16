/**
 * tests/fixtures/reconciler/stub-provider.mjs — minimal in-memory
 * ITicketingProvider stub for the apply contract tests (Story #1494 /
 * Task #1520).
 *
 * The stub is deliberately leaner than `tests/fixtures/mock-provider.js`
 * (the legacy general-purpose mock used elsewhere): it only implements
 * the surface the apply pipeline calls — `updateTicket`, `addSubIssue`,
 * `removeSubIssue` — and records every invocation in a flat `calls` array
 * so contract assertions can pattern-match the exact order and arguments.
 * Nothing else is implemented so any accidental call to a non-apply method
 * throws loudly.
 *
 * Story #4545 removed the `createTicket` stub (and the `startingIssue`
 * id-minting counter that existed only to serve it) when `createTicket` —
 * the Epic-hierarchy write surface — was dropped from ITicketingProvider.
 */

import { ITicketingProvider } from '../../../.agents/scripts/lib/ITicketingProvider.js';

/**
 * @typedef {{kind: string, args: unknown[], result?: unknown}} StubCall
 */

export class StubProvider extends ITicketingProvider {
  /**
   * @param {{failOn?: (call: StubCall) => boolean}} [opts]
   */
  constructor({ failOn = null } = {}) {
    super();
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

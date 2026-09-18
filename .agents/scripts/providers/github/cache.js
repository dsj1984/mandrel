/**
 * GitHub Provider — per-instance ticket cache. No TTL: `peekFresh` bounds age
 * per call, and mutators invalidate explicitly.
 *
 * @param {{ now?: () => number }} [opts]
 * @returns {{
 *   has(ticketId: number): boolean,
 *   peek(ticketId: number): object|undefined,
 *   peekFresh(ticketId: number, maxAgeMs: number): object|undefined,
 *   set(ticketId: number, ticket: object): void,
 *   primeIfAbsent(ticket: object): void,
 *   primeMany(tickets: Array<object>): void,
 *   invalidate(ticketId: number): void,
 * }}
 */
export function createInlineTicketCache({ now = Date.now } = {}) {
  /** @type {Map<number, { ticket: object, insertedAt: number }>} */
  const store = new Map();

  function primeIfAbsent(ticket) {
    if (!ticket || typeof ticket.id !== 'number') return;
    if (store.has(ticket.id)) return;
    if (!ticket.labelSet && Array.isArray(ticket.labels)) {
      ticket.labelSet = new Set(ticket.labels);
    }
    store.set(ticket.id, { ticket, insertedAt: now() });
  }

  return {
    has(ticketId) {
      return store.has(ticketId);
    },

    peek(ticketId) {
      return store.get(ticketId)?.ticket;
    },

    peekFresh(ticketId, maxAgeMs) {
      const entry = store.get(ticketId);
      if (!entry) return undefined;
      if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) return undefined;
      if (now() - entry.insertedAt >= maxAgeMs) return undefined;
      return entry.ticket;
    },

    set(ticketId, ticket) {
      store.set(ticketId, { ticket, insertedAt: now() });
    },

    primeIfAbsent,

    primeMany(tickets) {
      for (const t of tickets ?? []) primeIfAbsent(t);
    },

    invalidate(ticketId) {
      store.delete(ticketId);
    },
  };
}

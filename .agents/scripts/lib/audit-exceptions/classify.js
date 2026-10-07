/**
 * Settle each record's mechanical verdict. First match wins:
 * `dead` → `expired` → `orphaned` → `unjustified` → `unknown` → `live`.
 * Only a probe that PROVED the exception exempts nothing may say `dead`; an
 * undecided probe says `unknown`, because a false `dead` invites deleting a
 * load-bearing exception.
 *
 * @module lib/audit-exceptions/classify
 */

export const VERDICTS = Object.freeze([
  'dead',
  'expired',
  'orphaned',
  'unjustified',
  'live',
  'unknown',
]);

/**
 * @param {object} record
 * @param {Map<string, string>} ticketStates - ref → `open` | `closed`.
 * @param {string} today - ISO date.
 * @returns {{ verdict: string, verdictBasis: string }}
 */
function decide(record, ticketStates, today) {
  if (record.probe?.verdict === 'dead') {
    return { verdict: 'dead', verdictBasis: record.probe.basis };
  }
  if (record.expires && record.expires < today) {
    return { verdict: 'expired', verdictBasis: 'expiry-date' };
  }
  const states = record.ticketRefs.map((ref) => ticketStates.get(ref));
  if (states.length > 0 && states.every((s) => s === 'closed')) {
    return { verdict: 'orphaned', verdictBasis: 'ticket-closed' };
  }
  // A permanent shape (an untracked build dir, a platform skip) needs no written reason.
  if (!record.justification && !record.permanentHint) {
    return { verdict: 'unjustified', verdictBasis: 'no-justification' };
  }
  if (record.probe?.verdict === 'unknown') {
    return { verdict: 'unknown', verdictBasis: record.probe.basis };
  }
  return { verdict: 'live', verdictBasis: record.probe?.basis ?? 'none' };
}

/**
 * Mutates and returns `records` with `verdict` / `verdictBasis` set, the
 * probe's own finding kept as `probeBasis` (an `unjustified` pin a dependent
 * still needs is a different finding from an unjustified redundant one), and
 * the transient `probe` field removed.
 *
 * @param {object[]} records
 * @param {{ ticketStates?: Map<string, string>, today: string }} opts
 * @returns {object[]}
 */
export function classifyAll(records, { ticketStates = new Map(), today }) {
  for (const record of records) {
    Object.assign(record, decide(record, ticketStates, today));
    record.probeBasis = record.probe?.basis ?? null;
    delete record.probe;
  }
  return records;
}

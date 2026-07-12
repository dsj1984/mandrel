/**
 * delivery-mode.js — delivery-shape mode resolution for the collapsed
 * persist surface (Epic #4474 PR4, design §2 mode matrix).
 *
 * The risk verdict's optional `deliveryShape` field ("fan-out" | "single",
 * absent → fan-out so every existing verdict stays valid) selects between
 * the three persist modes:
 *
 *   - `fan-out` — the full mode: ticket validator + DAG + budget gates,
 *     Story-tree creation via the structural reconciler.
 *   - `single` — the spec-only single-delivery mode: NO tickets are
 *     authored, the ticket validator + DAG are skipped (fenced by
 *     construction — {@link resolveDeliveryMode} hard-refuses the
 *     combination of `deliveryShape: "single"` with a tickets payload, so
 *     the skip branch is unreachable when tickets are present), and the
 *     persist applies the `delivery::single` routing marker instead of a
 *     Story tree. Inert until #4475 lands the deliver-side reader.
 *   - `amend` — the change-request delta path (`--amend`): tickets carry
 *     `op: add|modify|keep|close` and the persist maps the ops onto the
 *     existing Story tree (see `plan-persist/amend.js`).
 *
 * @module lib/orchestration/plan-persist/delivery-mode
 */

import { parseDeliverySlicingTable } from '../consolidation-precondition.js';

/** Canonical delivery-shape values the risk-verdict schema admits. */
const DELIVERY_SHAPES = Object.freeze(['fan-out', 'single']);

/**
 * Mode-coherence hard error (design §1 step 3 item 3, extended for PR4).
 *
 * Resolves the persist mode from the risk verdict's `deliveryShape` (absent
 * → `fan-out`), the tickets payload, and the `--amend` flag — and refuses
 * every incoherent combination loudly instead of silently coercing:
 *
 *   - unknown `deliveryShape` values;
 *   - `deliveryShape: "single"` WITH a tickets payload (the DAG-skip
 *     leakage risk — the single mode's validator/DAG skip is only sound
 *     when there are no tickets to validate);
 *   - fan-out without a non-empty tickets array;
 *   - `--amend` combined with `deliveryShape: "single"` (the delta path is
 *     fan-out-shaped by definition — a single-delivery re-plan is a
 *     `--force` re-persist);
 *   - `--amend` without tickets (the delta IS the tickets-with-ops
 *     payload);
 *   - `op` fields present without `--amend` (a full persist must never
 *     silently reinterpret an amend delta as a fresh tree).
 *
 * @param {{ deliveryShape?: string }} riskVerdict schema-validated verdict
 * @param {unknown} tickets parsed tickets payload (null when no file)
 * @param {{ amend?: boolean }} [opts]
 * @returns {'fan-out'|'single'|'amend'} the resolved persist mode
 */
export function resolveDeliveryMode(riskVerdict, tickets, opts = {}) {
  const { amend = false } = opts;
  const shape = riskVerdict?.deliveryShape ?? 'fan-out';
  if (!DELIVERY_SHAPES.includes(shape)) {
    throw new Error(
      `[plan-persist] unknown deliveryShape "${shape}" — expected one of ` +
        `${DELIVERY_SHAPES.join(', ')} (or omit the field for fan-out).`,
    );
  }
  const hasTickets = Array.isArray(tickets) && tickets.length > 0;

  if (amend) {
    if (shape === 'single') {
      throw new Error(
        '[plan-persist] --amend is incoherent with deliveryShape "single" — ' +
          'the amend delta maps ops onto an existing Story tree, and a ' +
          'single-delivery plan has none. Re-author the verdict as fan-out, ' +
          'or re-persist the single plan with --force.',
      );
    }
    if (!hasTickets) {
      throw new Error(
        '[plan-persist] --amend requires a tickets payload carrying ' +
          '`op: add|modify|keep|close` on every ticket — the delta IS the ' +
          'tickets file (--tickets <file>).',
      );
    }
    return 'amend';
  }

  if (shape === 'single') {
    if (hasTickets) {
      throw new Error(
        '[plan-persist] mode-coherence: deliveryShape "single" with a ' +
          'tickets payload is contradictory — the single-delivery mode ' +
          'authors NO tickets (the Delivery Slicing table is the audit ' +
          'trail). Remove the tickets file, or re-author the risk verdict ' +
          'as fan-out.',
      );
    }
    return 'single';
  }

  if (!hasTickets) {
    throw new Error(
      '[plan-persist] fan-out persist requires a non-empty tickets array ' +
        '(--tickets <file>). A ticket-less spec-only plan must declare ' +
        'deliveryShape: "single" in the risk verdict.',
    );
  }
  if (tickets.some((t) => t && typeof t === 'object' && 'op' in t)) {
    throw new Error(
      '[plan-persist] tickets carry `op` fields but --amend was not passed ' +
        '— refusing to reinterpret an amend delta as a full persist. Pass ' +
        '--amend, or strip the op fields for a fresh fan-out.',
    );
  }
  return 'fan-out';
}

/**
 * Count the slices of the authored Tech Spec's `## Delivery Slicing` table
 * — the single-mode plan summary's `sliceCount` (design §2: the slicing
 * table IS the single mode's audit trail). Returns `null` when the table
 * is absent or unparseable (fail-open, mirroring the parser's contract).
 *
 * @param {string} techSpecContent
 * @returns {number|null}
 */
export function countDeliverySlices(techSpecContent) {
  const rows = parseDeliverySlicingTable(techSpecContent ?? '');
  return Array.isArray(rows) ? rows.length : null;
}

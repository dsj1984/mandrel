/**
 * lib/orchestration/deliver-route.js — the deliver-side reader for the
 * plan-time single-delivery seam (Epic #4475, M4-A).
 *
 * The plan path already ships the seam inert (Epic #4474): the risk verdict's
 * `deliveryShape`, the `delivery::single` label, and the
 * `epic-plan-state.decompose = { ticketCount: 0, shape: "single" }`
 * checkpoint. Nothing on the deliver side read them — until this module. It
 * folds those two markers (plus the global kill-switch) into a single
 * delivery-route verdict for `/deliver`.
 *
 * Pure and total — inputs in, verdict out. No GitHub calls, no I/O, no
 * throws. It mirrors how `review-depth.js#resolveDepth` and
 * `epic-audit-prepare.js` read `planningRisk` / `decompose` off the
 * `epic-plan-state` checkpoint: the caller fetches the Epic labels + the
 * checkpoint, then hands both here.
 *
 * ── Routing precedence (highest wins) ──────────────────────────────────
 *   1. Kill-switch. `delivery.routing.singleDelivery === false` forces
 *      `fan-out` for EVERY Epic, even a single-labelled one — the instant
 *      global revert (`lib/config/delivery-routing.js`). Overrides all.
 *   2. Single marker. The `delivery::single` label (primary) OR
 *      `checkpoint.decompose.shape === "single"` (secondary) → `single`.
 *   3. Wide-DAG advisory. A fan-out-shaped Epic whose ready-width > 1 is
 *      genuine parallelism → `fan-out`. Deliver-time width only ADVISES —
 *      it never reroutes a single-marked Epic (that would orphan a Story
 *      tree that does not exist; re-route = re-plan).
 *   4. Legacy / no marker → `fan-out` (safe backward-compat: a legacy Epic
 *      has an authored Story tree the fan-out engine consumes).
 *
 * BEHAVIOR-PRESERVING in M4-A: the router consumes a `single` verdict via a
 * stub that continues at `deliver-epic.md` (fan-out), so no `/deliver`
 * observably changes until M4-B lands `deliver-epic-single.md`.
 *
 * @typedef {'single'|'fan-out'} DeliveryRoute
 */

import { getDeliveryRouting } from '../config/delivery-routing.js';

/** The canonical single-delivery routing marker label. */
export const DELIVERY_SINGLE_LABEL = 'delivery::single';

/**
 * True when the Epic carries the `delivery::single` routing label. Tolerant
 * of the two label shapes callers hold: an array of label-name strings, or an
 * array of `{ name }` objects (the GitHub REST label shape).
 *
 * @param {{ labels?: Array<string | { name?: string }> } | null | undefined} epic
 * @returns {boolean}
 */
function hasSingleLabel(epic) {
  const labels = Array.isArray(epic?.labels) ? epic.labels : [];
  return labels.some((l) => {
    const name = typeof l === 'string' ? l : l?.name;
    return name === DELIVERY_SINGLE_LABEL;
  });
}

/**
 * True when the plan-state checkpoint's `decompose.shape` is the deliberate
 * single shape. `plan-persist.js` writes `decompose = { ticketCount: 0,
 * shape: "single" }` for a spec-only plan; every other value (including a
 * legacy checkpoint with no `shape` field) is not-single.
 *
 * @param {{ decompose?: { shape?: string } } | null | undefined} checkpoint
 * @returns {boolean}
 */
function hasSingleDecomposeShape(checkpoint) {
  return checkpoint?.decompose?.shape === 'single';
}

/**
 * Resolve the delivery route for one Epic from its labels, its plan-state
 * checkpoint, and the resolved config. See the module header for the full
 * precedence. Pure — never throws; malformed / absent inputs degrade to the
 * safe `fan-out` default.
 *
 * @param {{ labels?: Array<string | { name?: string }> } | null | undefined} epic
 *   The Epic ticket snapshot (only `labels` is read here).
 * @param {{ decompose?: { shape?: string } } | null | undefined} checkpoint
 *   The `epic-plan-state` structured comment, parsed (or `null` on a legacy
 *   Epic that predates the checkpoint — treated as no marker).
 * @param {object | null | undefined} config
 *   The resolved config; `delivery.routing.singleDelivery` is the kill-switch.
 * @returns {{ route: DeliveryRoute, reason: string, singleDeliveryEnabled: boolean }}
 */
export function resolveEpicDeliveryRoute(epic, checkpoint, config) {
  const { singleDelivery } = getDeliveryRouting(config);

  // 1. Kill-switch — overrides all. A `false` value forces fan-out even for
  //    an Epic the planner marked single (the instant global revert).
  if (singleDelivery === false) {
    return {
      route: 'fan-out',
      reason:
        'kill-switch: delivery.routing.singleDelivery=false forces fan-out for every Epic',
      singleDeliveryEnabled: false,
    };
  }

  // 2. Single marker — label (primary) OR checkpoint decompose shape
  //    (secondary). Either alone routes single.
  const labelled = hasSingleLabel(epic);
  const shaped = hasSingleDecomposeShape(checkpoint);
  if (labelled || shaped) {
    const via =
      labelled && shaped
        ? `${DELIVERY_SINGLE_LABEL} label + decompose.shape="single"`
        : labelled
          ? `${DELIVERY_SINGLE_LABEL} label`
          : 'decompose.shape="single"';
    return {
      route: 'single',
      reason: `single marker present (${via})`,
      singleDeliveryEnabled: true,
    };
  }

  // 3/4. No single marker → fan-out (a wide DAG or a legacy Story tree; the
  //      deliver-time width only advises and never reroutes here).
  return {
    route: 'fan-out',
    reason: 'no single marker — fan-out (legacy Story tree or wide DAG)',
    singleDeliveryEnabled: true,
  };
}

/**
 * Compute the ready-width of a delivery plan — the count of work units that
 * could dispatch on the first beat. It is the mechanical parallelism signal
 * the planner uses at plan time to mark a genuinely-wide Epic `fan-out`, and
 * that `/deliver` may surface as an advisory at deliver time (it never
 * reroutes — see the module header).
 *
 * Accepts either input shape the framework already produces:
 *   - Delivery-Slicing rows — `[{ independent: boolean }, …]` from
 *     `parseDeliverySlicingTable`. A serial chain (every row
 *     `Independent: No`, or a lone independent slice) has width 1; two or
 *     more independent slices yield a width equal to that independent count
 *     (> 1) — genuine parallelism.
 *   - A wave DAG — `[[…], […], …]` (the array-of-waves `state.waves` shape
 *     `runBuildWaveDagPhase` produces). The width is the largest wave — the
 *     most Stories ready to dispatch on a single beat.
 *
 * Pure and total: an empty / malformed / unrecognized input degrades to
 * width 1 (the safe "not wide" signal). Never throws.
 *
 * @param {Array<{ independent?: boolean }> | Array<Array<unknown>> | null | undefined} deliverySlicingRowsOrDag
 * @returns {number} an integer ≥ 1.
 */
export function computeReadyWidth(deliverySlicingRowsOrDag) {
  const input = deliverySlicingRowsOrDag;
  if (!Array.isArray(input) || input.length === 0) return 1;

  // Wave-DAG shape: an array whose entries are themselves arrays.
  if (input.every((entry) => Array.isArray(entry))) {
    let widest = 1;
    for (const wave of input) {
      if (wave.length > widest) widest = wave.length;
    }
    return widest;
  }

  // Delivery-Slicing rows: entries are `{ independent }` records.
  const independentCount = input.reduce(
    (acc, row) =>
      row && typeof row === 'object' && row.independent === true
        ? acc + 1
        : acc,
    0,
  );
  return independentCount >= 2 ? independentCount : 1;
}

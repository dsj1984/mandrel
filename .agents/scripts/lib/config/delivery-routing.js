/**
 * `delivery.routing` accessor + framework defaults — Epic #4475 (M4-A),
 * the single-delivery-as-default foundation.
 *
 * `delivery.routing.singleDelivery` is the **global kill-switch** for the
 * single-delivery route. It defaults to `true` (single-delivery is the
 * default shape for epic-shaped work), and is shipped INERT in M4-A: the
 * `deliver.md` router's single verdict currently falls through to the
 * fan-out helper, so flipping this knob has no observable effect until
 * M4-B wires `deliver-epic-single.md`.
 *
 * When set to `false`, `resolveEpicDeliveryRoute` forces EVERY Epic — even
 * one carrying the `delivery::single` label or a `decompose.shape:"single"`
 * checkpoint — down the fan-out path. This is the instant, per-consumer
 * global revert that ships BEFORE the default flips: no code rollback, no
 * re-plan, just a config edit.
 *
 * Framework-defaults pattern mirrors `lib/config/ci.js#getCiDelivery`.
 */

export const DELIVERY_ROUTING_DEFAULTS = Object.freeze({
  singleDelivery: true,
});

/**
 * Read the merged `delivery.routing` block, applying framework defaults for
 * any field the operator omitted. Accepts the full resolved config, the bare
 * `delivery` bag, or the bare `routing` bag — mirroring `getCiDelivery`'s
 * tolerant unwrap so callers can pass whichever shape they hold.
 *
 * @param {object | null | undefined} config
 * @returns {{ singleDelivery: boolean }}
 */
export function getDeliveryRouting(config) {
  const routing = config?.delivery?.routing ?? config?.routing ?? config ?? {};
  return {
    singleDelivery:
      typeof routing.singleDelivery === 'boolean'
        ? routing.singleDelivery
        : DELIVERY_ROUTING_DEFAULTS.singleDelivery,
  };
}

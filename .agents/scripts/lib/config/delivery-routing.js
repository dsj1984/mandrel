/**
 * `delivery.routing` accessor + framework defaults — Epic #4475 (M4-A),
 * the single-delivery-as-default foundation, plus Epic #4478 (M7-B), the
 * role-scoped-boot-context flip and the maker-checker sampling floor.
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
 * `delivery.routing.roleScopedAgents` is the **kill-switch for the role-scoped
 * boot contexts** (Epic #4478, M7-B). It mirrors the `singleDelivery` shape
 * exactly. It defaults to `true`: a converted spawn (`story-worker`,
 * `acceptance-critic`) boots on its own `.claude/agents/<role>.md` system
 * prompt instead of re-paying the full `CLAUDE.md` @-import closure, which is
 * the whole payoff of the context diet (≈50KB → ≈8KB per spawn). When set to
 * `false`, every converted spawn falls back to `subagent_type: general-purpose`
 * — the instant, code-rollback-free per-consumer revert, and the universal
 * escape for hosts that ignore `.claude/agents/`. Flipping it off never drops a
 * gate: the fallback is the full-closure agent that ran before M7-B.
 *
 * `delivery.routing.freshCriticSampleRate` is the **maker-checker sampling
 * floor** (Epic #4478, M7-B, Part 2). Risk-routed ceremony sends a low-risk
 * acceptance cluster down the contract-identical *inline* critic path, but a
 * fraction of low-risk clusters are still forced through a *fresh-context*
 * critic so "low risk" never degrades to zero independent checking. The rate is
 * clamped into `[0, 1]`; `0` disables the floor (pure risk routing), `1` forces
 * every cluster fresh. The default is `0.2`. See `resolveCeremonyForRisk` in
 * `lib/orchestration/ceremony-routing.js`.
 *
 * Framework-defaults pattern mirrors `lib/config/ci.js#getCiDelivery`.
 */

export const DELIVERY_ROUTING_DEFAULTS = Object.freeze({
  singleDelivery: true,
  roleScopedAgents: true,
  freshCriticSampleRate: 0.2,
});

/**
 * Clamp a candidate sample rate into `[0, 1]`. Non-finite / non-number inputs
 * fall back to the framework default so a degraded config never yields a
 * NaN-driven or out-of-range floor.
 *
 * @param {unknown} value
 * @returns {number}
 */
function clampSampleRate(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DELIVERY_ROUTING_DEFAULTS.freshCriticSampleRate;
  }
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Read the merged `delivery.routing` block, applying framework defaults for
 * any field the operator omitted. Accepts the full resolved config, the bare
 * `delivery` bag, or the bare `routing` bag — mirroring `getCiDelivery`'s
 * tolerant unwrap so callers can pass whichever shape they hold.
 *
 * @param {object | null | undefined} config
 * @returns {{ singleDelivery: boolean, roleScopedAgents: boolean, freshCriticSampleRate: number }}
 */
export function getDeliveryRouting(config) {
  const routing = config?.delivery?.routing ?? config?.routing ?? config ?? {};
  return {
    singleDelivery:
      typeof routing.singleDelivery === 'boolean'
        ? routing.singleDelivery
        : DELIVERY_ROUTING_DEFAULTS.singleDelivery,
    roleScopedAgents:
      typeof routing.roleScopedAgents === 'boolean'
        ? routing.roleScopedAgents
        : DELIVERY_ROUTING_DEFAULTS.roleScopedAgents,
    freshCriticSampleRate: clampSampleRate(routing.freshCriticSampleRate),
  };
}

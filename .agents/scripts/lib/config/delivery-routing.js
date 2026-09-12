/**
 * `delivery.routing` accessor + framework defaults — Epic #4478 (M7-B), the
 * role-scoped-boot-context flip and the ceremony profile.
 *
 * Stage 6 dropped `delivery.routing.singleDelivery` (the v1 epic
 * single-vs-fan-out kill-switch). Story #5313 dropped
 * `delivery.routing.freshCriticSampleRate` (the maker-checker sampling
 * floor): the standard profile now routes purely off the derived change
 * level — high or underivable → fresh critic, low → inline self-eval. v2 has
 * one Story delivery path; routing here is only about spawn boot context and
 * the ceremony profile.
 *
 * `delivery.routing.roleScopedAgents` is the **kill-switch for the role-scoped
 * boot contexts** (Epic #4478, M7-B). It defaults to `true`: a converted spawn
 * (`story-worker`, `acceptance-critic`) boots on its own
 * `.claude/agents/<role>.md` system prompt instead of re-paying the full
 * `CLAUDE.md` @-import closure, which is the whole payoff of the context diet
 * (≈50KB → ≈8KB per spawn). When set to `false`, every converted spawn falls
 * back to `subagent_type: general-purpose` — the instant, code-rollback-free
 * per-consumer revert, and the universal escape for hosts that ignore
 * `.claude/agents/`. Flipping it off never drops a gate: the fallback is the
 * full-closure agent that ran before M7-B.
 *
 * Framework-defaults pattern mirrors `lib/config/ci.js#getCiDelivery`.
 */

export const DELIVERY_ROUTING_DEFAULTS = Object.freeze({
  roleScopedAgents: true,
  /** @type {'minimal'|'standard'|'strict'} */
  ceremonyProfile: 'standard',
  /**
   * When true (default), attended `/mandrel-deliver` lands through merge in one
   * close (`--wait-merge` semantics) instead of stopping at `agent::closing`.
   * Operators opt out per-run with `--no-wait-merge`.
   */
  closeAndLand: true,
});

/**
 * Normalize ceremony profile; unknown values → `standard`.
 *
 * @param {unknown} value
 * @returns {'minimal'|'standard'|'strict'}
 */
function normalizeCeremonyProfile(value) {
  if (value === 'minimal' || value === 'standard' || value === 'strict') {
    return value;
  }
  return DELIVERY_ROUTING_DEFAULTS.ceremonyProfile;
}

/**
 * Read the merged `delivery.routing` block, applying framework defaults for
 * any field the operator omitted. Accepts the full resolved config, the bare
 * `delivery` bag, or the bare `routing` bag — mirroring `getCiDelivery`'s
 * tolerant unwrap so callers can pass whichever shape they hold.
 *
 * @param {object | null | undefined} config
 * @returns {{
 *   roleScopedAgents: boolean,
 *   ceremonyProfile: 'minimal'|'standard'|'strict',
 *   closeAndLand: boolean,
 * }}
 */
export function getDeliveryRouting(config) {
  const routing = config?.delivery?.routing ?? config?.routing ?? config ?? {};
  return {
    roleScopedAgents:
      typeof routing.roleScopedAgents === 'boolean'
        ? routing.roleScopedAgents
        : DELIVERY_ROUTING_DEFAULTS.roleScopedAgents,
    ceremonyProfile: normalizeCeremonyProfile(routing.ceremonyProfile),
    closeAndLand:
      typeof routing.closeAndLand === 'boolean'
        ? routing.closeAndLand
        : DELIVERY_ROUTING_DEFAULTS.closeAndLand,
  };
}

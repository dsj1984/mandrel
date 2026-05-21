/**
 * review-providers/review-provider-factory.js — resolve
 * `codeReview.provider` to a concrete `ReviewProvider` instance.
 *
 * Story #2825 (Epic #2815) — the factory is the only entry point.
 * `runCodeReview()` never references a specific adapter directly;
 * adding a backend is (1) implement the interface, (2) register here,
 * (3) extend the schema enum.
 *
 * Behaviour:
 *   - Unset / missing `codeReview.provider` defaults to `'native'`.
 *   - Unknown provider name throws an Error with remediation text
 *     naming the supported values.
 *   - Adapters that throw at construction time (e.g. `codex`
 *     probing for an absent plugin command) bubble their error
 *     verbatim — the factory does NOT silently fall back to `native`
 *     because that would mask a deliberate operator routing choice.
 *
 * Story #2825 registers only the `native` placeholder. The native
 * adapter body itself lands in a later story; this file establishes
 * the registry shape and the error contract.
 *
 * @typedef {import('./types.js').ReviewProvider} ReviewProvider
 * @typedef {import('./types.js').Finding} Finding
 * @typedef {import('./types.js').ReviewInput} ReviewInput
 */

/**
 * Placeholder native adapter. Story #2825 only stands up the seam;
 * the real findings-collection logic moves into `native.js` in a
 * later story and replaces this stub. The stub throws on `runReview`
 * so any caller that wires the seam before the adapter lands fails
 * loudly rather than silently returning an empty `Finding[]`.
 *
 * @returns {ReviewProvider}
 */
function createNativeProviderStub() {
  return {
    /**
     * @param {ReviewInput} _input
     * @returns {Promise<Finding[]>}
     */
    async runReview(_input) {
      throw new Error(
        '[ReviewProviderFactory] native provider is not yet implemented. ' +
          'The native adapter lands in a later story under Epic #2815; ' +
          'until then, do not invoke runCodeReview() through this factory.',
      );
    },
  };
}

/**
 * Provider registry. Maps the `codeReview.provider` enum value to a
 * zero-arg constructor that returns a `ReviewProvider` instance.
 *
 * @type {Readonly<Record<string, () => ReviewProvider>>}
 */
const PROVIDERS = Object.freeze({
  native: createNativeProviderStub,
});

/**
 * The provider name used when `codeReview.provider` is unset or the
 * `codeReview` block is absent entirely.
 */
export const DEFAULT_PROVIDER_NAME = 'native';

/**
 * Resolve a `ReviewProvider` instance from the resolved agentrc
 * config block. Pass the `codeReview` sub-object (not the full
 * config) so callers can compose with their own config readers.
 *
 * @param {{ provider?: string, providerConfig?: object }|null|undefined} codeReviewConfig
 * @param {{ registry?: Readonly<Record<string, () => ReviewProvider>> }} [opts]
 * @returns {ReviewProvider}
 * @throws {Error} when the configured provider name is not registered.
 */
export function createReviewProvider(codeReviewConfig, opts = {}) {
  const registry = opts.registry ?? PROVIDERS;
  const name =
    codeReviewConfig && typeof codeReviewConfig.provider === 'string'
      ? codeReviewConfig.provider
      : DEFAULT_PROVIDER_NAME;

  const ctor = registry[name];
  if (!ctor) {
    const supported = Object.keys(registry).sort().join(', ');
    throw new Error(
      `[ReviewProviderFactory] Unknown codeReview.provider "${name}". ` +
        `Supported values: ${supported}. ` +
        'Set codeReview.provider in .agentrc.json to one of the supported ' +
        'values, or remove the field to use the default ("native").',
    );
  }
  return ctor();
}

/**
 * Expose the registered provider names — primarily for diagnostics
 * and test fixtures.
 *
 * @returns {string[]}
 */
export function listRegisteredProviders() {
  return Object.keys(PROVIDERS).sort();
}

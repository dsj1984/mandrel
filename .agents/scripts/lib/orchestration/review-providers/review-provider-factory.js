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
 * Story #2833 replaced the placeholder `native` stub with the real
 * adapter from `./native.js`; the registry shape is unchanged.
 *
 * @typedef {import('./types.js').ReviewProvider} ReviewProvider
 * @typedef {import('./types.js').Finding} Finding
 * @typedef {import('./types.js').ReviewInput} ReviewInput
 */

import { createCodexProviderForRegistry } from './codex.js';
import { createNativeProviderForRegistry } from './native.js';

/**
 * Provider registry. Maps the `codeReview.provider` enum value to a
 * zero-arg constructor that returns a `ReviewProvider` instance.
 *
 * Story #2830 (Task #2834) registers the `codex` adapter alongside
 * `native`. The `codex` constructor probes for the `/codex:review`
 * slash command at construction time and throws a hard-fail Error
 * (naming both remediations) when the plugin is not installed — the
 * factory does NOT silently fall back to `native`.
 *
 * @type {Readonly<Record<string, () => ReviewProvider>>}
 */
const PROVIDERS = Object.freeze({
  codex: createCodexProviderForRegistry,
  native: createNativeProviderForRegistry,
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

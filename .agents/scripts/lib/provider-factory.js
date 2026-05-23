/**
 * Provider Factory — resolves the configured ticketing provider to a concrete class.
 *
 * Accepts the canonical resolved config object (the wrapper returned by
 * `resolveConfig()` with `config.github` populated). The legacy
 * `orchestration`-shaped argument is no longer supported as part of the
 * Epic #2880 hard cutover; see `.agents/rules/git-conventions.md#contract-cutovers-—-no-shim-layer`.
 *
 * @see docs/v5-implementation-plan.md Sprint 1B
 */

import { GitHubProvider } from '../providers/github.js';

/** @type {Record<string, typeof import('../lib/ITicketingProvider.js').ITicketingProvider>} */
const PROVIDERS = {
  github: GitHubProvider,
};

/**
 * Create a ticketing provider instance from the canonical resolved config.
 *
 * The canonical contract is:
 *   - `config.github` carries the GitHub provider config block
 *     (`owner`, `repo`, `projectNumber`, `projectOwner`, `operatorHandle`,
 *     and friends).
 *   - Today GitHub is the only supported provider, so the provider name is
 *     inferred from the presence of `config.github`. When additional
 *     providers land, this resolver will gain a `config.provider` discriminator.
 *
 * @param {object|null} config - The resolved config wrapper (`resolveConfig()` output).
 * @param {{ token?: string }} [opts] - Override options (e.g., test token).
 * @returns {import('../lib/ITicketingProvider.js').ITicketingProvider}
 * @throws {Error} If config is not provided or the provider block is missing.
 */
export function createProvider(config, opts = {}) {
  if (!config) {
    throw new Error(
      '[ProviderFactory] config is not configured. ' +
        'Pass the resolved config from resolveConfig() with a populated "github" block.',
    );
  }

  const providerName = resolveProviderName(config);
  if (!providerName) {
    throw new Error(
      '[ProviderFactory] provider is required. ' +
        'Populate the canonical "github" block in .agentrc.json.',
    );
  }

  const ProviderClass = PROVIDERS[providerName];
  if (!ProviderClass) {
    const supported = Object.keys(PROVIDERS).join(', ');
    throw new Error(
      `[ProviderFactory] Unsupported provider "${providerName}". ` +
        `Supported: ${supported}.`,
    );
  }

  const providerConfig = config[providerName];
  if (!providerConfig) {
    throw new Error(
      `[ProviderFactory] ${providerName} config block is required ` +
        `when provider is "${providerName}".`,
    );
  }

  return new ProviderClass(providerConfig, opts);
}

/**
 * Infer the provider name from the resolved config. Today the only
 * supported value is `'github'`; a future provider would add a discriminator
 * field on the top-level config and this helper would consult it.
 */
function resolveProviderName(config) {
  if (typeof config.provider === 'string') return config.provider;
  if (config.github) return 'github';
  return null;
}

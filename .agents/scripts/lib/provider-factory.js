/** Provider factory — resolved config → concrete ticketing provider. */

import { GitHubProvider } from '../providers/github.js';

/** @type {Record<string, typeof import('../lib/ITicketingProvider.js').ITicketingProvider>} */
const PROVIDERS = {
  github: GitHubProvider,
};

/**
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

/** An explicit `config.provider` wins; otherwise a `github` block implies it. */
function resolveProviderName(config) {
  if (typeof config.provider === 'string') return config.provider;
  if (config.github) return 'github';
  return null;
}

/**
 * Provider Factory — instantiates the ticketing provider from a canonical
 * `github` config block.
 *
 * Post-cutover (Story #2944, Epic #2880), the factory accepts the canonical
 * `github` block from `.agentrc.json` (`config.github`) directly. There is
 * no `provider` discriminator and no per-provider sub-block lookup — every
 * supported runtime targets GitHub. If/when a second backend is added, the
 * discriminator returns under a fresh top-level config block (e.g.
 * `ticketing.provider`), not via a `github.provider` field.
 *
 * @see docs/v5-implementation-plan.md Sprint 1B (initial design)
 * @see Epic #2880 F14 (canonical config cutover)
 */

import { GitHubProvider } from '../providers/github.js';

/**
 * Create a ticketing provider instance from the canonical `github` config.
 *
 * Accepts the canonical `github` block (top-level shape from
 * `.agentrc.json`, e.g. `resolveConfig().github`). The legacy
 * config-resolver shim object — recognized by the presence of a nested
 * `github` sub-key alongside a `provider` discriminator — is unwrapped to
 * its inner `github` block for the duration of Epic #2880's call-site
 * migration. Story #2947 deletes both the shim and the unwrap branch in a
 * single hard cutover.
 *
 * @param {object|null} github - The `github` block from `.agentrc.json`
 *   (typically `resolveConfig().github`). Must carry at least `owner` and
 *   `repo`; `operatorHandle`, `projectNumber`, `projectOwner`,
 *   `defaultTimeoutMs` are honored when present.
 * @param {{ token?: string, gh?: object }} [opts] - Override options (e.g.,
 *   test token, injected `gh-exec` facade).
 * @returns {import('../lib/ITicketingProvider.js').ITicketingProvider}
 * @throws {Error} If `github` is missing or lacks `owner`/`repo`.
 */
export function createProvider(github, opts = {}) {
  if (!github) {
    throw new Error(
      '[ProviderFactory] github config is not configured in .agentrc.json. ' +
        'Add a top-level "github" block with at least "owner" and "repo".',
    );
  }

  // Transitional unwrap: callers under Epic #2880 still pass the legacy
  // resolver-shim object whose inner block carries the actual owner/repo.
  // Recognize the shim shape (`{ provider, github: {...}, ... }`) and use
  // its nested `github` instead of treating the wrapper as the config.
  // Removed in Story #2947 once every call site reads canonical config.
  const effective =
    github.provider && github.github && typeof github.github === 'object'
      ? github.github
      : github;

  if (!effective.owner || !effective.repo) {
    throw new Error(
      '[ProviderFactory] github.owner and github.repo are required.',
    );
  }

  return new GitHubProvider(effective, opts);
}

/**
 * framework-repo.js — ownership routing SSOT across `consumer`, `framework`
 * and `platform` buckets. Deliberately no `?? currentRepo` fallback: an
 * unresolvable bucket is `routable: false` + `missingKey`, and the caller must
 * say out loud what it did instead of silently mis-filing.
 */

export const DEFAULT_FRAMEWORK_REPO = 'dsj1984/mandrel';

export const OWNERSHIP_BUCKETS = Object.freeze([
  'consumer',
  'framework',
  'platform',
]);

const OWNERSHIP_CONFIG_KEYS = Object.freeze({
  consumer: 'github.owner / github.repo',
  framework: 'github.followUpRepos.framework',
  platform: 'github.followUpRepos.platform',
});

/**
 * @param {string|null|undefined} slug
 * @returns {{ owner: string, repo: string } | null}
 */
export function parseRepoSlug(slug) {
  if (typeof slug !== 'string') return null;
  const parts = slug.trim().split('/');
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!owner || !repo) return null;
  return { owner, repo };
}

/**
 * @param {{ owner?: string, repo?: string }|null|undefined} repo
 * @returns {string|null}
 */
export function formatRepoSlug(repo) {
  if (!repo || typeof repo !== 'object') return null;
  const { owner, repo: name } = /** @type {{owner?: string, repo?: string}} */ (
    repo
  );
  if (typeof owner !== 'string' || typeof name !== 'string') return null;
  if (!owner.trim() || !name.trim()) return null;
  return `${owner.trim()}/${name.trim()}`;
}

/**
 * @param {object} [config]
 * @returns {{ consumer: ({owner: string, repo: string}|null), framework: ({owner: string, repo: string}|null), platform: ({owner: string, repo: string}|null) }}
 */
export function resolveOwnershipRepos(config) {
  const github = config?.github ?? {};
  const followUp = github?.followUpRepos ?? {};
  const owner = typeof github.owner === 'string' ? github.owner.trim() : '';
  const repo = typeof github.repo === 'string' ? github.repo.trim() : '';
  return {
    consumer: owner && repo ? { owner, repo } : null,
    framework:
      parseRepoSlug(followUp.framework) ??
      parseRepoSlug(DEFAULT_FRAMEWORK_REPO),
    platform: parseRepoSlug(followUp.platform),
  };
}

/**
 * Total: never a substituted repo.
 *
 * @param {object} opts
 * @param {string} opts.bucket
 * @param {{consumer?: object|null, framework?: object|null, platform?: object|null}} opts.repos
 * @param {{owner: string, repo: string}|null} [opts.currentRepo] — for `crossRepo`.
 * @returns {{ bucket: string, routedRepo: ({owner: string, repo: string}|null), routable: boolean, missingKey: (string|null), crossRepo: boolean }}
 */
export function routeOwnership({ bucket, repos, currentRepo = null } = {}) {
  const known = OWNERSHIP_BUCKETS.includes(bucket);
  const routedRepo = known ? (repos?.[bucket] ?? null) : null;
  const routable = Boolean(routedRepo?.owner && routedRepo?.repo);
  const missingKey = routable
    ? null
    : (OWNERSHIP_CONFIG_KEYS[bucket] ?? `unknown ownership bucket "${bucket}"`);
  const crossRepo =
    routable &&
    Boolean(currentRepo) &&
    (routedRepo.owner !== currentRepo.owner ||
      routedRepo.repo !== currentRepo.repo);
  return { bucket, routedRepo, routable, missingKey, crossRepo };
}

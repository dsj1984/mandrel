/**
 * framework-repo.js — the follow-up **ownership routing** SSOT: which
 * repository a finding, a retro proposal, or a CI-gap intake issue is filed
 * in, and what to say when that question has no answer.
 *
 * ## Three buckets, not two
 *
 * A defect surfaced by one repository's CI is not necessarily that
 * repository's to fix. Ownership splits three ways:
 *
 *   - `consumer`  — the repo the run is standing in (`github.owner`/`repo`).
 *   - `framework` — the Mandrel framework itself
 *     (`github.followUpRepos.framework`, defaulted to the mirror constant).
 *   - `platform`  — a shared platform / infrastructure repo that neither of
 *     the other two owns: a shared base config, a runner fleet, a
 *     cross-repo toolchain (`github.followUpRepos.platform`, **no default**
 *     — nothing can guess a shared repo's slug).
 *
 * ## Why there is no `?? currentRepo` fallback
 *
 * The two-bucket predecessor resolved a framework-tagged item with
 * `frameworkRepo ? frameworkRepo : currentRepo`. When the config key was
 * absent that expression filed framework-owned work into the **consumer's**
 * repo while the rendered retro claimed it went to the framework repo — a
 * silent mis-file, recorded in `retro-proposals-graduator.js`'s own file-top
 * comment. The failure was invisible in this repository precisely because
 * consumer === framework here.
 *
 * So an unresolvable bucket is a first-class outcome, never a fallback:
 * `routeOwnership` returns `routable: false` plus the `missingKey` that
 * would fix it, and every caller must decide **out loud** what to do with
 * that — file locally and say so in the body (the CI-gap filer), or defer
 * and surface it where an operator will see it (the graduators). What no
 * caller may do is route it somewhere plausible and stay quiet.
 */

/**
 * Canonical framework repository slug, used when the consumer config does
 * not supply `github.followUpRepos.framework`. The `framework` bucket is the
 * one bucket with a knowable default: it is this framework.
 */
export const DEFAULT_FRAMEWORK_REPO = 'dsj1984/mandrel';

/** The closed ownership-bucket set. */
export const OWNERSHIP_BUCKETS = Object.freeze([
  'consumer',
  'framework',
  'platform',
]);

/**
 * The `.agentrc.json` key behind each bucket, quoted verbatim when a bucket
 * is unroutable so the operator is told which key to set rather than that
 * "routing failed".
 */
export const OWNERSHIP_CONFIG_KEYS = Object.freeze({
  consumer: 'github.owner / github.repo',
  framework: 'github.followUpRepos.framework',
  platform: 'github.followUpRepos.platform',
});

/**
 * Parse an `"<owner>/<repo>"` slug into `{ owner, repo }`, or `null` when the
 * slug is absent, empty, or malformed. A `null` return is the signal an
 * unroutable bucket is built from — never a reason to substitute another
 * repo.
 *
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
 * Render a `{ owner, repo }` pair back to its slug, or `null` when the pair
 * is absent/malformed.
 *
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
 * Resolve every ownership bucket from a resolved `.agentrc` config.
 *
 * `framework` falls back to {@link DEFAULT_FRAMEWORK_REPO}; `platform` has no
 * default and stays `null` when unconfigured; `consumer` is `null` when
 * `github.owner`/`github.repo` are unset. A `null` bucket is an honest
 * "unknown", which {@link routeOwnership} turns into a named, reportable
 * outcome.
 *
 * @param {object} [config] — resolved `.agentrc` config.
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
 * Route one ownership bucket to the repository its work belongs in.
 *
 * Total: an unknown bucket, an absent repos map, and an unconfigured bucket
 * all resolve to `routable: false` with the `missingKey` that would fix it —
 * never to a substituted repository.
 *
 * @param {object} opts
 * @param {string} opts.bucket — one of {@link OWNERSHIP_BUCKETS}.
 * @param {{consumer?: object|null, framework?: object|null, platform?: object|null}} opts.repos
 *   — resolved buckets, from {@link resolveOwnershipRepos} or assembled by a
 *   caller that already holds the repo objects.
 * @param {{owner: string, repo: string}|null} [opts.currentRepo] — the repo
 *   the run is standing in, used only to report `crossRepo`.
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

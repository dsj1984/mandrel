/**
 * GitHub Repo Settings — merge-method flags etc.
 *
 * Thin REST wrappers around `GET /repos/{owner}/{repo}` and the matching
 * `PATCH`. The fields we read/write are the merge-method allowlist plus
 * `allow_auto_merge` and `delete_branch_on_merge`, since Story 5 of Epic
 * #1235 promotes the hands-off-pipeline stance (squash-only, auto-merge
 * on, branch deleted on merge).
 *
 * Submodules in `providers/github/` are pure functions over `ctx` — see
 * `branches.js` for the canonical shape.
 */

const MERGE_METHOD_FIELDS = [
  'allow_squash_merge',
  'allow_rebase_merge',
  'allow_merge_commit',
  'allow_auto_merge',
  'delete_branch_on_merge',
];

/**
 * Read the repo's current merge-method-related settings. Returns only the
 * fields the bootstrap cares about so the diff layer can compare apples to
 * apples regardless of what other knobs the repo exposes.
 */
export async function getMergeMethods(ctx) {
  const endpoint = `/repos/${ctx.owner}/${ctx.repo}`;
  const raw = await ctx.http.rest(endpoint);
  const out = {};
  for (const f of MERGE_METHOD_FIELDS) {
    if (Object.hasOwn(raw, f)) out[f] = raw[f];
  }
  return out;
}

/**
 * PATCH the repo with the supplied merge-method settings. The GitHub API
 * accepts a sparse body — only the fields we PATCH are touched, so the
 * caller can decide whether to send the full set (Story 5's default) or
 * just the deltas (test-only).
 *
 * @param {object} ctx
 * @param {Partial<{
 *   allow_squash_merge: boolean,
 *   allow_rebase_merge: boolean,
 *   allow_merge_commit: boolean,
 *   allow_auto_merge: boolean,
 *   delete_branch_on_merge: boolean,
 * }>} settings
 */
export async function setMergeMethods(ctx, settings) {
  const endpoint = `/repos/${ctx.owner}/${ctx.repo}`;
  const body = {};
  for (const f of MERGE_METHOD_FIELDS) {
    if (Object.hasOwn(settings, f)) body[f] = settings[f];
  }
  await ctx.http.rest(endpoint, { method: 'PATCH', body });
  return { patched: Object.keys(body) };
}

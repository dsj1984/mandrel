/**
 * project-meta-resolver — shared GitHub Projects v2 owner-resolution
 * primitive (Story #4237).
 *
 * Background:
 *   Both `ColumnSync._loadMeta` (`lib/orchestration/column-sync.js`) and
 *   `resolveProjectIdByNumber` (`lib/bootstrap/workflow-audit.js`)
 *   needed to turn a `(owner, projectNumber)` pair into a Projects v2
 *   board node id. Each historically resolved only **user-owned** /
 *   `viewer`-owned boards: `viewer.projectV2(number:)` first, then
 *   `user(login:$owner).projectV2(number:)` (Story #3560). Neither had an
 *   `organization(login:$owner)` branch, so for an **org-owned** board
 *   every lookup failed with `NOT_FOUND` and the `agent::*` → board
 *   Status mirror silently no-oped (reproduced on `Beestera/swarm-os`).
 *
 * Fix:
 *   A single shared resolver that walks the owner-type ladder in order —
 *   `organization(login:$owner)` → `user(login:$owner)` → `viewer` —
 *   returning the first board it can resolve. Centralising the ladder in
 *   one place means the org path can never again drift between the two
 *   call sites.
 *
 * The resolver issues a sub-query for the project itself (`field(name:
 * "Status") { … }` for the column-sync caller, or a bare `id` for the
 * workflow-audit caller). Pass the desired projection in via
 * `projectFields`; the resolver wraps it in the right owner scope and
 * extracts the resolved `projectV2` node.
 */

/**
 * The owner-resolution ladder, in priority order. Each entry names the
 * GraphQL root field and whether it requires the `$owner` variable.
 *
 * `organization` and `user` are keyed by `login: $owner`; `viewer` is the
 * authenticated identity and takes no owner argument. The viewer rung is
 * the historical default and stays last so a configured owner is always
 * preferred over the ambient identity.
 */
const OWNER_SCOPES = Object.freeze([
  { root: 'organization', needsOwner: true },
  { root: 'user', needsOwner: true },
  { root: 'viewer', needsOwner: false },
]);

/**
 * Build the GraphQL document for a single owner scope.
 *
 * @param {{ root: string, needsOwner: boolean }} scope
 * @param {string} projectFields — the inner `projectV2(number: $number) { … }`
 *   selection body (everything between the braces).
 * @returns {string}
 */
function buildScopedQuery(scope, projectFields) {
  if (scope.needsOwner) {
    return `
      query($owner: String!, $number: Int!) {
        ${scope.root}(login: $owner) {
          projectV2(number: $number) {
            ${projectFields}
          }
        }
      }`;
  }
  return `
    query($number: Int!) {
      ${scope.root} {
        projectV2(number: $number) {
          ${projectFields}
        }
      }
    }`;
}

/**
 * Resolve a Projects v2 board node by walking the owner-type ladder.
 *
 * Tries `organization(login:$owner)` → `user(login:$owner)` → `viewer` in
 * order, returning the first non-null `projectV2` node. A scope that
 * throws (e.g. GitHub returns `NOT_FOUND` for the wrong owner type) or
 * resolves to `null` is treated as a miss and the ladder advances to the
 * next rung. Returns `null` when every rung misses.
 *
 * When `owner` is falsy, only the `viewer` rung is attempted (there is no
 * login to scope `organization`/`user` by) — this preserves the original
 * viewer-only behaviour for callers that never configured a project owner.
 *
 * @param {{
 *   provider: { graphql: Function },
 *   owner?: string | null,
 *   projectNumber: number,
 *   projectFields: string,
 * }} args
 * @returns {Promise<object|null>} the resolved `projectV2` node, or null.
 */
export async function resolveProjectMeta(args) {
  const { provider, owner, projectNumber, projectFields } = args ?? {};
  if (!provider || typeof provider.graphql !== 'function') {
    throw new TypeError('resolveProjectMeta requires a provider with graphql');
  }
  if (typeof projectFields !== 'string' || projectFields.length === 0) {
    throw new TypeError(
      'resolveProjectMeta requires a projectFields selection',
    );
  }

  for (const scope of OWNER_SCOPES) {
    // Skip the owner-scoped rungs when no owner login is available.
    if (scope.needsOwner && !owner) continue;

    const query = buildScopedQuery(scope, projectFields);
    const vars = scope.needsOwner
      ? { owner, number: projectNumber }
      : { number: projectNumber };

    let data;
    try {
      data = await provider.graphql(query, vars);
    } catch {
      // Wrong owner type (NOT_FOUND), missing scope, etc. — advance the
      // ladder rather than aborting the whole resolution.
      continue;
    }

    const node = data?.[scope.root]?.projectV2;
    if (node) return node;
  }

  return null;
}

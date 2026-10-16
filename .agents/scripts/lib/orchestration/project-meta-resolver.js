/**
 * project-meta-resolver — the one Projects v2 owner-resolution ladder
 * (`organization` → `user` → `viewer`), shared so an org-owned board can
 * never again silently fail to resolve at one call site. Callers pass the
 * `projectV2 { … }` selection body as `projectFields`.
 */

import {
  isProjectAccessFailure,
  ProjectAccessError,
  toProjectAccessError,
} from './board-access-latch.js';

export { ProjectAccessError };

/**
 * Priority order. `viewer` (the ambient identity) is last so a configured
 * owner always wins.
 */
const OWNER_SCOPES = Object.freeze([
  { root: 'organization', needsOwner: true },
  { root: 'user', needsOwner: true },
  { root: 'viewer', needsOwner: false },
]);

/**
 * @param {{ root: string, needsOwner: boolean }} scope
 * @param {string} projectFields — the selection body inside `projectV2 { … }`.
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
 * One rung's `projectV2` node, or null for a miss. An owner miss (NOT_FOUND)
 * and any other non-access error advance the ladder; a scope or auth refusal
 * is raised as a `ProjectAccessError`.
 */
async function queryRung(
  provider,
  scope,
  { owner, projectNumber, projectFields },
) {
  const vars = scope.needsOwner
    ? { owner, number: projectNumber }
    : { number: projectNumber };
  try {
    const data = await provider.graphql(
      buildScopedQuery(scope, projectFields),
      vars,
    );
    return data?.[scope.root]?.projectV2 ?? null;
  } catch (err) {
    if (isProjectAccessFailure(err)) throw toProjectAccessError(err);
    return null;
  }
}

/**
 * The first non-null `projectV2` node down the ladder. A null rung or an
 * owner miss (NOT_FOUND — expected on two of three rungs) advances; a scope
 * or auth refusal is identical on every rung, so it fails fast as a
 * `ProjectAccessError` instead of being hidden by the ladder. With no
 * `owner`, only `viewer` is tried.
 *
 * @param {{
 *   provider: { graphql: Function },
 *   owner?: string | null,
 *   projectNumber: number,
 *   projectFields: string,
 * }} args
 * @returns {Promise<object|null>} the resolved `projectV2` node, or null.
 * @throws {ProjectAccessError} when the token cannot read the board.
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
    if (scope.needsOwner && !owner) continue;
    const node = await queryRung(provider, scope, {
      owner,
      projectNumber,
      projectFields,
    });
    if (node) return node;
  }

  return null;
}

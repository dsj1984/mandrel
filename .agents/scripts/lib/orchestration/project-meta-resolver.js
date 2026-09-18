/**
 * project-meta-resolver — the one Projects v2 owner-resolution ladder
 * (`organization` → `user` → `viewer`), shared so an org-owned board can
 * never again silently fail to resolve at one call site. Callers pass the
 * `projectV2 { … }` selection body as `projectFields`.
 */

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
 * The first non-null `projectV2` node down the ladder; a throwing or null
 * rung is a miss. With no `owner`, only `viewer` is tried.
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
    if (scope.needsOwner && !owner) continue;

    const query = buildScopedQuery(scope, projectFields);
    const vars = scope.needsOwner
      ? { owner, number: projectNumber }
      : { number: projectNumber };

    let data;
    try {
      data = await provider.graphql(query, vars);
    } catch {
      // Wrong owner type (NOT_FOUND) etc. — advance the ladder.
      continue;
    }

    const node = data?.[scope.root]?.projectV2;
    if (node) return node;
  }

  return null;
}

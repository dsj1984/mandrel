/**
 * GitHub Projects V2 — board/field/view setup over GraphQL.
 *
 * All cross-cutting helpers (`addItemToProject`, `fetchProjectMetadata`)
 * live here. The facade exposes them via `ctx.hooks.addItemToProject` so
 * sibling submodules (issues.js, branches.js) can invoke them without
 * importing this file directly — preserving the ctx-threading discipline.
 */

import { runGraphql } from './graphql.js';
import {
  ADD_PROJECT_ITEM_MUTATION,
  buildProjectV2LookupQuery,
  CREATE_PROJECT_MUTATION,
  CREATE_PROJECT_VIEW_MUTATION,
  CREATE_SINGLE_SELECT_FIELD_MUTATION,
  OWNER_NODE_LOOKUP_QUERY,
  PROJECT_FIELDS_FRAGMENT,
  PROJECT_VIEWS_FRAGMENT,
  STATUS_FIELD_FRAGMENT,
  UPDATE_SINGLE_SELECT_FIELD_MUTATION,
} from './graphql-builder.js';

/**
 * Detect whether a GraphQL error represents a missing Projects V2 permission
 * scope. Bootstrap treats these as soft failures.
 */
export function isInsufficientScopes(err) {
  if (!err) return false;
  const haystack = err.message ?? err.toString?.() ?? String(err);
  return (
    /INSUFFICIENT_SCOPES/i.test(haystack) ||
    /Resource not accessible by personal access token/i.test(haystack) ||
    /your token has not been granted the required scopes/i.test(haystack)
  );
}

/**
 * Fetch Project V2 data, checking both User and Organization scopes. Soft
 * failures (warn + return null) so callers degrade gracefully.
 */
async function fetchProjectV2(ctx, fragment) {
  if (!ctx.projectNumber) return null;

  try {
    const userProjectData = await runGraphql(
      ctx,
      buildProjectV2LookupQuery('user', fragment),
      { owner: ctx.projectOwner, number: ctx.projectNumber },
    );
    if (userProjectData?.user?.projectV2) return userProjectData.user.projectV2;
  } catch (err) {
    console.warn(
      `[GitHubProvider] ProjectV2 user lookup failed (owner=${ctx.projectOwner}): ${err.message}`,
    );
  }

  try {
    const orgProjectData = await runGraphql(
      ctx,
      buildProjectV2LookupQuery('organization', fragment),
      { owner: ctx.projectOwner, number: ctx.projectNumber },
    );
    return orgProjectData?.organization?.projectV2;
  } catch (err) {
    console.warn(
      `[GitHubProvider] ProjectV2 org lookup failed (owner=${ctx.projectOwner}): ${err.message}`,
    );
  }

  return null;
}

/**
 * Strict sibling of `fetchProjectV2` — rethrows instead of swallowing so
 * callers can detect INSUFFICIENT_SCOPES and degrade.
 */
async function fetchProjectV2Strict(ctx, fragment) {
  if (!ctx.projectNumber) return null;

  let userErr = null;
  try {
    const userProjectData = await runGraphql(
      ctx,
      buildProjectV2LookupQuery('user', fragment),
      { owner: ctx.projectOwner, number: ctx.projectNumber },
    );
    if (userProjectData?.user?.projectV2) return userProjectData.user.projectV2;
  } catch (err) {
    if (isInsufficientScopes(err)) throw err;
    userErr = err;
  }

  try {
    const orgProjectData = await runGraphql(
      ctx,
      buildProjectV2LookupQuery('organization', fragment),
      { owner: ctx.projectOwner, number: ctx.projectNumber },
    );
    if (orgProjectData?.organization?.projectV2)
      return orgProjectData.organization.projectV2;
  } catch (err) {
    if (isInsufficientScopes(err)) throw err;
    throw err;
  }

  if (userErr) throw userErr;
  return null;
}

/* node:coverage ignore next */
async function fetchProjectMetadata(ctx) {
  if (ctx.state.projectId) return ctx.state.projectId;
  const project = await fetchProjectV2(ctx, 'id');
  if (project) ctx.state.projectId = project.id;
  return ctx.state.projectId;
}

/**
 * @param {object} ctx
 * @param {string} contentNodeId - GraphQL node ID of the issue/PR.
 */
export async function addItemToProject(ctx, contentNodeId) {
  const projectId = await fetchProjectMetadata(ctx);
  if (!projectId) return;
  await runGraphql(ctx, ADD_PROJECT_ITEM_MUTATION, {
    projectId,
    contentId: contentNodeId,
  });
}

/**
 * Pure: detect the soft-degrade envelope `{ scopesMissing: true }` that
 * GraphQL helpers return on INSUFFICIENT_SCOPES. Exported for tests.
 *
 * @param {unknown} value
 * @returns {value is { scopesMissing: true }}
 */
export function isScopesMissingEnvelope(value) {
  return (
    Boolean(value) && typeof value === 'object' && value.scopesMissing === true
  );
}

/**
 * Resolve a pre-configured project by `ctx.projectNumber`.
 *
 * @returns {Promise<{ projectId: string, projectNumber: number, created: false } | { scopesMissing: true } | null>}
 *   The project on success, `{ scopesMissing: true }` when GraphQL signals
 *   insufficient scopes, or `null` when the project number is set but the
 *   project itself was not found (caller decides whether to throw).
 */
export async function resolveExistingProject(ctx) {
  try {
    const project = await fetchProjectV2(ctx, 'id');
    if (project) {
      ctx.state.projectId = project.id;
      return {
        projectId: project.id,
        projectNumber: ctx.projectNumber,
        created: false,
      };
    }
  } catch (err) {
    if (isInsufficientScopes(err)) return { scopesMissing: true };
    throw err;
  }
  return null;
}

/**
 * Look up the GraphQL node id for `owner`, trying organization then user.
 *
 * @returns {Promise<string | { scopesMissing: true } | null>}
 */
export async function lookupOwnerNodeId(ctx, owner) {
  try {
    const ownerLookupData = await runGraphql(ctx, OWNER_NODE_LOOKUP_QUERY, {
      login: owner,
    });
    return (
      ownerLookupData?.organization?.id ?? ownerLookupData?.user?.id ?? null
    );
  } catch (err) {
    if (isInsufficientScopes(err)) return { scopesMissing: true };
    throw err;
  }
}

/**
 * Create a new ProjectV2 owned by `ownerNodeId` with title `name`.
 *
 * @returns {Promise<{ projectId: string, projectNumber: number, created: true } | { scopesMissing: true }>}
 */
export async function createProjectForOwner(ctx, ownerNodeId, name) {
  try {
    const createProjectData = await runGraphql(ctx, CREATE_PROJECT_MUTATION, {
      ownerId: ownerNodeId,
      title: name,
    });
    const project = createProjectData?.createProjectV2?.projectV2;
    if (!project) {
      throw new Error('[GitHubProvider] createProjectV2 returned no project.');
    }
    ctx.state.projectId = project.id;
    ctx.projectNumber = project.number;
    return {
      projectId: project.id,
      projectNumber: project.number,
      created: true,
    };
  } catch (err) {
    if (isInsufficientScopes(err)) return { scopesMissing: true };
    throw err;
  }
}

/**
 * Resolve the configured Project, or create one if `projectNumber` is not
 * set. On insufficient scopes returns `{ scopesMissing: true }` so bootstrap
 * can degrade.
 */
export async function resolveOrCreateProject(ctx, opts = {}) {
  const owner = opts.owner ?? ctx.projectOwner;
  const name = opts.name ?? ctx.projectName ?? `${ctx.repo} — Agent Protocols`;

  if (ctx.projectNumber) {
    const resolved = await resolveExistingProject(ctx);
    if (resolved) return resolved;
    throw new Error(
      `[GitHubProvider] Project #${ctx.projectNumber} not found for ${owner}.`,
    );
  }

  const ownerNodeId = await lookupOwnerNodeId(ctx, owner);
  if (isScopesMissingEnvelope(ownerNodeId)) return ownerNodeId;
  if (!ownerNodeId) {
    throw new Error(
      `[GitHubProvider] Could not resolve owner node id for "${owner}".`,
    );
  }

  return createProjectForOwner(ctx, ownerNodeId, name);
}

/**
 * Ensure the Status single-select field exists on the project with the given
 * options. Idempotent. When the mutation is unavailable due to missing
 * scopes, returns `{ status: 'scopes-missing', added: [] }`.
 */
export async function ensureStatusField(ctx, optionNames) {
  if (!ctx.projectNumber) {
    throw new Error(
      '[GitHubProvider] ensureStatusField requires projectNumber.',
    );
  }

  let project;
  try {
    project = await fetchProjectV2Strict(ctx, STATUS_FIELD_FRAGMENT);
  } catch (err) {
    if (isInsufficientScopes(err))
      return { status: 'scopes-missing', added: [] };
    throw err;
  }

  if (!project) {
    throw new Error(
      `[GitHubProvider] Project #${ctx.projectNumber} not found for ${ctx.projectOwner}.`,
    );
  }

  const statusField = (project.fields?.nodes ?? []).find(
    (f) => f?.name === 'Status',
  );

  if (!statusField) {
    try {
      const createFieldData = await runGraphql(
        ctx,
        CREATE_SINGLE_SELECT_FIELD_MUTATION,
        {
          projectId: project.id,
          name: 'Status',
          options: optionNames.map((o) => ({
            name: o,
            color: 'GRAY',
            description: '',
          })),
        },
      );
      return {
        status: 'created',
        added: [...optionNames],
        fieldId: createFieldData?.createProjectV2Field?.projectV2Field?.id,
      };
    } catch (err) {
      if (isInsufficientScopes(err))
        return { status: 'scopes-missing', added: [] };
      throw err;
    }
  }

  const existing = new Map(
    (statusField.options ?? []).map((o) => [o.name, o.id]),
  );
  const missing = optionNames.filter((name) => !existing.has(name));
  if (missing.length === 0) {
    return { status: 'unchanged', added: [], fieldId: statusField.id };
  }

  const mergedOptions = [
    // Preserve existing options by id so Projects doesn't drop them.
    ...(statusField.options ?? []).map((o) => ({
      id: o.id,
      name: o.name,
      color: 'GRAY',
      description: '',
    })),
    ...missing.map((name) => ({ name, color: 'GRAY', description: '' })),
  ];

  try {
    await runGraphql(ctx, UPDATE_SINGLE_SELECT_FIELD_MUTATION, {
      fieldId: statusField.id,
      name: 'Status',
      options: mergedOptions,
    });
    return { status: 'updated', added: missing, fieldId: statusField.id };
  } catch (err) {
    if (isInsufficientScopes(err))
      return { status: 'scopes-missing', added: [] };
    throw err;
  }
}

/**
 * Best-effort Projects V2 Views creation. Any failure (missing mutation,
 * missing scopes, rate limit) is caught and surfaced as
 * `{ unavailable: true }` so the caller can direct the user to
 * `docs/project-board.md` for manual setup.
 */
export async function ensureProjectViews(ctx, viewDefs) {
  if (!ctx.projectNumber) {
    throw new Error(
      '[GitHubProvider] ensureProjectViews requires projectNumber.',
    );
  }

  const created = [];
  const skipped = [];

  let project;
  try {
    project = await fetchProjectV2Strict(ctx, PROJECT_VIEWS_FRAGMENT);
  } catch (err) {
    if (isInsufficientScopes(err)) {
      return {
        created,
        skipped: viewDefs.map((v) => v.name),
        unavailable: true,
      };
    }
    return {
      created,
      skipped: viewDefs.map((v) => v.name),
      unavailable: true,
    };
  }

  if (!project) {
    throw new Error(
      `[GitHubProvider] Project #${ctx.projectNumber} not found for ${ctx.projectOwner}.`,
    );
  }

  const existingViewNames = new Set(
    (project.views?.nodes ?? []).map((v) => v?.name).filter(Boolean),
  );

  let unavailable = false;
  for (const def of viewDefs) {
    if (existingViewNames.has(def.name)) {
      skipped.push(def.name);
      continue;
    }
    if (unavailable) {
      skipped.push(def.name);
      continue;
    }
    try {
      await runGraphql(ctx, CREATE_PROJECT_VIEW_MUTATION, {
        projectId: project.id,
        name: def.name,
        filter: def.filter,
      });
      created.push(def.name);
    } catch {
      // First failure signals the mutation is unavailable in this context —
      // stop attempting subsequent views to avoid noise.
      unavailable = true;
      skipped.push(def.name);
    }
  }

  return { created, skipped, unavailable };
}

/* node:coverage ignore next */
export async function ensureProjectFields(ctx, fieldDefs) {
  if (!ctx.projectNumber) return { created: [], skipped: [] };

  const project = await fetchProjectV2(ctx, PROJECT_FIELDS_FRAGMENT);

  if (!project) {
    throw new Error(
      `[GitHubProvider] Project #${ctx.projectNumber} not found for ${ctx.projectOwner}.`,
    );
  }

  const existingFields = new Set(
    project.fields.nodes.map((f) => f.name).filter(Boolean),
  );

  const created = [];
  const skipped = [];

  for (const def of fieldDefs) {
    if (existingFields.has(def.name)) {
      skipped.push(def.name);
      continue;
    }

    if (def.type === 'iteration') {
      skipped.push(def.name); // Not supported via GraphQL
      continue;
    }

    if (def.type === 'single_select') {
      await runGraphql(ctx, CREATE_SINGLE_SELECT_FIELD_MUTATION, {
        projectId: project.id,
        name: def.name,
        options: (def.options ?? []).map((o) => ({
          name: o,
          color: 'GRAY',
          description: '',
        })),
      });
    }

    created.push(def.name);
  }

  return { created, skipped };
}

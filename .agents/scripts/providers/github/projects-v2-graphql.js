/**
 * Projects V2 GraphQL shim — single retained surface (Story #1358, Epic #1179).
 * Collapses the projects.js / graphql.js / graphql-builder.js trio into one
 * file; provider delegates the four V2 methods + addItemToProject here. Token:
 * `gh auth token` → GITHUB_TOKEN/GH_TOKEN env. Soft-fails on
 * INSUFFICIENT_SCOPES via `{scopesMissing:true}` / `status:'scopes-missing'` /
 * `unavailable:true` envelopes. Wave 3 deletes the old submodules.
 */
import { execSync } from 'node:child_process';
import { withTransientRetry } from './transient-retry.js';

// Resolve an owner node id per-scope. Querying `user` and `organization`
// together in one request makes GitHub return a NOT_FOUND error for whichever
// the login is NOT (e.g. `organization` for a personal account), and `gql`
// throws on any `errors` array — discarding the id that *did* resolve. So we
// probe each scope separately and tolerate the per-scope NOT_FOUND.
const Q_OWNER_ID = (scope) =>
  `query($login:String!){${scope}(login:$login){id}}`;
const Q_PROJ = (scope, fields) =>
  `query($owner:String!,$number:Int!){${scope}(login:$owner){projectV2(number:$number){${fields}}}}`;
const M_PROJ = `mutation($ownerId:ID!,$title:String!){createProjectV2(input:{ownerId:$ownerId,title:$title}){projectV2{id number}}}`;
const M_FIELD = `mutation($projectId:ID!,$name:String!,$options:[ProjectV2SingleSelectFieldOptionInput!]!){createProjectV2Field(input:{projectId:$projectId,dataType:SINGLE_SELECT,name:$name,singleSelectOptions:$options}){projectV2Field{... on ProjectV2SingleSelectField{id name}}}}`;
const M_UPDATE = `mutation($fieldId:ID!,$name:String!,$options:[ProjectV2SingleSelectFieldOptionInput!]!){updateProjectV2Field(input:{fieldId:$fieldId,name:$name,singleSelectOptions:$options}){projectV2Field{... on ProjectV2SingleSelectField{id name}}}}`;
const M_ITEM = `mutation($projectId:ID!,$contentId:ID!){addProjectV2ItemById(input:{projectId:$projectId,contentId:$contentId}){item{id}}}`;
const F_STATUS = `id fields(first:50){nodes{... on ProjectV2SingleSelectField{id name options{id name}}}}`;
const F_FIELDS = `id fields(first:50){nodes{... on ProjectV2Field{name} ... on ProjectV2IterationField{name} ... on ProjectV2SingleSelectField{name}}}`;
const SCOPES_RE =
  /INSUFFICIENT_SCOPES|Resource not accessible by personal access token|your token has not been granted the required scopes/i;
const opt = (name, id) => ({
  ...(id && { id }),
  name,
  color: 'GRAY',
  description: '',
});

function readGhCliToken() {
  try {
    const cliToken = execSync('gh auth token', {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return cliToken || null;
  } catch {
    return null;
  }
}

function readEnvToken() {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;
}

function memoizeEnvToken(token) {
  if (!process.env.GITHUB_TOKEN) process.env.GITHUB_TOKEN = token;
}

function resolveToken() {
  const envToken = readEnvToken();
  if (envToken) return envToken;
  const ghToken = readGhCliToken();
  if (!ghToken) {
    throw new Error(
      '[GitHubProvider] No GitHub token (set GITHUB_TOKEN or run `gh auth login`).',
    );
  }
  memoizeEnvToken(ghToken);
  return ghToken;
}

export const isInsufficientScopes = (err) =>
  Boolean(err) &&
  SCOPES_RE.test(err.message ?? err.toString?.() ?? String(err));
export const isScopesMissingEnvelope = (value) =>
  Boolean(value) && typeof value === 'object' && value.scopesMissing === true;

async function gql(ctx, query, variables, { retry = false } = {}) {
  const run = async () => {
    const fetchImpl = ctx.fetchImpl ?? globalThis.fetch;
    const response = await fetchImpl('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${ctx.token ?? resolveToken()}`,
        'Content-Type': 'application/json',
        'User-Agent': 'node.js',
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok)
      throw new Error(
        `[GitHubProvider] GraphQL ${response.status}: ${await response.text().catch(() => '')}`,
      );
    const json = await response.json();
    if (json.errors?.length)
      throw new Error(
        `[GitHubProvider] GraphQL errors: ${JSON.stringify(json.errors)}`,
      );
    return json.data;
  };
  return retry ? withTransientRetry(run) : run();
}

async function lookupProject(ctx, fragment, strict = false) {
  if (!ctx.projectNumber) return null;
  let lastError = null;
  for (const scope of ['user', 'organization']) {
    try {
      const data = await gql(
        ctx,
        Q_PROJ(scope, fragment),
        { owner: ctx.projectOwner, number: ctx.projectNumber },
        { retry: true },
      );
      if (data?.[scope]?.projectV2) return data[scope].projectV2;
    } catch (err) {
      if (strict && isInsufficientScopes(err)) throw err;
      lastError = err;
    }
  }
  if (strict && lastError) throw lastError;
  return null;
}

/**
 * Resolve the node id for an owner login, which may be a personal user OR an
 * organization. Tries `user` first, then `organization`, in separate requests
 * so a per-scope NOT_FOUND never aborts the lookup. Returns `null` when the
 * login resolves to neither. Re-throws insufficient-scope errors so the caller
 * can soft-fail with `{ scopesMissing: true }`.
 */
async function resolveOwnerId(ctx, owner) {
  let lastError = null;
  for (const scope of ['user', 'organization']) {
    try {
      const data = await gql(
        ctx,
        Q_OWNER_ID(scope),
        { login: owner },
        {
          retry: true,
        },
      );
      const id = data?.[scope]?.id;
      if (id) return id;
    } catch (err) {
      if (isInsufficientScopes(err)) throw err;
      lastError = err; // NOT_FOUND for this scope — try the next.
    }
  }
  if (lastError) throw lastError;
  return null;
}

export async function resolveOrCreateProject(ctx, opts = {}) {
  const owner = opts.owner ?? ctx.projectOwner;
  const name = opts.name ?? ctx.projectName ?? `${ctx.repo} — Mandrel`;
  if (ctx.projectNumber) {
    try {
      const existingProject = await lookupProject(ctx, 'id');
      if (existingProject) {
        ctx.state.projectId = existingProject.id;
        return {
          projectId: existingProject.id,
          projectNumber: ctx.projectNumber,
          created: false,
        };
      }
    } catch (err) {
      if (isInsufficientScopes(err)) return { scopesMissing: true };
      throw err;
    }
    throw new Error(
      `[GitHubProvider] Project #${ctx.projectNumber} not found for ${owner}.`,
    );
  }
  try {
    const ownerId = await resolveOwnerId(ctx, owner);
    if (!ownerId)
      throw new Error(
        `[GitHubProvider] Could not resolve owner node id for "${owner}".`,
      );
    const createdProject = (await gql(ctx, M_PROJ, { ownerId, title: name }))
      ?.createProjectV2?.projectV2;
    if (!createdProject)
      throw new Error('[GitHubProvider] createProjectV2 returned no project.');
    ctx.state.projectId = createdProject.id;
    ctx.projectNumber = createdProject.number;
    return {
      projectId: createdProject.id,
      projectNumber: createdProject.number,
      created: true,
    };
  } catch (err) {
    if (isInsufficientScopes(err)) return { scopesMissing: true };
    throw err;
  }
}

export async function ensureStatusField(ctx, optionNames) {
  if (!ctx.projectNumber)
    throw new Error(
      '[GitHubProvider] ensureStatusField requires projectNumber.',
    );
  let project;
  try {
    project = await lookupProject(ctx, F_STATUS, true);
  } catch (err) {
    if (isInsufficientScopes(err))
      return { status: 'scopes-missing', added: [] };
    throw err;
  }
  if (!project)
    throw new Error(
      `[GitHubProvider] Project #${ctx.projectNumber} not found for ${ctx.projectOwner}.`,
    );
  const statusField = (project.fields?.nodes ?? []).find(
    (field) => field?.name === 'Status',
  );
  try {
    if (!statusField) {
      const createResult = await gql(
        ctx,
        M_FIELD,
        {
          projectId: project.id,
          name: 'Status',
          options: optionNames.map((name) => opt(name)),
        },
        { retry: true },
      );
      return {
        status: 'created',
        added: [...optionNames],
        fieldId: createResult?.createProjectV2Field?.projectV2Field?.id,
      };
    }
    const existingOptions = new Map(
      (statusField.options ?? []).map((option) => [option.name, option.id]),
    );
    const missing = optionNames.filter((name) => !existingOptions.has(name));
    if (missing.length === 0)
      return { status: 'unchanged', added: [], fieldId: statusField.id };
    const merged = [
      ...(statusField.options ?? []).map((option) =>
        opt(option.name, option.id),
      ),
      ...missing.map((name) => opt(name)),
    ];
    await gql(
      ctx,
      M_UPDATE,
      { fieldId: statusField.id, name: 'Status', options: merged },
      { retry: true },
    );
    return { status: 'updated', added: missing, fieldId: statusField.id };
  } catch (err) {
    if (isInsufficientScopes(err))
      return { status: 'scopes-missing', added: [] };
    throw err;
  }
}

export async function ensureProjectFields(ctx, fieldDefs) {
  if (!ctx.projectNumber) return { created: [], skipped: [] };
  const project = await lookupProject(ctx, F_FIELDS);
  if (!project)
    throw new Error(
      `[GitHubProvider] Project #${ctx.projectNumber} not found for ${ctx.projectOwner}.`,
    );
  const existingFieldNames = new Set(
    project.fields.nodes.map((field) => field.name).filter(Boolean),
  );
  const created = [],
    skipped = [];
  for (const def of fieldDefs) {
    if (existingFieldNames.has(def.name)) {
      skipped.push(def.name);
      continue;
    }
    if (def.type === 'single_select')
      await gql(
        ctx,
        M_FIELD,
        {
          projectId: project.id,
          name: def.name,
          options: (def.options ?? []).map((option) => opt(option)),
        },
        { retry: true },
      );
    created.push(def.name);
  }
  return { created, skipped };
}

export async function addItemToProject(ctx, contentNodeId) {
  if (!ctx.state.projectId) {
    const project = await lookupProject(ctx, 'id');
    if (!project) return;
    ctx.state.projectId = project.id;
  }
  await gql(ctx, M_ITEM, {
    projectId: ctx.state.projectId,
    contentId: contentNodeId,
  });
}

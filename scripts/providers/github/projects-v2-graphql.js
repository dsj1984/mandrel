/**
 * Projects V2 GraphQL shim — single retained surface (Story #1358, Epic #1179).
 * Collapses the projects.js / graphql.js / graphql-builder.js trio into one
 * file; provider delegates the four V2 methods + addItemToProject here. Token:
 * `gh auth token` → GITHUB_TOKEN/GH_TOKEN env. Soft-fails on
 * INSUFFICIENT_SCOPES via `{scopesMissing:true}` / `status:'scopes-missing'` /
 * `unavailable:true` envelopes. Wave 3 deletes the old submodules.
 */
import { execSync } from 'node:child_process';

const Q_OWNER = `query($login:String!){user(login:$login){id} organization(login:$login){id}}`;
const Q_PROJ = (s, f) =>
  `query($owner:String!,$number:Int!){${s}(login:$owner){projectV2(number:$number){${f}}}}`;
const M_PROJ = `mutation($ownerId:ID!,$title:String!){createProjectV2(input:{ownerId:$ownerId,title:$title}){projectV2{id number}}}`;
const M_FIELD = `mutation($projectId:ID!,$name:String!,$options:[ProjectV2SingleSelectFieldOptionInput!]!){createProjectV2Field(input:{projectId:$projectId,dataType:SINGLE_SELECT,name:$name,singleSelectOptions:$options}){projectV2Field{... on ProjectV2SingleSelectField{id name}}}}`;
const M_UPDATE = `mutation($fieldId:ID!,$name:String!,$options:[ProjectV2SingleSelectFieldOptionInput!]!){updateProjectV2Field(input:{fieldId:$fieldId,name:$name,singleSelectOptions:$options}){projectV2Field{... on ProjectV2SingleSelectField{id name}}}}`;
const M_VIEW = `mutation($projectId:ID!,$name:String!,$filter:String!){createProjectV2View(input:{projectId:$projectId,name:$name,filter:$filter,layout:BOARD_LAYOUT}){projectV2View{id name}}}`;
const M_ITEM = `mutation($projectId:ID!,$contentId:ID!){addProjectV2ItemById(input:{projectId:$projectId,contentId:$contentId}){item{id}}}`;
const F_STATUS = `id fields(first:50){nodes{... on ProjectV2SingleSelectField{id name options{id name}}}}`;
const F_VIEWS = `id views(first:50){nodes{name}}`;
const F_FIELDS = `id fields(first:50){nodes{... on ProjectV2Field{name} ... on ProjectV2IterationField{name} ... on ProjectV2SingleSelectField{name}}}`;
const SCOPES_RE =
  /INSUFFICIENT_SCOPES|Resource not accessible by personal access token|your token has not been granted the required scopes/i;
const opt = (n, id) => ({
  ...(id && { id }),
  name: n,
  color: 'GRAY',
  description: '',
});

function readGhCliToken() {
  try {
    const t = execSync('gh auth token', {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return t || null;
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

export const isInsufficientScopes = (e) =>
  Boolean(e) && SCOPES_RE.test(e.message ?? e.toString?.() ?? String(e));
export const isScopesMissingEnvelope = (v) =>
  Boolean(v) && typeof v === 'object' && v.scopesMissing === true;

async function gql(ctx, query, variables) {
  const fetchImpl = ctx.fetchImpl ?? globalThis.fetch;
  const res = await fetchImpl('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${ctx.token ?? resolveToken()}`,
      'Content-Type': 'application/json',
      'User-Agent': 'node.js',
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok)
    throw new Error(
      `[GitHubProvider] GraphQL ${res.status}: ${await res.text().catch(() => '')}`,
    );
  const json = await res.json();
  if (json.errors?.length)
    throw new Error(
      `[GitHubProvider] GraphQL errors: ${JSON.stringify(json.errors)}`,
    );
  return json.data;
}

async function lookupProject(ctx, fragment, strict = false) {
  if (!ctx.projectNumber) return null;
  let last = null;
  for (const scope of ['user', 'organization']) {
    try {
      const d = await gql(ctx, Q_PROJ(scope, fragment), {
        owner: ctx.projectOwner,
        number: ctx.projectNumber,
      });
      if (d?.[scope]?.projectV2) return d[scope].projectV2;
    } catch (e) {
      if (strict && isInsufficientScopes(e)) throw e;
      last = e;
    }
  }
  if (strict && last) throw last;
  return null;
}

export async function resolveOrCreateProject(ctx, opts = {}) {
  const owner = opts.owner ?? ctx.projectOwner;
  const name = opts.name ?? ctx.projectName ?? `${ctx.repo} — Mandrel`;
  if (ctx.projectNumber) {
    try {
      const p = await lookupProject(ctx, 'id');
      if (p) {
        ctx.state.projectId = p.id;
        return {
          projectId: p.id,
          projectNumber: ctx.projectNumber,
          created: false,
        };
      }
    } catch (e) {
      if (isInsufficientScopes(e)) return { scopesMissing: true };
      throw e;
    }
    throw new Error(
      `[GitHubProvider] Project #${ctx.projectNumber} not found for ${owner}.`,
    );
  }
  try {
    const o = await gql(ctx, Q_OWNER, { login: owner });
    const ownerId = o?.organization?.id ?? o?.user?.id;
    if (!ownerId)
      throw new Error(
        `[GitHubProvider] Could not resolve owner node id for "${owner}".`,
      );
    const p = (await gql(ctx, M_PROJ, { ownerId, title: name }))
      ?.createProjectV2?.projectV2;
    if (!p)
      throw new Error('[GitHubProvider] createProjectV2 returned no project.');
    ctx.state.projectId = p.id;
    ctx.projectNumber = p.number;
    return { projectId: p.id, projectNumber: p.number, created: true };
  } catch (e) {
    if (isInsufficientScopes(e)) return { scopesMissing: true };
    throw e;
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
  } catch (e) {
    if (isInsufficientScopes(e)) return { status: 'scopes-missing', added: [] };
    throw e;
  }
  if (!project)
    throw new Error(
      `[GitHubProvider] Project #${ctx.projectNumber} not found for ${ctx.projectOwner}.`,
    );
  const cur = (project.fields?.nodes ?? []).find((f) => f?.name === 'Status');
  try {
    if (!cur) {
      const r = await gql(ctx, M_FIELD, {
        projectId: project.id,
        name: 'Status',
        options: optionNames.map((n) => opt(n)),
      });
      return {
        status: 'created',
        added: [...optionNames],
        fieldId: r?.createProjectV2Field?.projectV2Field?.id,
      };
    }
    const have = new Map((cur.options ?? []).map((o) => [o.name, o.id]));
    const missing = optionNames.filter((n) => !have.has(n));
    if (missing.length === 0)
      return { status: 'unchanged', added: [], fieldId: cur.id };
    const merged = [
      ...(cur.options ?? []).map((o) => opt(o.name, o.id)),
      ...missing.map((n) => opt(n)),
    ];
    await gql(ctx, M_UPDATE, {
      fieldId: cur.id,
      name: 'Status',
      options: merged,
    });
    return { status: 'updated', added: missing, fieldId: cur.id };
  } catch (e) {
    if (isInsufficientScopes(e)) return { status: 'scopes-missing', added: [] };
    throw e;
  }
}

export async function ensureProjectViews(ctx, viewDefs) {
  if (!ctx.projectNumber)
    throw new Error(
      '[GitHubProvider] ensureProjectViews requires projectNumber.',
    );
  const created = [],
    skipped = [];
  let project;
  try {
    project = await lookupProject(ctx, F_VIEWS, true);
  } catch {
    return { created, skipped: viewDefs.map((v) => v.name), unavailable: true };
  }
  if (!project)
    throw new Error(
      `[GitHubProvider] Project #${ctx.projectNumber} not found for ${ctx.projectOwner}.`,
    );
  const have = new Set(
    (project.views?.nodes ?? []).map((v) => v?.name).filter(Boolean),
  );
  let unavailable = false;
  for (const def of viewDefs) {
    if (have.has(def.name) || unavailable) {
      skipped.push(def.name);
      continue;
    }
    try {
      await gql(ctx, M_VIEW, {
        projectId: project.id,
        name: def.name,
        filter: def.filter,
      });
      created.push(def.name);
    } catch {
      unavailable = true;
      skipped.push(def.name);
    }
  }
  return { created, skipped, unavailable };
}

export async function ensureProjectFields(ctx, fieldDefs) {
  if (!ctx.projectNumber) return { created: [], skipped: [] };
  const project = await lookupProject(ctx, F_FIELDS);
  if (!project)
    throw new Error(
      `[GitHubProvider] Project #${ctx.projectNumber} not found for ${ctx.projectOwner}.`,
    );
  const have = new Set(project.fields.nodes.map((f) => f.name).filter(Boolean));
  const created = [],
    skipped = [];
  for (const def of fieldDefs) {
    if (have.has(def.name)) {
      skipped.push(def.name);
      continue;
    }
    if (def.type === 'single_select')
      await gql(ctx, M_FIELD, {
        projectId: project.id,
        name: def.name,
        options: (def.options ?? []).map((o) => opt(o)),
      });
    created.push(def.name);
  }
  return { created, skipped };
}

export async function addItemToProject(ctx, contentNodeId) {
  if (!ctx.state.projectId) {
    const p = await lookupProject(ctx, 'id');
    if (!p) return;
    ctx.state.projectId = p.id;
  }
  await gql(ctx, M_ITEM, {
    projectId: ctx.state.projectId,
    contentId: contentNodeId,
  });
}

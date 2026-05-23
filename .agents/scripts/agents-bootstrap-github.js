/* node:coverage ignore file */
/**
 * agents-bootstrap-github — Idempotent Label & Field Setup
 *
 * Creates the required label taxonomy and project board custom fields
 * for the v5 Epic-centric flow on a target GitHub repo. Idempotent —
 * skips resources that already exist.
 *
 * Usage:
 *   node .agents/scripts/agents-bootstrap-github.js
 *
 * Reads the canonical config from .agentrc.json via the config resolver,
 * then uses the provider factory to instantiate the correct provider.
 *
 * @see docs/v5-implementation-plan.md Sprint 1C
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { applyBranchProtection } from './lib/bootstrap/branch-protection.js';
import {
  CI_WORKFLOW_RELATIVE_PATH,
  renderCiWorkflow,
} from './lib/bootstrap/ci-workflow-template.js';
import { confirm as defaultHitlConfirm } from './lib/bootstrap/hitl-confirm.js';
import { applyMergeMethods } from './lib/bootstrap/merge-methods.js';
import {
  auditProjectWorkflows,
  formatAuditSummary,
  reapConflictingWorkflows,
  resolveProjectIdByNumber,
} from './lib/bootstrap/workflow-audit.js';
import { runAsCli } from './lib/cli-utils.js';
import {
  GhAuthError,
  GhNotInstalledError,
  GhVersionError,
  MissingRuntimeDepsError,
} from './lib/errors/index.js';
import { Logger } from './lib/Logger.js';
import {
  LABEL_TAXONOMY,
  PROJECT_FIELD_DEFS,
  PROJECT_VIEW_DEFS,
  STATUS_FIELD_OPTIONS,
} from './lib/label-taxonomy.js';
import { createProvider } from './lib/provider-factory.js';

/**
 * Minimum `gh` version the bootstrap supports. Set conservatively per
 * Tech Spec #1350 ("Risks & Mitigations → `gh` version skew"): older
 * releases miss flags the eventual `gh-exec` shim relies on. Bumping this
 * is a deliberate, operator-visible change — keep it tracked here.
 */
export const MIN_GH_VERSION = '2.40.0';

const GH_INSTALL_HINT =
  'Install gh: https://cli.github.com/ — then re-run this command.';
const GH_AUTH_HINT =
  'Run `gh auth login` (choose GitHub.com → HTTPS → login with a web browser), then re-run this command.';

/**
 * Framework runtime deps the consumer must have installed in
 * `node_modules/` before this script reaches the dynamic
 * `config-resolver` import. `ajv` is the sentinel — if it cannot
 * resolve, the operator skipped `/agents-bootstrap-project` (or its
 * Step 2c/2d dependency-install never ran). The list mirrors the floor
 * in `agents-bootstrap-project.md` Step 2c; keep them in sync.
 */
const REQUIRED_RUNTIME_DEPS = Object.freeze(['ajv']);

const RUNTIME_DEPS_HINT =
  'Run `/agents-bootstrap-project` (or `node .agents/scripts/agents-bootstrap-project.js` when present) to merge the framework runtime dependencies into your package.json and install them, then re-run this command.';

const PROJECTS_DOC_POINTER =
  'See docs/project-board.md for the manual Projects V2 setup checklist.';

/**
 * Default runner: synchronously execs `gh <args>` and returns
 * `{ status, stdout, stderr, error }`. Extracted so the preflight tests
 * can inject a stub without spawning a real child process. Forerunner of
 * the `lib/gh-exec.js` shim described in Tech Spec #1350; once that
 * lands, this helper deletes and the preflight calls `gh.exec(...)`.
 *
 * @param {string[]} args
 * @returns {{ status: number|null, stdout: string, stderr: string,
 *             error?: NodeJS.ErrnoException }}
 */
function defaultGhRunner(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8' });
  return {
    status: result.status,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
    error: result.error,
  };
}

/**
 * Parse the first `MAJOR.MINOR.PATCH` triple out of `gh --version` stdout.
 * Returns `null` when the shape is unrecognized so callers can decide
 * whether to surface an error or proceed.
 *
 * @param {string} stdout
 * @returns {string|null}
 */
export function parseGhVersion(stdout) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(stdout || '');
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

/**
 * Numeric comparison of two `MAJOR.MINOR.PATCH` strings.
 * Returns negative if `a < b`, positive if `a > b`, zero if equal.
 * Missing segments are treated as `0`. Non-numeric segments compare as 0.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareSemver(a, b) {
  const pa = String(a)
    .split('.')
    .map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b)
    .split('.')
    .map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Preflight the `gh` CLI before any provider call. Three failure modes,
 * each surfaced as a typed error so callers (CLI `main`, future
 * orchestrators, tests) can `instanceof`-match without parsing strings:
 *
 *   - {@link GhNotInstalledError} — `gh` not on PATH (ENOENT) or the
 *     `--version` invocation reported a non-zero exit suggesting the
 *     binary is missing/broken.
 *   - {@link GhVersionError} — `gh` is present but older than
 *     {@link MIN_GH_VERSION}; carries `{ found, required }` for the
 *     CLI to render an upgrade hint.
 *   - {@link GhAuthError} — `gh auth status` exited non-zero, meaning
 *     no host is logged in.
 *
 * On success returns `{ version }` so the caller can log the resolved
 * version. The `runner` seam defaults to a real `spawnSync('gh', …)`;
 * tests inject a stub returning the canonical
 * `{ status, stdout, stderr, error }` shape.
 *
 * @param {{ runner?: (args: string[]) => {
 *   status: number|null, stdout: string, stderr: string,
 *   error?: NodeJS.ErrnoException
 * } }} [opts]
 * @returns {Promise<{ version: string }>}
 */
export async function preflightGh(opts = {}) {
  const runner = opts.runner ?? defaultGhRunner;

  const versionResult = runner(['--version']);
  if (versionResult.error?.code === 'ENOENT') {
    throw new GhNotInstalledError(
      `gh CLI not found on PATH. ${GH_INSTALL_HINT}`,
    );
  }
  if (versionResult.status !== 0) {
    // Non-ENOENT failure of `gh --version` is treated as "not installed
    // correctly" — same remediation, same exit semantics.
    const stderrSnippet = (versionResult.stderr || '').trim().slice(0, 200);
    throw new GhNotInstalledError(
      `gh --version failed (exit ${versionResult.status}): ${stderrSnippet}. ${GH_INSTALL_HINT}`,
    );
  }

  const version = parseGhVersion(versionResult.stdout);
  if (!version) {
    throw new GhNotInstalledError(
      `Could not parse gh version from output: ${(versionResult.stdout || '').slice(0, 200)}. ${GH_INSTALL_HINT}`,
    );
  }
  if (compareSemver(version, MIN_GH_VERSION) < 0) {
    throw new GhVersionError(
      `gh ${version} is older than required ${MIN_GH_VERSION}. Upgrade with your package manager (e.g. \`brew upgrade gh\`, \`winget upgrade GitHub.cli\`, or see https://cli.github.com/) and re-run this command.`,
      { found: version, required: MIN_GH_VERSION },
    );
  }

  const authResult = runner(['auth', 'status']);
  if (authResult.error?.code === 'ENOENT') {
    // Defensive — `gh --version` already passed, so ENOENT here would be a
    // PATH race. Treat the same as not-installed.
    throw new GhNotInstalledError(
      `gh CLI disappeared between version and auth check. ${GH_INSTALL_HINT}`,
    );
  }
  if (authResult.status !== 0) {
    throw new GhAuthError(
      `gh auth status failed: not logged in. ${GH_AUTH_HINT}`,
    );
  }

  return { version };
}

/**
 * Detect that an error is a not-found / 404 signal across the surfaces
 * the provider can emit. The `gh-exec` classifier wraps the CLI's
 * "could not resolve to a" / "HTTP 404" / "not found" stderr in a
 * `GhNotFoundError` whose message is the literal string
 * `gh-exec: resource not found` — the `'404'` substring is absent. The
 * legacy bespoke-client path produced `failed (404):` messages. Match
 * both so a legitimate fresh-repo run (issue #1 doesn't exist yet)
 * doesn't fatal-fail the preflight.
 */
function isApiAccessNotFoundError(err) {
  if (!err) return false;
  if (err.name === 'GhNotFoundError') return true;
  const message = err.message ?? '';
  const stderr = err.stderr ?? '';
  return (
    /\b404\b/.test(message) ||
    /\b404\b/.test(stderr) ||
    /resource not found/i.test(message) ||
    /resource not found/i.test(stderr) ||
    /\bnot found\b/i.test(stderr) ||
    /could not resolve to a/i.test(stderr)
  );
}

/**
 * Preflight the framework's runtime dependencies before dynamic-importing
 * `config-resolver.js` (which transitively pulls in `ajv` via
 * `config-settings-schema.js`). A fresh consumer who skipped
 * `/agents-bootstrap-project` will not have `ajv` installed, and the
 * raw `ERR_MODULE_NOT_FOUND` from the dynamic import is opaque. This
 * preflight converts that into a {@link MissingRuntimeDepsError} that
 * names the missing packages and points the operator at the right
 * workflow.
 *
 * The `resolver` seam lets tests inject a stub without touching the real
 * module graph; production uses `import.meta.resolve(specifier)`.
 *
 * @param {{ resolver?: (specifier: string) => string | Promise<string> }} [opts]
 * @returns {Promise<void>}
 */
export async function preflightRuntimeDeps(opts = {}) {
  const resolver =
    opts.resolver ?? ((specifier) => import.meta.resolve(specifier));
  const missing = [];
  for (const specifier of REQUIRED_RUNTIME_DEPS) {
    try {
      await resolver(specifier);
    } catch {
      missing.push(specifier);
    }
  }
  if (missing.length > 0) {
    throw new MissingRuntimeDepsError(
      `Framework runtime dependencies missing from node_modules/: ${missing.join(', ')}. ${RUNTIME_DEPS_HINT}`,
      { missing },
    );
  }
}

async function verifyApiAccess(provider) {
  try {
    await provider.getTicket(1);
  } catch (err) {
    // Not-found is fine — API reachable, issue #1 doesn't exist on the
    // target repo. Anything else (auth, scope, transport) is fatal.
    if (!isApiAccessNotFoundError(err)) {
      throw new Error(
        `[bootstrap] API access verification failed: ${err.message}`,
      );
    }
  }
}

async function ensureLabels(provider, log) {
  log(`[bootstrap] Ensuring ${LABEL_TAXONOMY.length} labels...`);
  const labels = await provider.ensureLabels(LABEL_TAXONOMY);
  const missing = Array.isArray(labels.missing) ? labels.missing : [];
  log(
    `[bootstrap] Labels — created: ${labels.created.length}, skipped: ${labels.skipped.length}, missing: ${missing.length}`,
  );
  if (labels.created.length > 0) {
    log(`[bootstrap]   Created: ${labels.created.join(', ')}`);
  }
  if (missing.length > 0) {
    log(
      `[bootstrap] ⚠️  ${missing.length} label(s) were reported as created/skipped but are NOT present on the remote: ${missing.join(', ')}. Re-run bootstrap or create them manually with \`gh label create\`.`,
    );
  }
  return labels;
}

async function resolveProject(provider, providerConfig, log) {
  const fallback = (scopesMissing) => ({
    projectNumber: providerConfig?.projectNumber ?? null,
    created: false,
    skipped: true,
    scopesMissing,
  });
  try {
    const result = await provider.resolveOrCreateProject();
    if (result.scopesMissing) {
      log(
        `[bootstrap] Projects V2: token lacks the "project" scope — skipping board provisioning. ${PROJECTS_DOC_POINTER}`,
      );
      return fallback(true);
    }
    const projectNumber = result.projectNumber ?? null;
    const created = !!result.created;
    log(
      `[bootstrap] ${created ? 'Created' : 'Using'} Project V2 #${projectNumber}.`,
    );
    return { projectNumber, created, skipped: false, scopesMissing: false };
  } catch (err) {
    log(
      `[bootstrap] Projects V2 resolution failed: ${err.message}. ${PROJECTS_DOC_POINTER}`,
    );
    return fallback(false);
  }
}

async function ensureStatusField(provider, log) {
  try {
    const statusField = await provider.ensureStatusField(STATUS_FIELD_OPTIONS);
    if (statusField.status === 'scopes-missing') {
      log(
        `[bootstrap] Projects V2 Status field: insufficient scopes. ${PROJECTS_DOC_POINTER}`,
      );
    } else {
      const addedSuffix = statusField.added.length
        ? ` (added: ${statusField.added.join(', ')})`
        : '';
      log(`[bootstrap] Status field — ${statusField.status}${addedSuffix}`);
    }
    return statusField;
  } catch (err) {
    log(`[bootstrap] Status field provisioning failed: ${err.message}`);
    return { status: 'skipped', added: [] };
  }
}

async function ensureViews(provider, log) {
  try {
    const views = await provider.ensureProjectViews(PROJECT_VIEW_DEFS);
    if (views.unavailable) {
      log(
        `[bootstrap] Projects V2 Views mutation unavailable — skipped ${views.skipped.join(', ')}. ${PROJECTS_DOC_POINTER}`,
      );
    } else {
      log(
        `[bootstrap] Views — created: ${views.created.length}, skipped: ${views.skipped.length}`,
      );
    }
    return views;
  } catch (err) {
    log(`[bootstrap] Views provisioning failed: ${err.message}`);
    return { created: [], skipped: [], unavailable: false };
  }
}

/**
 * Audit the project's built-in workflows and, when explicitly opted-in
 * via `--reap-conflicting-workflows`, delete the ones that race against
 * the orchestrator's `ColumnSync` writes. Default behaviour is
 * advisory: warn loudly with the operator-driven remediation hint, do
 * not mutate. Story #2845.
 *
 * Returns a structured envelope the bootstrap summary renders, even
 * when the audit was skipped (no projectId) so callers don't need a
 * separate "did this run" guard.
 *
 * @param {object} provider
 * @param {number} projectNumber
 * @param {boolean} reap
 * @param {(line: string) => void} log
 */
async function auditAndOptionallyReapWorkflows(
  provider,
  projectNumber,
  reap,
  log,
) {
  let projectId = null;
  try {
    projectId = await resolveProjectIdByNumber({ provider, projectNumber });
  } catch (err) {
    log(
      `[bootstrap] Workflow audit: could not resolve project id — ${err.message}.`,
    );
    return { skipped: true, reason: 'project-id-unresolved' };
  }
  if (!projectId) {
    log(
      `[bootstrap] Workflow audit: project #${projectNumber} not visible to viewer — skipping.`,
    );
    return { skipped: true, reason: 'project-not-visible' };
  }
  let audit;
  try {
    audit = await auditProjectWorkflows({ provider, projectId });
  } catch (err) {
    log(`[bootstrap] Workflow audit failed: ${err.message} — skipping.`);
    return { skipped: true, reason: 'audit-failed', error: err.message };
  }
  log(`[bootstrap] Workflow audit — ${formatAuditSummary(audit)}.`);
  if (audit.conflicting.length === 0) {
    return { audit, reaped: [], action: 'no-conflicts' };
  }
  const names = audit.conflicting.map((w) => w.name).join(', ');
  if (!reap) {
    log(
      `[bootstrap] ⚠️ Conflicting workflows enabled: ${names}. ` +
        `These race against the orchestrator's ColumnSync writes and ` +
        `typically leave closed Stories stuck at "In Progress" on the ` +
        `board (see Story #2813 for the reproduction). Remediation: ` +
        `(a) re-run with --reap-conflicting-workflows to delete them, ` +
        `or (b) toggle them off in the GitHub UI under ` +
        `Project → Workflows. The orchestrator's post-merge ` +
        `resync-status-column.js CLI defends against both unless you ` +
        `also disable that step.`,
    );
    return { audit, reaped: [], action: 'warn-only' };
  }
  log(
    `[bootstrap] Reaping ${audit.conflicting.length} conflicting workflow(s): ${names}...`,
  );
  const { reaped } = await reapConflictingWorkflows({ provider, audit });
  log(
    `[bootstrap] ✅ Deleted ${reaped.length} workflow(s): ${reaped.map((r) => r.name).join(', ')}.`,
  );
  return { audit, reaped, action: 'reaped' };
}

async function ensureProjectFields(provider, project, log) {
  log(
    `[bootstrap] Ensuring ${PROJECT_FIELD_DEFS.length} project fields on project #${project.projectNumber}...`,
  );
  const fields = await provider.ensureProjectFields(PROJECT_FIELD_DEFS);
  log(
    `[bootstrap] Fields — created: ${fields.created.length}, skipped: ${fields.skipped.length}`,
  );
  return fields;
}

/**
 * Create or additively-merge branch protection on `baseBranch` (typically
 * `main`) so the `delivery.quality.prGate.checks` suite is required
 * before merge. Behaviour rules:
 *
 *   - `enforceBranchProtection: false` → skip, log the opt-out, return a
 *     `{ status: 'skipped' }` summary.
 *   - `prGate.checks` empty or absent → skip with a clear log, since there
 *     is nothing to enforce.
 *   - Existing protection rule → preserve every existing required-check
 *     context and append only the missing prGate names.
 *   - No existing rule → create a fresh one carrying just the prGate
 *     contexts plus minimal sensible defaults (strict status checks).
 *
 * Errors (insufficient scopes, repo permission denied, etc.) are logged
 * and return a `{ status: 'failed' }` summary so the bootstrap CLI
 * surfaces a non-fatal warning rather than aborting the entire run —
 * matching how the project-board provisioning steps degrade.
 */
async function ensureMainBranchProtection(
  provider,
  { baseBranch, prGate },
  log,
) {
  if (prGate?.enforceBranchProtection === false) {
    log(
      `[bootstrap] Branch protection on '${baseBranch}': skipped (delivery.quality.prGate.enforceBranchProtection=false).`,
    );
    return { status: 'skipped', reason: 'opt-out' };
  }

  const checkNames = (prGate?.checks ?? [])
    .map((c) => c?.name)
    .filter((n) => typeof n === 'string' && n.length > 0);
  if (checkNames.length === 0) {
    log(
      `[bootstrap] Branch protection on '${baseBranch}': skipped (no prGate.checks configured).`,
    );
    return { status: 'skipped', reason: 'no-checks' };
  }

  try {
    const result = await provider.setBranchProtection(baseBranch, {
      contexts: checkNames,
    });
    const verb = result.created ? 'Created' : 'Updated';
    const addedSuffix = result.added.length
      ? ` (added: ${result.added.join(', ')})`
      : ' (all required checks already present)';
    log(
      `[bootstrap] Branch protection on '${baseBranch}': ${verb} rule${addedSuffix}.`,
    );
    return { status: result.created ? 'created' : 'merged', ...result };
  } catch (err) {
    log(
      `[bootstrap] Branch protection on '${baseBranch}': failed — ${err.message}. Proceeding without it.`,
    );
    return { status: 'failed', reason: err.message };
  }
}

/**
 * Render the stabilized-quality-gates CI workflow template into a project
 * checkout. Idempotent on the byte level: when `.github/workflows/ci.yml`
 * already matches the rendered template, no write occurs and the action is
 * `unchanged`. When the file is absent the action is `created`. When the
 * file exists with operator-authored differences the helper preserves it
 * and returns `custom-workflow-skip` along with the rendered body so the
 * bootstrap caller (or `/agents-update`) can offer a side-by-side diff.
 *
 * Network-free; safe to invoke under tests with a tmp `projectRoot`.
 *
 * @param {object} args
 * @param {string} args.projectRoot - Repo root (must contain or accept
 *   `.github/workflows/`).
 * @param {object} [args.template] - Forwarded to `renderCiWorkflow`.
 * @param {boolean} [args.write=true] - When `false`, the helper computes
 *   the would-be action without touching disk. Used by the
 *   bootstrap CLI's dry-run mode.
 * @returns {{ action: 'created'|'unchanged'|'custom-workflow-skip',
 *             path: string, rendered: string }}
 */
export function ensureCiWorkflow(args) {
  const projectRoot = args.projectRoot;
  const rendered = renderCiWorkflow(args.template);
  const target = path.join(projectRoot, CI_WORKFLOW_RELATIVE_PATH);
  if (!fs.existsSync(target)) {
    if (args.write !== false) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, rendered, 'utf8');
    }
    return { action: 'created', path: target, rendered };
  }
  const existing = fs.readFileSync(target, 'utf8');
  if (existing === rendered) {
    return { action: 'unchanged', path: target, rendered };
  }
  return { action: 'custom-workflow-skip', path: target, rendered };
}

/**
 * Run the idempotent bootstrap sequence.
 *
 * Accepts the canonical resolved config (output of `resolveConfig()` —
 * `config.github` holds the GitHub provider block). Epic #2880 removed the
 * legacy shim parameters; see `.agents/rules/git-conventions.md#contract-cutovers-—-no-shim-layer`.
 *
 * @param {object} config - Resolved config wrapper with a `github` block.
 * @param {{
 *   token?: string,
 *   quiet?: boolean,
 *   providerOverride?: object,
 *   project?: object,
 *   github?: object,
 *   baseBranch?: string,
 * }} [opts]
 */
export async function runBootstrap(config, opts = {}) {
  const provider =
    opts.providerOverride ?? createProvider(config, { token: opts.token });
  const log = opts.quiet ? () => {} : Logger.info;
  const providerName = config.provider ?? (config.github ? 'github' : null);
  const providerConfig = providerName ? config[providerName] : null;

  log('[bootstrap] Starting idempotent setup...');
  log(`[bootstrap] Provider: ${providerName}`);
  log(`[bootstrap] Target: ${providerConfig?.owner}/${providerConfig?.repo}`);

  log('[bootstrap] Verifying API access...');
  await verifyApiAccess(provider);
  log('[bootstrap] API access verified.');

  const labels = await ensureLabels(provider, log);
  const project = await resolveProject(provider, providerConfig, log);

  const projectReady = !project.skipped && project.projectNumber;
  let statusField = { status: 'skipped', added: [] };
  let views = { created: [], skipped: [], unavailable: false };
  let fields = { created: [], skipped: [] };

  if (projectReady) {
    statusField = await ensureStatusField(provider, log);
    views = await ensureViews(provider, log);
    fields = await ensureProjectFields(provider, project, log);
  } else {
    log('[bootstrap] No active project — skipping legacy project-field setup.');
  }

  // Story #2845 — audit project workflows for the ones that race against
  // the orchestrator's ColumnSync writes (notably `Pull request merged`
  // and `Pull request linked to issue`, which both rewrite Status as a
  // side-effect of auto-merge). When `--reap-conflicting-workflows` is
  // set, also delete the offenders via `deleteProjectV2Workflow` (the
  // only programmatic action GraphQL exposes today — `enabled` is
  // read-only).
  const workflowAudit = projectReady
    ? await auditAndOptionallyReapWorkflows(
        provider,
        project.projectNumber,
        opts.reapConflictingWorkflows === true,
        log,
      )
    : { skipped: true, reason: 'no-project' };

  // Consumer-facing bootstrap promotes the framework's CI-gates-only
  // stance: branch protection with enforce_admins + 0-approval-count and
  // the squash-only merge-method allowlist. Behavior-shifting drift on
  // either step routes through the HITL confirm gate — non-TTY runs abort
  // with a clear stderr message rather than silently apply.
  //
  // The legacy `ensureMainBranchProtection` helper is preserved (re-
  // exported below) so the Epic #1142 Story #1157 contract tests stay
  // green; `applyBranchProtection` is its consumer-parity successor.
  // Post-reshape: bootstrap reads from the new `project` + `github` blocks
  // exclusively. The legacy "agent settings" opt was removed in Epic #2880.
  const projectCfg = opts.project ?? config.project ?? {};
  const githubCfg = opts.github ?? {};
  const settings = {
    ...projectCfg,
    baseBranch: opts.baseBranch ?? projectCfg.baseBranch ?? 'main',
    github: githubCfg,
    // Preserve the legacy `quality` shape pointer when callers still pass it.
    quality: projectCfg.quality,
  };
  const hitlConfirm =
    opts.hitlConfirm ??
    ((args) =>
      defaultHitlConfirm(args, {
        assume: opts.assumeYes ? 'yes' : opts.assumeNo ? 'no' : undefined,
      }));

  const branchProtection = await applyBranchProtection({
    provider,
    settings,
    hitlConfirm,
    log,
  });
  const mergeMethods = await applyMergeMethods({
    provider,
    settings,
    hitlConfirm,
    log,
  });

  log('[bootstrap] Done.');
  return {
    labels,
    fields,
    project,
    statusField,
    views,
    workflowAudit,
    branchProtection,
    mergeMethods,
  };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function formatProjectSummary(project) {
  if (project.scopesMissing) return 'skipped (missing project scope)';
  if (project.created) return `created #${project.projectNumber}`;
  if (project.projectNumber) return `adopted #${project.projectNumber}`;
  return 'skipped';
}

function formatBranchProtectionSummary(bp) {
  if (!bp) return 'not-run';
  if (bp.status === 'created') return `created (added: ${bp.added.join(', ')})`;
  if (bp.status === 'merged') {
    return bp.added.length
      ? `merged (added: ${bp.added.join(', ')})`
      : 'merged (no changes)';
  }
  if (bp.status === 'skipped') return `skipped (${bp.reason})`;
  if (bp.status === 'failed') return `failed (${bp.reason})`;
  return bp.status;
}

function formatWorkflowAuditSummary(wa) {
  if (!wa) return 'not-run';
  if (wa.skipped) return `skipped (${wa.reason})`;
  if (wa.action === 'no-conflicts') return 'no conflicting workflows';
  if (wa.action === 'warn-only')
    return `warned (${wa.audit.conflicting.length} conflicting; pass --reap-conflicting-workflows to delete)`;
  if (wa.action === 'reaped') return `reaped ${wa.reaped.length} workflow(s)`;
  return wa.action ?? 'unknown';
}

function formatMergeMethodsSummary(mm) {
  if (!mm) return 'not-run';
  if (mm.status === 'unchanged') return 'unchanged (already at target stance)';
  if (mm.status === 'patched')
    return `patched (${(mm.patched ?? []).join(', ') || '—'})`;
  if (mm.status === 'skipped') return `skipped (${mm.reason})`;
  if (mm.status === 'failed') return `failed (${mm.reason})`;
  return mm.status;
}

function printSummary(result) {
  Logger.info('\n=== Bootstrap Summary ===');
  Logger.info(`Labels created: ${result.labels.created.length}`);
  Logger.info(`Labels skipped: ${result.labels.skipped.length}`);
  Logger.info(`Fields created: ${result.fields.created.length}`);
  Logger.info(`Fields skipped: ${result.fields.skipped.length}`);
  Logger.info(`Project: ${formatProjectSummary(result.project)}`);
  Logger.info(`Status field: ${result.statusField.status}`);
  const unavailableSuffix = result.views.unavailable
    ? ' (mutation unavailable)'
    : '';
  Logger.info(
    `Views — created: ${result.views.created.length}, skipped: ${result.views.skipped.length}${unavailableSuffix}`,
  );
  Logger.info(
    `Workflow audit: ${formatWorkflowAuditSummary(result.workflowAudit)}`,
  );
  Logger.info(
    `Branch protection: ${formatBranchProtectionSummary(result.branchProtection)}`,
  );
  Logger.info(
    `Merge methods: ${formatMergeMethodsSummary(result.mergeMethods)}`,
  );
}

async function main() {
  // Preflight `gh` before touching config or the provider — surfaces the
  // most common new-adopter failure (missing/stale `gh`) as the first
  // diagnostic instead of an ENOENT later in the provider stack.
  // Tech Spec #1350 → "Bootstrap surface": gh auth status must exit 0
  // before bootstrap proceeds.
  try {
    const { version } = await preflightGh();
    Logger.info(`[bootstrap] gh CLI ${version} ready (auth verified).`);
  } catch (err) {
    if (
      err instanceof GhNotInstalledError ||
      err instanceof GhAuthError ||
      err instanceof GhVersionError
    ) {
      Logger.error(`[bootstrap] ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  // Preflight runtime deps before the dynamic config-resolver import so
  // a green-field consumer who skipped `/agents-bootstrap-project` gets
  // a workflow hint instead of a raw `ERR_MODULE_NOT_FOUND`.
  try {
    await preflightRuntimeDeps();
  } catch (err) {
    if (err instanceof MissingRuntimeDepsError) {
      Logger.error(`[bootstrap] ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  // Dynamic import to avoid circular dependency issues at module level.
  const { resolveConfig, validateOrchestrationConfig } = await import(
    './lib/config-resolver.js'
  );

  const config = resolveConfig();

  if (!config.github) {
    throw new Error(
      '[bootstrap] No "github" block found in .agentrc.json.',
    );
  }

  try {
    validateOrchestrationConfig(config);
  } catch (err) {
    Logger.error(`[bootstrap] ERROR: ${err.message}`);
    process.exit(1);
  }

  const installWorkflows = process.argv.includes('--install-workflows');
  // Epic #1235 Story 5 — flags let CI / non-interactive callers pin the
  // HITL gate's answer deterministically. The bootstrap is non-interactive
  // by default in non-TTY contexts (the gate returns false and aborts);
  // these flags are the documented escape hatches.
  const assumeYes = process.argv.includes('--assume-yes');
  const assumeNo = process.argv.includes('--assume-no');
  // Story #2845 — opt-in destructive flag. When set, the workflow-audit
  // step calls `deleteProjectV2Workflow` for every conflicting built-in
  // (e.g. "Pull request merged", "Pull request linked to issue"). Default
  // is warn-only because the GraphQL mutation is irreversible.
  const reapConflictingWorkflows = process.argv.includes(
    '--reap-conflicting-workflows',
  );

  try {
    const result = await runBootstrap(config, {
      installWorkflows,
      project: config.project,
      github: config.github,
      assumeYes,
      assumeNo,
      reapConflictingWorkflows,
    });
    printSummary(result);
  } catch (err) {
    throw new Error(`[bootstrap] runBootstrap failed: ${err.message}`);
  }
}

// Re-export internal helpers for test consumers (no production caller imports them).
export {
  ensureMainBranchProtection,
  isApiAccessNotFoundError,
  verifyApiAccess,
};

runAsCli(import.meta.url, main, { source: 'Bootstrap' });

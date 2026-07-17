/* node:coverage ignore file */
/**
 * agents-bootstrap-github — Idempotent Label & Field Setup
 *
 * Creates the required label taxonomy and project board custom fields
 * for the v5 Story-centric flow on a target GitHub repo. Idempotent —
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

import { applyBranchProtection } from './lib/bootstrap/branch-protection.js';
import {
  compareSemver,
  MIN_GH_VERSION,
  parseGhVersion,
  preflightGh,
  preflightRuntimeDeps,
} from './lib/bootstrap/gh-preflight.js';
import { confirm as defaultHitlConfirm } from './lib/bootstrap/hitl-confirm.js';
import { applyMergeMethods } from './lib/bootstrap/merge-methods.js';
import { printSummary } from './lib/bootstrap/summary.js';
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
  STATUS_FIELD_OPTIONS,
} from './lib/label-taxonomy.js';
import { createProvider } from './lib/provider-factory.js';

const PROJECTS_DOC_POINTER =
  'Configure the board views manually in the GitHub Projects UI.';

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

async function verifyApiAccess(provider) {
  try {
    await provider.getTicket(1);
  } catch (err) {
    // Not-found is fine — API reachable, issue #1 doesn't exist on the
    // target repo. Anything else (auth, scope, transport) is fatal.
    if (!isApiAccessNotFoundError(err)) {
      throw new Error(
        `[Bootstrap] API access verification failed: ${err.message}`,
      );
    }
  }
}

async function ensureLabels(provider, log) {
  log(`[Bootstrap] Ensuring ${LABEL_TAXONOMY.length} labels...`);
  const labels = await provider.ensureLabels(LABEL_TAXONOMY);
  const missing = Array.isArray(labels.missing) ? labels.missing : [];
  log(
    `[Bootstrap] Labels — created: ${labels.created.length}, skipped: ${labels.skipped.length}, missing: ${missing.length}`,
  );
  if (missing.length > 0) {
    log(
      `[Bootstrap] ⚠️  ${missing.length} label(s) were reported as created/skipped but are NOT present on the remote: ${missing.join(', ')}. Re-run bootstrap or create them manually with \`gh label create\`.`,
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
        `[Bootstrap] Projects V2: token lacks the "project" scope — skipping board provisioning. ${PROJECTS_DOC_POINTER}`,
      );
      return fallback(true);
    }
    const projectNumber = result.projectNumber ?? null;
    const created = !!result.created;
    log(
      `[Bootstrap] ${created ? 'Created' : 'Using'} Project V2 #${projectNumber}.`,
    );
    return { projectNumber, created, skipped: false, scopesMissing: false };
  } catch (err) {
    log(
      `[Bootstrap] Projects V2 resolution failed: ${err.message}. ${PROJECTS_DOC_POINTER}`,
    );
    return fallback(false);
  }
}

async function ensureStatusField(provider, log) {
  try {
    const statusField = await provider.ensureStatusField(STATUS_FIELD_OPTIONS);
    if (statusField.status === 'scopes-missing') {
      log(
        `[Bootstrap] Projects V2 Status field: insufficient scopes. ${PROJECTS_DOC_POINTER}`,
      );
    } else {
      const addedSuffix = statusField.added.length
        ? ` (added: ${statusField.added.join(', ')})`
        : '';
      log(`[Bootstrap] Status field — ${statusField.status}${addedSuffix}`);
    }
    return statusField;
  } catch (err) {
    log(`[Bootstrap] Status field provisioning failed: ${err.message}`);
    return { status: 'skipped', added: [] };
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
      `[Bootstrap] Workflow audit: could not resolve project id — ${err.message}.`,
    );
    return { skipped: true, reason: 'project-id-unresolved' };
  }
  if (!projectId) {
    log(
      `[Bootstrap] Workflow audit: project #${projectNumber} not visible to viewer — skipping.`,
    );
    return { skipped: true, reason: 'project-not-visible' };
  }
  let audit;
  try {
    audit = await auditProjectWorkflows({ provider, projectId });
  } catch (err) {
    log(`[Bootstrap] Workflow audit failed: ${err.message} — skipping.`);
    return { skipped: true, reason: 'audit-failed', error: err.message };
  }
  log(`[Bootstrap] Workflow audit — ${formatAuditSummary(audit)}.`);
  if (audit.conflicting.length === 0) {
    return { audit, reaped: [], action: 'no-conflicts' };
  }
  const names = audit.conflicting.map((w) => w.name).join(', ');
  if (!reap) {
    log(
      `[Bootstrap] ⚠️ Conflicting Projects V2 workflows enabled: ${names}. ` +
        `They can leave closed Stories stuck at "In Progress". Fix: re-run ` +
        `with --reap-conflicting-workflows, or disable them under ` +
        `Project → Workflows.`,
    );
    return { audit, reaped: [], action: 'warn-only' };
  }
  log(
    `[Bootstrap] Reaping ${audit.conflicting.length} conflicting workflow(s): ${names}...`,
  );
  const { reaped } = await reapConflictingWorkflows({ provider, audit });
  log(
    `[Bootstrap] ✅ Deleted ${reaped.length} workflow(s): ${reaped.map((r) => r.name).join(', ')}.`,
  );
  return { audit, reaped, action: 'reaped' };
}

async function ensureProjectFields(provider, project, log) {
  log(
    `[Bootstrap] Ensuring ${PROJECT_FIELD_DEFS.length} project fields on project #${project.projectNumber}...`,
  );
  const fields = await provider.ensureProjectFields(PROJECT_FIELD_DEFS);
  log(
    `[Bootstrap] Fields — created: ${fields.created.length}, skipped: ${fields.skipped.length}`,
  );
  return fields;
}

/**
 * Run the idempotent bootstrap sequence.
 *
 * Accepts the canonical resolved config (output of `resolveConfig()` —
 * `config.github` holds the GitHub provider block). Epic #2880 removed the
 * legacy shim parameters; see `.agents/rules/git-conventions-reference.md#contract-cutovers-—-no-shim-layer`.
 *
 * Consent-first install (Story #3526, Feature #3515, Epic #3438): every
 * mutation this function performs — labels, Projects V2, branch protection,
 * merge methods — is the irreversible `github-admin` phase group from the
 * mutation manifest. The whole sequence is now **explicit opt-in**: unless
 * `opts.githubAdminApproved === true`, `runBootstrap` short-circuits before
 * touching the provider and issues **zero** GitHub mutations. This is the
 * boundary-level enforcement of the consent signal the `bootstrap.js`
 * orchestrator threads from `parseAndValidate` (interactive operator
 * confirmation, `--assume-yes`, or `--approve-github-admin`) down through
 * `executeGithubBootstrap`: a direct caller cannot silently reconfigure a
 * repo by skipping that consent. Even additive branch-protection /
 * merge-method changes that
 * previously applied without a prompt are gated — they are enumerated in the
 * manifest's `github-admin` group and only land once that group is approved.
 *
 * @param {object} config - Resolved config wrapper with a `github` block.
 * @param {{
 *   token?: string,
 *   quiet?: boolean,
 *   providerOverride?: object,
 *   project?: object,
 *   github?: object,
 *   baseBranch?: string,
 *   githubAdminApproved?: boolean,
 *   withProjectBoard?: boolean,
 *   isTTY?: boolean,
 * }} [opts] - `githubAdminApproved` MUST be `true` for any GitHub mutation to
 *   occur; any other value (absent / `false`) is treated as "not approved"
 *   and the run is a verified no-op.
 *   `withProjectBoard` (default `false`) — opt-in for Projects V2 board,
 *   Status field, custom fields, and workflow audit. When absent or `false`,
 *   the board decoration is skipped and only labels + branch protection +
 *   merge methods are provisioned.
 */
export async function runBootstrap(config, opts = {}) {
  // Explicit opt-in gate (Story #3526). Default-deny: absent or non-`true`
  // approval issues zero GitHub mutations and returns a no-op envelope the
  // CLI summary renders as a skip. The provider is never instantiated, so a
  // non-approved run performs no network I/O at all.
  if (opts.githubAdminApproved !== true) {
    const skipLog = opts.quiet ? () => {} : Logger.info;
    skipLog(
      '[Bootstrap] GitHub-admin mutations skipped: github-admin phase group not approved (explicit opt-in required).',
    );
    return { skipped: true, reason: 'github-admin-not-approved' };
  }

  const provider =
    opts.providerOverride ?? createProvider(config, { token: opts.token });
  const log = opts.quiet ? () => {} : Logger.info;
  const providerName = config.provider ?? (config.github ? 'github' : null);
  const providerConfig = providerName ? config[providerName] : null;

  log('[Bootstrap] Starting idempotent setup...');
  log(`[Bootstrap] Provider: ${providerName}`);
  log(`[Bootstrap] Target: ${providerConfig?.owner}/${providerConfig?.repo}`);

  log('[Bootstrap] Verifying API access...');
  await verifyApiAccess(provider);
  log('[Bootstrap] API access verified.');

  const labels = await ensureLabels(provider, log);

  // Board decoration (Projects V2 board, Status field, custom fields, workflow
  // audit) is opt-in and defaults OFF. Minimal install = labels only. Gate is
  // `opts.withProjectBoard === true`; absent or false skips all board work.
  // ColumnSync already soft-noops when projectNumber is unset (column-sync.js:19-23).
  const projectBoard = opts.withProjectBoard === true;
  let project = { projectNumber: null, created: false, skipped: true };
  let statusField = { status: 'skipped', added: [] };
  let fields = { created: [], skipped: [] };
  let workflowAudit = {
    skipped: true,
    reason: 'board-decoration-not-opted-in',
  };

  if (projectBoard) {
    project = await resolveProject(provider, providerConfig, log);
    const projectReady = !project.skipped && project.projectNumber;
    if (projectReady) {
      statusField = await ensureStatusField(provider, log);
      fields = await ensureProjectFields(provider, project, log);
      // Story #2845 — audit project workflows for the ones that race against
      // the orchestrator's ColumnSync writes (notably `Pull request merged`
      // and `Pull request linked to issue`, which both rewrite Status as a
      // side-effect of auto-merge). When `--reap-conflicting-workflows` is
      // set, also delete the offenders via `deleteProjectV2Workflow` (the
      // only programmatic action GraphQL exposes today — `enabled` is
      // read-only).
      workflowAudit = await auditAndOptionallyReapWorkflows(
        provider,
        project.projectNumber,
        opts.reapConflictingWorkflows === true,
        log,
      );
    } else {
      log('[Bootstrap] No active project — skipping project-field setup.');
      workflowAudit = { skipped: true, reason: 'no-project' };
    }
  } else {
    log('[Bootstrap] Project board decoration skipped (opt-in not set).');
  }

  // Consumer-facing bootstrap promotes the framework's CI-gates-only
  // stance: branch protection with enforce_admins + 0-approval-count and
  // the squash-only merge-method allowlist. Behavior-shifting drift on
  // branch protection routes through the HITL confirm gate — non-TTY runs
  // abort with a clear stderr message rather than silently apply. The
  // merge-method step differs by design (Story #4045 A4): non-TTY without an
  // assume override default-applies the framework stance with an explicit
  // log line (see mergeMethodsHitlConfirm below).
  //
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

  // Merge-methods gate (Story #4045 A4): under non-TTY without an explicit
  // assume override there is no operator to consult, and the default HITL
  // gate declines every non-TTY prompt — which would make applyMergeMethods'
  // documented non-TTY default-apply branch unreachable. Skip the gate in
  // that case so the merge-method stance default-applies with its explicit
  // log line. Interactive runs (and explicit --assume-yes/--assume-no, and
  // injected gates) keep the loud confirm/decline behaviour.
  const stdoutIsTTY = opts.isTTY ?? Boolean(process.stdout.isTTY);
  const mergeMethodsHitlConfirm =
    opts.hitlConfirm ??
    (stdoutIsTTY || opts.assumeYes || opts.assumeNo ? hitlConfirm : undefined);
  const mergeMethods = await applyMergeMethods({
    provider,
    settings,
    hitlConfirm: mergeMethodsHitlConfirm,
    log,
  });

  log('[Bootstrap] Done.');
  return {
    labels,
    fields,
    project,
    statusField,
    workflowAudit,
    branchProtection,
    mergeMethods,
  };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main() {
  // Preflight `gh` before touching config or the provider — surfaces the
  // most common new-adopter failure (missing/stale `gh`) as the first
  // diagnostic instead of an ENOENT later in the provider stack.
  // Tech Spec #1350 → "Bootstrap surface": gh auth status must exit 0
  // before bootstrap proceeds.
  try {
    const { version } = await preflightGh();
    Logger.info(`[Bootstrap] gh CLI ${version} ready (auth verified).`);
  } catch (err) {
    if (
      err instanceof GhNotInstalledError ||
      err instanceof GhAuthError ||
      err instanceof GhVersionError
    ) {
      Logger.error(`[Bootstrap] ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  // Preflight runtime deps before the dynamic config-resolver import so
  // a consumer who hasn't installed framework runtime deps yet gets a
  // clear hint (`run mandrel init` or `npm install mandrel`) instead of
  // a raw `ERR_MODULE_NOT_FOUND`.
  try {
    await preflightRuntimeDeps();
  } catch (err) {
    if (err instanceof MissingRuntimeDepsError) {
      Logger.error(`[Bootstrap] ${err.message}`);
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
    throw new Error('[Bootstrap] No "github" block found in .agentrc.json.');
  }

  try {
    validateOrchestrationConfig(config);
  } catch (err) {
    Logger.error(`[Bootstrap] ERROR: ${err.message}`);
    process.exit(1);
  }

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
  // Story #3526 — GitHub-admin mutations are explicit opt-in. The standalone
  // CLI must carry an unambiguous approval signal before any remote mutation
  // lands: either `--approve-github-admin` (the dedicated consent flag) or
  // `--assume-yes` (the existing "accept everything" escape hatch). Without
  // one of these, `runBootstrap` short-circuits to a verified no-op so a bare
  // invocation never silently reconfigures branch protection or merge methods.
  const githubAdminApproved =
    assumeYes || process.argv.includes('--approve-github-admin');
  // Story #4234 — Board decoration is opt-in (default off). Pass
  // `--with-project-board` to also provision the Projects V2 board, Status
  // field, and custom fields.
  const withProjectBoard = process.argv.includes('--with-project-board');

  try {
    const result = await runBootstrap(config, {
      project: config.project,
      github: config.github,
      assumeYes,
      assumeNo,
      reapConflictingWorkflows,
      githubAdminApproved,
      withProjectBoard,
    });
    // A non-approved run returns the skip envelope (no full result shape);
    // the skip line is already logged inside runBootstrap, so render the
    // detailed summary only when mutations were actually attempted.
    if (result.skipped) {
      Logger.info(
        `[Bootstrap] GitHub-admin step skipped (${result.reason}). Re-run with --approve-github-admin (or --assume-yes) to apply.`,
      );
    } else {
      printSummary(result);
    }
  } catch (err) {
    throw new Error(`[Bootstrap] runBootstrap failed: ${err.message}`);
  }
}

// Re-export the gh-preflight surface so existing test consumers can keep
// importing it from this module after the Story #3349 split.
export {
  compareSemver,
  isApiAccessNotFoundError,
  MIN_GH_VERSION,
  parseGhVersion,
  preflightGh,
  preflightRuntimeDeps,
  verifyApiAccess,
};

runAsCli(import.meta.url, main, { source: 'Bootstrap' });

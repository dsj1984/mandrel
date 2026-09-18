/* node:coverage ignore file */
/**
 * agents-bootstrap-github — idempotent GitHub-side setup: label taxonomy,
 * optional project board, branch protection, merge methods.
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
 * Not-found across both error shapes (`GhNotFoundError` carries no `404`
 * substring), so a fresh repo with no issue 1 passes the preflight.
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
    // Not-found means the API is reachable; anything else is fatal.
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
 * Audit the board's built-in workflows that race `ColumnSync` (e.g. "Pull
 * request merged" rewriting Status); warn by default, delete only under
 * `reap` — the GraphQL delete is irreversible. Always returns an envelope.
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
 * Run the idempotent bootstrap sequence. Every mutation here is the
 * irreversible `github-admin` phase group, so this is the default-deny
 * boundary: unless `opts.githubAdminApproved === true` it returns before
 * constructing the provider — zero mutations, zero network I/O.
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
 * }} [opts] - `withProjectBoard` opts into the board, its fields and the
 *   workflow audit.
 */
export async function runBootstrap(config, opts = {}) {
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

  // Board decoration defaults off; ColumnSync soft-noops without a projectNumber.
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

  // The CI-gates-only stance: branch protection (enforce_admins, 0 approvals)
  // and squash-only merges. Behaviour-shifting branch-protection drift goes
  // through the HITL gate, which aborts on non-TTY.
  const projectCfg = opts.project ?? config.project ?? {};
  const githubCfg = opts.github ?? {};
  const settings = {
    ...projectCfg,
    baseBranch: opts.baseBranch ?? projectCfg.baseBranch ?? 'main',
    github: githubCfg,
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

  // Non-TTY with no assume override: drop the gate (which would decline every
  // prompt) so merge methods default-apply with a log line, by design.
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

async function main() {
  // A missing/stale/unauthenticated `gh` is the first diagnostic, not an
  // ENOENT deep in the provider stack.
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

  // Before the dynamic import, so missing deps get a hint, not ERR_MODULE_NOT_FOUND.
  try {
    await preflightRuntimeDeps();
  } catch (err) {
    if (err instanceof MissingRuntimeDepsError) {
      Logger.error(`[Bootstrap] ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

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

  // --assume-yes/--assume-no pin the HITL gate's answer for non-TTY callers.
  const assumeYes = process.argv.includes('--assume-yes');
  const assumeNo = process.argv.includes('--assume-no');
  const reapConflictingWorkflows = process.argv.includes(
    '--reap-conflicting-workflows',
  );
  // A bare invocation must never reconfigure the repo.
  const githubAdminApproved =
    assumeYes || process.argv.includes('--approve-github-admin');
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
    // A skip envelope has no summary shape.
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

// Re-exported: callers import the gh-preflight surface from here.
export {
  compareSemver,
  isApiAccessNotFoundError,
  MIN_GH_VERSION,
  parseGhVersion,
  preflightGh,
  preflightRuntimeDeps,
  verifyApiAccess,
};

runAsCli(import.meta.url, main, {
  source: 'Bootstrap',
  usage: {
    invocation:
      'node .agents/scripts/agents-bootstrap-github.js [--assume-yes|--assume-no] [--approve-github-admin] [--with-project-board] [--reap-conflicting-workflows]',
    summary:
      'Bootstrap the GitHub side of a consumer repo: label taxonomy, issue forms, workflows, and the optional project board.',
    flags: [
      ['--assume-yes', 'Answer yes to every prompt (non-interactive run).'],
      ['--assume-no', 'Answer no to every prompt (probe only).'],
      [
        '--approve-github-admin',
        'Consent to admin-scoped GitHub mutations (implied by --assume-yes).',
      ],
      ['--with-project-board', 'Also provision the GitHub Project board.'],
      [
        '--reap-conflicting-workflows',
        'Remove pre-existing workflow files that clash with the framework set.',
      ],
    ],
  },
});

/* node:coverage ignore file */
/**
 * agents-bootstrap-github — Idempotent Label & Field Setup
 *
 * Creates the required label taxonomy and project board custom fields
 * for the v5 Epic-centric orchestration on a target GitHub repo.
 * Idempotent — skips resources that already exist.
 *
 * Usage:
 *   node .agents/scripts/agents-bootstrap-github.js
 *
 * Reads orchestration config from .agentrc.json via the config resolver,
 * then uses the provider factory to instantiate the correct provider.
 *
 * @see docs/v5-implementation-plan.md Sprint 1C
 */

import fs from 'node:fs';
import path from 'node:path';
import { applyBranchProtection } from './lib/bootstrap/branch-protection.js';
import {
  CI_WORKFLOW_RELATIVE_PATH,
  renderCiWorkflow,
} from './lib/bootstrap/ci-workflow-template.js';
import { confirm as defaultHitlConfirm } from './lib/bootstrap/hitl-confirm.js';
import { applyMergeMethods } from './lib/bootstrap/merge-methods.js';
import { runAsCli } from './lib/cli-utils.js';
import { Logger } from './lib/Logger.js';
import {
  LABEL_TAXONOMY,
  PROJECT_FIELD_DEFS,
  PROJECT_VIEW_DEFS,
  STATUS_FIELD_OPTIONS,
} from './lib/label-taxonomy.js';
import { createProvider } from './lib/provider-factory.js';

const PROJECTS_DOC_POINTER =
  'See docs/project-board.md for the manual Projects V2 setup checklist.';

async function verifyApiAccess(provider) {
  try {
    await provider.getTicket(1);
  } catch (err) {
    // A 404 is fine — API reachable, issue #1 doesn't exist. Anything else is fatal.
    if (!err.message.includes('404')) {
      throw new Error(
        `[bootstrap] API access verification failed: ${err.message}`,
      );
    }
  }
}

async function ensureLabels(provider, log) {
  log(`[bootstrap] Ensuring ${LABEL_TAXONOMY.length} labels...`);
  const labels = await provider.ensureLabels(LABEL_TAXONOMY);
  log(
    `[bootstrap] Labels — created: ${labels.created.length}, skipped: ${labels.skipped.length}`,
  );
  if (labels.created.length > 0) {
    log(`[bootstrap]   Created: ${labels.created.join(', ')}`);
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
 * `main`) so the `agentSettings.quality.prGate.checks` suite is required
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
      `[bootstrap] Branch protection on '${baseBranch}': skipped (agentSettings.quality.prGate.enforceBranchProtection=false).`,
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
 * @param {object} orchestration - The orchestration config from .agentrc.json.
 * @param {{
 *   token?: string,
 *   quiet?: boolean,
 *   providerOverride?: object,
 *   agentSettings?: object,
 *   baseBranch?: string,
 * }} [opts]
 */
export async function runBootstrap(orchestration, opts = {}) {
  const provider =
    opts.providerOverride ??
    createProvider(orchestration, { token: opts.token });
  const log = opts.quiet ? () => {} : Logger.info;
  const providerConfig = orchestration[orchestration.provider];

  log('[bootstrap] Starting idempotent setup...');
  log(`[bootstrap] Provider: ${orchestration.provider}`);
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

  // Consumer-facing bootstrap promotes the framework's CI-gates-only
  // stance: branch protection with enforce_admins + 0-approval-count and
  // the squash-only merge-method allowlist. Behavior-shifting drift on
  // either step routes through the HITL confirm gate — non-TTY runs abort
  // with a clear stderr message rather than silently apply.
  //
  // The legacy `ensureMainBranchProtection` helper is preserved (re-
  // exported below) so the Epic #1142 Story #1157 contract tests stay
  // green; `applyBranchProtection` is its consumer-parity successor.
  const settings = opts.agentSettings
    ? {
        ...opts.agentSettings,
        baseBranch: opts.baseBranch ?? opts.agentSettings?.baseBranch ?? 'main',
      }
    : { baseBranch: opts.baseBranch ?? 'main' };
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
    `Branch protection: ${formatBranchProtectionSummary(result.branchProtection)}`,
  );
  Logger.info(
    `Merge methods: ${formatMergeMethodsSummary(result.mergeMethods)}`,
  );
}

async function main() {
  // Dynamic import to avoid circular dependency issues at module level.
  const { resolveConfig, validateOrchestrationConfig } = await import(
    './lib/config-resolver.js'
  );

  const config = resolveConfig();

  if (!config.orchestration) {
    Logger.fatal(
      '[bootstrap] No "orchestration" block found in .agentrc.json.',
    );
  }

  try {
    validateOrchestrationConfig(config.orchestration);
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

  try {
    const result = await runBootstrap(config.orchestration, {
      installWorkflows,
      agentSettings: config.agentSettings,
      assumeYes,
      assumeNo,
    });
    printSummary(result);
  } catch (err) {
    Logger.fatal(`[bootstrap] runBootstrap failed: ${err.message}`);
  }
}

// Re-export internal helper for test consumers (no production caller imports it).
export { ensureMainBranchProtection };

runAsCli(import.meta.url, main, { source: 'Bootstrap' });

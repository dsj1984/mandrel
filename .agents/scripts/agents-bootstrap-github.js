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
 * Run the idempotent bootstrap sequence.
 *
 * @param {object} orchestration - The orchestration config from .agentrc.json.
 * @param {{ token?: string, quiet?: boolean }} [opts]
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

  log('[bootstrap] Done.');
  return { labels, fields, project, statusField, views };
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

  try {
    const result = await runBootstrap(config.orchestration, {
      installWorkflows,
    });
    printSummary(result);
  } catch (err) {
    Logger.fatal(`[bootstrap] runBootstrap failed: ${err.message}`);
  }
}

runAsCli(import.meta.url, main, { source: 'Bootstrap' });

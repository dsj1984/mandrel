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
import { runAsCli } from './lib/cli-utils.js';
import {
  GhAuthError,
  GhNotInstalledError,
  GhVersionError,
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
  // Post-reshape: bootstrap reads from the new `project` + `github` blocks;
  // the legacy `agentSettings` bag is still accepted so consumer-bootstrap
  // tests that hand-craft fixtures keep working.
  const projectCfg = opts.project ?? opts.agentSettings ?? {};
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
      project: config.project,
      github: config.github,
      // Legacy shim — older consumer test fixtures may still read this.
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

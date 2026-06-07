#!/usr/bin/env node
/**
 * bootstrap-new.js — simplified consumer setup for Mandrel.
 *
 * A streamlined alternative to bootstrap.js (see
 * chris-bootstrap-instructions.md). Differences from the original:
 *   - No config profiles — `.agentrc.json` always seeds from the bundled
 *     `.agents/starter-agentrc.json` (the no-profile starter reference).
 *   - Runs even when the directory is NOT a git repo yet (preflight detects
 *     git state instead of failing on it).
 *   - Adds a Projects V2 permission check to preflight.
 *   - Replaces the phased-approval manifest with a plain summary + confirm
 *     loop (interactive runs can go back and re-answer).
 *   - Reserves a placeholder step for provisioning a new GitHub repo /
 *     project (exits with a message until implemented).
 *
 * NOTE: every step is prefixed with `[temp]` logging for development
 * visibility — strip these once the flow is settled.
 *
 * Usage:
 *   node .agents/scripts/bootstrap-new.js [flags]
 *
 * Flags:
 *   --owner <name>            GitHub owner (default: parsed from origin remote)
 *   --repo <name>             GitHub repo  (default: parsed from origin remote)
 *   --operator-handle <name>  GitHub handle for github.operatorHandle
 *   --base-branch <name>      Base branch (default: origin/HEAD or 'main')
 *   --project-number <n>      Projects V2 number/name (optional)
 *   --assume-yes              Accept every default; required for non-TTY runs
 *   --skip-github             Skip the GitHub-side bootstrap entirely
 *   --skip-quality            Skip the quality-gates bootstrap
 *   --dry-run                 Collect info and print the plan; change nothing
 *   --reap-conflicting-workflows  Delete Projects V2 built-in workflows that
 *                             race against the orchestrator (destructive)
 *   --help                    Print this help
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

// Reused bootstrap library helpers (unchanged).
import { listProjects, listRepos } from './lib/bootstrap/gh-list.js';
import {
  buildLedgerRecord,
  writeInstallLedger,
} from './lib/bootstrap/install-ledger.js';
import {
  buildMutationManifest,
  PHASE_GROUPS,
} from './lib/bootstrap/manifest.js';
import { runPreflight } from './lib/bootstrap/preflight.js';
import { applyProjectBootstrap } from './lib/bootstrap/project-bootstrap.js';
import {
  collectAnswers,
  inferDefaults,
  parseFlags,
} from './lib/bootstrap/prompt.js';
import { runAsCli } from './lib/cli-utils.js';
import { Logger } from './lib/Logger.js';

const HELP = `bootstrap-new.js — simplified consumer setup for Mandrel.

Usage: node .agents/scripts/bootstrap-new.js [flags]

Flags:
  --owner <name>            GitHub owner (default: parsed from origin remote)
  --repo <name>             GitHub repo  (default: parsed from origin remote)
  --operator-handle <name>  GitHub handle for github.operatorHandle
  --base-branch <name>      Base branch (default: origin/HEAD or 'main')
  --project-number <n>      Projects V2 number/name (optional)
  --assume-yes              Accept every default; required for non-TTY runs
  --skip-github             Skip the GitHub-side bootstrap entirely
  --skip-quality            Skip the quality-gates bootstrap
  --dry-run                 Collect info and print the plan; change nothing
  --reap-conflicting-workflows  Delete Projects V2 built-in workflows that
                            race against the orchestrator (destructive)
  --help                    Print this help
`;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Strip an `owner/` prefix off a repo slug, leaving the bare repo name. */
function bareRepoName(slug) {
  const slash = slug.indexOf('/');
  return slash === -1 ? slug : slug.slice(slash + 1);
}

/** Resolve the GitHub owner for the pickers: flag → env → inferred default. */
function resolveOwnerForPicker(defaults, flags, env = process.env) {
  if (typeof flags?.owner === 'string' && flags.owner.length > 0) {
    return flags.owner;
  }
  if (typeof env?.GH_OWNER === 'string' && env.GH_OWNER.length > 0) {
    return env.GH_OWNER;
  }
  if (typeof defaults?.owner === 'string' && defaults.owner.length > 0) {
    return defaults.owner;
  }
  return null;
}

/** Ask a yes/no question. Non-interactive runs auto-accept (return true). */
async function confirmYesNo(message, interactive) {
  if (!interactive) return true;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const raw = (await rl.question(`${message} [Y/n]: `)).trim().toLowerCase();
    return raw === '' || raw === 'y' || raw === 'yes';
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// Question list (Step 3) — config profile dropped per the new spec.
// ---------------------------------------------------------------------------

/**
 * Build the Step 3 question list. `silentAccept` keys (owner/repo/baseBranch/
 * operatorHandle) are git-inferred and accepted without prompting unless an
 * override is supplied. The `operatorHandle` and `projectNumber` defaults
 * track the repo owner / repo name respectively (see post-processing in
 * `collectAndConfirm`).
 */
function buildQuestions(defaults, flags, env = process.env) {
  const owner = resolveOwnerForPicker(defaults, flags, env);
  return [
    {
      key: 'owner',
      flag: 'owner',
      env: 'GH_OWNER',
      message: 'Github repo owner',
      default: defaults.owner,
      required: true,
      validate: (v) =>
        /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(v) ? null : 'Invalid GitHub owner',
    },
    {
      key: 'operatorHandle',
      flag: 'operator-handle',
      env: 'GH_OPERATOR_HANDLE',
      message: 'Github username/handle (without the @)',
      // Default tracks the repo owner; resolved post-collect if left blank.
      default: defaults.owner,
      required: false,
      validate: (v) =>
        v.length === 0 || /^[A-Za-z0-9-]+$/.test(v)
          ? null
          : 'Invalid GitHub handle',
    },
    {
      key: 'repo',
      flag: 'repo',
      env: 'GH_REPO',
      message:
        'Github repo name - Select from the list or enter a new name to create one',
      default: defaults.repo,
      required: true,
      picker: {
        list: () => listRepos({ owner }).map(bareRepoName),
      },
      validate: (v) =>
        /^[A-Za-z0-9._-]+$/.test(v) ? null : 'Invalid GitHub repo name',
    },
    {
      key: 'baseBranch',
      flag: 'base-branch',
      env: 'GH_BASE_BRANCH',
      message: 'Base branch',
      default: defaults.baseBranch || 'main',
      required: true,
      validate: (v) => (v.length > 0 ? null : 'Base branch is required'),
    },
    {
      key: 'projectNumber',
      flag: 'project-number',
      env: 'GH_PROJECT_NUMBER',
      message:
        'Github Project V2 name - Select from the list or enter a new name to create one',
      // Default tracks the repo name; resolved post-collect if left blank.
      default: defaults.repo,
      required: false,
      picker: {
        list: () => listProjects({ owner }),
      },
      // Accept blank (skip), an existing project number, or a new project
      // name (letters/digits/space/._-).
      validate: (v) =>
        v.length === 0 || /^\d+$/.test(v) || /^[A-Za-z0-9 ._-]+$/.test(v)
          ? null
          : 'Invalid project name',
    },
  ];
}

const INFERRED_KEYS = Object.freeze([
  'owner',
  'repo',
  'baseBranch',
  'operatorHandle',
]);
const FLAG_BY_KEY = Object.freeze({
  owner: 'owner',
  repo: 'repo',
  baseBranch: 'base-branch',
  operatorHandle: 'operator-handle',
});
const ENV_BY_KEY = Object.freeze({
  owner: 'GH_OWNER',
  repo: 'GH_REPO',
  baseBranch: 'GH_BASE_BRANCH',
  operatorHandle: 'GH_OPERATOR_HANDLE',
});

/** Keys whose git-inferred default is accepted without prompting. */
function resolveSilentAccept(defaults, flags, env = process.env) {
  const out = [];
  for (const key of INFERRED_KEYS) {
    const value = defaults?.[key];
    if (typeof value !== 'string' || value.length === 0) continue;
    if (typeof flags?.[FLAG_BY_KEY[key]] === 'string') continue;
    if (typeof env?.[ENV_BY_KEY[key]] === 'string') continue;
    out.push(key);
  }
  return out;
}

// ---------------------------------------------------------------------------
// GitHub-side bootstrap (Step 6) — same wiring as bootstrap.js.
// ---------------------------------------------------------------------------

async function runGithubBootstrap(answers, opts) {
  const { runBootstrap, preflightGh, preflightRuntimeDeps } = await import(
    './agents-bootstrap-github.js'
  );
  await preflightGh();
  await preflightRuntimeDeps();
  const { resolveConfig, validateOrchestrationConfig } = await import(
    './lib/config-resolver.js'
  );
  // `resolveConfig` reads github.projectNumber from .agentrc.json, which the
  // persistProjectNumber step writes BEFORE this runs — so the provider reuses
  // the existing project instead of creating a new one (Bug: gave #8, created
  // #12 because the number never reached the provider config).
  const config = resolveConfig();
  validateOrchestrationConfig(config);
  return runBootstrap(config, {
    project: config.project,
    github: config.github,
    assumeYes: opts.assumeYes,
    baseBranch: answers.baseBranch,
    githubAdminApproved: true,
    // Opt-in: delete the Projects V2 built-in workflows that race against the
    // orchestrator's ColumnSync (e.g. "Pull request merged"). Off by default.
    reapConflictingWorkflows: Boolean(opts.reapConflictingWorkflows),
  });
}

/** True only when every github-admin sub-mutation that ran succeeded. */
function githubSubMutationsSucceeded(gh) {
  if (gh.branchProtection?.status === 'failed') return false;
  if (gh.mergeMethods?.status === 'failed') return false;
  return true;
}

/** Phase groups whose mutations actually landed, for the install ledger. */
function resolveAppliedGroups(approvedGroups, report) {
  const applied = new Set();
  for (const group of approvedGroups ?? []) {
    if (group === PHASE_GROUPS.GITHUB_ADMIN) {
      const gh = report?.github;
      if (gh && !gh.error && !gh.skipped && githubSubMutationsSucceeded(gh)) {
        applied.add(group);
      }
      continue;
    }
    applied.add(group);
  }
  return applied;
}

// ---------------------------------------------------------------------------
// Pipeline phases
// ---------------------------------------------------------------------------

/**
 * Step 1 — Parse argv, handle `--help`, and enforce the non-TTY contract
 * (`--owner`/`--repo` or env equivalents + `--assume-yes`).
 */
export function parseAndValidate(argv, opts = {}) {
  Logger.info('[temp][step1] Parse & validate');
  const stdout = opts.stdout ?? process.stdout;
  const env = opts.env ?? process.env;
  const stdin = opts.stdin ?? process.stdin;
  const flags = parseFlags(argv);
  if (flags.help) {
    stdout.write(HELP);
    return { ok: false, exit: 0 };
  }
  const interactive = Boolean(stdin.isTTY) && !flags['assume-yes'];
  const assumeYes = Boolean(flags['assume-yes']);
  if (!interactive && !assumeYes) {
    const required = ['owner', 'repo'];
    const missing = required.filter(
      (k) =>
        typeof flags[k] !== 'string' &&
        typeof env[`GH_${k.toUpperCase()}`] !== 'string',
    );
    if (missing.length > 0) {
      Logger.error(
        `[bootstrap-new] non-TTY run requires --owner and --repo (or GH_OWNER / GH_REPO) and --assume-yes. Missing: ${missing.join(', ')}`,
      );
      return { ok: false, exit: 1 };
    }
  }
  return { ok: true, payload: { flags, interactive, assumeYes } };
}

/**
 * Step 1b — Resolve paths, infer defaults from git, and echo the detected
 * values back to the operator (the "share found values" requirement).
 */
export function prepareContext(state, opts = {}) {
  Logger.info('[temp][step1] Sharing detected values');
  const scriptUrl = opts.scriptUrl ?? import.meta.url;
  const here = path.dirname(fileURLToPath(scriptUrl));
  const projectRoot = opts.projectRoot ?? process.cwd();
  const agentRoot = path.resolve(here, '..');
  const defaults = inferDefaults(projectRoot);
  const silentAccept = resolveSilentAccept(defaults, state.flags);

  Logger.info('[bootstrap-new] Detected from local git:');
  Logger.info(`  owner          ${defaults.owner ?? '(none)'}`);
  Logger.info(`  repo           ${defaults.repo ?? '(none)'}`);
  Logger.info(`  base branch    ${defaults.baseBranch ?? '(none)'}`);
  Logger.info(`  username       ${defaults.operatorHandle ?? '(none)'}`);

  return {
    ok: true,
    payload: { projectRoot, agentRoot, defaults, silentAccept },
  };
}

/**
 * Step 2 — Preflight. Work-tree check is informational (does not fail the
 * gate); adds the Projects V2 permission check. Prints a pass/fail line for
 * every check.
 */
export async function runPreflightPhase(state, opts = {}) {
  Logger.info('[temp][step2] Preflight checks');
  const run = opts.run ?? runPreflight;
  const skipGithub = Boolean(state.flags['skip-github']);
  const result = await run({
    skipGithub,
    requireWorkTree: false,
    checkProjectScope: !skipGithub,
  });

  for (const check of result.checks) {
    if (check.ok) {
      Logger.info(
        `[bootstrap-new] ✓ ${check.name}${check.detail ? ` — ${check.detail}` : ''}`,
      );
    } else {
      Logger.error(`[bootstrap-new] ✗ ${check.name}: ${check.remedy}`);
    }
  }

  if (!result.ok) {
    Logger.error(
      '[bootstrap-new] Preflight failed. Resolve the issues above and re-run.',
    );
    return { ok: false, exit: 1 };
  }

  Logger.info(
    `[bootstrap-new] git initialized: ${result.gitInitialized ? 'yes' : 'no'}`,
  );
  return {
    ok: true,
    payload: { preflight: result, gitInitialized: result.gitInitialized },
  };
}

/** Render the resolved answers as a human-readable summary block. */
function renderAnswerSummary(answers, creation, project) {
  const lines = [
    '\n=== Review your answers ===',
    `  Repo owner       ${answers.owner}`,
    `  Username/handle  ${answers.operatorHandle || '(none)'}`,
    `  Repo name        ${answers.repo}${creation.newRepo ? '  (NEW — will be created)' : ''}`,
    `  Base branch      ${answers.baseBranch}`,
    `  Project V2 name  ${project.name}${creation.newProject ? '  (NEW — will be created)' : ''}`,
    `  Project V2 #     ${project.number}`,
  ];
  return lines.join('\n');
}

/**
 * Determine whether the answers ask for resources that do not exist yet.
 * A repo not present in the owner's repo list is treated as "new"; a
 * non-numeric project answer (a typed name, not a picked number) is "new".
 * When a list cannot be fetched we assume the resource exists (do not block).
 * When GitHub is skipped entirely there is nothing to create, so detection
 * is bypassed.
 */
function detectCreation(answers, skipGithub) {
  const creation = { newRepo: false, newProject: false };
  if (skipGithub) return creation;
  try {
    const repos = listRepos({ owner: answers.owner }).map(bareRepoName);
    if (repos.length > 0 && answers.repo && !repos.includes(answers.repo)) {
      creation.newRepo = true;
    }
  } catch {
    /* cannot determine — assume existing */
  }
  const pn = answers.projectNumber;
  if (typeof pn === 'string' && pn.length > 0 && !/^\d+$/.test(pn)) {
    creation.newProject = true;
  }
  return creation;
}

/**
 * Resolve the Projects V2 answer into a `{ name, number }` pair for the
 * summary. The picker stores only the numeric value, so for an existing
 * project (numeric answer) we look the name up in the owner's project list.
 * A typed answer (non-numeric) is a new project name with no number yet.
 */
function resolveProjectDisplay(answers, skipGithub) {
  const pn = answers.projectNumber;
  if (!pn) return { name: '(skip)', number: '(skip)' };
  if (/^\d+$/.test(pn)) {
    let name = '(unknown)';
    if (!skipGithub) {
      try {
        const match = listProjects({ owner: answers.owner }).find(
          (p) => p.value === pn,
        );
        if (match) {
          const m = /^(.*)\s+\(#\d+\)$/.exec(match.label);
          name = m ? m[1] : match.label;
        }
      } catch {
        /* leave as unknown */
      }
    }
    return { name, number: pn };
  }
  // Typed name → new project; number is assigned at creation time.
  return { name: pn, number: '(new)' };
}

/**
 * Steps 3 + 4 — Collect answers, show a summary, and confirm. Interactive
 * runs that answer "no" loop back and re-ask. Non-interactive runs
 * auto-accept. Then collect creation approval when a new repo/project was
 * requested.
 */
export async function collectAndConfirm(state) {
  Logger.info('[temp][step3] Collect answers');
  let silentAccept = state.silentAccept;
  // Loop until the operator confirms the summary (or we auto-accept).
  for (;;) {
    const { answers, missing } = await collectAnswers({
      questions: buildQuestions(state.defaults, state.flags),
      flags: state.flags,
      interactive: state.interactive,
      assumeYes: state.assumeYes,
      silentAccept,
    });
    if (missing.length > 0) {
      Logger.error(
        `[bootstrap-new] missing required answers: ${missing.join(', ')}`,
      );
      return { ok: false, exit: 1 };
    }
    // Defaults that track another answer: handle ⇐ owner, project ⇐ repo.
    if (!answers.operatorHandle) answers.operatorHandle = answers.owner;

    const skipGithub = Boolean(state.flags['skip-github']);
    const creation = detectCreation(answers, skipGithub);
    const project = resolveProjectDisplay(answers, skipGithub);

    Logger.info('[temp][step4] Approval');
    Logger.info(renderAnswerSummary(answers, creation, project));
    const correct = await confirmYesNo('Is this correct?', state.interactive);
    if (!correct) {
      Logger.info('[bootstrap-new] Okay — let’s try again.');
      // Re-prompt everything on the next pass (drop silent-accept).
      silentAccept = [];
      continue;
    }

    // In --dry-run we only collect/confirm info, so never ask to create.
    if (!state.flags['dry-run'] && (creation.newRepo || creation.newProject)) {
      const approved = await confirmYesNo(
        'Create the new GitHub repo/project listed above?',
        state.interactive,
      );
      if (!approved) {
        Logger.error(
          '[bootstrap-new] Creation declined — cannot continue without the repo/project. Exiting.',
        );
        return { ok: false, exit: 1 };
      }
    }
    return { ok: true, payload: { answers, creation } };
  }
}

/**
 * --dry-run gate — print the resolved answers and the full mutation plan,
 * then halt BEFORE any file write, GitHub change, or label creation. Runs
 * after collect/confirm so the operator sees exactly what would happen.
 */
/** Render the dry-run plan as a per-section layout (no mutations happen). */
function renderDryRunPlan(state) {
  const a = state.answers ?? {};
  const c = state.creation ?? {};
  const flagList = Object.entries(state.flags ?? {}).map(([k, v]) =>
    v === true ? k : `${k}=${v}`,
  );
  return [
    '\n=== Dry run — nothing will be changed ===',
    'Values',
    `  owner            ${a.owner ?? '(none)'}`,
    `  operator handle  ${a.operatorHandle ?? '(none)'}`,
    `  repo             ${a.repo ?? '(none)'}`,
    `  base branch      ${a.baseBranch ?? '(none)'}`,
    `  project number   ${a.projectNumber || '(skip)'}`,
    '',
    'Creation',
    `  new repo         ${c.newRepo ? 'yes' : 'no'}`,
    `  new project      ${c.newProject ? 'yes' : 'no'}`,
    '',
    'Flags',
    `  ${flagList.length ? flagList.join(', ') : '(none)'}`,
  ].join('\n');
}

export function dryRunPlan(state) {
  if (!state.flags['dry-run']) return { ok: true, payload: {} };
  Logger.info('[temp][dry-run] Printing plan (no writes)');
  Logger.info(
    '[bootstrap-new] --dry-run: no files, GitHub settings, or labels will be changed.',
  );
  Logger.info(renderDryRunPlan(state));
  return { ok: false, exit: 0 };
}

/**
 * Step 5 — Provision a new GitHub repo / project. Placeholder: until this is
 * implemented, exit with a message when creation is actually required.
 */
export function maybeCreateResources(state) {
  Logger.info('[temp][step5] Create GH repo/project (placeholder)');
  const { newRepo, newProject } = state.creation;
  if (!newRepo && !newProject) {
    Logger.info('[bootstrap-new] No new GitHub resources needed — skipping.');
    return { ok: true, payload: {} };
  }
  const parts = [];
  if (newRepo) parts.push(`repo "${state.answers.repo}"`);
  if (newProject) parts.push(`project "${state.answers.projectNumber}"`);
  Logger.error(
    `[bootstrap-new] Provisioning ${parts.join(' and ')} is not implemented yet. ` +
      'Please create it on GitHub, then re-run. Exiting.',
  );
  return { ok: false, exit: 0 };
}

/**
 * Step 6a — Project-side bootstrap. With phased approval removed, all
 * project-side phase groups are treated as approved.
 */
export async function executeBootstrap(state) {
  Logger.info('[temp][step6] Project bootstrap');
  Logger.info(
    `[bootstrap-new] Starting project bootstrap at ${state.projectRoot} (owner=${state.answers.owner} repo=${state.answers.repo} base=${state.answers.baseBranch})`,
  );
  const approvedGroups = new Set(Object.values(PHASE_GROUPS));
  const report = await applyProjectBootstrap({
    projectRoot: state.projectRoot,
    agentRoot: state.agentRoot,
    answers: state.answers,
    approvedGroups,
    skipQuality: Boolean(state.flags['skip-quality']),
  });
  return { ok: true, payload: { report, approvedGroups } };
}

/**
 * Step 6 (between project + GitHub) — Persist the chosen Projects V2 number
 * into .agentrc.json's github block so it is the stored source of truth that
 * resolveConfig (and the orchestrator) read back. Runs AFTER the project-side
 * bootstrap has ensured .agentrc.json exists and BEFORE the GitHub bootstrap,
 * so the provider reuses the existing project instead of creating a new one.
 * Merges into an existing file (ensureAgentrc never overwrites one). Stored as
 * an integer per the schema; a blank/new-project answer stores nothing.
 */
export function persistProjectNumber(state) {
  Logger.info('[temp][step6] Persist projectNumber to .agentrc.json');
  const pn = String(state.answers.projectNumber ?? '');
  if (!/^\d+$/.test(pn)) {
    return { ok: true, payload: {} };
  }
  const target = path.join(state.projectRoot, '.agentrc.json');
  let config;
  try {
    config = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (err) {
    Logger.error(
      `[bootstrap-new] Could not read ${target} to store projectNumber: ${err.message}`,
    );
    return { ok: true, payload: {} };
  }
  config.github = config.github ?? {};
  if (config.github.projectNumber !== Number(pn)) {
    config.github.projectNumber = Number(pn);
    fs.writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    Logger.info(
      `[bootstrap-new] Stored github.projectNumber=${pn} in .agentrc.json`,
    );
  }
  return { ok: true, payload: {} };
}

/** Step 6b — GitHub-side bootstrap. Honours `--skip-github`. */
export async function executeGithubBootstrap(state) {
  Logger.info('[temp][step6] GitHub bootstrap');
  if (state.flags['skip-github']) {
    Logger.info(
      '[bootstrap-new] --skip-github set; skipping GitHub bootstrap.',
    );
    return { ok: true, payload: {} };
  }
  try {
    state.report.github = await runGithubBootstrap(state.answers, {
      assumeYes: state.assumeYes,
      reapConflictingWorkflows: Boolean(
        state.flags['reap-conflicting-workflows'],
      ),
    });
  } catch (err) {
    Logger.error(`[bootstrap-new] GitHub bootstrap failed: ${err.message}`);
    // GhExecError carries the real gh stderr/stdout/exit code — surface it so
    // a generic "gh exited with code 1" is actually diagnosable.
    if (err.stderr)
      Logger.error(`[bootstrap-new]   gh stderr: ${err.stderr.trim()}`);
    if (err.stdout)
      Logger.error(`[bootstrap-new]   gh stdout: ${err.stdout.trim()}`);
    if (Array.isArray(err.args)) {
      Logger.error(`[bootstrap-new]   gh args: ${err.args.join(' ')}`);
    }
    state.report.github = { error: err.message };
  }
  return { ok: true, payload: {} };
}

/** Step 6c — Record the install ledger for a future uninstall. */
export function recordLedger(state) {
  Logger.info('[temp][step6] Record install ledger');
  const appliedGroups = resolveAppliedGroups(
    state.approvedGroups,
    state.report,
  );
  const manifestCtx = {
    answers: state.answers,
    skipGithub: Boolean(state.flags['skip-github']),
    skipQuality: Boolean(state.flags['skip-quality']),
  };
  const entries = buildMutationManifest(manifestCtx).filter((e) =>
    appliedGroups.has(e.phaseGroup),
  );
  if (entries.length === 0) {
    state.report.ledger = { written: false, reason: 'no-mutations-applied' };
    return { ok: true, payload: {} };
  }
  const record = buildLedgerRecord({
    entries,
    approvedGroups: appliedGroups,
    answers: state.answers,
  });
  const result = writeInstallLedger(state.projectRoot, record);
  state.report.ledger = { ...result, approvedGroups: [...appliedGroups] };
  return { ok: true, payload: {} };
}

/** Pipeline driver — threads accumulated state through each phase. */
export async function runPipeline(phases) {
  let state = {};
  for (const phase of phases) {
    const result = await phase(state);
    if (!result.ok) return { ok: false, exit: result.exit, state };
    state = { ...state, ...(result.payload ?? {}) };
  }
  return { ok: true, state };
}

export async function main(argv = process.argv.slice(2)) {
  const result = await runPipeline([
    () => parseAndValidate(argv),
    (s) => prepareContext(s),
    (s) => runPreflightPhase(s),
    (s) => collectAndConfirm(s),
    (s) => dryRunPlan(s),
    (s) => maybeCreateResources(s),
    (s) => executeBootstrap(s),
    (s) => persistProjectNumber(s),
    (s) => executeGithubBootstrap(s),
    (s) => recordLedger(s),
  ]);
  if (!result.ok) return result.exit;
  Logger.info('\n[bootstrap-new] Done.');
  return 0;
}

runAsCli(import.meta.url, main, {
  source: 'BootstrapNew',
  propagateExitCode: true,
});

#!/usr/bin/env node
/**
 * bootstrap.js — single-command consumer setup for Mandrel.
 *
 * The sole bootstrap orchestrator (Story #3690 collapsed the temporary
 * bootstrap-new.js fork into this file). Key behaviours:
 *   - No config profiles — `.agentrc.json` always seeds from the bundled
 *     `.agents/starter-agentrc.json` starter reference.
 *   - Runs even when the directory is NOT a git repo yet (preflight detects
 *     git state instead of failing on it).
 *   - Adds a Projects V2 permission check to preflight (warns rather than
 *     failing when classic token scopes cannot be read, e.g. fine-grained
 *     PATs).
 *   - Uses a plain summary + confirm loop (interactive runs can go back and
 *     re-answer) instead of a phased-approval manifest.
 *   - Provisions the missing pieces of a cold start: initializes the local
 *     git repo (with a first commit) when absent, creates the GitHub repo
 *     (linking + pushing the local tree), and creates the Projects V2 board
 *     from a typed name — capturing its number for the rest of the run.
 *
 * Usage:
 *   node .agents/scripts/bootstrap.js [flags]
 *
 * Flags:
 *   --owner <name>            GitHub owner (default: parsed from origin remote)
 *   --repo <name>             GitHub repo  (default: parsed from origin remote)
 *   --visibility <v>          Visibility for a newly created repo:
 *                             private | public | internal (default: private)
 *   --operator-handle <name>  GitHub handle for github.operatorHandle
 *   --base-branch <name>      Base branch (default: origin/HEAD or 'main')
 *   --project-number <n>      Projects V2 number/name (optional)
 *   --assume-yes              Accept every default + approve GitHub-admin
 *                             mutations. A non-TTY run requires this (or
 *                             --approve-github-admin) — there is no operator
 *                             to confirm the summary.
 *   --approve-github-admin    Consent to the irreversible GitHub-admin phase
 *                             (labels, Projects V2, branch protection, merge
 *                             methods) without accepting every other default.
 *   --skip-github             Skip the GitHub-side bootstrap entirely
 *   --skip-quality            Skip the quality-gates bootstrap
 *   --dry-run                 Collect info and print the plan; change nothing
 *   --reap-conflicting-workflows  Delete Projects V2 built-in workflows that
 *                             race against the orchestrator (destructive)
 *   --help                    Print this help
 */

import { spawnSync } from 'node:child_process';
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
import { exec, GhNotFoundError } from './lib/gh-exec.js';
import { Logger } from './lib/Logger.js';

const HELP = `bootstrap.js — single-command consumer setup for Mandrel.

Usage: node .agents/scripts/bootstrap.js [flags]

Flags:
  --owner <name>            GitHub owner (default: parsed from origin remote)
  --repo <name>             GitHub repo  (default: parsed from origin remote)
  --visibility <v>          Visibility for a newly created repo:
                            private | public | internal (default: private)
  --operator-handle <name>  GitHub handle for github.operatorHandle
  --base-branch <name>      Base branch (default: origin/HEAD or 'main')
  --project-number <n>      Projects V2 number/name (optional)
  --assume-yes              Accept every default + approve GitHub-admin
                            mutations. A non-TTY run requires this (or
                            --approve-github-admin) — there is no operator
                            to confirm the summary.
  --approve-github-admin    Consent to the irreversible GitHub-admin phase
                            (labels, Projects V2, branch protection, merge
                            methods) without accepting every other default.
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

/**
 * Normalize an operator handle to the bare login the starter template expects.
 *
 * The starter `.agentrc.json` carries `"operatorHandle": "@[USERNAME]"` and the
 * seed step substitutes `[USERNAME]` with this answer — so the answer MUST be
 * the bare handle (no leading `@`), or the seeded value becomes `@@foo`. The
 * interactive validator already rejects a leading `@`, but the
 * `--operator-handle @x` flag and `GH_OPERATOR_HANDLE=@x` env paths skip that
 * validator (Story #3700). Stripping a single leading `@` here closes that gap
 * for every resolution path. Idempotent: a bare handle is returned unchanged,
 * so a re-run never re-strips or re-accumulates.
 *
 * @param {string|undefined|null} handle
 * @returns {string|undefined|null} the input with a single leading `@` removed
 */
export function normalizeHandleAnswer(handle) {
  if (typeof handle !== 'string') return handle;
  return handle.replace(/^@/, '');
}

/** Run a list-producing fn, returning [] on any throw. */
function safeList(fn) {
  try {
    return fn() ?? [];
  } catch {
    return [];
  }
}

/** Resolve the GitHub owner for the pickers: flag → env → inferred default. */
export function resolveOwnerForPicker(defaults, flags, env = process.env) {
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

/**
 * Run a git command in `cwd`. Returns the normalized
 * `{ ok, status, stdout, stderr, error }` shape (mirroring the bootstrap
 * preflight/gh-list runners) so callers branch on `ok` without juggling
 * spawnSync internals.
 */
function runGit(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return {
    ok: !result.error && result.status === 0,
    status: result.status,
    stdout: typeof result.stdout === 'string' ? result.stdout.trim() : '',
    stderr: typeof result.stderr === 'string' ? result.stderr.trim() : '',
    error: result.error,
  };
}

/**
 * Surface a `gh`/exec failure with the same detail the GitHub bootstrap
 * step prints — message plus the real gh stderr/stdout/args carried on a
 * `GhExecError` — so a bare "gh exited with code 1" is actually diagnosable.
 */
function logGhError(label, err) {
  Logger.error(`[bootstrap] ${label} failed: ${err.message}`);
  if (err.stderr)
    Logger.error(`[bootstrap]   gh stderr: ${String(err.stderr).trim()}`);
  if (err.stdout)
    Logger.error(`[bootstrap]   gh stdout: ${String(err.stdout).trim()}`);
  if (Array.isArray(err.args)) {
    Logger.error(`[bootstrap]   gh args: ${err.args.join(' ')}`);
  }
}

/**
 * Per-command git identity args. The first commit fails when neither a repo-
 * nor global-level `user.name`/`user.email` is configured, which is common on
 * a freshly provisioned machine. When either is missing we supply a
 * non-persistent identity via `-c` (derived from the operator handle) so the
 * commit succeeds without mutating the operator's git config.
 */
function gitIdentityArgs(cwd, answers) {
  const haveName = runGit(['config', 'user.name'], cwd).ok;
  const haveEmail = runGit(['config', 'user.email'], cwd).ok;
  if (haveName && haveEmail) return [];
  const handle = answers.operatorHandle || answers.owner || 'mandrel';
  return [
    '-c',
    `user.name=${handle}`,
    '-c',
    `user.email=${handle}@users.noreply.github.com`,
  ];
}

/**
 * Initialize the local git repo when one is not already present, and ensure
 * at least one commit exists so `gh repo create --source=. --push` has
 * something to push. Idempotent: a repo that already resolves `HEAD` is left
 * untouched. Returns `{ ok, initialized, committed }` (or `{ ok:false, error }`
 * on failure).
 */
function ensureGitInitialized(state) {
  const cwd = state.projectRoot;
  const branch = state.answers.baseBranch || 'main';
  let initialized = false;
  if (!state.gitInitialized) {
    // `git init -b <branch>` (git ≥ 2.28) sets the initial branch directly;
    // fall back to a plain init + symbolic-ref for older git.
    let init = runGit(['init', '-b', branch], cwd);
    if (!init.ok) {
      init = runGit(['init'], cwd);
      if (!init.ok)
        return { ok: false, error: init.stderr || 'git init failed' };
      runGit(['symbolic-ref', 'HEAD', `refs/heads/${branch}`], cwd);
    }
    initialized = true;
    state.gitInitialized = true;
    Logger.info(
      `[bootstrap] Initialized git repo (branch ${branch}) at ${cwd}.`,
    );
  }

  // A push needs a commit; create one only when HEAD does not resolve yet.
  let committed = false;
  if (!runGit(['rev-parse', '--verify', 'HEAD'], cwd).ok) {
    runGit(['add', '-A'], cwd);
    const commit = runGit(
      [
        ...gitIdentityArgs(cwd, state.answers),
        'commit',
        '--allow-empty',
        '-m',
        'Initial commit',
      ],
      cwd,
    );
    if (!commit.ok) {
      return { ok: false, error: commit.stderr || 'git commit failed' };
    }
    committed = true;
    Logger.info('[bootstrap] Created initial commit.');
  }
  return { ok: true, initialized, committed };
}

/**
 * Wire the local `origin` remote to owner/repo when it is missing, so the
 * GitHub bootstrap — which infers the target repo from the local remote —
 * can run. This is the companion to `createGithubRepo`: that path wires
 * `origin` itself via `--remote origin`, but a repo that already exists (or
 * a re-run after a partial failure) leaves the local folder unlinked. Only
 * acts when the repo actually exists on GitHub; pushes the base branch to
 * set upstream, downgrading a rejected push to a warning since the bootstrap
 * only needs the remote to resolve (content sync is the operator's to settle).
 */
async function ensureGitRemote(state, execImpl = exec) {
  const cwd = state.projectRoot;
  const { owner, repo } = state.answers;
  const branch = state.answers.baseBranch || 'main';
  if (runGit(['remote', 'get-url', 'origin'], cwd).ok) return;
  if (!(await repoExists(owner, repo, execImpl))) {
    Logger.warn(
      `[bootstrap] No 'origin' remote and ${owner}/${repo} does not exist on GitHub — skipping remote wiring.`,
    );
    return;
  }
  const url = `https://github.com/${owner}/${repo}.git`;
  const add = runGit(['remote', 'add', 'origin', url], cwd);
  if (!add.ok) {
    Logger.warn(`[bootstrap] Could not add 'origin' remote: ${add.stderr}`);
    return;
  }
  Logger.info(`[bootstrap] Wired 'origin' → ${url}.`);
  const push = runGit(['push', '-u', 'origin', branch], cwd);
  if (!push.ok) {
    Logger.warn(
      `[bootstrap] 'origin' is set but push of '${branch}' failed (resolve manually, e.g. \`git pull --rebase origin ${branch}\`): ${push.stderr}`,
    );
  }
}

/**
 * Authoritatively check whether `owner/repo` exists, via `gh repo view`.
 * Returns false on a not-found (so the repo can be created), true when it
 * resolves, and true on any other error (auth/network/etc.) so a transient
 * failure never triggers a spurious create attempt. Used instead of an
 * `is it in the repo-list?` heuristic, which mis-fires for a brand-new
 * account whose `gh repo list` is empty.
 */
async function repoExists(owner, repo, execImpl = exec) {
  try {
    await execImpl({
      args: ['repo', 'view', `${owner}/${repo}`, '--json', 'name'],
    });
    return true;
  } catch (err) {
    if (err instanceof GhNotFoundError) return false;
    return true;
  }
}

/**
 * Link the repo to the Projects V2 board (`gh project link`) so issues and
 * PRs from the repo surface on the project. Runs whenever both a numeric
 * project number and a repo are resolved — a freshly created project or an
 * existing one picked from the list. Non-fatal and re-run-safe: an
 * already-linked repo or a transient hiccup is downgraded to a warning so it
 * never fails the bootstrap.
 */
async function ensureProjectLinked(state, execImpl = exec) {
  const { owner, repo } = state.answers;
  const pn = String(state.answers.projectNumber ?? '');
  if (!/^\d+$/.test(pn) || !repo) return;
  try {
    await execImpl({
      args: ['project', 'link', pn, '--owner', owner, '--repo', repo],
    });
    Logger.info(
      `[bootstrap] Linked repo ${owner}/${repo} to Project V2 #${pn}.`,
    );
  } catch (err) {
    Logger.warn(
      `[bootstrap] Could not link repo ${owner}/${repo} to Project V2 #${pn} (continuing): ${err.message}`,
    );
  }
}

/** Visibilities `gh repo create` accepts; each maps to a `--<v>` flag. */
export const REPO_VISIBILITIES = Object.freeze([
  'private',
  'public',
  'internal',
]);

/**
 * Resolve the new-repo visibility from `--visibility` (default `private`).
 * Case-insensitive. Returns `null` for an unrecognized value so the caller
 * can reject it with a clear message instead of silently defaulting.
 */
export function resolveRepoVisibility(flags = {}) {
  const raw = flags.visibility;
  if (typeof raw !== 'string' || raw.length === 0) return 'private';
  const value = raw.trim().toLowerCase();
  return REPO_VISIBILITIES.includes(value) ? value : null;
}

/**
 * Create the GitHub repo from the resolved owner/repo. `--source` links the
 * existing local repo, `--remote origin` wires the remote, and `--push`
 * uploads the current branch — so the local tree and the new remote stay in
 * lockstep and Step 1's auto-detection works on a re-run. Visibility comes
 * from `--visibility` (default private). Throws GhExecError on failure
 * (surfaced by the caller).
 */
async function createGithubRepo(state, execImpl = exec) {
  const { owner, repo } = state.answers;
  const slug = `${owner}/${repo}`;
  const visibility = resolveRepoVisibility(state.flags);
  await execImpl({
    args: [
      'repo',
      'create',
      slug,
      `--${visibility}`,
      '--source',
      state.projectRoot,
      '--remote',
      'origin',
      '--push',
    ],
  });
  Logger.info(
    `[bootstrap] Created GitHub repo ${slug} (${visibility}) and pushed.`,
  );
}

/**
 * Create a Projects V2 board from the typed name and rewrite
 * `state.answers.projectNumber` to the assigned numeric id so the downstream
 * persist + GitHub bootstrap steps treat it as an existing project (and never
 * create a duplicate). Throws on failure or when gh returns no number.
 */
async function createGithubProject(state, execImpl = exec) {
  const { owner } = state.answers;
  const title = String(state.answers.projectNumber);
  // `gh project create` uses `--format json` (not `--json`), so exec returns
  // the raw `{ stdout }` envelope — parse the number ourselves.
  const res = await execImpl({
    args: [
      'project',
      'create',
      '--owner',
      owner,
      '--title',
      title,
      '--format',
      'json',
    ],
  });
  let number = null;
  try {
    number = JSON.parse(res.stdout)?.number ?? null;
  } catch {
    /* fall through to the guard below */
  }
  if (!Number.isInteger(number)) {
    throw new Error(
      `gh project create returned no numeric project number (stdout: ${res.stdout?.trim() ?? ''})`,
    );
  }
  state.answers.projectNumber = String(number);
  Logger.info(`[bootstrap] Created GitHub Project V2 "${title}" (#${number}).`);
  return number;
}

// ---------------------------------------------------------------------------
// Question list (Step 3).
// ---------------------------------------------------------------------------

/**
 * Build the Step 3 question list. `silentAccept` keys (owner/repo/baseBranch/
 * operatorHandle) are git-inferred and accepted without prompting unless an
 * override is supplied. The `operatorHandle` and `projectNumber` defaults
 * track the repo owner / repo name respectively (see post-processing in
 * `collectAndConfirm`).
 */
export function buildQuestions(defaults, flags, env = process.env, lists = {}) {
  const owner = resolveOwnerForPicker(defaults, flags, env);
  // Pre-fetched lists (shared with the summary display) are a fast path used
  // only when populated. They're empty when the owner is unknown up front
  // (a folder with no git remote), so the pickers fall back to a live fetch
  // keyed off the owner the operator just typed (`answers.owner`).
  const reposList = lists.reposList;
  const projectsList = lists.projectsList;
  const pickerOwner = (answers) => answers?.owner || owner;
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
        list: (answers) => {
          if (Array.isArray(reposList) && reposList.length > 0)
            return reposList;
          const o = pickerOwner(answers);
          return o ? listRepos({ owner: o }).map(bareRepoName) : [];
        },
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
        list: (answers) => {
          if (Array.isArray(projectsList) && projectsList.length > 0) {
            return projectsList;
          }
          const o = pickerOwner(answers);
          return o ? listProjects({ owner: o }) : [];
        },
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
export function resolveSilentAccept(defaults, flags, env = process.env) {
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
    // Real consent signal threaded from `parseAndValidate` (Story #3897):
    // interactive operator confirmation, `--assume-yes`, or
    // `--approve-github-admin`. Default-deny at the boundary gate when absent.
    githubAdminApproved: opts.githubAdminApproved === true,
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
 * Step 1 — Parse argv, handle `--help`, and enforce the non-TTY contract.
 *
 * Consent contract (Story #3897). A non-TTY run has no operator to confirm
 * the summary loop in `collectAndConfirm`, so the irreversible GitHub-admin
 * mutations cannot ride on a real confirmation — they need an explicit
 * up-front signal. The gate therefore requires **either** `--assume-yes`
 * **or** `--approve-github-admin` on any non-TTY run (matching the
 * `--help` text), and computes `githubAdminApproved` once for the whole run:
 *
 *   - **interactive (TTY)** → consent is the operator's `Is this correct?`
 *     confirmation in `collectAndConfirm`, so the run is approved.
 *   - **non-TTY** → consent is `--assume-yes` or `--approve-github-admin`;
 *     without one of those the run halts before any mutation.
 *
 * `githubAdminApproved` flows down to `runGithubBootstrap`, which forwards it
 * to the boundary gate in `agents-bootstrap-github.js#runBootstrap`. That
 * gate is default-deny, so a non-approved value makes the GitHub-admin phase
 * a verified no-op instead of a silent mutation.
 */
export function parseAndValidate(argv, opts = {}) {
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
  const approveGithubAdmin = Boolean(flags['approve-github-admin']);
  // A non-TTY run cannot collect operator consent interactively, so it MUST
  // carry an explicit consent signal. This restores parity with the --help
  // text, which has always claimed --assume-yes is required for non-TTY runs.
  if (!interactive && !assumeYes && !approveGithubAdmin) {
    Logger.error(
      '[bootstrap] non-TTY run requires --assume-yes or --approve-github-admin ' +
        '(no operator is present to confirm the GitHub-admin mutations).',
    );
    return { ok: false, exit: 1 };
  }
  if (!interactive) {
    const required = ['owner', 'repo'];
    const missing = required.filter(
      (k) =>
        typeof flags[k] !== 'string' &&
        typeof env[`GH_${k.toUpperCase()}`] !== 'string',
    );
    if (missing.length > 0) {
      Logger.error(
        `[bootstrap] non-TTY run requires --owner and --repo (or GH_OWNER / GH_REPO). Missing: ${missing.join(', ')}`,
      );
      return { ok: false, exit: 1 };
    }
  }
  // Real GitHub-admin consent: an interactive run confirms it in
  // `collectAndConfirm`; a non-TTY run signals it via flag (above).
  const githubAdminApproved = interactive || assumeYes || approveGithubAdmin;
  if (resolveRepoVisibility(flags) === null) {
    Logger.error(
      `[bootstrap] invalid --visibility "${flags.visibility}". ` +
        `Expected one of: ${REPO_VISIBILITIES.join(', ')}.`,
    );
    return { ok: false, exit: 1 };
  }
  return {
    ok: true,
    payload: { flags, interactive, assumeYes, githubAdminApproved },
  };
}

/**
 * Step 1b — Resolve paths, infer defaults from git, and echo the detected
 * values back to the operator (the "share found values" requirement).
 */
export function prepareContext(state, opts = {}) {
  const scriptUrl = opts.scriptUrl ?? import.meta.url;
  const here = path.dirname(fileURLToPath(scriptUrl));
  const projectRoot = opts.projectRoot ?? process.cwd();
  const agentRoot = path.resolve(here, '..');
  const defaults = inferDefaults(projectRoot);
  const silentAccept = resolveSilentAccept(defaults, state.flags);

  Logger.info('[bootstrap] Detected from local git:');
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
        `[bootstrap] ✓ ${check.name}${check.detail ? ` — ${check.detail}` : ''}`,
      );
    } else {
      Logger.error(`[bootstrap] ✗ ${check.name}: ${check.remedy}`);
    }
  }

  if (!result.ok) {
    Logger.error(
      '[bootstrap] Preflight failed. Resolve the issues above and re-run.',
    );
    return { ok: false, exit: 1 };
  }

  Logger.info(
    `[bootstrap] git initialized: ${result.gitInitialized ? 'yes' : 'no'}`,
  );
  return {
    ok: true,
    payload: { preflight: result, gitInitialized: result.gitInitialized },
  };
}

/** Render the resolved answers as a human-readable summary block. */
function renderAnswerSummary(
  answers,
  creation,
  project,
  gitInitialized,
  visibility,
) {
  const newRepoNote = creation.newRepo
    ? `  (NEW — will be created, ${visibility})`
    : '';
  const lines = [
    '\n=== Review your answers ===',
    `  Repo owner       ${answers.owner}`,
    `  Username/handle  ${answers.operatorHandle || '(none)'}`,
    `  Repo name        ${answers.repo}${newRepoNote}`,
    `  Base branch      ${answers.baseBranch}`,
    `  Project V2 name  ${project.name}${creation.newProject ? '  (NEW — will be created)' : ''}`,
    `  Project V2 #     ${project.number}`,
    `  Local git        ${gitInitialized ? 'initialized' : 'will be initialized'}`,
  ];
  return lines.join('\n');
}

/**
 * Determine whether the answers ask for resources that do not exist yet.
 * The repo is "new" when `gh repo view owner/repo` reports it does not
 * exist — an authoritative per-repo probe rather than an "is it in the
 * repo-list?" check, which mis-fired for a brand-new account whose
 * `gh repo list` is empty (it then assumed the repo already existed and
 * skipped creation). A non-numeric project answer (a typed name, not a
 * picked number) is "new". When GitHub is skipped there is nothing to
 * create, so detection is bypassed.
 */
async function detectCreation(answers, skipGithub) {
  const creation = { newRepo: false, newProject: false };
  if (skipGithub) return creation;
  if (answers.repo && answers.owner) {
    creation.newRepo = !(await repoExists(answers.owner, answers.repo));
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
function resolveProjectDisplay(answers, skipGithub, projectsList) {
  const pn = answers.projectNumber;
  if (!pn) return { name: '(skip)', number: '(skip)' };
  if (/^\d+$/.test(pn)) {
    let name = '(unknown)';
    if (!skipGithub) {
      const projects =
        projectsList ?? safeList(() => listProjects({ owner: answers.owner }));
      const match = projects.find((p) => p.value === pn);
      if (match) {
        const m = /^(.*)\s+\(#\d+\)$/.exec(match.label);
        name = m ? m[1] : match.label;
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
  const skipGithub = Boolean(state.flags['skip-github']);
  const owner = resolveOwnerForPicker(state.defaults, state.flags);
  // Fetch the owner's repos + projects ONCE and reuse for the pickers and
  // the summary display — so the resolved project name never depends on a
  // second (flaky) `gh` call. (Repo existence for the creation check is a
  // separate, authoritative `gh repo view` probe in `detectCreation`.)
  const reposList =
    !skipGithub && owner
      ? safeList(() => listRepos({ owner }).map(bareRepoName))
      : [];
  const projectsList =
    !skipGithub && owner ? safeList(() => listProjects({ owner })) : [];

  let silentAccept = state.silentAccept;
  // Loop until the operator confirms the summary (or we auto-accept).
  for (;;) {
    const { answers, missing } = await collectAnswers({
      questions: buildQuestions(state.defaults, state.flags, process.env, {
        reposList,
        projectsList,
      }),
      flags: state.flags,
      interactive: state.interactive,
      assumeYes: state.assumeYes,
      silentAccept,
    });
    if (missing.length > 0) {
      Logger.error(
        `[bootstrap] missing required answers: ${missing.join(', ')}`,
      );
      return { ok: false, exit: 1 };
    }
    // Defaults that track another answer: handle ⇐ owner, project ⇐ repo.
    if (!answers.operatorHandle) answers.operatorHandle = answers.owner;
    // Strip a single leading `@` so the starter template's `@[USERNAME]`
    // substitution yields `@foo`, not `@@foo` (Story #3700). The flag/env
    // paths bypass the interactive validator that already rejects a leading
    // `@`, so normalize uniformly here.
    answers.operatorHandle = normalizeHandleAnswer(answers.operatorHandle);

    const creation = await detectCreation(answers, skipGithub);
    const project = resolveProjectDisplay(answers, skipGithub, projectsList);
    Logger.info(
      renderAnswerSummary(
        answers,
        creation,
        project,
        state.gitInitialized,
        resolveRepoVisibility(state.flags),
      ),
    );
    const correct = await confirmYesNo('Is this correct?', state.interactive);
    if (!correct) {
      Logger.info('[bootstrap] Okay — let’s try again.');
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
          '[bootstrap] Creation declined — cannot continue without the repo/project. Exiting.',
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
    `  git init         ${state.gitInitialized ? 'no' : 'yes'}`,
    `  new repo         ${c.newRepo ? `yes (${resolveRepoVisibility(state.flags)})` : 'no'}`,
    `  new project      ${c.newProject ? 'yes' : 'no'}`,
    '',
    'Flags',
    `  ${flagList.length ? flagList.join(', ') : '(none)'}`,
  ].join('\n');
}

export function dryRunPlan(state) {
  if (!state.flags['dry-run']) return { ok: true, payload: {} };
  Logger.info(
    '[bootstrap] --dry-run: no files, GitHub settings, or labels will be changed.',
  );
  Logger.info(renderDryRunPlan(state));
  return { ok: false, exit: 0 };
}

/**
 * Step 5 — Provision the missing pieces of a cold start, in dependency order:
 *
 *   1. Local git — `git init` + an initial commit when the folder is not a
 *      repo yet (so the repo create below has something to push).
 *   2. GitHub repo — `gh repo create --source --remote --push` when the repo
 *      does not exist for the owner; otherwise wire the `origin` remote to the
 *      existing repo when the local folder is not yet linked. Either way the
 *      GitHub bootstrap can resolve the target from the local remote.
 *   3. GitHub Project V2 — `gh project create` from the typed name when the
 *      project answer is a name rather than an existing number; the assigned
 *      number is written back onto `state.answers.projectNumber`.
 *   4. Link — `gh project link` ties the repo to the project board so its
 *      issues/PRs surface there (non-fatal; safe to re-run).
 *
 * Every action is idempotent and guarded by the detection done in
 * `collectAndConfirm`, so a re-run on an already-provisioned project is a
 * no-op. `--skip-github` suppresses the GitHub mutations but still runs the
 * local git init. `--dry-run` never reaches this step (it halts earlier).
 *
 * `deps.exec` injects the `gh-exec` seam so the GitHub-touching branches
 * (`gh repo create`, `gh project create`, `gh project link`) are unit-testable
 * without spawning a real `gh`; it defaults to the module's `exec`.
 */
export async function provisionResources(state, deps = {}) {
  const execImpl = deps.exec ?? exec;
  const skipGithub = Boolean(state.flags['skip-github']);

  // 1. Local git — initialize + first commit when missing (idempotent).
  const git = ensureGitInitialized(state);
  if (!git.ok) {
    Logger.error(`[bootstrap] git initialization failed: ${git.error}`);
    return { ok: false, exit: 1 };
  }
  if (!git.initialized && !git.committed) {
    Logger.info('[bootstrap] git already initialized — leaving as-is.');
  }

  const { newRepo, newProject } = state.creation;
  if (skipGithub) {
    if (newRepo || newProject) {
      Logger.info(
        '[bootstrap] --skip-github set; not creating the GitHub repo/project.',
      );
    }
    return { ok: true, payload: {} };
  }

  // 2. GitHub repo — create + link + push when it does not exist yet;
  //    otherwise ensure the local `origin` remote points at the existing repo
  //    so the GitHub bootstrap can resolve the target (idempotent re-runs and
  //    pre-created repos would otherwise leave the folder unlinked).
  if (newRepo) {
    try {
      await createGithubRepo(state, execImpl);
    } catch (err) {
      logGhError('repo create', err);
      return { ok: false, exit: 1 };
    }
  } else {
    await ensureGitRemote(state, execImpl);
  }

  // 3. GitHub Project V2 — create from the typed name; capture its number so
  //    the persist + GitHub bootstrap steps reuse it instead of duplicating.
  if (newProject) {
    try {
      await createGithubProject(state, execImpl);
      // It now exists with a real number; downstream treats it as existing.
      state.creation.newProject = false;
    } catch (err) {
      logGhError('project create', err);
      return { ok: false, exit: 1 };
    }
  }

  if (!newRepo && !newProject) {
    Logger.info('[bootstrap] No new GitHub resources needed.');
  }

  // 4. Link the repo to the project board so issues/PRs surface on it
  //    (idempotent + non-fatal; runs for both freshly created and existing
  //    repo/project pairs).
  await ensureProjectLinked(state, execImpl);

  return { ok: true, payload: {} };
}

/**
 * Step 6a — Project-side bootstrap. With phased approval removed, all
 * project-side phase groups are treated as approved.
 */
export async function executeBootstrap(state) {
  Logger.info(
    `[bootstrap] Starting project bootstrap at ${state.projectRoot} (owner=${state.answers.owner} repo=${state.answers.repo} base=${state.answers.baseBranch})`,
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
      `[bootstrap] Could not read ${target} to store projectNumber: ${err.message}`,
    );
    return { ok: true, payload: {} };
  }
  config.github = config.github ?? {};
  // Minimal-write contract (Story #3700): only re-serialize `.agentrc.json`
  // when the stored number actually changes. When the value is already present
  // and equal, leave the file byte-for-byte untouched — a re-run must not churn
  // the consumer's hand-formatting or whitespace.
  if (config.github.projectNumber === Number(pn)) {
    return { ok: true, payload: {} };
  }
  config.github.projectNumber = Number(pn);
  fs.writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  Logger.info(`[bootstrap] Stored github.projectNumber=${pn} in .agentrc.json`);
  return { ok: true, payload: {} };
}

/** Step 6b — GitHub-side bootstrap. Honours `--skip-github`. */
export async function executeGithubBootstrap(state) {
  if (state.flags['skip-github']) {
    Logger.info('[bootstrap] --skip-github set; skipping GitHub bootstrap.');
    return { ok: true, payload: {} };
  }
  try {
    state.report.github = await runGithubBootstrap(state.answers, {
      assumeYes: state.assumeYes,
      githubAdminApproved: state.githubAdminApproved === true,
      reapConflictingWorkflows: Boolean(
        state.flags['reap-conflicting-workflows'],
      ),
    });
  } catch (err) {
    // GhExecError carries the real gh stderr/stdout/exit code — surface it so
    // a generic "gh exited with code 1" is actually diagnosable.
    logGhError('GitHub bootstrap', err);
    state.report.github = { error: err.message };
  }
  return { ok: true, payload: {} };
}

/** Step 6c — Record the install ledger for a future uninstall. */
export function recordLedger(state) {
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
    (s) => provisionResources(s),
    (s) => executeBootstrap(s),
    (s) => persistProjectNumber(s),
    (s) => executeGithubBootstrap(s),
    (s) => recordLedger(s),
  ]);
  if (!result.ok) return result.exit;
  Logger.info('\n[bootstrap] Done.');
  return 0;
}

runAsCli(import.meta.url, main, {
  source: 'Bootstrap',
  propagateExitCode: true,
});

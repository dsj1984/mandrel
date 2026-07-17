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
 *   --with-quality            Opt-in: install local quality gates (pre-commit
 *                             hook + quality:preview/watch scripts). Off by
 *                             default — prompted y/N.
 *   --dry-run                 Collect info and print the plan; change nothing
 *   --with-project-board      Opt-in: provision the Projects V2 Status field
 *                             and custom fields. Off by default — the project
 *                             board object is still created when a project
 *                             name is supplied, but decoration is skipped.
 *   --with-issue-forms        Opt-in: generate .github/ISSUE_TEMPLATE/story.yml.
 *                             Off by default.
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
import {
  buildManualInstructions,
  COMMIT_SUBJECT,
  resolveStagePaths,
  stageBootstrapFiles,
} from './lib/bootstrap/commit-push.js';
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
  --with-quality            Opt-in: install local quality gates (pre-commit
                            hook + quality:preview/watch scripts).
                            (default: off — prompted y/N).
  --dry-run                 Collect info and print the plan; change nothing
  --with-project-board      Opt-in: provision the Projects V2 Status field
                            and custom fields (default: off — prompted y/N).
  --with-issue-forms        Opt-in: generate .github/ISSUE_TEMPLATE/story.yml
                            (default: off — prompted y/N).
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

/**
 * Ask a yes/no question. `defaultAnswer` controls the default when the
 * operator presses Enter without typing (true = Y/n, false = y/N). In
 * non-interactive mode the default is returned immediately.
 */
async function confirmYesNo(message, interactive, defaultAnswer = true) {
  if (!interactive) return defaultAnswer;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const hint = defaultAnswer ? '[Y/n]' : '[y/N]';
    const raw = (await rl.question(`${message} ${hint}: `))
      .trim()
      .toLowerCase();
    if (raw === '') return defaultAnswer;
    return raw === 'y' || raw === 'yes';
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
  Logger.error(`[Bootstrap] ${label} failed: ${err.message}`);
  if (err.stderr)
    Logger.error(`[Bootstrap]   gh stderr: ${String(err.stderr).trim()}`);
  if (err.stdout)
    Logger.error(`[Bootstrap]   gh stdout: ${String(err.stdout).trim()}`);
  if (Array.isArray(err.args)) {
    Logger.error(`[Bootstrap]   gh args: ${err.args.join(' ')}`);
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
      `[Bootstrap] Initialized git repo (branch ${branch}) at ${cwd}.`,
    );
  }

  // A push needs a commit; create one only when HEAD does not resolve yet.
  //
  // SECURITY (Story #3894): do NOT `git add -A` here. `.gitignore` seeding
  // (`ensureGitignore`) runs two phases later in the pipeline, so at this
  // point a cold-start folder may still contain secret-bearing files
  // (`.env`, `.mcp.json`). Staging the whole tree before any gitignore
  // exists — followed immediately by `gh repo create --push` — would push
  // those secrets to a brand-new (often public) remote with no per-file
  // consent, violating `security-baseline.md` § Secrets Management. The
  // push only needs a commit to *exist*, so we create an empty one; the
  // operator's own first content commit lands after the gitignore phase has
  // already excluded the secret-bearing paths.
  let committed = false;
  if (!runGit(['rev-parse', '--verify', 'HEAD'], cwd).ok) {
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
    Logger.info('[Bootstrap] Created initial commit.');
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
      `[Bootstrap] No 'origin' remote and ${owner}/${repo} does not exist on GitHub — skipping remote wiring.`,
    );
    return;
  }
  const url = `https://github.com/${owner}/${repo}.git`;
  const add = runGit(['remote', 'add', 'origin', url], cwd);
  if (!add.ok) {
    Logger.warn(`[Bootstrap] Could not add 'origin' remote: ${add.stderr}`);
    return;
  }
  Logger.info(`[Bootstrap] Wired 'origin' → ${url}.`);
  const push = runGit(['push', '-u', 'origin', branch], cwd);
  if (!push.ok) {
    Logger.warn(
      `[Bootstrap] 'origin' is set but push of '${branch}' failed (resolve manually, e.g. \`git pull --rebase origin ${branch}\`): ${push.stderr}`,
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
      `[Bootstrap] Linked repo ${owner}/${repo} to Project V2 #${pn}.`,
    );
  } catch (err) {
    Logger.warn(
      `[Bootstrap] Could not link repo ${owner}/${repo} to Project V2 #${pn} (continuing): ${err.message}`,
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
    `[Bootstrap] Created GitHub repo ${slug} (${visibility}) and pushed.`,
  );
}

/**
 * Find an existing Projects V2 board owned by `owner` whose title matches
 * `title` exactly (case-insensitive, trimmed), returning its numeric id or
 * `null` when none matches. Lists through the injected `execImpl` seam (the
 * same `gh project list --owner X --format json` shape `gh-list` parses) so
 * the dedupe is unit-testable without spawning a real `gh`. Any non-zero
 * exit, spawn error, or unparseable payload degrades to `null` (no match) so
 * a transient list failure never blocks creation.
 *
 * @param {string} owner
 * @param {string} title
 * @param {typeof exec} execImpl
 * @returns {Promise<number|null>}
 */
async function findExistingProjectNumber(owner, title, execImpl) {
  const wanted = title.trim().toLowerCase();
  if (wanted.length === 0) return null;
  let res;
  try {
    res = await execImpl({
      args: ['project', 'list', '--owner', owner, '--format', 'json'],
    });
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(res?.stdout ?? '');
  } catch {
    return null;
  }
  const projects = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.projects)
      ? parsed.projects
      : [];
  for (const item of projects) {
    if (!item || typeof item !== 'object') continue;
    if (!Number.isInteger(item.number)) continue;
    const itemTitle =
      typeof item.title === 'string' ? item.title.trim().toLowerCase() : '';
    if (itemTitle === wanted) return item.number;
  }
  return null;
}

/**
 * Resolve the typed Projects V2 name into a numeric id and rewrite
 * `state.answers.projectNumber` so the downstream persist + GitHub bootstrap
 * steps treat it as an existing project (and never create a duplicate). Before
 * creating, it **dedupes against the owner's existing project titles**: if a
 * board with the same title already exists, that board is adopted instead of
 * running `gh project create` — so a re-run that re-types the same name never
 * spawns a second same-titled board (Story #3896 / review Finding B.3). Throws
 * on create failure or when gh returns no number.
 */
async function createGithubProject(state, execImpl = exec) {
  const { owner } = state.answers;
  const title = String(state.answers.projectNumber);
  const existing = await findExistingProjectNumber(owner, title, execImpl);
  if (Number.isInteger(existing)) {
    state.answers.projectNumber = String(existing);
    Logger.info(
      `[Bootstrap] Reusing existing GitHub Project V2 "${title}" (#${existing}) — no duplicate created.`,
    );
    return existing;
  }
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
  Logger.info(`[Bootstrap] Created GitHub Project V2 "${title}" (#${number}).`);
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
  // `owner` / `repo` are GitHub-side answers. When `--skip-github` suppresses
  // the entire GitHub bootstrap, they are not required — this lets a
  // non-interactive `--assume-yes --skip-github` run materialize and configure
  // a fresh non-git directory (no inferable remote) without hard-failing on
  // `missing required answers: owner, repo`. With GitHub bootstrap active they
  // remain required (the target repo must be resolvable).
  const skipGithub = Boolean(flags?.['skip-github']);
  return [
    {
      key: 'owner',
      flag: 'owner',
      env: 'GH_OWNER',
      message: '\n\nGitHub repo owner',
      default: defaults.owner,
      required: !skipGithub,
      validate: (v) =>
        /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(v) ? null : 'Invalid GitHub owner',
    },
    {
      key: 'operatorHandle',
      flag: 'operator-handle',
      env: 'GH_OPERATOR_HANDLE',
      message:
        'GitHub username/handle without preceding@ (default: same as owner)',
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
      message: 'New GitHub repo name',
      pickerMessage:
        'GitHub repo name  - Select existing or press ENTER to create',
      default: defaults.repo,
      required: !skipGithub,
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
      message: 'New GitHub Project V2 name',
      pickerMessage:
        'GitHub Project V2 name  - Select existing or press ENTER to create',
      // Prefer the already-stored numeric project number (an
      // already-provisioned project on a re-run) so `--assume-yes` resolves a
      // numeric answer that `detectCreation` treats as existing — never a
      // duplicate board (Story #3896). Falls back to the repo name only on a
      // genuine first run where nothing is stored yet.
      default: defaults.projectNumber || defaults.repo,
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
    // Opt-in: provision Status field + custom fields on the project board.
    // Default off — prompted y/N during collect/confirm or via --with-project-board.
    withProjectBoard: opts.withProjectBoard === true,
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
  // (owner/repo are resolved from flags/env/git-remote downstream — a consent
  // signal alone is sufficient to advance, exactly as the pre-Story #3897
  // `--assume-yes` path did.)
  if (!interactive && !assumeYes && !approveGithubAdmin) {
    Logger.error(
      '[Bootstrap] non-TTY run requires --assume-yes or --approve-github-admin ' +
        '(no operator is present to confirm the GitHub-admin mutations).',
    );
    return { ok: false, exit: 1 };
  }
  // Real GitHub-admin consent: an interactive run confirms it in
  // `collectAndConfirm`; a non-TTY run signals it via flag (above).
  const githubAdminApproved = interactive || assumeYes || approveGithubAdmin;
  if (resolveRepoVisibility(flags) === null) {
    Logger.error(
      `[Bootstrap] invalid --visibility "${flags.visibility}". ` +
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

  Logger.info('[\n');
  Logger.info('[Bootstrap] Checking existing GitHub values:');
  Logger.info(`  GitHub Repo Owner  ${defaults.owner ?? '(unknown)'}`);
  Logger.info(`  GitHub Repo Name   ${defaults.repo ?? '(unknown)'}`);
  Logger.info(`  Base Branch        ${defaults.baseBranch ?? '(unknown)'}`);
  Logger.info(`  GitHub Username    ${defaults.operatorHandle ?? '(unknown)'}`);

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
      // A non-fatal informational check (it carries `gitInitialized`) shows a
      // glyph reflecting the real state rather than its always-true gate pass:
      // ✓ when the git repo exists, ✗ when it does not (bootstrap initialises
      // it in a later phase regardless — the ✗ never aborts the run).
      const glyph =
        typeof check.gitInitialized === 'boolean' && !check.gitInitialized
          ? '✗'
          : '✓';
      Logger.info(
        `[Bootstrap] ${glyph} ${check.name}${check.detail ? ` — ${check.detail}` : ''}`,
      );
    } else {
      Logger.error(`[Bootstrap] ✗ ${check.name}: ${check.remedy}`);
    }
  }

  if (!result.ok) {
    Logger.error(
      '[Bootstrap] Preflight failed. Resolve the issues above and re-run.',
    );
    return { ok: false, exit: 1 };
  }

  // The git-repo state is already reported by the (non-fatal) "Local git
  // initialized" check above — both derive from the same
  // `git rev-parse --is-inside-work-tree` probe — so there is no separate
  // "git initialized" line here (it would duplicate, and contradict, that
  // check). The boolean is still threaded through the payload for later phases.
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
    ? `  will be created as ${visibility}`
    : '';
  const lines = [
    '=== Review choices ===',
    `  Repo owner       ${answers.owner}`,
    `  Username/handle  ${answers.operatorHandle || '(none)'}`,
    `  Repo name        ${answers.repo}${newRepoNote}`,
    `  Base branch      ${answers.baseBranch}`,
    `  Project V2 name  ${project.name}${creation.newProject ? '  will be created' : ''}`,
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
        `[Bootstrap] missing required answers: ${missing.join(', ')}. ` +
          'Pass them as flags (e.g. `--owner <name> --repo <name>`), or run ' +
          'with `--skip-github` to configure the files/local setup only and ' +
          'wire GitHub later.',
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
      Logger.info('[Bootstrap] Okay — let’s try again.');
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
          '[Bootstrap] Creation declined — cannot continue without the repo/project. Exiting.',
        );
        return { ok: false, exit: 1 };
      }
    }

    // Opt-in: board decoration (Status field, custom fields). Default off.
    // Dry-run halts immediately after this step — resolve without prompting.
    let withProjectBoard = Boolean(state.flags['with-project-board']);
    if (!state.flags['dry-run'] && !withProjectBoard) {
      withProjectBoard = await confirmYesNo(
        'Set up project board fields (Status, custom)?',
        state.interactive,
        false,
      );
    }

    // Opt-in: GitHub Issue Form templates. Default off.
    let withIssueForms = Boolean(state.flags['with-issue-forms']);
    if (!state.flags['dry-run'] && !withIssueForms) {
      withIssueForms = await confirmYesNo(
        'Generate GitHub Issue Form templates?',
        state.interactive,
        false,
      );
    }

    // Opt-in: local quality gates. Default off.
    let withQuality = Boolean(state.flags['with-quality']);
    if (!state.flags['dry-run'] && !withQuality) {
      withQuality = await confirmYesNo(
        'Install local quality gates (pre-commit hook + quality:preview/watch scripts)?',
        state.interactive,
        false,
      );
    }

    return {
      ok: true,
      payload: {
        answers,
        creation,
        withProjectBoard,
        withIssueForms,
        withQuality,
      },
    };
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
    '[Bootstrap] --dry-run: no files, GitHub settings, or labels will be changed.',
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
    Logger.error(`[Bootstrap] git initialization failed: ${git.error}`);
    return { ok: false, exit: 1 };
  }
  if (!git.initialized && !git.committed) {
    Logger.info('[Bootstrap] git already initialized — leaving as-is.');
  }

  const { newRepo, newProject } = state.creation;
  if (skipGithub) {
    if (newRepo || newProject) {
      Logger.info(
        '[Bootstrap] --skip-github set; not creating the GitHub repo/project.',
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
    Logger.info('[Bootstrap] No new GitHub resources needed.');
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
    `[Bootstrap] Starting project bootstrap at ${state.projectRoot} (owner=${state.answers.owner} repo=${state.answers.repo} base=${state.answers.baseBranch})`,
  );
  const approvedGroups = new Set(Object.values(PHASE_GROUPS));
  const report = await applyProjectBootstrap({
    projectRoot: state.projectRoot,
    agentRoot: state.agentRoot,
    answers: state.answers,
    approvedGroups,
    withQuality: state.withQuality === true,
    withIssueForms: state.withIssueForms === true,
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
      `[Bootstrap] Could not read ${target} to store projectNumber: ${err.message}`,
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
  Logger.info(`[Bootstrap] Stored github.projectNumber=${pn} in .agentrc.json`);
  return { ok: true, payload: {} };
}

/** Step 6b — GitHub-side bootstrap. Honours `--skip-github`. */
export async function executeGithubBootstrap(state) {
  if (state.flags['skip-github']) {
    Logger.info('[Bootstrap] --skip-github set; skipping GitHub bootstrap.');
    return { ok: true, payload: {} };
  }
  try {
    state.report.github = await runGithubBootstrap(state.answers, {
      assumeYes: state.assumeYes,
      githubAdminApproved: state.githubAdminApproved === true,
      withProjectBoard: state.withProjectBoard === true,
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
    withQuality: state.withQuality === true,
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
    // The live execution report lets the ledger record `already-present` vs
    // `seeded` per entry, so uninstall never deletes a pre-existing
    // `.agentrc.json` the install merely left in place (Story #3895).
    report: state.report,
  });
  const result = writeInstallLedger(state.projectRoot, record);
  state.report.ledger = { ...result, approvedGroups: [...appliedGroups] };
  return { ok: true, payload: {} };
}

/**
 * Step 7 — Offer to commit + push the bootstrap wiring (Story #3899).
 *
 * Story delivery runs in git worktrees that check out **tracked files only**,
 * so an uncommitted `.agents/` tree means every Story sub-agent breaks. This
 * step closes that "worked in my checkout, broke in delivery" trap by offering
 * the commit + push at the end of the run.
 *
 * Ordering: this phase runs LAST in the pipeline, after `executeBootstrap`
 * (which seeds the secret-safe `.gitignore`) and `recordLedger`. The stage
 * step also uses an explicit allowlist and refuses to stage `.env` /
 * `.mcp.json` / `.agentrc.local.json` regardless of `.gitignore` state, so the
 * commit never carries a secret even before the gitignore-ordering Story
 * (#3894) lands.
 *
 * Behaviour:
 *   - `--dry-run` → no-op (the dry-run gate already halted earlier; this is a
 *     belt-and-braces guard for direct calls).
 *   - Interactive + accept → stage the allowlist, commit with a conventional
 *     subject, push the base branch.
 *   - Interactive + decline → print the exact manual commands; no git mutation.
 *   - Non-interactive (`--assume-yes` / no TTY) → the defined safe path is to
 *     print the manual commands and make NO git mutation, so a CI run never
 *     surprises the operator with a push it did not ask for.
 *
 * `deps.runGit` injects the git seam and `deps.confirm` the yes/no prompt seam
 * for unit testing; both default to the module's implementations.
 */
export async function offerCommitPush(state, deps = {}) {
  if (state.flags['dry-run']) return { ok: true, payload: {} };
  const runGitImpl = deps.runGit ?? runGit;
  const confirmImpl = deps.confirm ?? confirmYesNo;
  const cwd = state.projectRoot;
  const branch = state.answers.baseBranch || 'main';
  const stagePaths = resolveStagePaths(cwd);
  const instructions = buildManualInstructions({
    stagePaths,
    baseBranch: branch,
  });

  // Non-interactive (--assume-yes / no TTY): never push unprompted. Print the
  // exact commands and leave the working tree untouched.
  if (!state.interactive) {
    Logger.info(`\n[Bootstrap] ${instructions}`);
    return { ok: true, payload: { commitPush: { action: 'instructed' } } };
  }

  const accepted = await confirmImpl(
    'Commit and push the Mandrel setup?',
    state.interactive,
  );
  if (!accepted) {
    Logger.info(`\n[Bootstrap] ${instructions}`);
    return { ok: true, payload: { commitPush: { action: 'declined' } } };
  }

  const staged = stageBootstrapFiles({ projectRoot: cwd, runGit: runGitImpl });
  if (!staged.ok) {
    Logger.warn(`[Bootstrap] Could not stage the wiring: ${staged.error}`);
    Logger.info(`\n[Bootstrap] ${instructions}`);
    return { ok: true, payload: { commitPush: { action: 'stage-failed' } } };
  }
  const commit = runGitImpl(
    [...gitIdentityArgs(cwd, state.answers), 'commit', '-m', COMMIT_SUBJECT],
    cwd,
  );
  if (!commit.ok) {
    // A "nothing to commit" exit is benign — the wiring is already committed.
    Logger.warn(
      `[Bootstrap] git commit did not create a commit (already committed?): ${commit.stderr || commit.stdout}`,
    );
    Logger.info(`\n[Bootstrap] ${instructions}`);
    return { ok: true, payload: { commitPush: { action: 'commit-skipped' } } };
  }
  Logger.info('[Bootstrap] Committed the Mandrel wiring.');
  const push = runGitImpl(['push', '-u', 'origin', branch], cwd);
  if (!push.ok) {
    Logger.warn(
      `[Bootstrap] Commit landed but push of '${branch}' failed (push it manually with \`git push -u origin ${branch}\`): ${push.stderr}`,
    );
    return { ok: true, payload: { commitPush: { action: 'push-failed' } } };
  }
  Logger.info(`[Bootstrap] Pushed '${branch}' to origin.`);
  return { ok: true, payload: { commitPush: { action: 'committed-pushed' } } };
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

export async function main(argv = process.argv.slice(2), deps = {}) {
  // `deps.phases` lets tests inject a substitute pipeline so the
  // post-pipeline GitHub-failure detection can be exercised
  // deterministically without spawning `gh` (Story #3898).
  const phases = deps.phases ?? [
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
    (s) => offerCommitPush(s),
  ];
  const result = await runPipeline(phases);
  if (!result.ok) return result.exit;

  // GitHub-side bootstrap failures are non-fatal to the pipeline (so the
  // ledger still records the project-side mutations that already landed —
  // the failure is surfaced, not silently rolled back), but they MUST NOT
  // exit 0. `executeGithubBootstrap` records `report.github.error` instead
  // of throwing; detect it here and exit non-zero with a distinct final
  // status line so `mandrel init` and CI see the failure (Story #3898).
  const githubError = result.state?.report?.github?.error;
  if (githubError) {
    Logger.error(
      `\n[Bootstrap] GitHub bootstrap failed: ${githubError}. ` +
        'Project-side setup (labels are GitHub-side; the local .agentrc.json / ' +
        'quality-gate / workflow files that were applied are recorded in the ' +
        'install ledger) completed, but the GitHub label/board/protection ' +
        'setup did not. Resolve the cause above (commonly `gh auth login` or a ' +
        'missing repo/project scope) and re-run `mandrel bootstrap` — the run is ' +
        'idempotent and will skip what already succeeded.',
    );
    return 1;
  }

  Logger.info('\n[Bootstrap] Done.');
  return 0;
}

runAsCli(import.meta.url, main, {
  source: 'Bootstrap',
  propagateExitCode: true,
});

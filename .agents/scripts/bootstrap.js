#!/usr/bin/env node
/**
 * bootstrap.js — single-command consumer setup for Mandrel (flags: see HELP).
 * Works on a folder that is not yet a git repo, and provisions the missing
 * pieces of a cold start: local repo, GitHub repo, Projects V2 board.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { stageLegacyEntryDocRemoval } from './lib/bootstrap/agents-md-fold.js';
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

function bareRepoName(slug) {
  const slash = slug.indexOf('/');
  return slash === -1 ? slug : slug.slice(slash + 1);
}

/**
 * Strip one leading `@`: the starter template's `@[USERNAME]` would otherwise
 * seed `@@foo`, and the flag/env paths bypass the interactive validator.
 *
 * @param {string|undefined|null} handle
 * @returns {string|undefined|null} the input with a single leading `@` removed
 */
export function normalizeHandleAnswer(handle) {
  if (typeof handle !== 'string') return handle;
  return handle.replace(/^@/, '');
}

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

/** Yes/no prompt; non-interactive returns `defaultAnswer`. */
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

/** Run git in `cwd` → `{ ok, status, stdout, stderr, error }`. */
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

/** Log a `GhExecError` with its gh stderr/stdout/args so it is diagnosable. */
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
 * A non-persistent `-c` identity when `user.name`/`user.email` is unset (fresh
 * machine), so the commit succeeds without mutating the operator's config.
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
 * Idempotently init the repo and ensure a commit exists for
 * `gh repo create --push`.
 */
function ensureGitInitialized(state) {
  const cwd = state.projectRoot;
  const branch = state.answers.baseBranch || 'main';
  let initialized = false;
  if (!state.gitInitialized) {
    // `init -b` needs git ≥ 2.28; fall back to init + symbolic-ref.
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

  // SECURITY: the commit is EMPTY, never `git add -A` — `.gitignore` is seeded
  // later, so staging now would push `.env` / `.mcp.json` to the new remote.
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
 * Wire a missing `origin` to an existing GitHub repo (the GitHub bootstrap
 * infers its target from it). A rejected push only warns: the remote just
 * needs to resolve.
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
 * `gh repo view` probe: false only on not-found, so a transient error never
 * triggers a spurious create. (A repo-list check mis-fires on empty accounts.)
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

/** `gh project link` the repo to the board; non-fatal and re-run-safe. */
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

/** `--visibility` (default `private`); `null` for an unknown value. */
export function resolveRepoVisibility(flags = {}) {
  const raw = flags.visibility;
  if (typeof raw !== 'string' || raw.length === 0) return 'private';
  const value = raw.trim().toLowerCase();
  return REPO_VISIBILITIES.includes(value) ? value : null;
}

/** Create, link as `origin`, and push the repo. Throws GhExecError. */
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
 * The number of the owner's board titled `title` (case-insensitive), or
 * `null` — including on any list failure, which must not block creation.
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
 * Resolve the typed board name to a number (adopting a same-titled board so a
 * re-run never duplicates it) and write it onto `answers.projectNumber`.
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
  // `--format json` (not `--json`): exec returns raw stdout to parse.
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

/** The Step 3 question list. */
export function buildQuestions(defaults, flags, env = process.env, lists = {}) {
  const owner = resolveOwnerForPicker(defaults, flags, env);
  // Pre-fetched lists are empty when the owner was unknown up front, so the
  // pickers fall back to a live fetch keyed off the typed `answers.owner`.
  const reposList = lists.reposList;
  const projectsList = lists.projectsList;
  const pickerOwner = (answers) => answers?.owner || owner;
  // owner/repo are optional under --skip-github, so a remote-less folder can
  // still be configured non-interactively.
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
      // A stored number first, so a re-run never reads as a new board.
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
      // Blank (skip), an existing number, or a new project name.
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

async function runGithubBootstrap(answers, opts) {
  const { runBootstrap, preflightGh, preflightRuntimeDeps } = await import(
    './agents-bootstrap-github.js'
  );
  await preflightGh();
  await preflightRuntimeDeps();
  const { resolveConfig, validateOrchestrationConfig } = await import(
    './lib/config-resolver.js'
  );
  // persistProjectNumber has already written the number, so the provider
  // reuses the board instead of creating another.
  const config = resolveConfig();
  validateOrchestrationConfig(config);
  return runBootstrap(config, {
    project: config.project,
    github: config.github,
    assumeYes: opts.assumeYes,
    baseBranch: answers.baseBranch,
    // Default-deny at the boundary gate (see parseAndValidate).
    githubAdminApproved: opts.githubAdminApproved === true,
    withProjectBoard: opts.withProjectBoard === true,
    reapConflictingWorkflows: Boolean(opts.reapConflictingWorkflows),
  });
}

/** True only when every github-admin sub-mutation that ran succeeded. */
function githubSubMutationsSucceeded(gh) {
  if (gh.branchProtection?.status === 'failed') return false;
  if (gh.mergeMethods?.status === 'failed') return false;
  return true;
}

/**
 * Phase groups that landed, for the install ledger. Every project-side group
 * always runs; only GitHub-admin is variable.
 *
 * @param {object|undefined} report — the live execution report.
 * @returns {Set<string>}
 */
function resolveAppliedGroups(report) {
  const applied = new Set(Object.values(PHASE_GROUPS));
  const gh = report?.github;
  const githubApplied = Boolean(
    gh && !gh.error && !gh.skipped && githubSubMutationsSucceeded(gh),
  );
  if (!githubApplied) applied.delete(PHASE_GROUPS.GITHUB_ADMIN);
  return applied;
}

/**
 * Step 1 — parse argv and compute GitHub-admin consent once: an interactive
 * run consents via the summary confirmation; a non-TTY run MUST pass
 * `--assume-yes` or `--approve-github-admin` or halts before any mutation.
 * The downstream gate in `runBootstrap` is default-deny.
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
  if (!interactive && !assumeYes && !approveGithubAdmin) {
    Logger.error(
      '[Bootstrap] non-TTY run requires --assume-yes or --approve-github-admin ' +
        '(no operator is present to confirm the GitHub-admin mutations).',
    );
    return { ok: false, exit: 1 };
  }
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

/** Step 1b — resolve paths, infer defaults from git, and echo them. */
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

/** Step 2 — preflight; the work-tree check is informational only. */
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
      // The informational git check shows the real state; its ✗ never aborts.
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

  return {
    ok: true,
    payload: { preflight: result, gitInitialized: result.gitInitialized },
  };
}

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
 * Which answers name resources that do not exist yet: a repo `repoExists`
 * denies, or a non-numeric (typed) project answer.
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
 * `{ name, number }` for the summary; the picker stores only the number, so
 * an existing project's name is looked up.
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
  return { name: pn, number: '(new)' };
}

/**
 * Steps 3 + 4 — collect answers and loop until the summary is confirmed, then
 * get creation approval and the opt-ins.
 */
export async function collectAndConfirm(state) {
  const skipGithub = Boolean(state.flags['skip-github']);
  const owner = resolveOwnerForPicker(state.defaults, state.flags);
  // Fetched once for pickers and summary, so the name never needs a second call.
  const reposList =
    !skipGithub && owner
      ? safeList(() => listRepos({ owner }).map(bareRepoName))
      : [];
  const projectsList =
    !skipGithub && owner ? safeList(() => listProjects({ owner })) : [];

  let silentAccept = state.silentAccept;
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
    if (!answers.operatorHandle) answers.operatorHandle = answers.owner;
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
      silentAccept = [];
      continue;
    }

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

    // Opt-ins default off; dry-run resolves them without prompting.
    let withProjectBoard = Boolean(state.flags['with-project-board']);
    if (!state.flags['dry-run'] && !withProjectBoard) {
      withProjectBoard = await confirmYesNo(
        'Set up project board fields (Status, custom)?',
        state.interactive,
        false,
      );
    }

    let withIssueForms = Boolean(state.flags['with-issue-forms']);
    if (!state.flags['dry-run'] && !withIssueForms) {
      withIssueForms = await confirmYesNo(
        'Generate GitHub Issue Form templates?',
        state.interactive,
        false,
      );
    }

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

/** --dry-run gate: print the plan and halt before any mutation. */
export function dryRunPlan(state) {
  if (!state.flags['dry-run']) return { ok: true, payload: {} };
  Logger.info(
    '[Bootstrap] --dry-run: no files, GitHub settings, or labels will be changed.',
  );
  Logger.info(renderDryRunPlan(state));
  return { ok: false, exit: 0 };
}

/**
 * Step 5 — provision a cold start in dependency order: local git, GitHub repo
 * (or `origin` wiring), Projects V2 board, repo↔board link. Every step is
 * idempotent; `--skip-github` still runs the local git init.
 */
export async function provisionResources(state, deps = {}) {
  const execImpl = deps.exec ?? exec;
  const skipGithub = Boolean(state.flags['skip-github']);

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

  if (newProject) {
    try {
      await createGithubProject(state, execImpl);
      state.creation.newProject = false;
    } catch (err) {
      logGhError('project create', err);
      return { ok: false, exit: 1 };
    }
  }

  if (!newRepo && !newProject) {
    Logger.info('[Bootstrap] No new GitHub resources needed.');
  }

  await ensureProjectLinked(state, execImpl);

  return { ok: true, payload: {} };
}

/** Step 6a — project-side bootstrap (every phase runs). */
export async function executeBootstrap(state) {
  Logger.info(
    `[Bootstrap] Starting project bootstrap at ${state.projectRoot} (owner=${state.answers.owner} repo=${state.answers.repo} base=${state.answers.baseBranch})`,
  );
  const report = await applyProjectBootstrap({
    projectRoot: state.projectRoot,
    agentRoot: state.agentRoot,
    answers: state.answers,
    withQuality: state.withQuality === true,
    withIssueForms: state.withIssueForms === true,
  });
  return { ok: true, payload: { report } };
}

/**
 * Persist the numeric project number into `.agentrc.json` — after the
 * project-side bootstrap creates the file, before the GitHub bootstrap reads
 * it, so the provider reuses the board.
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
  // Unchanged → leave the file byte-for-byte (keep the consumer's formatting).
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
    logGhError('GitHub bootstrap', err);
    state.report.github = { error: err.message };
  }
  return { ok: true, payload: {} };
}

/** Step 6c — Record the install ledger for a future uninstall. */
export function recordLedger(state) {
  const appliedGroups = resolveAppliedGroups(state.report);
  const manifestCtx = {
    answers: state.answers,
    skipGithub: Boolean(state.flags['skip-github']),
    withQuality: state.withQuality === true,
  };
  const entries = buildMutationManifest(manifestCtx).filter((e) =>
    appliedGroups.has(e.phaseGroup),
  );
  const record = buildLedgerRecord({
    entries,
    approvedGroups: appliedGroups,
    answers: state.answers,
    // Records `already-present` vs `seeded`, so uninstall never deletes a
    // pre-existing `.agentrc.json`.
    report: state.report,
  });
  const result = writeInstallLedger(state.projectRoot, record);
  state.report.ledger = { ...result, approvedGroups: [...appliedGroups] };
  return { ok: true, payload: {} };
}

/**
 * Step 7 — offer to commit + push the wiring: delivery worktrees check out
 * tracked files only, so an uncommitted `.agents/` breaks every Story. Runs
 * last, after `.gitignore` is seeded; staging is an allowlist that refuses
 * secret files regardless. Non-interactive runs only print the commands —
 * never an unasked-for push.
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

  const added = stageBootstrapFiles({ projectRoot: cwd, runGit: runGitImpl });
  // The folded-away CLAUDE.md deletion rides the same commit.
  const staged = stageLegacyEntryDocRemoval({
    projectRoot: cwd,
    runGit: runGitImpl,
    after: added,
  });
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
    // Benign when the wiring is already committed.
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

  // A GitHub failure is non-fatal to the pipeline (the ledger still records
  // what landed) but MUST NOT exit 0.
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
  usage: HELP,
});

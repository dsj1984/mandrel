#!/usr/bin/env node
/**
 * bootstrap.js — single-command consumer setup for Mandrel.
 *
 * Replaces the legacy `/agents-bootstrap-project` + `/agents-bootstrap-github`
 * slash commands with one deterministic Node script (Story #2074, hard
 * cutover). Walks the operator through every required value (auto-detecting
 * what it can), applies the project-side file mutations, then runs the
 * existing GitHub-side bootstrap.
 *
 * Usage:
 *   node .agents/scripts/bootstrap.js [flags]
 *
 * Flags:
 *   --owner <name>            GitHub owner (default: parsed from origin remote)
 *   --repo <name>             GitHub repo  (default: parsed from origin remote)
 *   --operator-handle <name>  GitHub handle for `agentSettings.operatorHandle`
 *   --base-branch <name>      Base branch (default: origin/HEAD or `main`)
 *   --project-number <n>      Projects V2 number (optional)
 *   --assume-yes              Accept every default; required for non-TTY runs
 *   --skip-github             Skip the GitHub-side bootstrap entirely
 *   --skip-quality            Skip the quality-gates bootstrap (Step 7.5)
 *   --dry-run                 Print the resolved plan without mutating
 *   --help                    Print this help
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyProjectBootstrap } from './lib/bootstrap/project-bootstrap.js';
import {
  collectAnswers,
  inferDefaults,
  parseFlags,
} from './lib/bootstrap/prompt.js';
import { runAsCli } from './lib/cli-utils.js';
import { Logger } from './lib/Logger.js';

const HELP = `bootstrap.js — single-command consumer setup for Mandrel.

Usage: node .agents/scripts/bootstrap.js [flags]

Flags:
  --owner <name>            GitHub owner (default: parsed from origin remote)
  --repo <name>             GitHub repo  (default: parsed from origin remote)
  --operator-handle <name>  GitHub handle for github.operatorHandle
  --base-branch <name>      Base branch (default: origin/HEAD or 'main')
  --project-number <n>      Projects V2 number (optional)
  --assume-yes              Accept every default; required for non-TTY runs
  --skip-github             Skip the GitHub-side bootstrap entirely
  --skip-quality            Skip the quality-gates bootstrap (Step 7.5)
  --dry-run                 Print the resolved plan without mutating
  --help                    Print this help
`;

function buildQuestions(defaults) {
  return [
    {
      key: 'owner',
      flag: 'owner',
      env: 'GH_OWNER',
      message: 'GitHub owner',
      default: defaults.owner,
      required: true,
      validate: (v) =>
        /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(v) ? null : 'Invalid GitHub owner',
    },
    {
      key: 'repo',
      flag: 'repo',
      env: 'GH_REPO',
      message: 'GitHub repo',
      default: defaults.repo,
      required: true,
      validate: (v) =>
        /^[A-Za-z0-9._-]+$/.test(v) ? null : 'Invalid GitHub repo name',
    },
    {
      key: 'operatorHandle',
      flag: 'operator-handle',
      env: 'GH_OPERATOR_HANDLE',
      message: 'Operator GitHub handle (without @)',
      default: defaults.operatorHandle,
      required: false,
      validate: (v) =>
        v.length === 0 || /^[A-Za-z0-9-]+$/.test(v)
          ? null
          : 'Invalid GitHub handle',
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
      message: 'Projects V2 number (blank to skip)',
      default: null,
      required: false,
      validate: (v) =>
        v.length === 0 || /^\d+$/.test(v)
          ? null
          : 'Must be an integer or blank',
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

/**
 * Compute the set of keys whose inferred default should be accepted
 * without prompting. A key qualifies when:
 *   - `inferDefaults` produced a non-empty value for it; AND
 *   - no CLI flag was supplied for it; AND
 *   - no environment variable override was supplied for it.
 *
 * Flag / env overrides win, but they take their normal path through
 * `collectAnswers` rather than this silent-accept set, so the operator
 * still sees them logged in the per-field resolution.
 *
 * Exported for unit testing.
 */
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

function printSummary(report) {
  Logger.info('\n=== Bootstrap Summary ===');
  Logger.info(
    `  package.json           created=${report.pkg.created} sync:commands=${report.pkg.scriptsSyncCommands} prepare=${report.pkg.scriptsPrepare} deps+=${report.pkg.deps.added.length}`,
  );
  Logger.info(
    `  install                ${report.install.ran ? `ran via ${report.install.manager}` : `skipped (${report.install.reason})`}`,
  );
  Logger.info(`  .agentrc.json          ${report.agentrc.action}`);
  Logger.info(`  .claude/settings.json  ${report.claudeSettings.action}`);
  Logger.info(`  .gitignore commands    ${report.gitignore.commands}`);
  Logger.info(`  .gitignore mcp         ${report.gitignore.mcp}`);
  Logger.info(`  parity                 ${report.parity.ok ? 'OK' : 'FAIL'}`);
  if (report.quality.skipped) {
    Logger.info('  quality                skipped');
  } else {
    Logger.info(`  quality.helper         ${report.quality.helper.action}`);
    Logger.info(`  quality.hook           ${report.quality.hook.action}`);
    Logger.info(`  quality.scripts        ${report.quality.scripts.action}`);
    Logger.info(`  quality.config         ${report.quality.config.action}`);
  }
  if (report.winPerf.skipped) {
    Logger.info(
      `  windows-git-perf       skipped (${report.winPerf.platform})`,
    );
  } else {
    Logger.info(
      `  windows-git-perf       ${report.winPerf.ok ? 'OK' : 'warnings'}`,
    );
  }
  if (report.github) {
    Logger.info(
      `  github.labels          created=${report.github.labels.created.length} skipped=${report.github.labels.skipped.length}`,
    );
    Logger.info(
      `  github.project         ${report.github.project.projectNumber ?? 'skipped'}`,
    );
    Logger.info(
      `  github.branchProtection ${report.github.branchProtection.status ?? 'n/a'}`,
    );
    Logger.info(
      `  github.mergeMethods    ${report.github.mergeMethods.status ?? 'n/a'}`,
    );
  } else {
    Logger.info('  github                 skipped');
  }
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
  const config = resolveConfig();
  validateOrchestrationConfig(config.orchestration);
  return runBootstrap(config.orchestration, {
    project: config.project,
    github: config.github,
    agentSettings: config.agentSettings,
    assumeYes: opts.assumeYes,
    baseBranch: answers.baseBranch,
  });
}

// ---------------------------------------------------------------------------
// Phase helpers (Story #2459 / Task #2471)
//
// `main()` was a 75-line procedural pipeline that mixed flag parsing,
// non-TTY validation, defaults inference, answer collection, the project-
// side mutation, and the GitHub-side bootstrap into a single function
// with seven decision points. Each phase below is now a small helper that
// returns either `{ ok: true, payload? }` (the pipeline advances) or
// `{ ok: false, exit: <code> }` (the pipeline short-circuits with the
// supplied exit code). `main` becomes a five-line pipeline driver.
//
// The helpers are exported so the sibling test file can exercise each
// phase in isolation without spawning a child process.
// ---------------------------------------------------------------------------

/**
 * @typedef {object} PhaseHalt
 * @property {false} ok        — pipeline must stop here.
 * @property {number} exit     — process exit code to return.
 *
 * @typedef {object} PhaseAdvance
 * @property {true} ok         — pipeline advances to the next phase.
 * @property {object} [payload] — values the next phase needs.
 *
 * @typedef {PhaseHalt | PhaseAdvance} PhaseResult
 */

/**
 * Phase 1 — Parse argv, short-circuit on `--help`, and enforce the
 * non-TTY contract (`--assume-yes` plus `--owner`/`--repo` or their env
 * equivalents).
 *
 * Exported for tests.
 *
 * @param {string[]} argv
 * @param {object} [opts]
 * @param {NodeJS.WritableStream} [opts.stdout]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {{ isTTY?: boolean }} [opts.stdin]
 * @returns {PhaseResult}
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
  if (!interactive && !assumeYes) {
    const required = ['owner', 'repo'];
    const missing = required.filter(
      (k) =>
        typeof flags[k] !== 'string' &&
        typeof env[`GH_${k.toUpperCase()}`] !== 'string',
    );
    if (missing.length > 0) {
      Logger.error(
        `[bootstrap] non-TTY run requires --owner and --repo (or GH_OWNER / GH_REPO) and --assume-yes. Missing: ${missing.join(', ')}`,
      );
      return { ok: false, exit: 1 };
    }
  }
  return { ok: true, payload: { flags, interactive, assumeYes } };
}

/**
 * Phase 2 — Resolve project paths, infer defaults from git, and compute
 * which inferred keys can be silently accepted. Pure I/O against the
 * local filesystem (no network calls).
 *
 * @param {{ flags: Record<string, string|boolean>, interactive: boolean }} state
 * @param {{ scriptUrl?: string, projectRoot?: string }} [opts]
 * @returns {PhaseAdvance}
 */
export function prepareContext(state, opts = {}) {
  const scriptUrl = opts.scriptUrl ?? import.meta.url;
  const here = path.dirname(fileURLToPath(scriptUrl));
  const projectRoot = opts.projectRoot ?? process.cwd();
  const agentRoot = path.resolve(here, '..');
  const defaults = inferDefaults(projectRoot);
  const silentAccept = resolveSilentAccept(defaults, state.flags);
  if (state.interactive && silentAccept.length > 0) {
    const summary = silentAccept
      .map((key) => `${key}=${defaults[key]}`)
      .join(' ');
    Logger.info(`[bootstrap] Auto-detected from local git: ${summary}`);
    Logger.info(
      '[bootstrap] Override any value with --owner / --repo / --base-branch / --operator-handle.',
    );
  }
  return {
    ok: true,
    payload: { projectRoot, agentRoot, defaults, silentAccept },
  };
}

/**
 * Phase 3 — Collect answers via the `RESOLVERS` chain and bail when any
 * required answer is missing. Also short-circuits the `--dry-run` plan
 * print so the operator can preview without mutating.
 *
 * @param {{
 *   flags: Record<string, string|boolean>,
 *   interactive: boolean,
 *   assumeYes: boolean,
 *   defaults: object,
 *   silentAccept: string[],
 * }} state
 * @returns {Promise<PhaseResult>}
 */
export async function collectAndValidateAnswers(state) {
  const { answers, missing } = await collectAnswers({
    questions: buildQuestions(state.defaults),
    flags: state.flags,
    interactive: state.interactive,
    assumeYes: state.assumeYes,
    silentAccept: state.silentAccept,
  });
  if (missing.length > 0) {
    Logger.error(`[bootstrap] missing required answers: ${missing.join(', ')}`);
    return { ok: false, exit: 1 };
  }
  if (state.flags['dry-run']) {
    Logger.info('[bootstrap] dry-run plan:');
    Logger.info(
      JSON.stringify(
        { answers, defaults: state.defaults, flags: state.flags },
        null,
        2,
      ),
    );
    return { ok: false, exit: 0 };
  }
  return { ok: true, payload: { answers } };
}

/**
 * Phase 4 — Execute the project-side bootstrap and return the structured
 * report. Logs the start banner so operator-visible output is unchanged
 * from the pre-refactor inline pipeline.
 *
 * @param {{
 *   answers: object,
 *   projectRoot: string,
 *   agentRoot: string,
 *   flags: Record<string, string|boolean>,
 * }} state
 * @returns {Promise<PhaseAdvance>}
 */
export async function executeBootstrap(state) {
  Logger.info(
    `[bootstrap] Starting project bootstrap at ${state.projectRoot} (owner=${state.answers.owner} repo=${state.answers.repo} base=${state.answers.baseBranch})`,
  );
  const report = await applyProjectBootstrap({
    projectRoot: state.projectRoot,
    agentRoot: state.agentRoot,
    answers: state.answers,
    skipQuality: Boolean(state.flags['skip-quality']),
  });
  return { ok: true, payload: { report } };
}

/**
 * Phase 5 — GitHub-side bootstrap. Honours `--skip-github`; on failure
 * the error is captured on the report rather than thrown so the summary
 * still prints. Always advances the pipeline so `printSummary` runs.
 *
 * @param {{
 *   report: object,
 *   answers: object,
 *   flags: Record<string, string|boolean>,
 *   assumeYes: boolean,
 * }} state
 * @returns {Promise<PhaseAdvance>}
 */
export async function executeGithubBootstrap(state) {
  if (state.flags['skip-github']) return { ok: true, payload: {} };
  try {
    state.report.github = await runGithubBootstrap(state.answers, {
      assumeYes: state.assumeYes,
    });
  } catch (err) {
    Logger.error(`[bootstrap] GitHub bootstrap failed: ${err.message}`);
    state.report.github = { error: err.message };
  }
  return { ok: true, payload: {} };
}

/**
 * Pipeline driver — chains a sequence of phase helpers, threading the
 * accumulated state through each call. The first helper to return
 * `{ ok: false }` short-circuits and the driver returns `result.exit`.
 *
 * Exported for tests so the contract is asserted without spawning a
 * child process.
 *
 * @param {Array<(state: object) => Promise<object>|object>} phases
 * @returns {Promise<{ ok: boolean, exit?: number, state: object }>}
 */
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
    (s) => collectAndValidateAnswers(s),
    (s) => executeBootstrap(s),
    (s) => executeGithubBootstrap(s),
  ]);
  if (!result.ok) return result.exit;
  printSummary(result.state.report);
  Logger.info('\n[bootstrap] Done.');
  return 0;
}

runAsCli(import.meta.url, main, {
  source: 'Bootstrap',
  propagateExitCode: true,
});

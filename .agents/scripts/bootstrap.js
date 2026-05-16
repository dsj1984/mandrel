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

export async function main(argv = process.argv.slice(2)) {
  const flags = parseFlags(argv);
  if (flags.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = process.cwd();
  const agentRoot = path.resolve(here, '..');
  const defaults = inferDefaults(projectRoot);
  const interactive = Boolean(process.stdin.isTTY) && !flags['assume-yes'];
  const assumeYes = Boolean(flags['assume-yes']);
  if (!interactive && !assumeYes) {
    // Allow flag-only non-interactive runs only when the operator has
    // pinned every required field via flag/env.
    const required = ['owner', 'repo'];
    const missing = required.filter(
      (k) =>
        typeof flags[k] !== 'string' &&
        typeof process.env[`GH_${k.toUpperCase()}`] !== 'string',
    );
    if (missing.length > 0) {
      Logger.error(
        `[bootstrap] non-TTY run requires --owner and --repo (or GH_OWNER / GH_REPO) and --assume-yes. Missing: ${missing.join(', ')}`,
      );
      return 1;
    }
  }
  const silentAccept = resolveSilentAccept(defaults, flags);
  if (interactive && silentAccept.length > 0) {
    const summary = silentAccept
      .map((key) => `${key}=${defaults[key]}`)
      .join(' ');
    Logger.info(`[bootstrap] Auto-detected from local git: ${summary}`);
    Logger.info(
      '[bootstrap] Override any value with --owner / --repo / --base-branch / --operator-handle.',
    );
  }
  const { answers, missing } = await collectAnswers({
    questions: buildQuestions(defaults),
    flags,
    interactive,
    assumeYes,
    silentAccept,
  });
  if (missing.length > 0) {
    Logger.error(`[bootstrap] missing required answers: ${missing.join(', ')}`);
    return 1;
  }
  if (flags['dry-run']) {
    Logger.info('[bootstrap] dry-run plan:');
    Logger.info(JSON.stringify({ answers, defaults, flags }, null, 2));
    return 0;
  }
  Logger.info(
    `[bootstrap] Starting project bootstrap at ${projectRoot} (owner=${answers.owner} repo=${answers.repo} base=${answers.baseBranch})`,
  );
  const report = await applyProjectBootstrap({
    projectRoot,
    agentRoot,
    answers,
    skipQuality: Boolean(flags['skip-quality']),
  });
  if (!flags['skip-github']) {
    try {
      report.github = await runGithubBootstrap(answers, { assumeYes });
    } catch (err) {
      Logger.error(`[bootstrap] GitHub bootstrap failed: ${err.message}`);
      report.github = { error: err.message };
    }
  }
  printSummary(report);
  Logger.info('\n[bootstrap] Done.');
  return 0;
}

runAsCli(import.meta.url, main, {
  source: 'Bootstrap',
  propagateExitCode: true,
});

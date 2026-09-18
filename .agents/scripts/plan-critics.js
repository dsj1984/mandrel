#!/usr/bin/env node

/**
 * plan-critics.js — operator-run pre-mortem dispatch verdict for a draft plan,
 * evaluated between Author and Persist, where a re-author loop can still act
 * on it. Advisory: exits 0 on any verdict; each skip is recorded to the
 * plan-metrics ledger so under-firing stays auditable. stdout carries only
 * `{ "premortem": { critic, dispatch, reasons } }`.
 *
 * Exit codes: 0 success (any verdict); 1 usage/IO error.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { runAsCli } from './lib/cli-utils.js';
import { resolveConfig } from './lib/config-resolver.js';
import { Logger, routeAllOutputToStderr } from './lib/Logger.js';
import { evaluatePlanCritics } from './lib/orchestration/plan-critics-evaluate.js';
import { appendCriticSkip } from './lib/orchestration/plan-metrics.js';

const CLI_OPTIONS = {
  stories: { type: 'string' },
  'tech-spec': { type: 'string' },
};

const USAGE = 'Usage: plan-critics.js --stories <file> [--tech-spec <file>]';

export const PLAN_CRITICS_CLI = 'plan-critics';

const DEP_MAP_KEYS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];

function collectPackageIdentity(names, pkg) {
  if (typeof pkg?.name === 'string') names.add(pkg.name);
  for (const key of DEP_MAP_KEYS) {
    const map = pkg?.[key];
    if (map && typeof map === 'object') {
      for (const dep of Object.keys(map)) names.add(dep);
    }
  }
}

/** Best-effort JSON read: a missing or malformed file yields `null`. */
async function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function workspacePatterns(pkg) {
  const ws = pkg?.workspaces;
  if (Array.isArray(ws)) return ws;
  if (Array.isArray(ws?.packages)) return ws.packages;
  return [];
}

/**
 * Handles `dir/*` (one level) and literal paths; never throws.
 *
 * @param {string} rootDir
 * @param {string[]} patterns
 * @returns {Promise<string[]>}
 */
async function resolveWorkspaceManifestPaths(rootDir, patterns) {
  const paths = [];
  for (const pattern of patterns) {
    if (typeof pattern !== 'string') continue;
    if (!pattern.endsWith('/*')) {
      paths.push(path.resolve(rootDir, pattern, 'package.json'));
      continue;
    }
    const base = path.resolve(rootDir, pattern.slice(0, -2));
    let entries;
    try {
      entries = await readdir(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        paths.push(path.join(base, entry.name, 'package.json'));
      }
    }
  }
  return paths;
}

/**
 * Package specifiers the repo's own manifests (root + workspaces) declare, so
 * the external-dependency probe can tell local from external. No manifest
 * yields `[]`, which only widens what counts as external.
 *
 * @param {{ rootDir?: string }} [opts]
 * @returns {Promise<string[]>}
 */
export async function collectRepoPackages({ rootDir = process.cwd() } = {}) {
  const root = await readJsonIfPresent(path.join(rootDir, 'package.json'));
  if (!root) return [];
  const names = new Set();
  collectPackageIdentity(names, root);
  const wsPaths = await resolveWorkspaceManifestPaths(
    rootDir,
    workspacePatterns(root),
  );
  for (const wsPath of wsPaths) {
    const pkg = await readJsonIfPresent(wsPath);
    if (pkg) collectPackageIdentity(names, pkg);
  }
  return [...names];
}

/**
 * @param {{ storiesPath: string, techSpecPath?: string|null }} paths
 * @returns {Promise<{ tickets: object[], techSpecContent: string }>}
 */
export async function loadCriticArtifacts({
  storiesPath,
  techSpecPath = null,
}) {
  const raw = await readFile(storiesPath, 'utf8');
  let tickets;
  try {
    tickets = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse stories file "${storiesPath}" as JSON: ${err.message}`,
    );
  }
  if (!Array.isArray(tickets)) {
    throw new Error(`Stories file "${storiesPath}" must contain a JSON array.`);
  }
  const techSpecContent = techSpecPath
    ? await readFile(techSpecPath, 'utf8')
    : '';
  return { tickets, techSpecContent };
}

/**
 * The ledger write is best-effort and never fails the plan step.
 *
 * @param {{ premortem: object }} verdict
 * @param {object} config
 * @param {{ append?: typeof appendCriticSkip }} [deps]
 * @returns {Promise<void>}
 */
export async function recordCriticSkips(
  verdict,
  config,
  { append = appendCriticSkip } = {},
) {
  const decision = verdict.premortem;
  Logger.info(
    `[plan-critics] critic ${decision.critic}: ` +
      `${decision.dispatch ? 'dispatch' : 'skip'} — ` +
      decision.reasons.join('; '),
  );
  if (!decision.dispatch) {
    await append(
      {
        critic: decision.critic,
        reasons: decision.reasons,
        cli: PLAN_CRITICS_CLI,
      },
      config,
    );
  }
}

/**
 * @param {{
 *   storiesPath: string,
 *   techSpecPath?: string|null,
 *   config?: object,
 *   knownPackages?: string[],
 *   append?: typeof appendCriticSkip,
 * }} args
 * @param {string[]} [args.knownPackages]
 * @returns {Promise<{ premortem: object }>}
 */
export async function evaluateCriticArtifacts({
  storiesPath,
  techSpecPath = null,
  config = {},
  knownPackages = [],
  append = appendCriticSkip,
}) {
  const { tickets, techSpecContent } = await loadCriticArtifacts({
    storiesPath,
    techSpecPath,
  });
  const verdict = evaluatePlanCritics({
    techSpecContent,
    tickets,
    config,
    knownPackages,
  });
  await recordCriticSkips(verdict, config, { append });
  return verdict;
}

async function main() {
  const { values } = parseArgs({ options: CLI_OPTIONS });

  if (!values.stories) {
    throw new Error(USAGE);
  }

  // stdout is reserved for the verdict JSON.
  routeAllOutputToStderr();

  const verdict = await evaluateCriticArtifacts({
    storiesPath: path.resolve(values.stories),
    techSpecPath: values['tech-spec']
      ? path.resolve(values['tech-spec'])
      : null,
    config: resolveConfig(),
    knownPackages: await collectRepoPackages(),
  });

  process.stdout.write(`${JSON.stringify(verdict)}\n`);
  return 0;
}

runAsCli(import.meta.url, main, {
  source: 'plan-critics',
  propagateExitCode: true,
  usage: {
    invocation:
      'node .agents/scripts/plan-critics.js --stories <file> [--tech-spec <file>]',
    summary:
      'Decide whether the maker-blind pre-mortem critic should run on an authored plan draft and print the verdict JSON on stdout.',
    flags: [
      ['--stories <file>', 'Authored stories.json (required).'],
      ['--tech-spec <file>', 'Optional companion techspec.md.'],
    ],
  },
});

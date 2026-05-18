/**
 * parse-args.js — argv parser for the git-cleanup CLI (Story #2466).
 *
 * Extracted verbatim from `git-cleanup.js` so `parseCleanupArgs(argv)`
 * keeps its named-export contract for the existing unit-test surface.
 *
 * @module lib/orchestration/git-cleanup/phases/parse-args
 */

import { parseArgs } from 'node:util';

const CLI_OPTIONS = {
  'dry-run': { type: 'boolean', default: false },
  execute: { type: 'boolean', default: false },
  remote: { type: 'boolean', default: false },
  yes: { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
  'fast-forward-main': { type: 'boolean', default: false },
  'prune-remotes': { type: 'boolean', default: false },
  branches: { type: 'boolean', default: false },
  stashes: { type: 'boolean', default: false },
  include: { type: 'string', multiple: true, default: [] },
  exclude: { type: 'string', multiple: true, default: [] },
  'drop-stashes': { type: 'string', multiple: true, default: [] },
  base: { type: 'string' },
  cwd: { type: 'string' },
};

function resolveActivePhases(values) {
  const anyPhaseFlag =
    values['fast-forward-main'] === true ||
    values['prune-remotes'] === true ||
    values.branches === true ||
    values.stashes === true;
  const allPhases = !anyPhaseFlag;
  return {
    fastForwardMain: allPhases || values['fast-forward-main'] === true,
    pruneRemotes: allPhases || values['prune-remotes'] === true,
    branches: allPhases || values.branches === true,
    stashes: allPhases || values.stashes === true,
  };
}

/**
 * Pure: parse argv into the normalized CLI option bag.
 *
 * @param {string[]} argv
 * @returns {{
 *   dryRun: boolean,
 *   execute: boolean,
 *   remote: boolean,
 *   yes: boolean,
 *   json: boolean,
 *   phases: { fastForwardMain: boolean, pruneRemotes: boolean, branches: boolean, stashes: boolean },
 *   include: string[],
 *   exclude: string[],
 *   dropStashes: string[],
 *   base: string|null,
 *   cwd: string|null,
 * }}
 */
export function parseCleanupArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: CLI_OPTIONS,
    strict: false,
  });
  const execute = values.execute === true && values['dry-run'] !== true;
  return {
    dryRun: !execute,
    execute,
    remote: values.remote === true,
    yes: values.yes === true,
    json: values.json === true,
    phases: resolveActivePhases(values),
    include: Array.isArray(values.include) ? values.include : [],
    exclude: Array.isArray(values.exclude) ? values.exclude : [],
    dropStashes: Array.isArray(values['drop-stashes'])
      ? values['drop-stashes']
      : [],
    base: typeof values.base === 'string' ? values.base : null,
    cwd: typeof values.cwd === 'string' ? values.cwd : null,
  };
}

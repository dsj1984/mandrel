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
  'include-content-merged': { type: 'boolean', default: false },
  base: { type: 'string' },
  cwd: { type: 'string' },
};

/**
 * Normalize a repeatable flag's parsed value to a list. `parseArgs` yields
 * an array for a `multiple: true` option, but only once the flag appears;
 * this keeps the three repeatable flags reading identically.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
function asList(value) {
  return Array.isArray(value) ? value : [];
}

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
 * Every flag the CLI honours MUST be declared in {@link CLI_OPTIONS}:
 * `parseArgs` runs with `strict: false`, so an undeclared flag is not
 * rejected — it is silently absorbed and the option it was meant to set
 * stays at its default. For `--include-content-merged` that failure mode
 * is destructive in the quiet direction's opposite: the operator asks to
 * include the weak-signal candidates, the flag is dropped, and the run
 * withholds them anyway.
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
 *   includeContentMerged: boolean,
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
    include: asList(values.include),
    exclude: asList(values.exclude),
    dropStashes: asList(values['drop-stashes']),
    includeContentMerged: values['include-content-merged'] === true,
    base: typeof values.base === 'string' ? values.base : null,
    cwd: typeof values.cwd === 'string' ? values.cwd : null,
  };
}

/**
 * Base-branch resolution and the repair-then-validate pass for plan persist.
 *
 * @module lib/orchestration/plan-persist/persist-helpers
 */

import { gitSpawn } from '../../git-utils.js';
import { validateTaskBodies } from '../task-body-validator.js';
import { validateAndNormalizeTickets } from '../ticket-validator.js';
import { normalizeAcceptanceHandles } from './acceptance-handle-repair.js';
import { repairChangeEntries } from './changes-repair.js';

/**
 * Reads `project.baseBranch` from resolved config; flat `baseBranch` serves
 * legacy settings-bag callers.
 *
 * @param {object} [config]
 * @returns {string}
 */
export function resolveBaseBranchRef(config) {
  return config?.project?.baseBranch ?? config?.baseBranch ?? 'main';
}

/**
 * @param {string} ref
 * @param {string} cwd
 * @returns {boolean}
 */
function refResolves(ref, cwd) {
  return (
    gitSpawn(cwd, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`)
      .status === 0
  );
}

/**
 * Local branch, else `origin/<branch>` (a CI PR checkout has no local base),
 * else `null` so the probes are skipped rather than reading every path as
 * absent (a shallow checkout has neither).
 *
 * @param {{ baseBranch: string, cwd?: string }} opts
 * @returns {string|null}
 */
function resolveProbeRef({ baseBranch, cwd }) {
  const repo = cwd ?? process.cwd();
  const candidates = [baseBranch, `origin/${baseBranch}`];
  return candidates.find((ref) => refResolves(ref, repo)) ?? null;
}

/**
 * The validator gates' own probe, so repair and gates agree on what is at
 * base.
 *
 * @param {{ baseBranchRef: string, path: string, cwd?: string }} opts
 * @returns {boolean}
 */
function defaultGitRunner({ baseBranchRef, path, cwd }) {
  const result = gitSpawn(
    cwd ?? process.cwd(),
    'cat-file',
    '-e',
    `${baseBranchRef}:${path}`,
  );
  return result.status === 0;
}

/**
 * With no base to read, a bare bullet is taken as an in-place edit.
 *
 * @param {{ baseBranchRef: string|null, cwd?: string, gitRunner?: Function }} opts
 * @returns {(path: string) => boolean}
 */
function makeExistsAtBase({ baseBranchRef, cwd, gitRunner }) {
  if (baseBranchRef === null) return () => true;
  const runner = gitRunner ?? defaultGitRunner;
  return (path) => Boolean(runner({ baseBranchRef, path, cwd }));
}

/**
 * @param {string} baseBranch
 * @param {string|null} baseBranchRef
 * @returns {string[]}
 */
function probeSkipWarnings(baseBranch, baseBranchRef) {
  if (baseBranchRef !== null) return [];
  return [
    `base branch ${baseBranch} does not resolve in this checkout (tried ` +
      `${baseBranch} and origin/${baseBranch}) — footprint probes skipped; ` +
      'the plan summary reports its references as ambiguous, not stale.',
  ];
}

/**
 * @param {object[]} validated
 * @param {Record<string, unknown>} extras
 */
function defineHidden(validated, extras) {
  for (const [key, value] of Object.entries(extras)) {
    Object.defineProperty(validated, key, {
      value,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
}

/**
 * Repair the mechanical `acceptance[]` / `changes[]` formalities (reported on
 * `repairs`), then validate.
 *
 * @param {object[]} tickets Mutated in place.
 * @param {object} config
 * @param {{ cwd?: string, gitRunner?: Function }} [opts]
 * @returns {object[] & { findings: object[], errors: string[], warnings: string[], normalizations: object[], repairs: object[], probeRef: string|null }}
 */
export function validateTickets(tickets, config, opts = {}) {
  const baseBranch = resolveBaseBranchRef(config);
  const baseBranchRef = resolveProbeRef({ baseBranch, cwd: opts.cwd });
  const repairs = [
    ...normalizeAcceptanceHandles(tickets),
    ...repairChangeEntries(tickets, {
      existsAtBase: makeExistsAtBase({
        baseBranchRef,
        cwd: opts.cwd,
        gitRunner: opts.gitRunner,
      }),
    }),
  ];
  const validated = validateAndNormalizeTickets(tickets, {
    baseBranchRef: baseBranchRef ?? undefined,
    gitRunner: opts.gitRunner,
    // Otherwise the probes run against process.cwd().
    cwd: opts.cwd,
  });
  validated.warnings.push(...probeSkipWarnings(baseBranch, baseBranchRef));
  validateTaskBodies(validated);
  defineHidden(validated, { repairs, probeRef: baseBranchRef });
  return validated;
}

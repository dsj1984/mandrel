/**
 * persist-helpers.js — pure helper surface for the flat Story `/mandrel-plan` persist.
 *
 * Exports:
 *   - `resolveBaseBranchRef(config)` — the one place the persist gates learn
 *     which ref to probe.
 *   - `validateTickets(tickets, config, opts)` — repairs the mechanical
 *     `changes[]` formalities against the base branch, then runs the
 *     cross-link, freshness, and task-body validators in one pass.
 *
 * Story #5312 deleted the fan-out probe that lived here: the delete
 * blast-radius count never refused a real plan, and the `git grep` it paid
 * for on every persist bought a warning nobody acted on.
 *
 * @module lib/orchestration/plan-persist/persist-helpers
 */

import { gitSpawn } from '../../git-utils.js';
import { validateTaskBodies } from '../task-body-validator.js';
import { validateAndNormalizeTickets } from '../ticket-validator.js';
import { repairChangeEntries } from './changes-repair.js';

/**
 * Resolve the ref the persist gates probe against.
 *
 * The canonical resolved config carries the base branch at
 * `project.baseBranch` (`lib/config-resolver.js` defaults it to `main`).
 * This helper used to read `config.baseBranch` — a key the resolver never
 * produces — so every freshness / file-assumption probe silently targeted
 * the literal `main` regardless of configuration. Benign in a repo whose
 * base branch *is* `main`; wrong for any consumer that configured something
 * else (Story #4541).
 *
 * The flat `config.baseBranch` fallback is retained for the legacy
 * `settings`-bag callers that pass `{ baseBranch, paths, planning }`.
 *
 * @param {object} [config] Resolved config, or a legacy settings bag.
 * @returns {string}
 */
export function resolveBaseBranchRef(config) {
  return config?.project?.baseBranch ?? config?.baseBranch ?? 'main';
}

/**
 * Default git probe: returns true when `path` exists at `ref` in the cwd repo.
 * `git cat-file -e <ref>:<path>` is the standard low-cost existence check —
 * the same probe the validator's own gates run, so the repair pass and the
 * gates cannot disagree about what is at base.
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
 * Repair the mechanical `changes[]` formalities, then validate.
 *
 * Repair before judging (Story #5312, the shape Story #5005 set for the
 * verify tier): a plain-string bullet or a trailing parenthetical is
 * rewritten into `{ path, assumption }` by probing the base branch, and
 * each rewrite is reported on the returned array's `repairs` so the dry-run
 * can print it. An entry nothing path-shaped can be salvaged from survives
 * untouched and still hard-errors in `validateTaskBodies`.
 *
 * @param {object[]} tickets Mutated in place.
 * @param {object} config Resolved config.
 * @param {{ cwd?: string, gitRunner?: Function }} [opts]
 * @returns {object[] & { findings: object[], errors: string[], warnings: string[], normalizations: object[], repairs: object[] }}
 */
export function validateTickets(tickets, config, opts = {}) {
  const baseBranchRef = resolveBaseBranchRef(config);
  const gitRunner = opts.gitRunner ?? defaultGitRunner;
  const repairs = repairChangeEntries(tickets, {
    existsAtBase: (path) =>
      Boolean(gitRunner({ baseBranchRef, path, cwd: opts.cwd })),
  });
  const validated = validateAndNormalizeTickets(tickets, {
    baseBranchRef,
    gitRunner: opts.gitRunner,
    // Thread the repo cwd into the AC-freshness / file-assumption git
    // probes (#4474 PR7) — without it they silently ran against
    // process.cwd(), which is only the repo root by coincidence.
    cwd: opts.cwd,
  });
  validateTaskBodies(validated);
  Object.defineProperty(validated, 'repairs', {
    value: repairs,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return validated;
}

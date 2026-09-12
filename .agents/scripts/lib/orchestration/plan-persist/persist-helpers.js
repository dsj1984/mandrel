/**
 * persist-helpers.js — pure helper surface for the flat Story `/mandrel-plan` persist.
 *
 * Exports:
 *   - `resolveBaseBranchRef(config)` — the one place the persist gates learn
 *     which branch name the operator configured.
 *
 * The ref the probes read is resolved per checkout (`resolveProbeRef`): the
 * local branch when it exists, else its `origin/` tracking ref (a PR
 * checkout on CI has no local `main`), else nothing — a shallow checkout
 * with no base at all skips the probes instead of reading every path as
 * absent.
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
 * Does `ref` name a commit in the repo at `cwd`?
 *
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
 * Resolve the configured base branch to a ref the footprint probes can read
 * in this checkout, or `null` when none exists.
 *
 * A developer checkout carries a local `main`; a CI pull-request checkout
 * (`actions/checkout` at the merge ref, detached) carries only
 * `origin/main`; a shallow smoke checkout carries neither. Probing the
 * bare branch name in the last two answers "absent" for every path, which
 * turns each bare-path repair into a `creates` and every declared path into
 * a stale reference. So: the local branch when it resolves, else its
 * `origin/` tracking ref when that does, else `null` — the caller then
 * skips the probes and says so, rather than reporting the tree as missing.
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
 * The `existsAtBase` predicate the `changes[]` repair pass probes with. With
 * no base to read, a bare bullet is taken as the in-place edit it almost
 * always is.
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
 * The one warning a checkout with no readable base leaves on the dry-run.
 *
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
 * Attach non-enumerable bookkeeping to the validated array.
 *
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
 * @returns {object[] & { findings: object[], errors: string[], warnings: string[], normalizations: object[], repairs: object[], probeRef: string|null }}
 */
export function validateTickets(tickets, config, opts = {}) {
  const baseBranch = resolveBaseBranchRef(config);
  const baseBranchRef = resolveProbeRef({ baseBranch, cwd: opts.cwd });
  const repairs = repairChangeEntries(tickets, {
    existsAtBase: makeExistsAtBase({
      baseBranchRef,
      cwd: opts.cwd,
      gitRunner: opts.gitRunner,
    }),
  });
  const validated = validateAndNormalizeTickets(tickets, {
    baseBranchRef: baseBranchRef ?? undefined,
    gitRunner: opts.gitRunner,
    // Thread the repo cwd into the AC-freshness / file-assumption git
    // probes (#4474 PR7) — without it they silently ran against
    // process.cwd(), which is only the repo root by coincidence.
    cwd: opts.cwd,
  });
  validated.warnings.push(...probeSkipWarnings(baseBranch, baseBranchRef));
  validateTaskBodies(validated);
  defineHidden(validated, { repairs, probeRef: baseBranchRef });
  return validated;
}

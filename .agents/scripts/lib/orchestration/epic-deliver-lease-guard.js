/**
 * epic-deliver-lease-guard.js — preflight guards for `/deliver`
 * (Story #3482, Epic #3457).
 *
 * `/deliver`'s prepare phase used to checkout `epic/<id>` over whatever
 * the operator had checked out, yanking HEAD and resetting baselines under a
 * live working session (the documented "epic-deliver shares the main checkout"
 * footgun). This module supplies the two preflight guards the Tech Spec
 * (#3476) wires into `epic-deliver-prepare.js` *before* any mutating git work:
 *
 *   1. **Epic-lease preflight.** Acquire the assignee-as-lease on the Epic
 *      ticket via `ticket-lease.acquireLease`. On a live foreign claim the
 *      guard **fails closed** — it throws a clear, operator-facing error that
 *      names the current owner (the `critical-workflow` risk axis demands
 *      refuse-and-exit, never warn-and-continue). `--steal` is the only
 *      override.
 *   2. **Checkout-safety preflight.** Refuse to start when the working tree is
 *      dirty or HEAD is on a branch other than the expected one, instead of
 *      checking `epic/<id>` out over the operator's work.
 *
 * Both guards are pure over injected seams (a `git` shim with
 * `statusPorcelain` / `currentBranch`, and the lease provider) so the unit
 * suite exercises them without standing up a real repo or hitting GitHub.
 * Liveness is threaded in via `heartbeatAt` exactly as `ticket-lease.js`
 * documents — this module does not read the lifecycle ledger itself.
 *
 * Per `.agents/rules/orchestration-error-handling.md`, the composed guard
 * surfaces unrecoverable failures with `throw new Error(...)` (mapped to
 * `process.exit(1)` by the `runAsCli` boundary), never `Logger.fatal`.
 */

import {
  acquireLeaseFailClosed,
  resolveOperatorFromCandidates,
} from './lease-guard-shared.js';

/**
 * Resolve the acquiring operator's identity. Precedence (Tech Spec #3476):
 *   1. An explicit `--as <handle>` flag.
 *   2. `github.operatorHandle` in `.agentrc.json`.
 *   3. The local `git config user.email`.
 *
 * The `@`-prefix some operators carry on `operatorHandle` is stripped (via
 * the shared lease-guard kernel) so the value matches the bare login written
 * to a ticket's `assignees`. This surface's missing-handle policy is `'null'`
 * — `runPrepareGuards` fails closed on a null operator with deliver-specific
 * wording after the (cheap, local) checkout-safety guard has run.
 *
 * @param {object} args
 * @param {string} [args.asFlag]        Explicit `--as` value.
 * @param {object} [args.config]        Resolved config (reads github.operatorHandle).
 * @param {string} [args.gitUserEmail]  Fallback `git config user.email`.
 * @returns {string|null} The resolved operator handle, or null when none could
 *   be determined.
 */
export function resolveOperator({ asFlag, config, gitUserEmail } = {}) {
  return resolveOperatorFromCandidates({
    candidates: [asFlag, config?.github?.operatorHandle, gitUserEmail],
  });
}

/**
 * Normalise the expected-branch argument into a non-empty list. `/deliver`
 * may legitimately start from either the Epic integration branch (`epic/<id>`,
 * on a resume) or the project base branch (`main`, on a fresh run), so the
 * guard accepts a set rather than a single name.
 *
 * @param {string|string[]} expectedBranch
 * @returns {string[]}
 */
function normaliseExpectedBranches(expectedBranch) {
  const list = (
    Array.isArray(expectedBranch) ? expectedBranch : [expectedBranch]
  ).filter((b) => typeof b === 'string' && b.length > 0);
  if (list.length === 0) {
    throw new Error('checkCheckoutSafety: expectedBranch is required');
  }
  return list;
}

/**
 * Pure checkout-safety classifier. The working tree must be clean and HEAD
 * must sit on one of `expectedBranch` before prepare moves anything.
 *
 * @param {object} args
 * @param {object} args.git              Injected git shim.
 * @param {() => { dirty: boolean, entries?: string }} args.git.statusPorcelain
 *   Returns whether the tree has uncommitted/untracked changes.
 * @param {() => string|null} args.git.currentBranch  Returns HEAD's branch (or
 *   null in detached-HEAD state).
 * @param {string|string[]} args.expectedBranch  The branch (or branches)
 *   prepare expects HEAD on (typically `epic/<id>` or the project base branch).
 * @returns {{
 *   safe: boolean,
 *   reason: 'clean'|'dirty'|'wrong-branch'|'detached-head',
 *   currentBranch: string|null,
 *   expectedBranches: string[],
 *   dirtyEntries?: string,
 * }}
 */
export function checkCheckoutSafety({ git, expectedBranch }) {
  if (!git || typeof git.statusPorcelain !== 'function') {
    throw new Error(
      'checkCheckoutSafety: git shim with statusPorcelain/currentBranch is required',
    );
  }
  const expectedBranches = normaliseExpectedBranches(expectedBranch);

  const status = git.statusPorcelain();
  if (status?.dirty) {
    return {
      safe: false,
      reason: 'dirty',
      currentBranch: git.currentBranch(),
      expectedBranches,
      dirtyEntries: status.entries,
    };
  }

  const branch = git.currentBranch();
  if (branch === null || branch === undefined || branch === '') {
    return {
      safe: false,
      reason: 'detached-head',
      currentBranch: null,
      expectedBranches,
    };
  }
  if (!expectedBranches.includes(branch)) {
    return {
      safe: false,
      reason: 'wrong-branch',
      currentBranch: branch,
      expectedBranches,
    };
  }
  return {
    safe: true,
    reason: 'clean',
    currentBranch: branch,
    expectedBranches,
  };
}

/**
 * Render the operator-facing message for a failed checkout-safety guard.
 *
 * @param {ReturnType<typeof checkCheckoutSafety>} result
 * @returns {string}
 */
export function renderCheckoutRefusal(result) {
  const expected = result.expectedBranches.map((b) => `'${b}'`).join(' or ');
  if (result.reason === 'dirty') {
    return (
      `[epic-deliver] Refusing to start: the working tree is dirty. ` +
      `/deliver will not check out ${expected} over uncommitted ` +
      `or untracked changes — commit, stash, or clean them, then re-run.\n` +
      `--- dirty entries ---\n${result.dirtyEntries ?? '(unavailable)'}`
    );
  }
  if (result.reason === 'detached-head') {
    return (
      `[epic-deliver] Refusing to start: HEAD is detached. /deliver ` +
      `expects HEAD on ${expected}. Check one out before re-running.`
    );
  }
  return (
    `[epic-deliver] Refusing to start: HEAD is on '${result.currentBranch}', ` +
    `not the expected ${expected}. /deliver will not yank HEAD ` +
    `away from your branch — switch to ${expected} yourself before re-running.`
  );
}

/**
 * Render the operator-facing message for a refused (live foreign) lease.
 *
 * @param {{ owner: string|null }} lease
 * @param {number} epicId
 * @returns {string}
 */
export function renderLeaseRefusal(lease, epicId) {
  return (
    `[epic-deliver] Refusing to start: Epic #${epicId} is already claimed by ` +
    `'${lease.owner}' with a live lease (recent heartbeat within the TTL). ` +
    `Another /deliver run is driving this Epic. Wait for it to finish, ` +
    `or pass --steal to forcibly transfer the claim.`
  );
}

/**
 * Acquire the Epic lease for `operator`, failing closed on a live foreign
 * claim. Returns the `acquireLease` result on success.
 *
 * @param {object} args
 * @param {object} args.provider              Ticketing provider.
 * @param {number} args.epicId                Epic ticket id.
 * @param {string} args.operator              Resolved operator handle.
 * @param {number|null} [args.heartbeatAt]    Current owner's last heartbeat (epoch ms).
 * @param {boolean} [args.steal=false]        Transfer a live foreign claim.
 * @param {object} [args.config]              Resolved config (TTL default).
 * @param {number} [args.now]                 Injectable clock.
 * @returns {Promise<{ acquired: boolean, owner: string, previousOwner: string|null, reason: string }>}
 * @throws {Error} when the Epic carries a live foreign claim and `steal` is false.
 */
export async function acquireEpicLease({
  provider,
  epicId,
  operator,
  heartbeatAt = null,
  steal = false,
  config,
  now,
}) {
  return acquireLeaseFailClosed({
    provider,
    ticketId: epicId,
    operator,
    heartbeatAt,
    steal,
    config,
    now,
    renderRefusal: renderLeaseRefusal,
  });
}

/**
 * Compose the two preflight guards in the order prepare needs them: the
 * checkout-safety check first (cheap, local, no network), then the Epic-lease
 * acquisition (a GitHub round-trip). Both fail closed by throwing.
 *
 * The checkout-safety guard runs first (cheap, local) and always executes. The
 * Epic-lease step then **fails closed**: when `operator` cannot be resolved
 * (null — `--as`, `github.operatorHandle`, and `git user.email` all empty, with
 * the shipped `@[USERNAME]` placeholder normalised to null), this throws rather
 * than running an ownerless, unguarded delivery. The lease is the cross-clone
 * coordination layer; without an identity it cannot serialise concurrent runs,
 * so silently skipping it would defeat the guard.
 *
 * @param {object} args
 * @param {number} args.epicId
 * @param {string|string[]} args.expectedBranch  Branch(es) prepare expects HEAD on.
 * @param {object} args.git                   Injected git shim (statusPorcelain/currentBranch).
 * @param {object} args.provider              Ticketing provider for the lease.
 * @param {string|null} args.operator         Resolved operator handle (null fails closed → throw).
 * @param {number|null} [args.heartbeatAt]    Current owner's last heartbeat (epoch ms).
 * @param {boolean} [args.steal=false]        Transfer a live foreign claim.
 * @param {object} [args.config]              Resolved config.
 * @param {number} [args.now]                 Injectable clock.
 * @param {object} [args.logger]              Logger with info/warn.
 * @returns {Promise<{
 *   checkout: ReturnType<typeof checkCheckoutSafety>,
 *   lease: { acquired: boolean, owner: string, reason: string },
 * }>}
 * @throws {Error} on a dirty/wrong-branch tree, an unresolvable operator
 *   identity, or a refused live foreign lease.
 */
export async function runPrepareGuards({
  epicId,
  expectedBranch,
  git,
  provider,
  operator,
  heartbeatAt = null,
  steal = false,
  config,
  now,
  logger,
}) {
  const log = logger ?? { info: () => {}, warn: () => {} };

  const checkout = checkCheckoutSafety({ git, expectedBranch });
  if (!checkout.safe) {
    throw new Error(renderCheckoutRefusal(checkout));
  }
  log.info?.(
    `[epic-deliver] ✅ Checkout-safety guard passed (clean tree on '${checkout.currentBranch}').`,
  );

  if (!operator) {
    throw new Error(
      '[epic-deliver] Refusing to start: no operator identity could be ' +
        'resolved. --as, github.operatorHandle (unset or still the shipped ' +
        '`@[USERNAME]` placeholder), and git user.email are all empty, so the ' +
        'Epic-lease has no owner and concurrent /deliver runs cannot be ' +
        'serialised. Set your own handle in .agentrc.local.json (e.g. ' +
        '{ "github": { "operatorHandle": "@your-login" } }), pass --as <handle>, ' +
        'or configure git user.email, then re-run.',
    );
  }

  const lease = await acquireEpicLease({
    provider,
    epicId,
    operator,
    heartbeatAt,
    steal,
    config,
    now,
  });
  if (lease.reason === 'stolen') {
    log.warn?.(
      `[epic-deliver] ⚠️  Stole the Epic #${epicId} lease from '${lease.previousOwner}' via --steal (live claim forcibly transferred).`,
    );
  } else {
    log.info?.(
      `[epic-deliver] ✅ Acquired Epic #${epicId} lease for '${operator}' (reason=${lease.reason}).`,
    );
  }
  return { checkout, lease };
}

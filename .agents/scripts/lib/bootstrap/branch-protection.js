/**
 * bootstrap/branch-protection
 *
 * Consumer-parity branch-protection writer. The bootstrap applies a
 * CI-gates-only stance every project in the framework inherits:
 *
 *   - `enforce_admins: true` — admins do not bypass the prGate suite.
 *   - `required_pull_request_reviews.required_approving_review_count: 0` —
 *     CI is the gate; the operator monitors and iterates the open PR
 *     to green via `/deliver`'s Phase 7 watch loop.
 *
 * Behaviour rules
 * ---------------
 * Fresh rule (no existing protection):
 *   The framework writes the full opinionated payload directly. No HITL
 *   prompt — there is nothing to diff against.
 *
 * Existing rule that already matches the target stance:
 *   Pure-additive append of any missing prGate.checks contexts. No HITL
 *   prompt (preserves the today-non-interactive contract for additive
 *   changes).
 *
 * Existing rule that *diverges* on a behavior-shifting field
 * (enforce_admins flip, approval-count change, strict-checks flip, or any
 * required-check context dropped):
 *   Routes the proposed payload through `hitlConfirm`. On rejection or
 *   non-TTY abort, the call is a no-op and we return
 *   `{ status: 'skipped', reason: 'hitl-declined' }`. On approval, we
 *   apply the diverging payload.
 *
 * Errors (insufficient scopes, repo permission denied, etc.) are logged
 * and surfaced as `{ status: 'failed' }` — the rest of the bootstrap is
 * not aborted. Matches `agents-bootstrap-github.js` failure handling so
 * the wrapper stays predictable.
 */

const TARGET_ENFORCE_ADMINS = true;
const TARGET_APPROVAL_COUNT = 0;

/**
 * Detect whether `current` (the GitHub API's `raw` protection payload)
 * diverges from the target stance on any behavior-shifting field. The
 * return value is a structured diff suitable for `hitlConfirm` so the
 * operator sees exactly what would flip.
 */
export function diffProtection(current, targetContexts) {
  if (!current) return null; // create-from-scratch path; no diff needed.

  const diff = {};
  const liveEnforceAdmins = current?.enforce_admins?.enabled ?? false;
  if (liveEnforceAdmins !== TARGET_ENFORCE_ADMINS) {
    diff.enforceAdmins = {
      current: liveEnforceAdmins,
      proposed: TARGET_ENFORCE_ADMINS,
    };
  }

  const liveReviews = current?.required_pull_request_reviews ?? null;
  // Live `null` means "PR reviews not configured at all". We *do* want to
  // promote the explicit zero-approval policy in that case, so the diff
  // reports it as a flip from null → { required_approving_review_count: 0 }.
  // An explicit zero-count rule blocks any future operator drift back to
  // 1+, which would re-introduce the approval-theater dependency the
  // framework deliberately stripped out.
  const liveApprovalCount = liveReviews?.required_approving_review_count;
  if (liveApprovalCount !== TARGET_APPROVAL_COUNT) {
    diff.approvingReviewCount = {
      current: liveApprovalCount ?? null,
      proposed: TARGET_APPROVAL_COUNT,
    };
  }

  const liveContexts = current?.required_status_checks?.contexts ?? [];
  const dropped = liveContexts.filter((c) => !targetContexts.includes(c));
  // We never *drop* operator contexts — the writer is additive on that
  // axis. So a dropped-on-target list is informational only and never
  // makes us route through HITL. Only enforce-admins / approval-count
  // shifts trigger the gate.
  if (dropped.length > 0) {
    diff.preservedContexts = dropped;
  }

  return Object.keys(diff).length > 0 ? diff : null;
}

function isBehaviorShifting(diff) {
  if (!diff) return false;
  return (
    Object.hasOwn(diff, 'enforceAdmins') ||
    Object.hasOwn(diff, 'approvingReviewCount')
  );
}

/**
 * Apply the framework's branch-protection stance to `baseBranch`.
 *
 * @param {object} args
 * @param {object} args.provider - Ticketing provider exposing
 *   `getBranchProtection(branch)` and `setBranchProtection(branch, opts)`.
 * @param {object} args.settings - The resolved settings bag. Carries
 *   `baseBranch` (default `main`) and `github.branchProtection.{enforce,
 *   requiredChecks}` post-reshape.
 * @param {(args:{summary:string, current:object|null, proposed:object})=>Promise<boolean>}
 *   [args.hitlConfirm] - HITL gate. Defaults to "abort on diverge"
 *   (returns false) when omitted — matching the non-TTY contract.
 * @param {(msg:string)=>void} [args.log] - Logger sink. Defaults to a no-op.
 */
export async function applyBranchProtection({
  provider,
  settings,
  hitlConfirm,
  log = () => {},
}) {
  const baseBranch = settings?.baseBranch ?? 'main';
  // Post-reshape: branch protection lives under `github.branchProtection`.
  // The legacy `quality.prGate` location is gone from the schema; reading
  // it here is a transitional fallback only.
  const branchProtection =
    settings?.github?.branchProtection ?? settings?.quality?.prGate ?? null;
  const enforce =
    branchProtection?.enforce ??
    branchProtection?.enforceBranchProtection ??
    true;
  const requiredChecks =
    branchProtection?.requiredChecks ?? branchProtection?.checks ?? [];

  if (enforce === false) {
    log(
      `[Bootstrap] Branch protection on '${baseBranch}': skipped (github.branchProtection.enforce=false).`,
    );
    return { status: 'skipped', reason: 'opt-out' };
  }

  const checkNames = requiredChecks
    .map((c) => c?.name)
    .filter((n) => typeof n === 'string' && n.length > 0);
  if (checkNames.length === 0) {
    log(
      `[Bootstrap] Branch protection on '${baseBranch}': skipped (no github.branchProtection.requiredChecks configured).`,
    );
    return { status: 'skipped', reason: 'no-checks' };
  }

  // Story #2018 (Bug 3): on a fresh-empty repo with no commits yet, the
  // base branch hasn't been pushed and the protection PUT would 404 with
  // a confusing transport error. Probe for existence first so operators
  // get a clear "no-base-branch" skip rather than discovering the
  // `enforce: false` opt-out by reading the failure message.
  if (typeof provider.branchExists === 'function') {
    let exists = true;
    try {
      exists = await provider.branchExists(baseBranch);
    } catch (err) {
      log(
        `[Bootstrap] Branch protection on '${baseBranch}': existence probe failed — ${err.message}. Proceeding with the write attempt.`,
      );
    }
    if (!exists) {
      log(
        `[Bootstrap] Branch protection on '${baseBranch}': skipped (base branch does not exist on the remote — push an initial commit first).`,
      );
      return { status: 'skipped', reason: 'no-base-branch' };
    }
  }

  let current = null;
  try {
    const probe = await provider.getBranchProtection(baseBranch);
    current = probe?.enabled ? (probe.raw ?? null) : null;
  } catch (err) {
    log(
      `[Bootstrap] Branch protection on '${baseBranch}': read failed — ${err.message}. Proceeding as if no rule exists.`,
    );
  }

  const diff = diffProtection(current, checkNames);
  if (isBehaviorShifting(diff)) {
    const approved =
      typeof hitlConfirm === 'function'
        ? await hitlConfirm({
            summary: `Branch protection on '${baseBranch}' diverges from the framework's CI-gates-only stance (enforce_admins=true, required_approving_review_count=0).`,
            current: {
              enforce_admins: current?.enforce_admins?.enabled ?? false,
              required_approving_review_count:
                current?.required_pull_request_reviews
                  ?.required_approving_review_count ?? null,
            },
            proposed: {
              enforce_admins: TARGET_ENFORCE_ADMINS,
              required_approving_review_count: TARGET_APPROVAL_COUNT,
            },
          })
        : false;
    if (!approved) {
      log(
        `[Bootstrap] Branch protection on '${baseBranch}': diverges from framework stance; HITL declined / non-TTY — leaving the operator's rule untouched.`,
      );
      return { status: 'skipped', reason: 'hitl-declined', diff };
    }
  }

  try {
    const result = await provider.setBranchProtection(baseBranch, {
      contexts: checkNames,
      enforceAdmins: TARGET_ENFORCE_ADMINS,
      requiredApprovingReviewCount: TARGET_APPROVAL_COUNT,
    });
    const verb = result.created ? 'Created' : 'Updated';
    const addedSuffix = result.added.length
      ? ` (added: ${result.added.join(', ')})`
      : ' (all required checks already present)';
    log(
      `[Bootstrap] Branch protection on '${baseBranch}': ${verb} rule${addedSuffix}.`,
    );
    return { status: result.created ? 'created' : 'merged', ...result };
  } catch (err) {
    log(
      `[Bootstrap] Branch protection on '${baseBranch}': failed — ${err.message}. Proceeding without it.`,
    );
    return { status: 'failed', reason: err.message };
  }
}

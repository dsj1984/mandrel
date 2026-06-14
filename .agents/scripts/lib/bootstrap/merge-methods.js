/**
 * bootstrap/merge-methods — Epic #1235 Story 5
 *
 * Promotes the framework's hands-off-pipeline merge stance to the
 * consumer repo:
 *   - allow_squash_merge: true   — single commit per PR; clean history.
 *   - allow_rebase_merge: false  — no rebase-merge (status checks would
 *                                  need to be re-run per commit).
 *   - allow_merge_commit: false  — no merge commits cluttering the
 *                                  default branch.
 *   - allow_auto_merge: true     — required for the auto-merge label
 *                                  feature Story 1 delivered.
 *   - delete_branch_on_merge: true — head branches are throwaway.
 *
 * Behaviour rules
 * ---------------
 * No drift (live settings already match the target): no-op, returns
 * `{ status: 'unchanged' }`.
 *
 * Drift (any field differs from the target stance): when a `hitlConfirm`
 * gate is supplied, the proposed payload routes through it — on approval
 * the PATCH is issued; on decline the module returns
 * `{ status: 'skipped', reason: 'hitl-declined' }` without writing (a loud
 * decline, never silent). When NO gate is supplied (non-TTY, no operator
 * present — Story #4045 A4), the framework stance is default-applied with
 * an explicit log line.
 */

export const TARGET_MERGE_METHODS = Object.freeze({
  allow_squash_merge: true,
  allow_rebase_merge: false,
  allow_merge_commit: false,
  allow_auto_merge: true,
  delete_branch_on_merge: true,
});

/**
 * Compute the drift between `current` (sparse) and the merged
 * (defaults+settings) target. Returns null when nothing diverges so the
 * caller can short-circuit before prompting HITL.
 */
export function diffMergeMethods(current, target) {
  const diff = {};
  for (const key of Object.keys(target)) {
    const live = current?.[key];
    if (live !== target[key]) {
      diff[key] = { current: live ?? null, proposed: target[key] };
    }
  }
  return Object.keys(diff).length > 0 ? diff : null;
}

/**
 * @param {object} args
 * @param {object} args.provider - Provider exposing `getMergeMethods()` /
 *   `setMergeMethods(settings)`.
 * @param {object} [args.settings] - The resolved settings bag. Reads
 *   `github.mergeMethods` and merges over framework defaults.
 * @param {(args:{summary:string, current:object, proposed:object})=>Promise<boolean>}
 *   [args.hitlConfirm] - HITL gate. Defaults to "abort on diverge".
 * @param {(msg:string)=>void} [args.log] - Logger sink.
 */
export async function applyMergeMethods({
  provider,
  settings,
  hitlConfirm,
  log = () => {},
}) {
  // Merge methods live under `github.mergeMethods`.
  const override = settings?.github?.mergeMethods ?? {};
  const target = { ...TARGET_MERGE_METHODS, ...override };

  let current = {};
  try {
    current = (await provider.getMergeMethods()) ?? {};
  } catch (err) {
    log(`[Bootstrap] Merge methods: read failed — ${err.message}.`);
    return { status: 'failed', reason: err.message };
  }

  const diff = diffMergeMethods(current, target);
  if (!diff) {
    log('[Bootstrap] Merge methods: already at target stance (no-op).');
    return { status: 'unchanged' };
  }

  let approved;
  if (typeof hitlConfirm === 'function') {
    approved = await hitlConfirm({
      summary:
        'Repo merge-method settings diverge from the framework hands-off-pipeline stance.',
      current,
      proposed: target,
    });
    if (!approved) {
      log(
        '[Bootstrap] Merge methods: HITL declined — leaving operator settings untouched\n\n' +
          'Note: auto-merge will remain disabled until the merge-method ' +
          'settings match the framework stance (allow_squash_merge: true, ' +
          'allow_auto_merge: true, delete_branch_on_merge: true).',
      );
      return { status: 'skipped', reason: 'hitl-declined', diff };
    }
  } else {
    // Non-TTY: no operator present to confirm. Default-apply the framework
    // stance and log explicitly so the consequence is never silent.
    log(
      '[Bootstrap] Merge methods: non-TTY — applying framework stance automatically ' +
        '(allow_squash_merge, allow_auto_merge, delete_branch_on_merge). ' +
        'To opt out, pass a hitlConfirm gate or set github.mergeMethods overrides in .agentrc.json.',
    );
    approved = true;
  }

  try {
    const result = await provider.setMergeMethods(target);
    log(`[Bootstrap] Merge methods: patched (${result.patched.join(', ')}).`);
    return { status: 'patched', ...result, diff };
  } catch (err) {
    log(`[Bootstrap] Merge methods: PATCH failed — ${err.message}.`);
    return { status: 'failed', reason: err.message };
  }
}

/**
 * Applies the framework merge stance (squash-only, auto-merge on, delete head
 * branches). On drift, a supplied `hitlConfirm` gate decides; with no gate
 * (non-TTY) the stance is applied with an explicit log line.
 */

export const TARGET_MERGE_METHODS = Object.freeze({
  allow_squash_merge: true,
  allow_rebase_merge: false,
  allow_merge_commit: false,
  allow_auto_merge: true,
  delete_branch_on_merge: true,
});

/** `null` when nothing diverges. */
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

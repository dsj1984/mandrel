/**
 * `delivery.worktreeIsolation` accessor + framework defaults.
 *
 * Several consumers read this block directly (runtime.js,
 * worktree-manager.js, workspace-provisioner.js) and previously each
 * carried its own fallback constant. Centralising the defaults here
 * lets `applyDefaults()` in `config-resolver.js` enrich the canonical
 * block once, so consumers never see `undefined` for a defaulted field
 * (which previously meant, e.g., `Boolean(undefined) === false`
 * silently disabling worktrees when the operator omitted the block).
 */

export const WORKTREE_ISOLATION_DEFAULTS = Object.freeze({
  enabled: true,
  root: '.worktrees',
  nodeModulesStrategy: 'per-worktree',
  primeFromPath: null,
  allowSymlinkOnWindows: false,
  reapOnSuccess: true,
  reapOnCancel: true,
  bootstrapFiles: Object.freeze(['.env']),
});

/**
 * Read the merged `delivery.worktreeIsolation` block, applying framework
 * defaults for any field the operator omitted. Accepts the full resolved
 * config, the bare delivery bag, or the bare worktreeIsolation bag.
 *
 * @param {object | null | undefined} config
 * @returns {typeof WORKTREE_ISOLATION_DEFAULTS}
 */
export function getWorktreeIsolation(config) {
  const wi =
    config?.delivery?.worktreeIsolation ??
    config?.worktreeIsolation ??
    config ??
    {};
  return {
    enabled:
      typeof wi.enabled === 'boolean'
        ? wi.enabled
        : WORKTREE_ISOLATION_DEFAULTS.enabled,
    root: wi.root ?? WORKTREE_ISOLATION_DEFAULTS.root,
    nodeModulesStrategy:
      wi.nodeModulesStrategy ?? WORKTREE_ISOLATION_DEFAULTS.nodeModulesStrategy,
    primeFromPath:
      wi.primeFromPath === undefined
        ? WORKTREE_ISOLATION_DEFAULTS.primeFromPath
        : wi.primeFromPath,
    allowSymlinkOnWindows:
      typeof wi.allowSymlinkOnWindows === 'boolean'
        ? wi.allowSymlinkOnWindows
        : WORKTREE_ISOLATION_DEFAULTS.allowSymlinkOnWindows,
    reapOnSuccess:
      typeof wi.reapOnSuccess === 'boolean'
        ? wi.reapOnSuccess
        : WORKTREE_ISOLATION_DEFAULTS.reapOnSuccess,
    reapOnCancel:
      typeof wi.reapOnCancel === 'boolean'
        ? wi.reapOnCancel
        : WORKTREE_ISOLATION_DEFAULTS.reapOnCancel,
    bootstrapFiles: Array.isArray(wi.bootstrapFiles)
      ? wi.bootstrapFiles
      : [...WORKTREE_ISOLATION_DEFAULTS.bootstrapFiles],
  };
}

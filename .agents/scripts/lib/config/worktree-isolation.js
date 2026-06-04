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
  // Gitignored workspace files copied into each new worktree. Includes the
  // operator's local-override files (`.agentrc.local.json`,
  // `.agents/instructions.local.md`) so a worktree-isolated agent honors the
  // §1.E local-override contract instead of silently falling back to the
  // committed `.agentrc.json` placeholders — the gap that left
  // `github.operatorHandle` unset inside worktrees and broke Story-lease
  // release at close. Missing sources are skipped by the provisioner, so
  // listing files that may be absent is safe. Keep in sync with
  // `DEFAULT_WORKSPACE_FILES` in `../workspace-provisioner.js`.
  bootstrapFiles: Object.freeze([
    '.env',
    '.mcp.json',
    '.agentrc.local.json',
    '.agents/instructions.local.md',
  ]),
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

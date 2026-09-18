/**
 * `delivery.worktreeIsolation` defaults, applied once so no consumer reads
 * `undefined` (e.g. `Boolean(undefined)` silently disabling worktrees).
 */

/**
 * `clone` is a copy-on-write clone (falls back to `per-worktree` on failure);
 * Windows has no reflink path.
 *
 * @param {NodeJS.Platform} [platform]
 * @returns {'clone' | 'per-worktree'}
 */
export function defaultNodeModulesStrategy(platform = process.platform) {
  return platform === 'win32' ? 'per-worktree' : 'clone';
}

export const WORKTREE_ISOLATION_DEFAULTS = Object.freeze({
  enabled: true,
  root: '.worktrees',
  nodeModulesStrategy: defaultNodeModulesStrategy(),
  primeFromPath: null,
  allowSymlinkOnWindows: false,
  reapOnSuccess: true,
  // Local overrides must reach the worktree, or e.g. `operatorHandle` reads
  // the committed placeholder and lease release breaks at close. Absent
  // files are skipped. Keep in sync with `DEFAULT_WORKSPACE_FILES` in
  // `../workspace-provisioner.js`.
  bootstrapFiles: Object.freeze([
    '.env',
    '.mcp.json',
    '.agentrc.local.json',
    '.agents/instructions.local.md',
  ]),
});

/**
 * Accepts the full config, the `delivery` bag, or the block itself.
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
    nodeModulesStrategy: wi.nodeModulesStrategy ?? defaultNodeModulesStrategy(),
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
    bootstrapFiles: Array.isArray(wi.bootstrapFiles)
      ? wi.bootstrapFiles
      : [...WORKTREE_ISOLATION_DEFAULTS.bootstrapFiles],
  };
}

/**
 * `agentSettings.quality.baselines` accessor (Epic #730 Story 5.5; relocated
 * under lib/config/ in Epic #773 Story 6).
 */

/**
 * Canonical on-disk locations for every ratchet baseline (Epic #730 Story 5.5).
 * The framework treats `<repoRoot>/baselines/` as the single tracked directory
 * for `lint.json` / `crap.json` / `maintainability.json`; operators may
 * override per-baseline `path` in `agentSettings.quality.baselines.*` but the
 * defaults are designed so a fresh clone has working ratchets immediately.
 */
export const BASELINES_DEFAULTS = Object.freeze({
  lint: Object.freeze({ path: 'baselines/lint.json', refreshCommand: null }),
  crap: Object.freeze({ path: 'baselines/crap.json', refreshCommand: null }),
  maintainability: Object.freeze({
    path: 'baselines/maintainability.json',
    refreshCommand: null,
  }),
});

/**
 * Read the grouped `agentSettings.quality.baselines` block, applying framework
 * defaults for any baseline (or any field within a baseline) the operator
 * omitted. Returns a `{ lint, crap, maintainability }` trio whose entries are
 * each `{ path, refreshCommand }` — never `undefined`.
 *
 * Accepts either the full resolved config (`{ agentSettings, ... }` wrapper)
 * or a bare `agentSettings` bag — the canonical two-shape accessor contract.
 *
 * @param {{ agentSettings?: { quality?: { baselines?: object } } } | object | null | undefined} config
 * @returns {{ lint: { path: string, refreshCommand: string|null }, crap: { path: string, refreshCommand: string|null }, maintainability: { path: string, refreshCommand: string|null } }}
 */
export function getBaselines(config) {
  const baselines =
    config?.agentSettings?.quality?.baselines ||
    config?.quality?.baselines ||
    {};
  const merge = (key) => {
    const fallback = BASELINES_DEFAULTS[key];
    const user = baselines[key] ?? {};
    return {
      path: user.path ?? fallback.path,
      refreshCommand:
        user.refreshCommand === undefined
          ? fallback.refreshCommand
          : user.refreshCommand,
    };
  };
  return {
    lint: merge('lint'),
    crap: merge('crap'),
    maintainability: merge('maintainability'),
  };
}

/**
 * Merge the user-supplied `quality.baselines` block with framework defaults.
 * Mirrors {@link getBaselines} but returns the same `{ lint, crap,
 * maintainability }` trio shape — used during the in-place defaults pass so
 * `agentSettings.quality.baselines` is fully populated for any direct reader.
 *
 * @param {object|undefined} userBlock
 */
export function resolveBaselines(userBlock) {
  return getBaselines({ quality: { baselines: userBlock ?? {} } });
}

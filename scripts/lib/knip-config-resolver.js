/**
 * knip-config-resolver.js — resolve a repository's knip configuration the way
 * knip itself would, and hand back its declared entry patterns.
 *
 * Split out of `knip-entry-sync.js` (Story #5039) because these are two
 * concerns that change for different reasons: *what knip's config says* tracks
 * knip's own releases, while *which CLIs something invokes* tracks this
 * repository's callers. Keeping them in one file also pushed that module's
 * maintainability index below its floor.
 *
 * Why not read the file ourselves: #5026 hardcoded
 * `JSON.parse(<root>/knip.json)`, so all seven of knip's other config
 * locations plus `package.json#knip` resolved to ENOENT and failed the gate
 * closed. That made it unusable in exactly the repositories that adopt the
 * shared `knip.base.json` — knip 6 has no root-level `extends`, so inheriting
 * the base means spreading it inside a TypeScript module, which a static
 * `knip.json` structurally cannot express.
 *
 * Going through `createOptions` also drops the assumption that `entry` is
 * *statically declared*. A config may build the array programmatically, so
 * even a purpose-built `knip.config.ts` parser would read the wrong thing;
 * knip evaluates the module and returns the computed value.
 */

/**
 * Load knip's own config resolver.
 *
 * Deliberately a dynamic import behind an injectable seam. `knip` is declared
 * in `runtime-deps.json` as an **optional** dependency, mirroring `typescript`:
 * the `.agents/` payload is materialized into consumers that may not run knip
 * at all, so an unresolvable `knip` must degrade to the skip path rather than
 * crash the gate at module load — and must never be preflight-blocked.
 *
 * @returns {Promise<{ createOptions?: Function }>}
 */
function importKnipSession() {
  return import('knip/session');
}

/**
 * Collect every declared entry pattern from a resolved knip configuration.
 *
 * Entries live in two places and #5026 read only the first. A pnpm-workspace
 * config — the shape that made this gate unusable in `Beestera/swarm-os` —
 * declares them per workspace, so a config with no top-level `entry` at all is
 * still fully enumerated. A named workspace's patterns are workspace-relative
 * and are joined to the workspace name; the root workspace (`.`) is already
 * repo-relative. A leading `!` is knip's *negation* marker (as opposed to the
 * trailing production marker) and stays at the front of the pattern rather
 * than getting buried behind the workspace prefix.
 *
 * `sawEntryArray` separates "declared nothing under `.agents/scripts/`" — a
 * legitimate result, reported as `missing` divergences — from "this config
 * enumerates no entry points anywhere", which leaves the gate nothing to
 * compare against.
 *
 * @param {object} parsedConfig knip's schema-parsed configuration
 * @returns {{ patterns: string[], sawEntryArray: boolean }}
 */
function collectEntryPatterns(parsedConfig) {
  const patterns = [];
  let sawEntryArray = false;

  const push = (value, prefix) => {
    if (typeof value !== 'string') return;
    if (!prefix) patterns.push(value);
    else if (value.startsWith('!'))
      patterns.push(`!${prefix}${value.slice(1)}`);
    else patterns.push(`${prefix}${value}`);
  };

  const addAll = (entry, prefix) => {
    if (!Array.isArray(entry)) return;
    sawEntryArray = true;
    for (const value of entry) push(value, prefix);
  };

  addAll(parsedConfig?.entry, '');

  const workspaces = parsedConfig?.workspaces;
  if (workspaces && typeof workspaces === 'object') {
    for (const [name, workspace] of Object.entries(workspaces)) {
      const trimmed = name.replace(/^\.\/+/, '').replace(/\/+$/, '');
      const prefix = trimmed === '' || trimmed === '.' ? '' : `${trimmed}/`;
      addAll(workspace?.entry, prefix);
    }
  }

  return { patterns, sawEntryArray };
}

/**
 * Resolve the entry patterns knip would see for `repoRoot`.
 *
 * Three outcomes, deliberately distinct — collapsing the first two is how a
 * broken configuration would come to look like an absent one:
 *
 *   skipped — nothing to check (no config file, no `package.json#knip`, or no
 *     resolvable `knip`). The gate exits 0. This is what makes it safe to wire
 *     into every consumer, matching `qa.gherkinLint`'s opt-in posture.
 *   error — a configuration exists but could not be resolved, or enumerates no
 *     entry points at all. The gate exits 2.
 *   resolved — `patterns` carries every declared entry, top-level and
 *     per-workspace, with knip's trailing `!` production markers intact.
 *
 * @param {{ repoRoot: string, loadKnipSession?: () => Promise<object> }} opts
 * @returns {Promise<{
 *   patterns: string[],
 *   configFilePath: string | null,
 *   skipped: string | null,
 *   error: string | null,
 * }>}
 */
export async function resolveKnipEntryPatterns({
  repoRoot,
  loadKnipSession = importKnipSession,
}) {
  const nothing = { patterns: [], configFilePath: null };

  let createOptions;
  try {
    ({ createOptions } = await loadKnipSession());
  } catch (error) {
    return {
      ...nothing,
      skipped: `the "knip" package is not resolvable from ${repoRoot} (${error.message})`,
      error: null,
    };
  }
  if (typeof createOptions !== 'function') {
    return {
      ...nothing,
      skipped: null,
      error:
        'the installed "knip" does not export createOptions from "knip/session" — this gate needs knip 6 or newer',
    };
  }

  let options;
  try {
    options = await createOptions({ cwd: repoRoot, args: {} });
  } catch (error) {
    return {
      ...nothing,
      skipped: null,
      error: `cannot resolve the knip configuration: ${error.message}`,
    };
  }

  const configFilePath = options?.configFilePath ?? null;
  if (!configFilePath) {
    return {
      ...nothing,
      skipped: `no knip configuration found under ${repoRoot} (no config file, no package.json#knip)`,
      error: null,
    };
  }

  const { patterns, sawEntryArray } = collectEntryPatterns(
    options?.parsedConfig,
  );
  if (!sawEntryArray) {
    return {
      patterns: [],
      configFilePath,
      skipped: null,
      error: `${configFilePath} declares no "entry" array, at the top level or in any workspace`,
    };
  }

  return { patterns, configFilePath, skipped: null, error: null };
}

/**
 * Test-only seam. Not API — `collectEntryPatterns` is exercised directly so the
 * workspace-prefix and negation rules can be pinned without a fixture tree.
 */
export const __testing = Object.freeze({
  collectEntryPatterns,
  importKnipSession,
});

/**
 * checks/index.js — Discovery-based registry + runner for self-healing checks.
 *
 * This module is the single entry point for every consumer surface that
 * runs checks (preflight guards at `epic-deliver.js` / `story-close.js`, the
 * `npm test` wrapper, the `diagnose.js` CLI viewer, and the retro hook in
 * `retro-runner.js`). Each surface calls `runChecks({ scope, autoFix, state })`
 * with its own scope and gets back `{ findings, fixed }`.
 *
 * Registry shape (each sibling module exports):
 *
 *   {
 *     id: string,
 *     severity: 'blocker' | 'warning' | 'info',
 *     scope: string[],                              // may include 'retro'
 *     autoCorrect: 'auto' | 'refuse-and-print',
 *     detect(state): Promise<Finding | null>,
 *     fix?(state): Promise<{ ok: boolean, message: string }>,
 *   }
 *
 * Invariants enforced here (defense-in-depth — see README for the full
 * contract):
 *
 *   1. `scope === 'retro'` is read-only. `runChecks({ scope: 'retro',
 *      autoFix: true })` throws `'retro scope is read-only: autoFix must
 *      be false'` before any check runs. The retro-runner relies on this
 *      to keep retro stateless even if a future call site flips the flag.
 *
 *   2. `autoCorrect: 'refuse-and-print'` is hard-refusal. The runner will
 *      NEVER invoke a check's `fix()` unless `autoCorrect === 'auto'`,
 *      even if the check author later adds a `fix` body. This is what
 *      makes new fix implementations harmless until their author also
 *      opts in.
 *
 *   3. Phase split: `detect()` invocations fan out concurrently via
 *      `Promise.all` (Story #2463 — preflight subprocess batching), while
 *      `fix()` invocations remain strictly serial. `detect()` is
 *      read-only against the frozen `assembleState` object, so concurrent
 *      reads cannot race it; `fix()` may mutate the worktree, so its
 *      ordering is preserved by walking the registry-ordered findings
 *      array sequentially.
 *
 * Discovery happens once per process via `loadRegistry()`. The result is
 * cached; `clearRegistryCache()` is exported for tests that want to
 * exercise a different fixture directory.
 */

import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** @typedef {'blocker' | 'warning' | 'info'} Severity */
/** @typedef {'auto' | 'refuse-and-print'} AutoCorrect */

/**
 * @typedef {object} Finding
 * @property {string} id
 * @property {Severity} severity
 * @property {string} scope
 * @property {string} summary
 * @property {string} [detail]
 * @property {string} fixCommand
 * @property {boolean} autoCorrectable
 */

/**
 * @typedef {object} FixResult
 * @property {boolean} ok
 * @property {string} message
 * @property {string[]} [commandsRun]
 */

/**
 * @typedef {object} Check
 * @property {string} id
 * @property {Severity} severity
 * @property {string[]} scope
 * @property {AutoCorrect} autoCorrect
 * @property {(state: object) => Promise<Finding | null> | Finding | null} detect
 * @property {((state: object) => Promise<FixResult> | FixResult)=} fix
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Module-local registry cache. Keyed by the absolute directory it was
 * loaded from so tests with fixture directories don't poison the cache
 * for the real `lib/checks/` directory.
 *
 * @type {Map<string, Check[]>}
 */
const registryCache = new Map();

/**
 * Module names that are part of the runner infrastructure, not checks.
 * `loadRegistry()` filters these out of the readdir scan.
 *
 * @type {Set<string>}
 */
const NON_CHECK_FILES = new Set(['index.js', 'state.js']);

/**
 * Clear the registry cache. Tests call this between cases that load from
 * a fixture directory so a fresh registry is observed.
 */
export function clearRegistryCache() {
  registryCache.clear();
}

/**
 * Load all check modules in a directory. Defaults to the directory this
 * module lives in (`lib/checks/`). Synchronously enumerates `.js` files,
 * filters out the runner infrastructure (`index.js`, `state.js`), and
 * dynamically imports each remaining file. Each module must default-export
 * a check object (see contract above).
 *
 * @param {object} [opts]
 * @param {string} [opts.dir]  Override directory — used by tests to load
 *   from a fixture directory.
 * @returns {Promise<Check[]>}
 */
export async function loadRegistry({ dir = __dirname } = {}) {
  const absDir = path.resolve(dir);
  if (registryCache.has(absDir)) {
    return registryCache.get(absDir);
  }
  let entries;
  try {
    entries = readdirSync(absDir);
  } catch {
    // No directory → empty registry. The runner is still callable; it just
    // returns `{ findings: [], fixed: [] }` for every scope. This is the
    // shape the diagnose viewer expects when invoked on a fresh checkout
    // before any check modules have been authored.
    registryCache.set(absDir, []);
    return [];
  }
  const checks = [];
  for (const entry of entries) {
    if (!entry.endsWith('.js')) continue;
    if (NON_CHECK_FILES.has(entry)) continue;
    const full = path.join(absDir, entry);
    try {
      const st = statSync(full);
      if (!st.isFile()) continue;
    } catch {
      continue;
    }
    const mod = await import(pathToFileURL(full).href);
    const check = mod.default ?? mod.check ?? mod;
    if (!isValidCheck(check)) {
      throw new Error(
        `checks/loadRegistry: ${entry} does not export a valid check { id, severity, scope, autoCorrect, detect }`,
      );
    }
    checks.push(check);
  }
  registryCache.set(absDir, checks);
  return checks;
}

/**
 * Look up a single check by id from the default registry. Returns
 * `undefined` if no check has that id.
 *
 * @param {string} id
 * @param {object} [opts]
 * @param {string} [opts.dir]
 * @returns {Promise<Check | undefined>}
 */
export async function getCheck(id, opts) {
  const registry = await loadRegistry(opts);
  return registry.find((c) => c.id === id);
}

/**
 * Run all checks matching `scope` against `state`. The retro-readonly and
 * refuse-and-print invariants are enforced here, not in the check
 * modules — see the JSDoc on the file for the rationale.
 *
 * @param {object} opts
 * @param {string} [opts.scope]      Surface scope, e.g. 'story-close',
 *   'epic-deliver', 'retro', 'diagnose'. When omitted, every check runs.
 * @param {boolean} [opts.autoFix=false]  Invoke `fix()` for checks with
 *   `autoCorrect: 'auto'`. Forbidden when `scope === 'retro'`.
 * @param {object} opts.state        Probed state from `assembleState()`.
 * @param {object} [opts.registry]   Pre-loaded registry — bypasses
 *   `loadRegistry()`. Used by tests with fixture checks.
 * @param {string} [opts.dir]        Fixture directory for `loadRegistry`.
 * @returns {Promise<{ findings: Finding[], fixed: Array<Finding & { fixResult: FixResult }> }>}
 */
export async function runChecks({
  scope,
  autoFix = false,
  state,
  registry,
  dir,
} = {}) {
  if (scope === 'retro' && autoFix === true) {
    throw new Error('retro scope is read-only: autoFix must be false');
  }
  const checks = registry ?? (await loadRegistry({ dir }));
  const filtered = scope
    ? checks.filter((c) => Array.isArray(c.scope) && c.scope.includes(scope))
    : checks;

  // Phase 1 (read-only fan-out, Story #2463): run every `detect()` in
  // parallel via Promise.all. `state` is the frozen object returned by
  // `assembleState()`, so concurrent reads are race-free. Promise.all
  // preserves input order in its resolved array, so the
  // findings-by-registry-order contract that downstream consumers rely on
  // is upheld even though the detects themselves overlap in flight.
  const detected = await Promise.all(
    filtered.map((check) => Promise.resolve(check.detect(state))),
  );

  /** @type {Finding[]} */
  const findings = [];
  /** @type {Array<Finding & { fixResult: FixResult }>} */
  const fixed = [];

  // Phase 2 (mutation-bearing serial pass): walk the registry-ordered
  // detection results and apply fix() one at a time. fix() may mutate the
  // worktree (delete branches, rewrite refs), so running it concurrently
  // would race those mutations and scramble logs.
  for (let i = 0; i < filtered.length; i += 1) {
    const check = filtered[i];
    const finding = detected[i];
    if (!finding) continue;
    // Invariant #2: refuse-and-print is hard-refusal — never invoke fix(),
    // regardless of whether the author defined one. The flag is the gate.
    if (
      autoFix &&
      check.autoCorrect === 'auto' &&
      typeof check.fix === 'function'
    ) {
      const result = await check.fix(state);
      if (result?.ok) {
        fixed.push({ ...finding, fixResult: result });
        continue;
      }
      // fix() ran and failed → surface the finding as unfixed so the
      // operator sees both the original problem AND the failure detail.
      findings.push({
        ...finding,
        detail: [
          finding.detail,
          `auto-fix attempted and failed: ${result?.message ?? 'no message'}`,
        ]
          .filter(Boolean)
          .join('\n'),
      });
      continue;
    }
    findings.push(finding);
  }
  return { findings, fixed };
}

/**
 * Shape-validate a check module. Used by `loadRegistry()` to fail fast on
 * malformed modules rather than crashing later inside `runChecks()`.
 *
 * @param {unknown} candidate
 * @returns {candidate is Check}
 */
function isValidCheck(candidate) {
  if (!candidate || typeof candidate !== 'object') return false;
  const c = /** @type {Record<string, unknown>} */ (candidate);
  if (typeof c.id !== 'string' || !c.id) return false;
  if (
    !['blocker', 'warning', 'info'].includes(/** @type {string} */ (c.severity))
  ) {
    return false;
  }
  if (!Array.isArray(c.scope) || c.scope.length === 0) return false;
  if (
    !['auto', 'refuse-and-print'].includes(
      /** @type {string} */ (c.autoCorrect),
    )
  ) {
    return false;
  }
  if (typeof c.detect !== 'function') return false;
  if (c.fix !== undefined && typeof c.fix !== 'function') return false;
  return true;
}

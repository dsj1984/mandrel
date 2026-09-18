/**
 * Discovery-based registry and runner for self-healing checks; every surface
 * calls `runChecks({ scope, autoFix, state })`. Invariants: `retro` scope is
 * read-only; `fix()` runs only when `autoCorrect === 'auto'`; `detect()` fans
 * out concurrently, `fix()` stays serial.
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
 * Keyed by absolute directory so fixture registries never poison the real one.
 *
 * @type {Map<string, Check[]>}
 */
const registryCache = new Map();

/** @type {Set<string>} */
const NON_CHECK_FILES = new Set(['index.js', 'state.js']);

export function clearRegistryCache() {
  registryCache.clear();
}

/**
 * Import every check module in `dir`; each must default-export a {@link Check}.
 *
 * @param {object} [opts]
 * @param {string} [opts.dir]
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
    // No directory → empty registry, not an error.
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
 * @param {object} opts
 * @param {string} [opts.scope]      Omitted runs every check.
 * @param {boolean} [opts.autoFix=false]  Forbidden when `scope === 'retro'`.
 * @param {object} opts.state        From `assembleState()`.
 * @param {object} [opts.registry]   Pre-loaded registry.
 * @param {string} [opts.dir]
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

  // `state` is frozen, so concurrent detects are race-free; Promise.all keeps
  // registry order.
  const detected = await Promise.all(
    filtered.map((check) => Promise.resolve(check.detect(state))),
  );

  /** @type {Finding[]} */
  const findings = [];
  /** @type {Array<Finding & { fixResult: FixResult }>} */
  const fixed = [];

  // fix() mutates the worktree, so it runs serially.
  for (let i = 0; i < filtered.length; i += 1) {
    const check = filtered[i];
    const finding = detected[i];
    if (!finding) continue;
    // refuse-and-print never runs fix(), even if one is defined.
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

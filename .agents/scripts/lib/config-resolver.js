/**
 * Unified Configuration Resolver — facade (Epic #773 Story 6).
 *
 * Resolution chain: <project-root>/.agentrc.json → built-in defaults.
 * `.env` is loaded lazily once per resolved root via `loadEnv`.
 *
 * Responsibilities kept here:
 *   - The `.agentrc.json` load + `agentSettings` AJV gate.
 *   - The per-root cache.
 *   - Re-exporting every accessor that previously lived in this file. Consumer
 *     imports (`import { ... } from './config-resolver.js'`) resolve
 *     byte-identically; the implementations now live under `lib/config/`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveLimits } from './config/limits.js';
import { resolvePaths } from './config/paths.js';
import { resolveQuality } from './config/quality.js';
import { validateOrchestrationConfig } from './config/validate-orchestration.js';
import { getSettingsValidator } from './config-schema.js';
import { loadEnv } from './env-loader.js';

export {
  BASELINES_DEFAULTS,
  getBaselines,
  resolveBaselines,
} from './config/baselines.js';
// --- Re-exports (facade contract) ---
export { COMMANDS_DEFAULTS, getCommands } from './config/commands.js';
export {
  getLimits,
  getSignals,
  LIMITS_DEFAULTS,
  resolveLimits,
  SIGNALS_DEFAULTS,
} from './config/limits.js';
export { getPaths, PATHS_DEFAULTS, resolvePaths } from './config/paths.js';
export {
  AUTO_REFRESH_DEFAULTS,
  CODING_GUARDRAILS_DEFAULTS,
  getQuality,
  MAINTAINABILITY_CRAP_DEFAULTS,
  MAINTAINABILITY_QUALITY_DEFAULTS,
  PR_GATE_DEFAULTS,
  resolveAutoRefresh,
  resolveCodingGuardrails,
  resolveMaintainabilityCrap,
  resolveMaintainabilityQuality,
  resolvePrGate,
  resolveQuality,
} from './config/quality.js';
export { getRunners } from './config/runners.js';
export {
  resolveRuntime,
  resolveSessionId,
  resolveWorkingPath,
  resolveWorktreeEnabled,
} from './config/runtime.js';
export { resolveListValue } from './config/shared.js';
export { validateOrchestrationConfig } from './config/validate-orchestration.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// scripts/lib/ → scripts/ → .agents/ → project root
export const PROJECT_ROOT = path.resolve(__dirname, '../../..');

// Cache keyed by absolute root path so callers passing different cwds
// (e.g. per-worktree) each get their own resolved config.
const _cacheByRoot = new Map();
const _envLoadedRoots = new Set();

/**
 * Defaults applied to a loaded .agentrc.json. Narrower than the zero-config
 * set: fields intentionally omitted here (e.g. baseBranch) remain undefined
 * unless the operator set them explicitly. The `paths`, `quality`, and
 * `limits` blocks are filled in by their resolvers below, not here. The
 * seven `*Root` filesystem keys moved under `paths.*` in Epic #773
 * Story 9; their defaults now live in {@link PATHS_DEFAULTS}.
 */
const LOADED_CONFIG_DEFAULTS = Object.freeze({
  docsContextFiles: [
    'architecture.md',
    'data-dictionary.md',
    'decisions.md',
    'patterns.md',
  ],
});

/** Defaults for the zero-config (no .agentrc.json present) path. Same omission
 * rule as {@link LOADED_CONFIG_DEFAULTS}; zero-config callers that need the
 * required path roots must declare a `.agentrc.json`. */
const ZERO_CONFIG_DEFAULTS = Object.freeze({
  docsContextFiles: [
    'architecture.md',
    'data-dictionary.md',
    'decisions.md',
    'patterns.md',
  ],
  baseBranch: 'main',
});

/** Keys filled in on a loaded config when the operator omitted them. `quality`,
 * `paths`, and `limits` are intentionally absent — they are filled by their
 * resolvers (deep-merge, not top-level fill) right after this loop runs. */
const LOADED_CONFIG_APPLY_KEYS = ['docsContextFiles', 'baseBranch'];

/**
 * Extract the flat agentSettings bag from whichever config format is present.
 * Results are cached per resolved root path to avoid redundant file I/O.
 *
 * Error policy:
 *   - File missing (ENOENT) → fall through to built-in defaults (zero-config).
 *   - File present but malformed JSON → throw immediately (config corruption is
 *     a fatal error, not a silent fallback scenario).
 *
 * @param {{ bustCache?: boolean, cwd?: string, validate?: boolean, ctx?: object }} [opts]
 *   - `cwd`: absolute path to the directory whose `.agentrc.json` should be
 *     loaded. Defaults to the framework's `PROJECT_ROOT`. Worktree-mode
 *     callers pass the worktree path so each worktree resolves its own config.
 *   - `bustCache`: force re-read for the resolved root.
 *   - `validate`: when `false`, skip `validateOrchestrationConfig()`. Default
 *     `true`. Only unit tests that feed deliberately-malformed configs should
 *     opt out; production callers must leave it on so a broken orchestration
 *     block fails loudly at load time instead of mid-run.
 *   - `ctx`: runtime context from `lib/runtime-context.js`. When provided,
 *     `ctx.fs` is used for `.agentrc.json` I/O instead of the module-level
 *     `node:fs`.
 * @returns {{ agentSettings: object, orchestration: object|null, raw: object|null, source: string }}
 *   The `agentSettings` key mirrors the on-disk `.agentrc.json` field name so
 *   destructure sites read identically to the file shape they describe. The
 *   accessors (`getLimits`, `getQuality`, `getPaths`, `getCommands`,
 *   `getBaselines`) accept this wrapper *or* a bare `agentSettings` bag — the
 *   two-shape contract documented on each accessor.
 */
export function resolveConfig(opts) {
  // Test-only override: `AP_AGENTRC_CWD` lets fixture tests point launcher
  // subprocesses at a temp dir holding a synthetic `.agentrc.json`, without
  // disk-swapping the real project config and racing against parallel tests.
  const envCwd = process.env.AP_AGENTRC_CWD;
  const root = path.resolve(opts?.cwd ?? envCwd ?? PROJECT_ROOT);
  const validate = opts?.validate !== false;
  const fsImpl = opts?.ctx?.fs ?? fs;

  if (!opts?.bustCache && _cacheByRoot.has(root)) {
    return _cacheByRoot.get(root);
  }

  // Lazy .env load: deferred from module scope so importing this module
  // never mutates process.env as a side effect. Loaded once per root.
  if (!_envLoadedRoots.has(root)) {
    loadEnv(root);
    _envLoadedRoots.add(root);
  }

  const agentrcPath = path.join(root, '.agentrc.json');
  if (fsImpl.existsSync(agentrcPath)) {
    let raw;
    try {
      raw = JSON.parse(fsImpl.readFileSync(agentrcPath, 'utf8'));
    } catch (parseErr) {
      throw new Error(
        `[config] Failed to parse .agentrc.json: ${parseErr.message}. ` +
          `Fix the JSON syntax before proceeding.`,
      );
    }

    const agentSettings = raw.agentSettings ?? {};

    const validateSettings = getSettingsValidator();
    if (!validateSettings(agentSettings)) {
      const details = validateSettings.errors
        .map((e) => `${e.instancePath || '(agentSettings)'} ${e.message}`)
        .join(', ');
      throw new Error(
        `[config] Invalid agentSettings in .agentrc.json: ${details}`,
      );
    }

    const orchestration = raw.orchestration ?? null;

    for (const key of LOADED_CONFIG_APPLY_KEYS) {
      agentSettings[key] = agentSettings[key] ?? LOADED_CONFIG_DEFAULTS[key];
    }

    agentSettings.quality = resolveQuality(agentSettings.quality);
    agentSettings.paths = resolvePaths(agentSettings.paths);
    agentSettings.limits = resolveLimits(agentSettings.limits);

    if (validate) validateOrchestrationConfig(orchestration);

    const resolved = { agentSettings, orchestration, raw, source: agentrcPath };
    _cacheByRoot.set(root, resolved);
    return resolved;
  }

  // Hard-coded defaults (zero-config experience)
  const zeroAgentSettings = { ...ZERO_CONFIG_DEFAULTS };
  zeroAgentSettings.quality = resolveQuality(zeroAgentSettings.quality);
  zeroAgentSettings.paths = resolvePaths(zeroAgentSettings.paths);
  zeroAgentSettings.limits = resolveLimits(zeroAgentSettings.limits);
  const resolved = {
    agentSettings: zeroAgentSettings,
    orchestration: null,
    audits: null,
    raw: null,
    source: 'built-in defaults',
  };
  _cacheByRoot.set(root, resolved);
  return resolved;
}

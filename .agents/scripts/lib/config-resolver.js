/**
 * Unified Configuration Resolver — facade (Epic #1720 Story #1739).
 *
 * Resolution chain: `<project-root>/.agentrc.local.json` (optional) →
 * `.agentrc.json` → built-in defaults. Object keys deep-merge; absent local
 * file is a no-op.
 * `.env` is loaded lazily once per resolved root via `loadEnv`.
 *
 * Post-reshape, `.agentrc.json` declares four top-level blocks:
 * `project`, `github`, `planning`, `delivery`. The resolver runs the
 * full-document AJV gate (`AGENTRC_SCHEMA`) on load and returns a wrapper
 * carrying each block plus a `raw`/`source` metadata pair.
 *
 * Hard cutover (Epic #2880, Story #2947): both the input-side and
 * output-side legacy shapes are gone. Legacy `agentSettings.*` /
 * `orchestration.*` input documents are rejected by the AJV schema
 * (`additionalProperties: false` at the top level), and the previously
 * synthesized `agentSettings` / `orchestration` output pointers have been
 * deleted from the resolver wrapper. Every internal call site reads the
 * canonical `project` / `github` / `planning` / `delivery` blocks
 * directly; consumers upgrade in lockstep with the framework bump
 * (see `.agents/rules/git-conventions-reference.md#contract-cutovers-—-no-shim-layer`).
 */

import fs from 'node:fs';
import path from 'node:path';
import { getCiDelivery } from './config/ci.js';
import { getCommands } from './config/commands.js';
import { getGitHub } from './config/github.js';
import { resolvePaths } from './config/paths.js';
import { validateOrchestrationConfig } from './config/validate-orchestration.js';
import { getWorktreeIsolation } from './config/worktree-isolation.js';
import { getAgentrcValidator } from './config-schema.js';
import { loadEnv } from './env-loader.js';
import { PROJECT_ROOT } from './project-root.js';

export { getAcceptanceEval } from './config/acceptance-eval.js';
export { BASELINES_DEFAULTS, getBaselines } from './config/baselines.js';
export { CI_DELIVERY_DEFAULTS, getCiDelivery } from './config/ci.js';
export { COMMANDS_DEFAULTS, getCommands } from './config/commands.js';
export { NOTIFICATIONS_DEFAULTS } from './config/github.js';
export {
  getLimits,
  LIMITS_DEFAULTS,
} from './config/limits.js';
export { getPaths } from './config/paths.js';
export {
  CODING_GUARDRAILS_DEFAULTS,
  getQuality,
  resolveCodingGuardrails,
  resolveMaintainabilityCrap,
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
export {
  defaultNodeModulesStrategy,
  WORKTREE_ISOLATION_DEFAULTS,
} from './config/worktree-isolation.js';
export { PROJECT_ROOT } from './project-root.js';

// Cache keyed by absolute root path so callers passing different cwds
// (e.g. per-worktree) each get their own resolved config.
const _cacheByRoot = new Map();
const _envLoadedRoots = new Set();

/**
 * Enrich `github.notifications` with NOTIFICATIONS_DEFAULTS so an omitted
 * block doesn't suppress notify.js's comment/webhook channels (which read
 * the shim directly and treat an empty allowlist as "channel off").
 */
function applyGithubDefaults(rawGithub) {
  if (!rawGithub) return null;
  return {
    ...rawGithub,
    notifications: getGitHub({ github: rawGithub }).notifications,
  };
}

/**
 * Enrich `project.commands` so an omitted field resolves to COMMANDS_DEFAULTS
 * rather than `undefined` — callers that read `project.commands.test` etc.
 * directly (without going through `getCommands()`) get the framework value.
 */
function applyCommandsDefaults(project) {
  return { ...project, commands: getCommands({ project }) };
}

/**
 * Enrich `delivery.worktreeIsolation` so an omitted field resolves to
 * WORKTREE_ISOLATION_DEFAULTS. Critical for `enabled`/`root` —
 * `Boolean(undefined) === false` previously disabled worktrees silently
 * when the operator omitted the block.
 */
function applyDeliveryDefaults(rawDelivery) {
  const delivery = { ...(rawDelivery ?? {}) };
  delivery.worktreeIsolation = getWorktreeIsolation({
    worktreeIsolation: delivery.worktreeIsolation,
  });
  // `delivery.ci` always carries autoMerge (and passes watch through) so
  // CI-aware delivery knobs resolve without operator opt-in.
  delivery.ci = getCiDelivery({ ci: delivery.ci });
  return delivery;
}

/**
 * Apply framework defaults for the four top-level blocks. Pure (no
 * mutation) — returns a fresh object.
 */
/**
 * Deep-merge plain objects for the `.agentrc.local.json` overlay. Arrays and
 * scalars from `override` replace the base value at that key.
 *
 * @param {unknown} base
 * @param {unknown} override
 * @returns {unknown}
 */
function deepMergeObjects(base, override) {
  if (
    override === null ||
    typeof override !== 'object' ||
    Array.isArray(override)
  ) {
    return override;
  }
  if (base === null || typeof base !== 'object' || Array.isArray(base)) {
    return { ...override };
  }
  const out = { ...base };
  for (const key of Object.keys(override)) {
    const baseVal = base[key];
    const overrideVal = override[key];
    if (
      overrideVal !== null &&
      typeof overrideVal === 'object' &&
      !Array.isArray(overrideVal) &&
      baseVal !== null &&
      typeof baseVal === 'object' &&
      !Array.isArray(baseVal)
    ) {
      out[key] = deepMergeObjects(baseVal, overrideVal);
    } else {
      out[key] = overrideVal;
    }
  }
  return out;
}

/** @param {import('node:fs')} fsImpl */
function readJsonConfigFile(fsImpl, filePath, label) {
  try {
    return JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
  } catch (parseErr) {
    throw new Error(
      `[config] Failed to parse ${label}: ${parseErr.message}. ` +
        `Fix the JSON syntax before proceeding.`,
    );
  }
}

const ZERO_CONFIG_RAW = Object.freeze({
  project: {
    paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
  },
});

function applyDefaults(raw) {
  const project = applyCommandsDefaults({ ...(raw.project ?? {}) });
  // Default docsContextFiles list — same five files the framework has
  // always shipped, preserved here so zero-config callers and configs
  // that omit the list both get the canonical mandatory-reads set.
  if (project.docsContextFiles == null) {
    project.docsContextFiles = [
      'architecture.md',
      'data-dictionary.md',
      'decisions.md',
      'patterns.md',
    ];
  }
  if (project.baseBranch == null) {
    project.baseBranch = 'main';
  }
  project.paths = resolvePaths(project.paths);
  return {
    project,
    github: applyGithubDefaults(raw.github),
    planning: raw.planning ?? {},
    delivery: applyDeliveryDefaults(raw.delivery),
    // `qa` is an optional top-level block (agentrc.schema.json
    // `#/$defs/qa`). It needs no default-layering — the harness resolver
    // (`resolveQaContract`) owns normalization and required-field
    // enforcement — it only needs to survive the reshape so
    // `/qa-run` Step 0 can read it off the resolved wrapper.
    ...(raw.qa !== undefined ? { qa: raw.qa } : {}),
  };
}

/**
 * Load + validate `.agentrc.json` and return the resolved wrapper.
 *
 * Returned shape:
 *   {
 *     project, github, planning, delivery,  // post-reshape canonical blocks
 *     qa,                                    // optional QA-harness block (present iff authored)
 *     raw, source,
 *   }
 *
 * Error policy:
 *   - File missing (ENOENT) → fall through to built-in defaults (zero-config).
 *   - File present but malformed JSON → throw immediately.
 *   - Schema validation failure → throw with a single-line error list.
 *
 * @param {{ bustCache?: boolean, cwd?: string, validate?: boolean, ctx?: object }} [opts]
 */
export function resolveConfig(opts) {
  const envCwd = process.env.AP_AGENTRC_CWD;
  const root = path.resolve(opts?.cwd ?? envCwd ?? PROJECT_ROOT);
  const validate = opts?.validate !== false;
  const fsImpl = opts?.ctx?.fs ?? fs;

  if (!opts?.bustCache && _cacheByRoot.has(root)) {
    return _cacheByRoot.get(root);
  }

  if (!_envLoadedRoots.has(root)) {
    loadEnv(root);
    _envLoadedRoots.add(root);
  }

  const agentrcPath = path.join(root, '.agentrc.json');
  const localPath = path.join(root, '.agentrc.local.json');
  const hasAgentrc = fsImpl.existsSync(agentrcPath);
  const hasLocal = fsImpl.existsSync(localPath);

  if (!hasAgentrc && !hasLocal) {
    const blocks = applyDefaults({ ...ZERO_CONFIG_RAW });
    const resolved = {
      ...blocks,
      raw: null,
      source: 'built-in defaults',
    };
    _cacheByRoot.set(root, resolved);
    return resolved;
  }

  let raw = hasAgentrc
    ? readJsonConfigFile(fsImpl, agentrcPath, '.agentrc.json')
    : { ...ZERO_CONFIG_RAW };

  let source = hasAgentrc ? agentrcPath : 'built-in defaults';

  if (hasLocal) {
    const localRaw = readJsonConfigFile(
      fsImpl,
      localPath,
      '.agentrc.local.json',
    );
    raw = deepMergeObjects(raw, localRaw);
    source =
      source === 'built-in defaults'
        ? `${localPath} (overrides built-in defaults)`
        : `${localPath} (overrides ${agentrcPath})`;
  }

  if (validate) {
    const validateAgentrc = getAgentrcValidator();
    if (!validateAgentrc(raw)) {
      const details = (validateAgentrc.errors || [])
        .map((e) => `${e.instancePath || '(root)'} ${e.message}`)
        .join(', ');
      throw new Error(`[config] Invalid .agentrc.json: ${details}`);
    }
  }

  const blocks = applyDefaults(raw);

  if (validate) validateOrchestrationConfig(blocks);

  const resolved = {
    ...blocks,
    raw,
    source,
  };
  _cacheByRoot.set(root, resolved);
  return resolved;
}

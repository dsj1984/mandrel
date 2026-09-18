/**
 * Configuration resolver facade: `.agentrc.local.json` deep-merges over
 * `.agentrc.json` over built-in defaults, validated against `AGENTRC_SCHEMA`
 * on load. `.env` loads lazily once per resolved root.
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
  CODING_GUARDRAILS,
  getQuality,
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
  getWorktreeIsolation,
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
 * Omitted `worktreeIsolation` fields resolve to defaults — otherwise an
 * absent `enabled` reads as false and silently disables worktrees.
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
    // Passed through as authored; `resolveQaContract` owns normalization.
    ...(raw.qa !== undefined ? { qa: raw.qa } : {}),
  };
}

/**
 * Returns `{ project, github, planning, delivery, qa?, raw, source }`. A
 * missing file falls back to defaults; malformed JSON or a schema failure
 * throws.
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

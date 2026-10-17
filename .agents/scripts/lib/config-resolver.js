/**
 * Configuration resolver facade: `.agentrc.local.json` deep-merges over
 * `.agentrc.json` over built-in defaults, validated against `AGENTRC_SCHEMA`
 * on load. `.env` loads lazily once per resolved root.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  deepMergeObjects,
  formatAgentrcErrors,
} from './config/agentrc-overlay.js';
import { getCiDelivery } from './config/ci.js';
import { getCommands } from './config/commands.js';
import { overlayRoot, resolveAgentrcRoot } from './config/git-roots.js';
import { getGitHub } from './config/github.js';
import { resolvePaths } from './config/paths.js';
import { validateOrchestrationConfig } from './config/validate-orchestration.js';
import { getWorktreeIsolation } from './config/worktree-isolation.js';
import { getAgentrcValidator } from './config-schema.js';
import { loadEnv } from './env-loader.js';

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

// Keyed by absolute root + validate mode, so per-worktree cwds and a
// `validate: false` read never answer a validating caller.
const _cacheByKey = new Map();
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
 * The merged raw config and a human description of where it came from;
 * `raw: null` when neither file exists (zero-config).
 *
 * @param {import('node:fs')} fsImpl
 * @param {string} root
 * @returns {{ raw: object|null, source: string }}
 */
function readRawConfig(fsImpl, root) {
  const agentrcPath = path.join(root, '.agentrc.json');
  const localPath = path.join(
    overlayRoot(root, { fsImpl }),
    '.agentrc.local.json',
  );
  const hasAgentrc = fsImpl.existsSync(agentrcPath);
  const hasLocal = fsImpl.existsSync(localPath);
  if (!hasAgentrc) {
    if (!hasLocal) return { raw: null, source: 'built-in defaults' };
    return {
      raw: deepMergeObjects(
        { ...ZERO_CONFIG_RAW },
        readJsonConfigFile(fsImpl, localPath, '.agentrc.local.json'),
      ),
      source: `${localPath} (overrides built-in defaults)`,
    };
  }
  const raw = readJsonConfigFile(fsImpl, agentrcPath, '.agentrc.json');
  if (!hasLocal) return { raw, source: agentrcPath };
  return {
    raw: deepMergeObjects(
      raw,
      readJsonConfigFile(fsImpl, localPath, '.agentrc.local.json'),
    ),
    source: `${localPath} (overrides ${agentrcPath})`,
  };
}

/** @param {object} raw */
function assertSchemaValid(raw) {
  const validateAgentrc = getAgentrcValidator();
  if (!validateAgentrc(raw)) {
    const details = formatAgentrcErrors(validateAgentrc.errors).join(', ');
    throw new Error(`[config] Invalid .agentrc.json: ${details}`);
  }
}

/**
 * Defaults applied over `raw`; a zero-config read is never validated.
 *
 * @param {{ raw: object|null, source: string }} read
 * @param {boolean} validate
 */
function finalizeConfig({ raw, source }, validate) {
  const checked = validate && raw !== null;
  if (checked) assertSchemaValid(raw);
  const blocks = applyDefaults(raw ?? { ...ZERO_CONFIG_RAW });
  if (checked) validateOrchestrationConfig(blocks);
  return { ...blocks, raw, source };
}

function ensureEnvLoaded(root) {
  if (_envLoadedRoots.has(root)) return;
  loadEnv(root);
  _envLoadedRoots.add(root);
}

/**
 * Returns `{ project, github, planning, delivery, qa?, raw, source }`. A
 * missing file falls back to defaults; malformed JSON or a schema failure
 * throws. The root is `resolveAgentrcRoot`'s; `GH_CONFIG_DIR` is gh-exec's. A call
 * with an injected `ctx.fs` neither reads nor fills the shared cache.
 *
 * @param {{ bustCache?: boolean, cwd?: string, validate?: boolean, ctx?: object }} [opts]
 */
export function resolveConfig(opts) {
  const root = resolveAgentrcRoot({ cwd: opts?.cwd });
  const validate = opts?.validate !== false;
  const injectedFs = opts?.ctx?.fs;
  const key = `${root}\0${validate}`;
  if (!injectedFs && !opts?.bustCache && _cacheByKey.has(key)) {
    return _cacheByKey.get(key);
  }
  ensureEnvLoaded(root);
  const resolved = finalizeConfig(
    readRawConfig(injectedFs ?? fs, root),
    validate,
  );
  if (!injectedFs) _cacheByKey.set(key, resolved);
  return resolved;
}

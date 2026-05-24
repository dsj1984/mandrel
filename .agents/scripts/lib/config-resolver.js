/**
 * Unified Configuration Resolver — facade (Epic #1720 Story #1739).
 *
 * Resolution chain: `<project-root>/.agentrc.json` → built-in defaults.
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
 * (see `.agents/rules/git-conventions.md#contract-cutovers-—-no-shim-layer`).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCiDelivery } from './config/ci.js';
import { getCommands } from './config/commands.js';
import { getGitHub } from './config/github.js';
import { getLifecycle } from './config/lifecycle.js';
import { resolvePaths } from './config/paths.js';
import { validateOrchestrationConfig } from './config/validate-orchestration.js';
import { getWorktreeIsolation } from './config/worktree-isolation.js';
import { getAgentrcValidator } from './config-schema.js';
import { loadEnv } from './env-loader.js';

export {
  BASELINES_DEFAULTS,
  getBaselines,
  resolveBaselines,
} from './config/baselines.js';
export { CI_DELIVERY_DEFAULTS, getCiDelivery } from './config/ci.js';
export { COMMANDS_DEFAULTS, getCommands } from './config/commands.js';
export {
  BRANCH_PROTECTION_DEFAULTS,
  DEFAULT_REQUIRED_CHECKS,
  getGitHub,
  MERGE_METHODS_DEFAULTS,
  NOTIFICATIONS_DEFAULTS,
} from './config/github.js';
export {
  getHydration,
  HYDRATION_DEFAULTS,
  resolveHydration,
} from './config/hydration.js';
export { getLifecycle, LIFECYCLE_DEFAULTS } from './config/lifecycle.js';
export {
  getLimits,
  getSignals,
  LIMITS_DEFAULTS,
  resolveLimits,
  SIGNALS_DEFAULTS,
} from './config/limits.js';
export { getPaths, PATHS_DEFAULTS, resolvePaths } from './config/paths.js';
export { getPreflight, PREFLIGHT_DEFAULTS } from './config/preflight.js';
export {
  AUTO_REFRESH_DEFAULTS,
  CODING_GUARDRAILS_DEFAULTS,
  getQuality,
  MAINTAINABILITY_CRAP_DEFAULTS,
  MAINTAINABILITY_QUALITY_DEFAULTS,
  resolveAutoRefresh,
  resolveCodingGuardrails,
  resolveMaintainabilityCrap,
  resolveMaintainabilityQuality,
  resolveQuality,
} from './config/quality.js';
export {
  DEFAULT_DECOMPOSER,
  DEFAULT_STORY_MERGE_RETRY,
  getRunners,
} from './config/runners.js';
export {
  resolveRuntime,
  resolveSessionId,
  resolveWorkingPath,
  resolveWorktreeEnabled,
} from './config/runtime.js';
export { resolveListValue } from './config/shared.js';
export { validateOrchestrationConfig } from './config/validate-orchestration.js';
export {
  getWorktreeIsolation,
  WORKTREE_ISOLATION_DEFAULTS,
} from './config/worktree-isolation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// scripts/lib/ → scripts/ → .agents/ → project root
export const PROJECT_ROOT = path.resolve(__dirname, '../../..');

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
  delivery.lifecycle = getLifecycle({ lifecycle: delivery.lifecycle });
  // Story #2899 (Epic #2880) — `delivery.ci` always carries
  // `skipForStoryPushes: true` by default so task-commit.js applies the
  // `[skip ci]` trailer without operator opt-in.
  delivery.ci = getCiDelivery({ ci: delivery.ci });
  return delivery;
}

/**
 * Apply framework defaults for the four top-level blocks. Pure (no
 * mutation) — returns a fresh object.
 */
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
  };
}

/**
 * Load + validate `.agentrc.json` and return the resolved wrapper.
 *
 * Returned shape:
 *   {
 *     project, github, planning, delivery,  // post-reshape canonical blocks
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
      source: agentrcPath,
    };
    _cacheByRoot.set(root, resolved);
    return resolved;
  }

  // Hard-coded defaults (zero-config experience).
  const zeroRaw = {
    project: {
      paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
    },
  };
  const blocks = applyDefaults(zeroRaw);
  const resolved = {
    ...blocks,
    raw: null,
    source: 'built-in defaults',
  };
  _cacheByRoot.set(root, resolved);
  return resolved;
}

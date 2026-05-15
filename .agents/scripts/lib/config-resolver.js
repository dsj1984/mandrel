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
 * Hard cutover: legacy `agentSettings.*` / `orchestration.*` documents are
 * rejected up front by the AJV schema. Consumers update their
 * `.agentrc.json` in lockstep with the framework bump.
 *
 * Backwards-compat shim: the returned object additionally exposes
 * `agentSettings` and `orchestration` pointers that surface a synthesized
 * view of the legacy shape, so call sites that haven't migrated yet keep
 * reading the same fields. The shim is read-only and converges on the
 * post-reshape paths internally.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getGitHub } from './config/github.js';
import { resolveLimits } from './config/limits.js';
import { resolvePaths } from './config/paths.js';
import { resolveQuality } from './config/quality.js';
import { validateOrchestrationConfig } from './config/validate-orchestration.js';
import { getAgentrcValidator } from './config-schema.js';
import { loadEnv } from './env-loader.js';

export {
  BASELINES_DEFAULTS,
  getBaselines,
  resolveBaselines,
} from './config/baselines.js';
export { COMMANDS_DEFAULTS, getCommands } from './config/commands.js';
export {
  BRANCH_PROTECTION_DEFAULTS,
  DEFAULT_REQUIRED_CHECKS,
  getGitHub,
  MERGE_METHODS_DEFAULTS,
  NOTIFICATIONS_DEFAULTS,
} from './config/github.js';
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// scripts/lib/ → scripts/ → .agents/ → project root
export const PROJECT_ROOT = path.resolve(__dirname, '../../..');

// Cache keyed by absolute root path so callers passing different cwds
// (e.g. per-worktree) each get their own resolved config.
const _cacheByRoot = new Map();
const _envLoadedRoots = new Set();

/**
 * Apply framework defaults for the four top-level blocks. Pure (no
 * mutation) — returns a fresh object.
 */
function applyDefaults(raw) {
  const project = { ...(raw.project ?? {}) };
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
  // Enrich `github.notifications` with NOTIFICATIONS_DEFAULTS so an omitted
  // block doesn't suppress notify.js's comment/webhook channels (which read
  // the shim directly and treat an empty allowlist as "channel off").
  const github = raw.github
    ? { ...raw.github, notifications: getGitHub({ github: raw.github }).notifications }
    : null;
  return {
    project,
    github,
    planning: raw.planning ?? {},
    delivery: raw.delivery ?? {},
  };
}

/**
 * Build the legacy-shape compatibility shim. Lets call sites that still
 * read `config.agentSettings.*` / `config.orchestration.*` keep working
 * during the migration sweep (Task #1761). The shim surfaces the
 * post-reshape blocks under their old paths — read-only and the values
 * stay reference-equal to the canonical blocks.
 */
function buildLegacyShim(blocks) {
  const { project, github, planning, delivery } = blocks;
  const resolvedQuality = resolveQuality(delivery?.quality);
  return {
    agentSettings: {
      baseBranch: project.baseBranch,
      paths: project.paths,
      docsContextFiles: project.docsContextFiles,
      commands: project.commands ?? {},
      planning,
      quality: resolvedQuality,
      limits: resolveLimits({ planning, delivery }),
    },
    orchestration: github
      ? {
          provider: 'github',
          github: {
            owner: github.owner,
            repo: github.repo,
            projectNumber: github.projectNumber ?? null,
            projectOwner: github.projectOwner ?? null,
            operatorHandle: github.operatorHandle,
          },
          notifications: github.notifications,
          worktreeIsolation: delivery?.worktreeIsolation ?? {},
          runners: {
            deliverRunner: delivery?.deliverRunner ?? {},
          },
        }
      : null,
  };
}

/**
 * Load + validate `.agentrc.json` and return the resolved wrapper.
 *
 * Returned shape:
 *   {
 *     project, github, planning, delivery,  // post-reshape canonical blocks
 *     agentSettings, orchestration,         // legacy-compat shim (read-only)
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
    const shim = buildLegacyShim(blocks);

    if (validate) validateOrchestrationConfig({ ...blocks, ...shim });

    const resolved = {
      ...blocks,
      ...shim,
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
  const shim = buildLegacyShim(blocks);
  const resolved = {
    ...blocks,
    ...shim,
    raw: null,
    source: 'built-in defaults',
  };
  _cacheByRoot.set(root, resolved);
  return resolved;
}

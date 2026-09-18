/**
 * Idempotent, additive installer for the quality-gates surface: guardrails
 * helper, pre-commit hook, npm scripts, config defaults, baseline merge
 * driver, and pruning the retired `baselines/epic/` tree.
 *
 * @module bootstrap/quality-bootstrap
 */

import { spawnSync as defaultSpawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getAgentrcDefaults, lookupPath } from '../config/defaults.js';
import { deepEqual } from '../json-utils.js';
import { ensureBaselineMergeDriver } from './baseline-merge-driver.js';

/** The framework's own pre-commit body. */
const FRAMEWORK_PRE_COMMIT = `node scripts/check-version-sync.js
npx lint-staged
# Story #1395 / Epic #1386: catch MI/CRAP drift at git-commit time so the
# agent refactors before the diff is closed. quality:preview wraps both gates
# with --changed-since HEAD --staged --json and exits non-zero on any
# threshold violation, blocking the commit and rendering the per-file delta
# table to stderr (via the gates inherited stdio).
node .agents/scripts/quality-preview.js --changed-since HEAD --staged
`;

/** Consumer pre-commit: only the load-bearing quality-preview line. */
export const DOWNSTREAM_PRE_COMMIT = `# Stabilized quality gates (Epic #1386 / Story #1401):
# catch MI/CRAP drift at git-commit time so the agent refactors before the
# diff is closed. quality:preview wraps both gates with --changed-since HEAD
# --staged and exits non-zero on any threshold violation, blocking the
# commit and rendering the per-file delta table to stderr.
node .agents/scripts/quality-preview.js --changed-since HEAD --staged
`;

/** Detects an installed quality-preview line in either body variant. */
export const PRE_COMMIT_MARKER =
  'node .agents/scripts/quality-preview.js --changed-since HEAD --staged';

/**
 * Mirrors `.agents/docs/agentrc-reference.json`. Other `autoRefresh` knobs are
 * fixed constants; seeding them would write an invalid config.
 */
const QUALITY_CONFIG_DEFAULTS = Object.freeze({
  autoRefresh: Object.freeze({ enabled: true }),
});

export const QUALITY_NPM_SCRIPTS = Object.freeze({
  'quality:preview':
    'node .agents/scripts/quality-preview.js --changed-since HEAD',
  'quality:watch': 'node .agents/scripts/quality-watch.js',
});

/** `null` when absent; parse errors propagate so a corrupt config fails loudly. */
function readJsonIfExists(p) {
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, 'utf8');
  return JSON.parse(raw);
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}

/**
 * @param {object} ctx
 * @param {string} ctx.projectRoot
 * @param {string} [ctx.frameworkRoot] - Defaults to `<projectRoot>/.agents`.
 */
export function ensureGuardrailsHelper(ctx) {
  const projectRoot = ctx.projectRoot;
  const target = path.join(
    projectRoot,
    '.agents',
    'workflows',
    'helpers',
    'code-quality-guardrails.md',
  );
  if (fs.existsSync(target)) {
    return { action: 'already-present', path: target };
  }
  const sourceRoot = ctx.frameworkRoot ?? path.join(projectRoot, '.agents');
  const source = path.join(
    sourceRoot,
    'workflows',
    'helpers',
    'code-quality-guardrails.md',
  );
  if (!fs.existsSync(source)) {
    return { action: 'missing-source', path: target };
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  return { action: 'copied', path: target };
}

/**
 * Create the hook when absent; an existing hook without the marker is never
 * overwritten — `custom-hook-skip` hands the operator the snippet to merge.
 *
 * @param {object} ctx
 * @param {string} ctx.projectRoot
 * @param {'framework'|'downstream'} [ctx.variant='downstream']
 */
export function ensurePreCommitHook(ctx) {
  const variant = ctx.variant ?? 'downstream';
  const body =
    variant === 'framework' ? FRAMEWORK_PRE_COMMIT : DOWNSTREAM_PRE_COMMIT;
  const huskyDir = path.join(ctx.projectRoot, '.husky');
  const hookPath = path.join(huskyDir, 'pre-commit');
  if (!fs.existsSync(hookPath)) {
    fs.mkdirSync(huskyDir, { recursive: true });
    fs.writeFileSync(hookPath, body, 'utf8');
    return {
      action: 'created',
      path: hookPath,
      variant,
      snippet: PRE_COMMIT_MARKER,
    };
  }
  const existing = fs.readFileSync(hookPath, 'utf8');
  if (existing.includes(PRE_COMMIT_MARKER)) {
    return {
      action: 'already-present',
      path: hookPath,
      variant,
      snippet: PRE_COMMIT_MARKER,
    };
  }
  return {
    action: 'custom-hook-skip',
    path: hookPath,
    variant,
    snippet: body,
    notice:
      'Custom .husky/pre-commit detected — leaving untouched. Append the snippet above so quality:preview runs at commit time.',
  };
}

/** Add missing quality npm scripts; existing values always win. */
export function ensureQualityNpmScripts(ctx) {
  const pkgPath = path.join(ctx.projectRoot, 'package.json');
  const pkg = readJsonIfExists(pkgPath);
  if (!pkg) {
    return { action: 'missing-package-json', path: pkgPath, scripts: {} };
  }
  pkg.scripts = pkg.scripts ?? {};
  const outcomes = {};
  let mutated = false;
  for (const [name, cmd] of Object.entries(QUALITY_NPM_SCRIPTS)) {
    if (typeof pkg.scripts[name] === 'string' && pkg.scripts[name].length > 0) {
      outcomes[name] = 'already-present';
    } else {
      pkg.scripts[name] = cmd;
      outcomes[name] = 'added';
      mutated = true;
    }
  }
  if (mutated) writeJson(pkgPath, pkg);
  return {
    action: mutated ? 'updated' : 'no-change',
    path: pkgPath,
    scripts: outcomes,
  };
}

/**
 * Set only keys that are absent AND differ from the framework default — a
 * default-equal write would be flagged `[REDUNDANT]` by sync-agentrc.
 * Default-equal keys are reported in `skippedKeys`.
 *
 * @param {object} target
 * @param {object} defaults
 * @param {object} frameworkDefaults — resolved defaults at the seed root.
 * @param {string} prefix — dotted path under construction.
 */
function mergeMissingKeys(
  target,
  defaults,
  frameworkDefaults = {},
  prefix = '',
) {
  const addedKeys = [];
  const skippedKeys = [];
  for (const [key, value] of Object.entries(defaults)) {
    const keyPath = prefix ? `${prefix}.${key}` : key;
    const frameworkValue =
      frameworkDefaults && typeof frameworkDefaults === 'object'
        ? frameworkDefaults[key]
        : undefined;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (!target[key] || typeof target[key] !== 'object') {
        target[key] = {};
      }
      const nested = mergeMissingKeys(
        target[key],
        value,
        frameworkValue ?? {},
        keyPath,
      );
      addedKeys.push(...nested.addedKeys);
      skippedKeys.push(...nested.skippedKeys);
      if (
        Object.keys(target[key]).length === 0 &&
        target[key] !== frameworkDefaults?.[key]
      ) {
        delete target[key];
      }
    } else if (target[key] === undefined) {
      if (deepEqual(value, frameworkValue)) {
        skippedKeys.push(keyPath);
      } else {
        target[key] = value;
        addedKeys.push(keyPath);
      }
    }
  }
  return { merged: target, addedKeys, skippedKeys };
}

/**
 * Seed missing quality defaults into `.agentrc.json`; writes nothing when the
 * file is absent (base bootstrap must run first).
 */
export function ensureQualityConfigDefaults(ctx) {
  const cfgPath = path.join(ctx.projectRoot, '.agentrc.json');
  const cfg = readJsonIfExists(cfgPath);
  if (!cfg) {
    return {
      action: 'missing-config',
      path: cfgPath,
      addedKeys: [],
      skippedKeys: [],
    };
  }
  const frameworkDefaults = getAgentrcDefaults();
  const frameworkQuality =
    lookupPath(frameworkDefaults, 'delivery.quality').value ?? {};
  const hadDelivery = Object.hasOwn(cfg, 'delivery');
  const hadQuality = hadDelivery && Object.hasOwn(cfg.delivery, 'quality');
  cfg.delivery = cfg.delivery ?? {};
  cfg.delivery.quality = cfg.delivery.quality ?? {};
  const { addedKeys, skippedKeys } = mergeMissingKeys(
    cfg.delivery.quality,
    QUALITY_CONFIG_DEFAULTS,
    frameworkQuality,
    'delivery.quality',
  );
  if (addedKeys.length > 0) {
    writeJson(cfgPath, cfg);
  } else {
    // Undo the scaffolding so memory matches disk.
    if (!hadQuality) delete cfg.delivery.quality;
    if (!hadDelivery) delete cfg.delivery;
  }
  return {
    action: addedKeys.length > 0 ? 'updated' : 'no-change',
    path: cfgPath,
    addedKeys,
    skippedKeys,
  };
}

/** Private: exporting it would add a dead-exports row. */
const LEGACY_EPIC_BASELINES_RELPATH = 'baselines/epic';

/**
 * Remove the inert per-Epic snapshot tree no reader consults. `git rm
 * --ignore-unmatch` stages it when tracked and no-ops otherwise; the caller
 * commits the delta.
 *
 * @param {object} ctx
 * @param {string} ctx.projectRoot
 * @param {typeof defaultSpawnSync} [ctx.spawnImpl]
 * @returns {{ action: 'absent'|'pruned', path: string, gitStatus?: number|null }}
 */
export function pruneLegacyEpicBaselines(ctx) {
  const target = path.join(ctx.projectRoot, 'baselines', 'epic');
  if (!fs.existsSync(target)) return { action: 'absent', path: target };
  const spawn = ctx.spawnImpl ?? defaultSpawnSync;
  const rm = spawn(
    'git',
    [
      'rm',
      '-r',
      '--quiet',
      '--ignore-unmatch',
      '--',
      LEGACY_EPIC_BASELINES_RELPATH,
    ],
    {
      cwd: ctx.projectRoot,
      encoding: 'utf-8',
      stdio: 'pipe',
      shell: false,
    },
  );
  fs.rmSync(target, { recursive: true, force: true });
  return { action: 'pruned', path: target, gitStatus: rm.status ?? null };
}

/**
 * @param {object} ctx
 * @param {string} ctx.projectRoot
 * @param {string} [ctx.frameworkRoot]
 * @param {'framework'|'downstream'} [ctx.variant]
 * @param {typeof defaultSpawnSync} [ctx.spawnImpl]
 */
export function applyQualityBootstrap(ctx) {
  return {
    helper: ensureGuardrailsHelper(ctx),
    hook: ensurePreCommitHook(ctx),
    scripts: ensureQualityNpmScripts(ctx),
    config: ensureQualityConfigDefaults(ctx),
    mergeDriver: ensureBaselineMergeDriver(ctx),
    legacyBaselines: pruneLegacyEpicBaselines(ctx),
  };
}

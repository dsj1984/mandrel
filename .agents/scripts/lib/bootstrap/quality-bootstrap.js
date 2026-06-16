/**
 * bootstrap/quality-bootstrap — Story #1401 (Epic #1386)
 *
 * Idempotent installer for the stabilized-quality-gates surface area on a
 * project clone. Performs four additive actions, each safe to re-run:
 *
 *   1. Copies the `code-quality-guardrails.md` helper into the project's
 *      `.agents/workflows/helpers/` (no-op when the helper is already present).
 *   2. Installs `.husky/pre-commit` carrying the `quality:preview` invocation
 *      that the framework ships, preserving any custom hook lines already in
 *      place. When a custom (non-framework) `pre-commit` exists, it is left
 *      untouched and the caller is told to merge in the snippet manually.
 *   3. Adds `quality:preview` and `quality:watch` npm scripts when missing.
 *      Existing scripts are preserved.
 *   4. Seeds `delivery.quality.codingGuardrails` and
 *      `delivery.quality.autoRefresh` defaults in `.agentrc.json` when
 *      the keys are absent. Existing values are preserved.
 *
 * Returns a structured summary so the bootstrap and update workflows can
 * surface exactly which actions ran and which were no-ops.
 *
 * Exports are pure-ish (filesystem effects only via the supplied paths) so
 * the test suite can drive the helper against a tmp directory.
 *
 * @module bootstrap/quality-bootstrap
 */

import fs from 'node:fs';
import path from 'node:path';
import { getAgentrcDefaults, lookupPath } from '../config/defaults.js';
import { deepEqual } from '../json-utils.js';

/**
 * The exact pre-commit body the framework ships. Kept as a single string so
 * the hook-installer can detect a verbatim framework hook (overwrite-safe)
 * vs a custom hook (preserve and warn).
 */
export const FRAMEWORK_PRE_COMMIT = `node scripts/check-version-sync.js
npx lint-staged
# Story #1395 / Epic #1386: catch MI/CRAP drift at git-commit time so the
# agent refactors before the diff is closed. quality:preview wraps both gates
# with --changed-since HEAD --staged --json and exits non-zero on any
# threshold violation, blocking the commit and rendering the per-file delta
# table to stderr (via the gates inherited stdio).
node .agents/scripts/quality-preview.js --changed-since HEAD --staged
`;

/**
 * Minimal pre-commit body for downstream projects that do not carry the
 * framework's `check-version-sync.js` script. Drops that line and the
 * `lint-staged` invocation (downstream may or may not have lint-staged
 * configured); keeps the quality-preview line which is the load-bearing
 * Epic #1386 addition.
 */
export const DOWNSTREAM_PRE_COMMIT = `# Stabilized quality gates (Epic #1386 / Story #1401):
# catch MI/CRAP drift at git-commit time so the agent refactors before the
# diff is closed. quality:preview wraps both gates with --changed-since HEAD
# --staged and exits non-zero on any threshold violation, blocking the
# commit and rendering the per-file delta table to stderr.
node .agents/scripts/quality-preview.js --changed-since HEAD --staged
`;

/**
 * Marker substring used to detect a framework-installed quality-preview line
 * inside a pre-commit hook regardless of which body variant is in use.
 */
export const PRE_COMMIT_MARKER =
  'node .agents/scripts/quality-preview.js --changed-since HEAD --staged';

/**
 * Default values seeded into `delivery.quality.{codingGuardrails,autoRefresh}`
 * when the keys are absent. Mirrors `.agents/docs/agentrc-reference.json` — keep in
 * sync when those numbers move.
 */
export const QUALITY_CONFIG_DEFAULTS = Object.freeze({
  codingGuardrails: Object.freeze({
    cyclomaticFlag: 8,
    cyclomaticMustFix: 12,
    miDropMustRefactor: 1.5,
    requireSiblingTest: false,
  }),
  autoRefresh: Object.freeze({
    enabled: true,
    miDropCap: 1.5,
    crapJumpCap: 5,
    scope: 'diff',
  }),
});

/**
 * NPM scripts seeded by the bootstrap. Existing values are preserved.
 */
export const QUALITY_NPM_SCRIPTS = Object.freeze({
  'quality:preview':
    'node .agents/scripts/quality-preview.js --changed-since HEAD',
  'quality:watch': 'node .agents/scripts/quality-watch.js',
});

/**
 * Read JSON from a path, returning `null` when the file does not exist.
 * Surfaces parse errors so callers can fail loudly on a corrupt config.
 */
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
 * Step 1 — Ensure the code-quality-guardrails helper is present under
 * `.agents/workflows/helpers/`. When the helper already exists we report
 * `already-present`. Otherwise the helper is copied from the framework source
 * if available, or skipped with a `missing-source` outcome the caller can
 * surface.
 *
 * @param {object} ctx
 * @param {string} ctx.projectRoot
 * @param {string} [ctx.frameworkRoot] - Path to the framework checkout
 *   (defaults to `<projectRoot>/.agents`). Tests pass an explicit path.
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
 * Step 2 — Install the `.husky/pre-commit` hook. Decision tree:
 *
 *   - No `.husky/pre-commit` file → write the requested body, action `created`.
 *   - File exists and already contains the quality-preview marker → no-op,
 *     action `already-present`.
 *   - File exists, does NOT contain the marker, and matches the framework
 *     body byte-for-byte → safe overwrite, action `updated`.
 *   - File exists, custom content → leave untouched and emit
 *     `custom-hook-skip` so the workflow can print the operator notice with
 *     the recommended snippet to merge in.
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

/**
 * Step 3 — Register the `quality:preview` and `quality:watch` npm scripts
 * in the project's `package.json`. Existing values are preserved
 * unconditionally; this helper only adds missing keys.
 *
 * Returns the per-script outcome so the workflow can surface which scripts
 * were added vs already present.
 */
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
 * Deep-merge the requested defaults into an object, only setting keys that
 * are absent AND whose intended value diverges from the framework default
 * at that dotted path. The runtime layers `getAgentrcDefaults()`
 * underneath the project config at read time, so a key whose intended
 * value equals the framework default would be written redundantly — and
 * would then be flagged `[REDUNDANT]` by the sync-agentrc helper on the
 * next /mandrel-update. Default-aware seeding keeps the two helpers from
 * contradicting each other.
 *
 * Returns `{ merged, addedKeys[] }` so the caller can report exactly
 * which keys were seeded. Pure-default writes are reported under
 * `skippedKeys[]` so callers can surface why the seed was a no-op.
 *
 * @param {object} target
 * @param {object} defaults — the values the caller would seed if
 *   default-blindness were the policy.
 * @param {object} frameworkDefaults — the framework's resolved defaults
 *   at the seed root. Compared to each intended write.
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
 * Step 4 — Seed the `delivery.quality.codingGuardrails` and
 * `delivery.quality.autoRefresh` defaults into `.agentrc.json`. Only
 * missing keys are added; existing values are preserved unconditionally
 * (including operator overrides that diverge from the framework defaults).
 *
 * When `.agentrc.json` does not exist the action is `missing-config` and
 * nothing is written — the project must complete its base bootstrap first.
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
    // No-op path — undo the scaffolding we inserted so the on-disk file
    // and the in-memory snapshot agree (defensive; nothing reads cfg
    // after this).
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

/**
 * Run all four steps in order. Composable wrapper used by the bootstrap
 * and update workflows. Each step's outcome is returned under its own key
 * so callers can render a per-action summary.
 *
 * @param {object} ctx
 * @param {string} ctx.projectRoot
 * @param {string} [ctx.frameworkRoot]
 * @param {'framework'|'downstream'} [ctx.variant]
 */
export function applyQualityBootstrap(ctx) {
  return {
    helper: ensureGuardrailsHelper(ctx),
    hook: ensurePreCommitHook(ctx),
    scripts: ensureQualityNpmScripts(ctx),
    config: ensureQualityConfigDefaults(ctx),
  };
}

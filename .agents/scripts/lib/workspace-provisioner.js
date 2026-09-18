/**
 * The single authority for copying gitignored workspace files (`.env`,
 * `.mcp.json`, local overrides) into a non-main checkout, so a worktree agent
 * honours local overrides instead of committed placeholders. Ad-hoc copy
 * logic elsewhere is a bug.
 */

import fs from 'node:fs';
import path from 'node:path';
import { NOOP_LOGGER } from './Logger.js';

// Keep in sync with `WORKTREE_ISOLATION_DEFAULTS.bootstrapFiles`. Often-absent
// overrides are safe: missing sources are skipped, never fatal.
export const DEFAULT_WORKSPACE_FILES = [
  '.env',
  '.mcp.json',
  '.agentrc.local.json',
  '.agents/instructions.local.md',
];

/**
 * `workspaceFiles` → legacy `worktreeIsolation.bootstrapFiles` (still
 * schema-accepted) → defaults.
 *
 * @param {object} [orchestrationConfig]
 * @returns {string[]}
 */
export function resolveWorkspaceFiles(orchestrationConfig) {
  const cfg = orchestrationConfig ?? {};
  if (Array.isArray(cfg.workspaceFiles)) return cfg.workspaceFiles.slice();
  const legacy = cfg.worktreeIsolation?.bootstrapFiles;
  if (Array.isArray(legacy)) return legacy.slice();
  return DEFAULT_WORKSPACE_FILES.slice();
}

/**
 * @param {string} name
 * @returns {string|null}  null on success, reason string on failure.
 */
function invalidNameReason(name) {
  if (typeof name !== 'string' || name.length === 0) return 'empty';
  const rel = path.normalize(name);
  if (rel.startsWith('..') || path.isAbsolute(rel) || rel.includes('\0')) {
    return 'traversal-or-absolute';
  }
  return null;
}

/**
 * Never overwrites a target file; missing sources are reported, not fatal.
 *
 * @param {object} opts
 * @param {string} opts.sourceRoot
 * @param {string} opts.targetWorktree
 * @param {string[]} [opts.files]
 * @param {object} [opts.logger]
 * @returns {{ copied: string[], skipped: string[], missing: string[] }}
 */
export function provision({
  sourceRoot,
  targetWorktree,
  files = DEFAULT_WORKSPACE_FILES,
  logger = NOOP_LOGGER,
}) {
  if (!sourceRoot || typeof sourceRoot !== 'string') {
    throw new Error('workspace-provisioner: sourceRoot is required');
  }
  if (!targetWorktree || typeof targetWorktree !== 'string') {
    throw new Error('workspace-provisioner: targetWorktree is required');
  }

  const result = { copied: [], skipped: [], missing: [] };
  if (!Array.isArray(files) || files.length === 0) return result;

  for (const name of files) {
    const reason = invalidNameReason(name);
    if (reason) {
      logger.warn(
        `workspace-provisioner: skipped invalid name='${name}' (${reason})`,
      );
      continue;
    }
    const rel = path.normalize(name);
    const src = path.join(sourceRoot, rel);
    if (!fs.existsSync(src)) {
      result.missing.push(rel);
      continue;
    }
    const dst = path.join(targetWorktree, rel);
    if (fs.existsSync(dst)) {
      logger.info(
        `workspace-provisioner: skipped path=${dst} (already exists)`,
      );
      result.skipped.push(rel);
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      logger.info(`workspace-provisioner: copied source=${src} target=${dst}`);
      result.copied.push(rel);
    } catch (err) {
      logger.warn(
        `workspace-provisioner: copy failed name=${name}: ${err.message}`,
      );
    }
  }
  return result;
}

/**
 * Throw if a required file is missing; with `sourceRoot`, the error carries a
 * paste-ready copy command.
 *
 * @param {object} opts
 * @param {string} opts.worktree
 * @param {string[]} [opts.files]
 * @param {string} [opts.sourceRoot]
 */
export function verify({
  worktree,
  files = DEFAULT_WORKSPACE_FILES,
  sourceRoot,
}) {
  if (!worktree || typeof worktree !== 'string') {
    throw new Error('workspace-provisioner: worktree is required');
  }
  const missing = [];
  for (const name of files) {
    if (invalidNameReason(name)) continue;
    const rel = path.normalize(name);
    const abs = path.join(worktree, rel);
    if (!fs.existsSync(abs)) missing.push({ name, rel, abs });
  }
  if (missing.length === 0) return;

  const namesList = missing.map((m) => m.name).join(', ');
  const pathsList = missing.map((m) => m.abs).join(', ');
  const lines = [
    `workspace-provisioner: required workspace file(s) missing from ${worktree}: ${namesList}`,
    `  missing path(s): ${pathsList}`,
  ];
  if (sourceRoot && typeof sourceRoot === 'string') {
    const copyCmd = process.platform === 'win32' ? 'copy /Y' : 'cp';
    for (const m of missing) {
      const src = path.join(sourceRoot, m.rel);
      lines.push(`  remediation: ${copyCmd} "${src}" "${m.abs}"`);
    }
  }
  throw new Error(lines.join('\n'));
}

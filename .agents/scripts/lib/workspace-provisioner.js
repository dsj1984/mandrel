/**
 * workspace-provisioner.js
 *
 * Central authority for populating a fresh worktree (or remote-runner checkout)
 * with gitignored workspace files — by default `.env`, `.mcp.json`, and the
 * operator's local-override files (`.agentrc.local.json`,
 * `.agents/instructions.local.md`) — plus any other files declared in
 * `.agentrc.json orchestration.workspaceFiles`. The local-override files are
 * provisioned so a worktree-isolated agent honors the §1.E local-override
 * contract (e.g. `github.operatorHandle`) rather than silently falling back to
 * the committed `.agentrc.json` placeholders. Every caller that needs these
 * files in a non-main checkout should go through this module; ad-hoc copy
 * logic elsewhere in the codebase is a bug.
 *
 * Public API:
 *   - `provision({ sourceRoot, targetWorktree, files?, logger? })` — copies
 *     each listed file from source to target, skipping any that already exist
 *     at the target. Returns `{ copied, skipped, missing }`.
 *   - `verify({ worktree, files?, sourceRoot? })` — throws when a required
 *     file is missing. When `sourceRoot` is passed, the error carries a
 *     copy-ready remediation command the operator can run verbatim.
 *   - `resolveWorkspaceFiles(orchestrationConfig)` — resolves the list honoring
 *     the new `orchestration.workspaceFiles` key, the legacy
 *     `orchestration.worktreeIsolation.bootstrapFiles`, and the default.
 *   - `DEFAULT_WORKSPACE_FILES` — `['.env', '.mcp.json', '.agentrc.local.json',
 *     '.agents/instructions.local.md']`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { NOOP_LOGGER } from './Logger.js';

// Keep in sync with `WORKTREE_ISOLATION_DEFAULTS.bootstrapFiles` in
// `./config/worktree-isolation.js`. The local-override files are listed even
// though they are frequently absent — `provision()` skips missing sources and
// `verify()` callers filter to files present at the source first, so a missing
// override never fails a worktree create.
export const DEFAULT_WORKSPACE_FILES = [
  '.env',
  '.mcp.json',
  '.agentrc.local.json',
  '.agents/instructions.local.md',
];

/**
 * Resolve the list of workspace files to provision.
 *
 * Precedence: explicit `orchestration.workspaceFiles` → legacy
 * `orchestration.worktreeIsolation.bootstrapFiles` → `DEFAULT_WORKSPACE_FILES`.
 *
 * @param {object} [orchestrationConfig]
 * @returns {string[]}
 */
export function resolveWorkspaceFiles(orchestrationConfig) {
  const cfg = orchestrationConfig ?? {};
  if (Array.isArray(cfg.workspaceFiles)) return cfg.workspaceFiles.slice();
  // Legacy `worktreeIsolation.bootstrapFiles` fallback — surviving callers:
  // tests/lib/workspace-provisioner.test.js, tests/lib/worktree/bootstrapper.test.js,
  // and consumer projects' `.agentrc.json` (config-schema still accepts it).
  const legacy = cfg.worktreeIsolation?.bootstrapFiles;
  if (Array.isArray(legacy)) return legacy.slice();
  return DEFAULT_WORKSPACE_FILES.slice();
}

/**
 * Validate a workspace-file name — must be relative, no `..`, no NULs, no
 * absolute paths.
 *
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
 * Copy configured workspace files from `sourceRoot` into `targetWorktree`.
 * Existing target files are preserved (never overwritten). Missing sources are
 * silently skipped and reported in the `missing` array.
 *
 * @param {object} opts
 * @param {string} opts.sourceRoot     Absolute path to the main repo.
 * @param {string} opts.targetWorktree Absolute path to the target worktree.
 * @param {string[]} [opts.files]      File list; defaults to DEFAULT_WORKSPACE_FILES.
 * @param {object} [opts.logger]       `{ info, warn, error }`.
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
 * Throw if any required workspace file is missing from `worktree`. Used as a
 * runtime guard (called right after every worktree create in
 * `single-story-init.js`) and as a test oracle.
 *
 * When `sourceRoot` is supplied, the thrown error carries the missing target
 * path and an exact `cp`/`copy` command the operator can paste to remediate.
 *
 * @param {object} opts
 * @param {string} opts.worktree
 * @param {string[]} [opts.files]
 * @param {string} [opts.sourceRoot] Main repo path; enables remediation hint.
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

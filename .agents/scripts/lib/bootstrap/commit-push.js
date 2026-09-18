/**
 * End-of-bootstrap offer to commit and push the wiring: worktrees check out
 * tracked files only, so an uncommitted `.agents/` breaks every Story. Stages
 * an explicit allowlist (never `git add -A`) and refuses secret files even
 * when they are not gitignored.
 *
 * @module bootstrap/commit-push
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Mirrors what the bootstrap writes; `.claude/commands/` is generated and
 * gitignored, so it is absent.
 *
 * @type {readonly string[]}
 */
export const BOOTSTRAP_COMMIT_PATHS = Object.freeze([
  '.agents',
  '.agentrc.json',
  'CLAUDE.md',
  '.claude/settings.json',
  '.gitignore',
  'package.json',
  'package-lock.json',
  '.husky',
]);

/**
 * Secrets and per-operator overrides: never staged, even when not gitignored.
 *
 * @type {ReadonlySet<string>}
 */
export const NEVER_STAGE_PATHS = Object.freeze(
  new Set([
    '.env',
    '.env.local',
    '.mcp.json',
    '.agentrc.local.json',
    '.agents/instructions.local.md',
  ]),
);

/**
 * @type {string}
 */
export const COMMIT_SUBJECT = 'chore: wire up Mandrel agent framework';

/**
 * @param {string} projectRoot
 * @param {typeof fs} [fsImpl]
 * @returns {string[]} existing, secret-free paths safe to stage
 */
export function resolveStagePaths(projectRoot, fsImpl = fs) {
  return BOOTSTRAP_COMMIT_PATHS.filter((rel) => {
    if (NEVER_STAGE_PATHS.has(rel)) return false;
    return fsImpl.existsSync(path.join(projectRoot, rel));
  });
}

/**
 * Manual commands for a declined or non-interactive offer; the `git add` line
 * names the allowlist so copy-pasting it cannot stage a secret.
 *
 * @param {object} args
 * @param {string[]} args.stagePaths
 * @param {string} args.baseBranch
 * @returns {string}
 */
export function buildManualInstructions({ stagePaths, baseBranch }) {
  const addArgs = stagePaths.length > 0 ? stagePaths.join(' ') : '.';
  return [
    'To commit and push the Mandrel setup yourself, run:',
    '',
    `  git add ${addArgs}`,
    `  git commit -m "${COMMIT_SUBJECT}"`,
    `  git push -u origin ${baseBranch}`,
    '',
    'Story delivery runs in git worktrees that check out tracked files only,',
    'so the .agents/ wiring MUST be committed before any /mandrel-deliver or',
    '/mandrel-deliver run — otherwise the worktree has no scripts and breaks.',
  ].join('\n');
}

/**
 * @param {object} args
 * @param {string} args.projectRoot
 * @param {(args: string[], cwd: string) => { ok: boolean, status?: number,
 *   stdout?: string, stderr?: string }} args.runGit
 * @param {typeof fs} [args.fsImpl]
 * @returns {{ ok: boolean, staged: string[], error?: string }}
 */
export function stageBootstrapFiles({ projectRoot, runGit, fsImpl = fs }) {
  const stagePaths = resolveStagePaths(projectRoot, fsImpl);
  if (stagePaths.length === 0) {
    return { ok: true, staged: [] };
  }
  const result = runGit(['add', '--', ...stagePaths], projectRoot);
  if (!result.ok) {
    return {
      ok: false,
      staged: [],
      error: result.stderr || 'git add failed',
    };
  }
  return { ok: true, staged: stagePaths };
}

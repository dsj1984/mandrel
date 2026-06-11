/**
 * bootstrap/commit-push — end-of-bootstrap "commit + push the wiring" offer
 * (Story #3899, Finding A.6).
 *
 * After a successful bootstrap the consumer's working tree carries the
 * framework wiring (`.agents/` tree, `.agentrc.json`, `CLAUDE.md`,
 * `.claude/settings.json`, `.gitignore`, `package.json`, `.husky/`). Nothing
 * told the operator to commit and push it — yet Story delivery runs in git
 * worktrees that check out **tracked files only**, so an uncommitted
 * `.agents/` means no scripts exist inside any worktree and every Story
 * sub-agent breaks. This module offers that commit + push at the end of the
 * run, and prints the exact manual commands when the offer is declined or the
 * run is non-interactive.
 *
 * Security: the stage step uses an explicit **allowlist** of bootstrap-written
 * paths (`git add -- <path>`), never `git add -A`, and explicitly refuses to
 * stage known secret files (`.env`, `.mcp.json`, `.agentrc.local.json`). This
 * keeps the commit safe regardless of whether the secret-safe `.gitignore`
 * Story (#3894) has landed — secrets are never staged even when un-ignored.
 *
 * Every git-touching helper takes an injectable `runGit` seam so the logic is
 * unit-testable without spawning a real `git`. The seam contract mirrors
 * `bootstrap.js#runGit`: `({ ok, status, stdout, stderr })`.
 *
 * @module bootstrap/commit-push
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * The bootstrap-written, version-controllable paths the commit offer stages.
 * Project-root-relative POSIX paths. Mirrors the file targets the bootstrap
 * pipeline writes (see `manifest.js` + `project-bootstrap.js`) plus the
 * materialized `.agents/` tree and `.husky/` quality hook. `.claude/commands/`
 * is intentionally absent — it is generated and gitignored.
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
 * Paths that MUST NEVER be staged by the commit offer, even when they are not
 * (yet) gitignored. These carry secrets or per-operator local overrides. This
 * is the defense-in-depth that lets the offer run safely before the
 * secret-safe `.gitignore` Story (#3894) lands.
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
 * The conventional commit subject the offer uses for the wiring commit.
 *
 * @type {string}
 */
export const COMMIT_SUBJECT = 'chore: wire up Mandrel agent framework';

/**
 * Resolve the subset of {@link BOOTSTRAP_COMMIT_PATHS} that actually exist on
 * disk and are not in {@link NEVER_STAGE_PATHS}. Pure (filesystem read only):
 * the secret-exclusion is applied here so a never-stage path is dropped before
 * it ever reaches `git add`.
 *
 * @param {string} projectRoot
 * @param {typeof fs} [fsImpl]
 * @returns {string[]} project-root-relative paths safe to stage
 */
export function resolveStagePaths(projectRoot, fsImpl = fs) {
  return BOOTSTRAP_COMMIT_PATHS.filter((rel) => {
    if (NEVER_STAGE_PATHS.has(rel)) return false;
    return fsImpl.existsSync(path.join(projectRoot, rel));
  });
}

/**
 * Build the exact manual commands the operator should run to commit and push
 * the wiring themselves. Printed when the offer is declined or the run is
 * non-interactive (`--assume-yes`). The `git add` line stages the resolved
 * allowlist only — never `git add -A` — so copy-pasting it cannot stage a
 * secret file.
 *
 * @param {object} args
 * @param {string[]} args.stagePaths — resolved, secret-free paths to stage.
 * @param {string} args.baseBranch
 * @returns {string} a multi-line, copy-pasteable command block
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
    'so the .agents/ wiring MUST be committed before any /deliver or',
    '/deliver run — otherwise the worktree has no scripts and breaks.',
  ].join('\n');
}

/**
 * Stage the resolved allowlist via `git add -- <paths>`. No-op (returns
 * `{ ok: true, staged: [] }`) when nothing resolves. Returns the git result on
 * failure so the caller can surface it.
 *
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

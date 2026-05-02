/**
 * worktree/bootstrapper.js
 *
 * File-copy + index-scrub helpers that prepare a freshly added worktree for
 * the agent (bootstrap files like `.env`) and tear the copy
 * back down cleanly at reap time (index scrubbing, submodule purge).
 *
 * All helpers receive an explicit `ctx` bag so they can be unit-tested without
 * instantiating `WorktreeManager`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { provision } from '../workspace-provisioner.js';
import { samePath } from './inspector.js';

/**
 * Detect whether the root repo declares `.agents` as a git submodule. Only
 * consumer projects do — in the framework repo itself `.agents` is a normal
 * tracked directory.
 *
 * @param {string} repoRoot
 * @returns {boolean}
 */
export function isAgentsSubmodule(repoRoot) {
  const gitmodulesPath = path.join(repoRoot, '.gitmodules');
  if (!fs.existsSync(gitmodulesPath)) return false;
  try {
    const body = fs.readFileSync(gitmodulesPath, 'utf8');
    return /^\s*path\s*=\s*["']?\.agents["']?\s*$/m.test(body);
  } catch {
    return false;
  }
}

/**
 * Copy untracked bootstrap files (default `.env`) from the repo
 * root into a freshly created worktree. Delegates to the central
 * `WorkspaceProvisioner`; kept as a named export so existing call sites keep
 * working.
 *
 * @param {{ repoRoot: string, config: { bootstrapFiles?: string[] }, logger: object }} ctx
 * @param {string} wtPath
 */
export function copyBootstrapFiles(ctx, wtPath) {
  const files = ctx.config?.bootstrapFiles;
  if (!Array.isArray(files) || files.length === 0) return;
  const logger = wrapBootstrapLogger(ctx.logger);
  provision({
    sourceRoot: ctx.repoRoot,
    targetWorktree: wtPath,
    files,
    logger,
  });
}

/**
 * Translate provisioner log lines into the `worktree.bootstrap …` prefix that
 * existing operators and log scrapers rely on.
 */
function wrapBootstrapLogger(inner) {
  const rewrite = (msg) =>
    String(msg).replace(/^workspace-provisioner:/, 'worktree.bootstrap');
  return {
    info: (m) => inner.info(rewrite(m)),
    warn: (m) => inner.warn(rewrite(m)),
    error: (m) => inner.error(rewrite(m)),
  };
}

/**
 * Copy the root repo's `.agents/` into the worktree as a plain directory.
 * Only runs when the root repo declares `.agents` as a submodule.
 *
 * @param {{ repoRoot: string, logger: object, git: object, platform: NodeJS.Platform }} ctx
 * @param {string} wtPath
 */
export function copyAgentsFromRoot(ctx, wtPath) {
  const submoduleCheck = ctx.isAgentsSubmodule ?? isAgentsSubmodule;
  if (!submoduleCheck(ctx.repoRoot)) return;
  const rootAgents = path.resolve(ctx.repoRoot, '.agents');
  if (!fs.existsSync(rootAgents)) {
    ctx.logger.warn(`agents-copy skipped: root ${rootAgents} does not exist`);
    return;
  }
  const wtAgents = path.resolve(wtPath, '.agents');
  if (samePath(wtAgents, rootAgents, ctx.platform)) {
    throw new Error(
      `WorktreeManager: refusing to clear root .agents (wtPath=${wtPath} resolves to repoRoot)`,
    );
  }
  const wtRel = path.relative(path.resolve(wtPath), wtAgents);
  if (wtRel.startsWith('..') || path.isAbsolute(wtRel)) {
    throw new Error(
      `WorktreeManager: wtAgents ${wtAgents} escapes wtPath ${wtPath}`,
    );
  }
  try {
    fs.rmSync(wtAgents, { recursive: true, force: true });
  } catch {
    // Nothing to remove, or permission — copy attempt will surface it.
  }
  try {
    fs.cpSync(rootAgents, wtAgents, {
      recursive: true,
      dereference: true,
      errorOnExist: false,
      force: true,
    });
  } catch (err) {
    ctx.logger.warn(`agents-copy failed path=${wtAgents}: ${err.message}`);
    return;
  }
  setAgentsGitlinkSkipWorktree(ctx, wtPath, true);
  ctx.logger.info(
    `worktree.agents.copied target=${wtAgents} source=${rootAgents}`,
  );
}

/**
 * Remove the copied `.agents/` directory and scrub the gitlink from the
 * worktree's index. The real `<repoRoot>/.agents` is never touched.
 *
 * @param {{ repoRoot: string, logger: object, git: object, platform: NodeJS.Platform }} ctx
 * @param {string} wtPath
 */
export function removeCopiedAgents(ctx, wtPath) {
  const wtAgents = path.resolve(wtPath, '.agents');
  const rootAgents = path.resolve(ctx.repoRoot, '.agents');
  if (samePath(wtAgents, rootAgents, ctx.platform)) {
    throw new Error(
      `WorktreeManager: refusing to remove root .agents (wtPath=${wtPath} resolves to repoRoot)`,
    );
  }
  // Only remove `wtPath/.agents` in consumer repos where `copyAgentsFromRoot`
  // actually materialised a copy. In framework repos (no `.gitmodules`),
  // `.agents/` is a tracked directory and deleting it here leaves the
  // worktree dirty, tripping `git worktree remove`'s "contains modified or
  // untracked files" guard and forcing every reap into the fs-rm-retry tail
  // (see ADR-20260424-638a).
  const submoduleCheck = ctx.isAgentsSubmodule ?? isAgentsSubmodule;
  if (submoduleCheck(ctx.repoRoot)) {
    try {
      const st = fs.lstatSync(wtAgents);
      if (st.isSymbolicLink()) {
        fs.unlinkSync(wtAgents);
      } else {
        fs.rmSync(wtAgents, { recursive: true, force: true });
      }
    } catch {
      // Nothing to remove — fall through to index scrub.
    }
  }
  setAgentsGitlinkSkipWorktree(ctx, wtPath, false);
  dropAgentsGitlinkFromIndex(ctx, wtPath);
  purgePerWorktreeSubmoduleDir(ctx, wtPath);
}

/**
 * Toggle the skip-worktree bit for `.agents` in a worktree-local index.
 *
 * @param {{ repoRoot: string, logger: object, git: object }} ctx
 * @param {string} wtPath
 * @param {boolean} enable
 */
function setAgentsGitlinkSkipWorktree(ctx, wtPath, enable) {
  const submoduleCheck = ctx.isAgentsSubmodule ?? isAgentsSubmodule;
  if (!submoduleCheck(ctx.repoRoot)) return;
  const ls = ctx.git.gitSpawn(wtPath, 'ls-files', '--stage', '--', '.agents');
  if (ls.status !== 0 || !/^160000 /.test(ls.stdout)) return;
  const flag = enable ? '--skip-worktree' : '--no-skip-worktree';
  const update = ctx.git.gitSpawn(
    wtPath,
    'update-index',
    flag,
    '--',
    '.agents',
  );
  if (update.status !== 0) {
    ctx.logger.warn(
      `agents-skip-worktree ${enable ? 'set' : 'clear'} failed path=${wtPath}: ${update.stderr || update.stdout}`,
    );
  }
}

/**
 * Remove any `.agents` gitlink entry from the worktree's index.
 *
 * @param {{ repoRoot: string, logger: object, git: object }} ctx
 * @param {string} wtPath
 */
export function dropAgentsGitlinkFromIndex(ctx, wtPath) {
  const submoduleCheck = ctx.isAgentsSubmodule ?? isAgentsSubmodule;
  if (!submoduleCheck(ctx.repoRoot)) return;
  const ls = ctx.git.gitSpawn(wtPath, 'ls-files', '--stage', '--', '.agents');
  if (ls.status !== 0 || !/^160000 /.test(ls.stdout)) return;
  const rm = ctx.git.gitSpawn(wtPath, 'rm', '--cached', '-f', '--', '.agents');
  if (rm.status !== 0) {
    ctx.logger.warn(
      `agents-index-scrub failed path=${wtPath}: ${rm.stderr || rm.stdout}`,
    );
  }
}

/**
 * Remove all mode-160000 gitlinks from a worktree index. Generic fallback
 * when `git worktree remove` reports the submodule guard.
 *
 * @param {{ logger: object, git: object }} ctx
 * @param {string} wtPath
 */
export function dropAllSubmoduleGitlinksFromIndex(ctx, wtPath) {
  const ls = ctx.git.gitSpawn(wtPath, 'ls-files', '--stage');
  if (ls.status !== 0 || !ls.stdout) return;
  const paths = ls.stdout
    .split(/\r?\n/)
    .map((line) => {
      const m = line.match(/^160000 [0-9a-f]+ \d+\t(.+)$/);
      return m ? m[1] : null;
    })
    .filter(Boolean);
  if (paths.length === 0) return;

  for (const submodulePath of paths) {
    ctx.git.gitSpawn(
      wtPath,
      'update-index',
      '--no-skip-worktree',
      '--',
      submodulePath,
    );
    const rm = ctx.git.gitSpawn(
      wtPath,
      'rm',
      '--cached',
      '-f',
      '--',
      submodulePath,
    );
    if (rm.status !== 0) {
      ctx.logger.warn(
        `submodule-index-scrub failed path=${submodulePath}: ${rm.stderr || rm.stdout}`,
      );
    }
  }
}

/**
 * Purge the per-worktree `<common-git-dir>/worktrees/<name>/modules/` dir so
 * `git worktree remove` does not hit the submodule guard.
 *
 * @param {{ repoRoot: string, logger: object }} ctx
 * @param {string} wtPath
 */
export function purgePerWorktreeSubmoduleDir(ctx, wtPath) {
  const dotGit = path.join(wtPath, '.git');
  let gitdir;
  try {
    const stat = fs.statSync(dotGit);
    if (stat.isDirectory()) {
      return;
    }
    const raw = fs.readFileSync(dotGit, 'utf8').trim();
    const m = raw.match(/^gitdir:\s*(.+)$/m);
    if (!m) return;
    gitdir = path.resolve(wtPath, m[1].trim());
  } catch {
    return;
  }
  const expectedRoot = path.resolve(ctx.repoRoot, '.git', 'worktrees');
  const rel = path.relative(expectedRoot, gitdir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    ctx.logger.warn(
      `agents-modules-purge skipped: per-worktree gitdir ${gitdir} is outside ${expectedRoot}`,
    );
    return;
  }
  const modulesDir = path.join(gitdir, 'modules');
  if (!fs.existsSync(modulesDir)) return;
  try {
    fs.rmSync(modulesDir, { recursive: true, force: true });
    ctx.logger.info(`worktree.agents.modules-purged path=${modulesDir}`);
  } catch (err) {
    ctx.logger.warn(
      `agents-modules-purge failed path=${modulesDir}: ${err.message}`,
    );
  }
}

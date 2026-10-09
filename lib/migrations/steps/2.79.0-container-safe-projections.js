// lib/migrations/steps/2.79.0-container-safe-projections.js
/**
 * Bring an existing consumer's bootstrap footprint to the container-safe
 * shape: upgrade the legacy unguarded `prepare` to the guarded
 * form, and add the `.claude/agents/` ignore entry. Reuses the bootstrap's own
 * helpers so a migrated tree matches a fresh bootstrap byte for byte. An
 * operator-customised `prepare` is never touched.
 */

import nodeFs from 'node:fs';
import path from 'node:path';

import {
  ensureGitignore,
  ensurePrepareScript,
  GITIGNORE_BLOCKS,
  LEGACY_PREPARE_COMMAND,
} from '../../../.agents/scripts/lib/bootstrap/project-bootstrap.js';

/**
 * @param {string} root
 * @param {typeof nodeFs} fsImpl
 * @returns {{ pkgPath: string, pkg: object | null }}
 */
function readPackageJson(root, fsImpl) {
  const pkgPath = path.join(root, 'package.json');
  if (!fsImpl.existsSync(pkgPath)) return { pkgPath, pkg: null };
  try {
    return { pkgPath, pkg: JSON.parse(fsImpl.readFileSync(pkgPath, 'utf8')) };
  } catch {
    return { pkgPath, pkg: null };
  }
}

/**
 * @param {string} root
 * @param {typeof nodeFs} fsImpl
 * @returns {boolean}
 */
function hasLegacyPrepare(root, fsImpl) {
  const { pkg } = readPackageJson(root, fsImpl);
  return pkg?.scripts?.prepare === LEGACY_PREPARE_COMMAND;
}

/**
 * @param {string} root
 * @param {typeof nodeFs} fsImpl
 * @returns {boolean}
 */
function lacksAgentsIgnore(root, fsImpl) {
  const target = path.join(root, '.gitignore');
  const body = fsImpl.existsSync(target)
    ? fsImpl.readFileSync(target, 'utf8')
    : '';
  return !GITIGNORE_BLOCKS.agents.pattern.test(body);
}

export const containerSafeProjections = {
  version: '2.79.0',
  description:
    'guard the bootstrap `prepare` so a manifest-only container `npm ci` ' +
    'skips the projections, and gitignore the generated .claude/agents/ ' +
    '(Story #5581)',
  /**
   * @param {{ projectRoot?: string, fs?: typeof nodeFs }} [ctx]
   * @param {typeof nodeFs} [fsImpl]
   * @returns {boolean}
   */
  detect(ctx, fsImpl = ctx?.fs ?? nodeFs) {
    const root = ctx?.projectRoot ?? process.cwd();
    return hasLegacyPrepare(root, fsImpl) || lacksAgentsIgnore(root, fsImpl);
  },
  /**
   * @param {{ projectRoot?: string, fs?: typeof nodeFs }} [ctx]
   * @param {typeof nodeFs} [fsImpl]
   * @returns {void}
   */
  apply(ctx, fsImpl = ctx?.fs ?? nodeFs) {
    const root = ctx?.projectRoot ?? process.cwd();
    if (hasLegacyPrepare(root, fsImpl)) {
      const { pkgPath, pkg } = readPackageJson(root, fsImpl);
      ensurePrepareScript(pkg.scripts);
      fsImpl.writeFileSync(
        pkgPath,
        `${JSON.stringify(pkg, null, 2)}\n`,
        'utf8',
      );
    }
    ensureGitignore({ projectRoot: root, fsImpl }, ['agents']);
  },
};

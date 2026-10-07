/**
 * The file universe an `/audit-exceptions` run reads: tracked files only (so a
 * gitignored local override is never read), minus vendored trees, worktrees
 * and the temp root, minus the materialized `.agents/` payload in a consumer —
 * a consumer cannot fix framework files, so findings there are noise to it.
 *
 * @module lib/audit-exceptions/scope
 */

import path from 'node:path';
import picomatch from 'picomatch';
import { gitSpawn } from '../git-utils.js';
import { readJsonc, readYaml } from './read.js';

const ALWAYS_EXCLUDED = Object.freeze([
  'node_modules/',
  '.worktrees/',
  '.claude/worktrees/',
]);

/** Gitignored by convention; listed so a force-added copy is still skipped. */
const LOCAL_OVERRIDE_FILES = Object.freeze([
  '.agentrc.local.json',
  '.agents/instructions.local.md',
]);

/** The package that ships `.agents/`; only there is the payload source. */
const FRAMEWORK_PACKAGE = 'mandrel';

/**
 * @param {string} root
 * @returns {{ files: string[]|null, detail: string }}
 */
function listTracked(root) {
  const res = gitSpawn(root, 'ls-files', '-z');
  if (res.status !== 0) return { files: null, detail: res.stderr };
  return { files: res.stdout.split('\0').filter(Boolean), detail: '' };
}

/**
 * @param {string[]} prefixes
 * @returns {(rel: string) => boolean}
 */
function excludedBy(prefixes) {
  return (rel) =>
    prefixes.some((p) => rel.startsWith(p)) ||
    LOCAL_OVERRIDE_FILES.includes(rel) ||
    rel.includes('/node_modules/');
}

/**
 * Workspace globs from `package.json#workspaces` (array or `{packages}`) and
 * `pnpm-workspace.yaml#packages`.
 *
 * @param {object|null} rootPkg
 * @param {object|null} pnpmWorkspace
 * @returns {string[]}
 */
function workspaceGlobs(rootPkg, pnpmWorkspace) {
  const ws = rootPkg?.workspaces;
  const npm = Array.isArray(ws) ? ws : (ws?.packages ?? []);
  const pnpm = pnpmWorkspace?.packages ?? [];
  return [...npm, ...pnpm].filter(
    (g) => typeof g === 'string' && !g.startsWith('!'),
  );
}

/**
 * Every manifest the dependency adapters read: the root plus each tracked
 * `package.json` whose directory a workspace glob matches.
 *
 * @param {string} root
 * @param {object|null} rootPkg
 * @param {string[]} files
 * @param {object|null} pnpmWorkspace
 * @returns {Array<{ dir: string, rel: string, pkg: object }>}
 */
function collectManifests(root, rootPkg, files, pnpmWorkspace) {
  const manifests = rootPkg
    ? [{ dir: '', rel: 'package.json', pkg: rootPkg }]
    : [];
  const globs = workspaceGlobs(rootPkg, pnpmWorkspace);
  if (globs.length === 0) return manifests;
  const isWorkspace = picomatch(globs);
  for (const rel of files) {
    if (path.posix.basename(rel) !== 'package.json' || rel === 'package.json')
      continue;
    const dir = path.posix.dirname(rel);
    if (!isWorkspace(dir)) continue;
    const pkg = readJsonc(root, rel);
    if (pkg) manifests.push({ dir, rel, pkg });
  }
  return manifests;
}

/**
 * @param {object} opts
 * @param {string} opts.root - analysed repository root.
 * @param {string} [opts.tempRel] - tempRoot relative to `root` (default `temp`).
 * @returns {{ files: string[], fileSet: Set<string>, isFrameworkSource: boolean,
 *   manifests: Array<{dir: string, rel: string, pkg: object}>,
 *   pnpmWorkspace: object|null, degradations: object[] }}
 */
export function buildScope({ root, tempRel = 'temp' }) {
  const degradations = [];
  const tracked = listTracked(root);
  if (tracked.files === null) {
    degradations.push({
      input: 'git',
      reason: 'tracked files unavailable; no file-borne exception was read',
      detail: tracked.detail,
    });
  }
  const rootPkg = readJsonc(root, 'package.json');
  const isFrameworkSource = rootPkg?.name === FRAMEWORK_PACKAGE;
  const prefixes = [...ALWAYS_EXCLUDED, `${tempRel.replace(/\/+$/, '')}/`];
  if (!isFrameworkSource) prefixes.push('.agents/');
  const isExcluded = excludedBy(prefixes);
  const files = (tracked.files ?? []).filter((rel) => !isExcluded(rel));
  const pnpmWorkspace = files.includes('pnpm-workspace.yaml')
    ? readYaml(root, 'pnpm-workspace.yaml')
    : null;
  return {
    files,
    fileSet: new Set(files),
    isFrameworkSource,
    manifests: collectManifests(root, rootPkg, files, pnpmWorkspace),
    pnpmWorkspace,
    degradations,
  };
}

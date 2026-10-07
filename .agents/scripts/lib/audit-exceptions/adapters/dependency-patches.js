/**
 * Patched dependencies: patch-package files (`patches/name+1.2.3.patch`) and
 * pnpm `patchedDependencies` (in `package.json#pnpm` or `pnpm-workspace.yaml`).
 * A patch is `dead` when its package left the tree, when it targets a version
 * that no longer resolves, or when the patch file it names is gone.
 *
 * @module lib/audit-exceptions/adapters/dependency-patches
 */

import path from 'node:path';
import { lineOf } from '../locate.js';
import { readText } from '../read.js';
import { makeRecord } from '../record.js';
import { noteFor } from './dependency-pins.js';

const PATCH_FILE_RE = /(?:^|\/)patches\/([^/]+)\.patch$/;

/**
 * `@scope+name+1.2.3` / `parent++child+1.0.0` → `{ name, version }`.
 *
 * @param {string} stem
 * @returns {{ name: string, version: string }|null}
 */
function parsePatchPackageStem(stem) {
  const parts = stem.split('++').pop().split('+');
  if (parts[0].startsWith('@') && parts.length >= 3) {
    return { name: `${parts[0]}/${parts[1]}`, version: parts[2] };
  }
  return parts.length >= 2 ? { name: parts[0], version: parts[1] } : null;
}

/** pnpm `name@1.2.3` (or bare `name`, meaning every version). */
function parsePnpmPatchKey(key) {
  const at = key.indexOf('@', 1);
  return at === -1
    ? { name: key, version: null }
    : { name: key.slice(0, at), version: key.slice(at + 1) };
}

/**
 * @param {{ name: string, version: string|null }} target
 * @param {object} index
 * @returns {{ verdict: string, basis: string }}
 */
function patchProbe(target, index) {
  const versions = index.present?.get(target.name);
  if (index.present === null)
    return { verdict: 'unknown', basis: 'no-lockfile' };
  if (!versions) return { verdict: 'dead', basis: 'absent-from-tree' };
  if (target.version && versions.size > 0 && !versions.has(target.version)) {
    return { verdict: 'dead', basis: 'version-drift' };
  }
  return { verdict: 'live', basis: 'applies-to-resolved' };
}

function patchPackageRecords(ctx) {
  const records = [];
  for (const rel of ctx.scope.files) {
    const m = PATCH_FILE_RE.exec(rel);
    const target = m?.[1].includes('+') ? parsePatchPackageStem(m[1]) : null;
    if (!target) continue;
    records.push(
      makeRecord({
        adapter: 'dependency-patches',
        category: 'dependency',
        surface: 'patch-package',
        file: rel,
        line: 1,
        target: target.name,
        rule: 'patch-package',
        justification: noteFor(
          ctx.scope.manifests[0]?.pkg,
          `patches.${target.name}`,
        ),
        probe: patchProbe(target, ctx.deps()),
      }),
    );
  }
  return records;
}

function pnpmPatchRecords(ctx, file, map, notesPkg) {
  const text = readText(ctx.root, file);
  return Object.entries(map ?? {}).map(([key, patchPath]) => {
    const target = parsePnpmPatchKey(key);
    const missing =
      typeof patchPath === 'string' &&
      !ctx.scope.fileSet.has(path.posix.normalize(patchPath));
    return makeRecord({
      adapter: 'dependency-patches',
      category: 'dependency',
      surface: 'pnpm-patchedDependencies',
      file,
      line: lineOf(text, key, ['patchedDependencies']),
      target: target.name,
      rule: 'pnpm-patchedDependencies',
      justification: noteFor(notesPkg, `pnpm.patchedDependencies.${key}`),
      probe: missing
        ? { verdict: 'dead', basis: 'patch-file-missing' }
        : patchProbe(target, ctx.deps()),
    });
  });
}

export const dependencyPatches = Object.freeze({
  id: 'dependency-patches',
  category: 'dependency',
  applies: (ctx) =>
    ctx.scope.manifests.length > 0
      ? { applies: true, reason: 'package manifests present' }
      : { applies: false, reason: 'no package.json' },
  extract: (ctx) => [
    ...patchPackageRecords(ctx),
    ...ctx.scope.manifests.flatMap((m) =>
      pnpmPatchRecords(ctx, m.rel, m.pkg.pnpm?.patchedDependencies, m.pkg),
    ),
    ...pnpmPatchRecords(
      ctx,
      'pnpm-workspace.yaml',
      ctx.scope.pnpmWorkspace?.patchedDependencies,
      null,
    ),
  ],
});

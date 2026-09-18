import fs from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';

/**
 * Walk a directory and return repo-relative `*.test.js` paths (forward
 * slashes). Skips `node_modules`, `.worktrees`, and dot-prefixed dirs.
 *
 * @param {string} root
 * @param {typeof fs} [fsLike]
 * @returns {string[]}
 */
export function walkTestFiles(root, fsLike = fs) {
  const out = [];
  walk(root, '');
  return out.sort();

  function walk(dir, prefix) {
    if (!fsLike.existsSync(dir)) return;
    for (const ent of fsLike.readdirSync(dir, { withFileTypes: true })) {
      const name = ent.name;
      if (
        name === 'node_modules' ||
        name === '.worktrees' ||
        name.startsWith('.')
      ) {
        continue;
      }
      const abs = path.join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (ent.isDirectory()) {
        walk(abs, rel);
      } else if (name.endsWith('.test.js')) {
        out.push(rel.replace(/\\/g, '/'));
      }
    }
  }
}

/**
 * Resolve the user's pattern to a sorted list of repo-relative test file
 * paths. Patterns may be:
 *
 * - a glob (`tests/**\/*.test.js`, `tests/lib/foo*.test.js`)
 * - an explicit file path (absolute or repo-relative)
 * - a directory (walked for `*.test.js` descendants)
 * - omitted (defaults to `tests/**\/*.test.js`)
 *
 * @param {object} opts
 * @param {string} [opts.pattern]
 * @param {string} opts.repoRoot
 * @param {string[]} [opts.allFiles] Override the discovered file list for tests.
 * @param {typeof fs} [opts.fsLike]
 * @returns {string[]}
 */
export function resolveTestFiles({ pattern, repoRoot, allFiles, fsLike = fs }) {
  const discoverAll = () => allFiles ?? walkTestFiles(repoRoot, fsLike);

  if (!pattern || pattern === 'tests/**/*.test.js') {
    return discoverAll().filter((f) => f.startsWith('tests/'));
  }

  // Absolute path → relativize.
  let target = pattern.replace(/\\/g, '/');
  if (path.isAbsolute(target)) {
    target = path.relative(repoRoot, path.resolve(target)).replace(/\\/g, '/');
  }

  // Directory → walk it for *.test.js files.
  const absTarget = path.resolve(repoRoot, target);
  if (fsLike.existsSync(absTarget)) {
    const stat = fsLike.statSync(absTarget);
    if (stat.isDirectory()) {
      return walkTestFiles(absTarget, fsLike)
        .map((rel) =>
          path
            .relative(repoRoot, path.join(absTarget, rel))
            .replace(/\\/g, '/'),
        )
        .filter((f) => f.endsWith('.test.js'));
    }
    if (stat.isFile() && target.endsWith('.test.js')) {
      return [target];
    }
  }

  // Glob → filter the universe.
  const isMatch = picomatch(target, { dot: true });
  return discoverAll().filter((f) => isMatch(f));
}

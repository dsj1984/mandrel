// lib/cli/sync.js
/**
 * `mandrel sync` subcommand — the .agents/ materializer.
 *
 * Copies the published package payload
 * (`node_modules/@mandrel/agents/.agents/`) into the consumer project's
 * `./.agents/` directory by **plain file copy** — never a symlink — so
 * Windows and POSIX behave identically (Tech Spec #3459, Feature #3461).
 *
 * Design contract (per Story #3467 AC and Tech Spec #3459 "API Changes"):
 *   - Copy, not symlink. The materialized tree is plain regular files.
 *   - Idempotent. A second run overwrites in place and leaves ./.agents/
 *     byte-identical to the package payload.
 *   - Self-locating. The package root is resolved from the installed
 *     `@mandrel/agents` package metadata, not from the current working
 *     directory, so it works regardless of where `mandrel` is invoked.
 *   - Exits non-zero with an actionable message when `@mandrel/agents` is
 *     not resolvable in node_modules.
 *   - `--dry-run` reports the planned copies and writes nothing.
 *   - `--force` is accepted; the copy is overwrite-in-place either way, so
 *     it exists for explicitness/forward-compat and changes no behaviour.
 *
 * Security (Tech Spec #3459 "Postinstall safety"):
 *   - Does nothing beyond a local file copy: no network, no shell, no writes
 *     outside `./.agents/`.
 *   - Logs only paths and counts, never file contents or environment values.
 *
 * Injectable seams (used by lib/cli/__tests__/sync.test.js):
 *   - `resolvePackageRoot` — replaces real `@mandrel/agents` resolution
 *   - `fs`                 — replaces the node:fs surface used here
 *   - `cwd`                — replaces process.cwd()
 *   - `write`              — replaces process.stdout.write
 *   - `writeErr`           — replaces process.stderr.write
 *   - `exit`               — replaces process.exit
 */

import nodeFs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const PACKAGE_NAME = '@mandrel/agents';

/**
 * Default resolver: locate the installed `@mandrel/agents` package root by
 * resolving its `package.json` and returning the directory that contains it.
 *
 * Throws an Error with `code: 'MODULE_NOT_FOUND'` when the package is not
 * installed — the caller maps that to an actionable non-zero exit.
 *
 * @param {string} fromDir - Directory to resolve from (the consumer project).
 * @returns {string} Absolute path to the package root.
 */
function defaultResolvePackageRoot(fromDir) {
  // Resolve relative to the consumer project so we find *their* install,
  // not a copy hoisted next to this CLI module.
  const requireFrom = createRequire(path.join(fromDir, 'noop.js'));
  const pkgJsonPath = requireFrom.resolve(`${PACKAGE_NAME}/package.json`);
  return path.dirname(pkgJsonPath);
}

/**
 * Recursively enumerate every regular file under `dir`, returning paths
 * relative to `dir` using POSIX-agnostic OS separators.
 *
 * Symlinks encountered in the source are dereferenced to their target file
 * content on copy (we never create symlinks in the destination).
 *
 * @param {string} dir - Absolute directory to walk.
 * @param {typeof nodeFs} fs
 * @param {string} [prefix] - Accumulated relative prefix (internal).
 * @returns {string[]} Relative file paths.
 */
function listFiles(dir, fs, prefix = '') {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? path.join(prefix, ent.name) : ent.name;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...listFiles(abs, fs, rel));
    } else {
      out.push(rel);
    }
  }
  return out;
}

/**
 * Materialize the package's `.agents/` tree into `./.agents/`.
 *
 * @param {{
 *   argv?: string[],
 *   resolvePackageRoot?: (fromDir: string) => string,
 *   fs?: typeof nodeFs,
 *   cwd?: () => string,
 *   write?: (s: string) => void,
 *   writeErr?: (s: string) => void,
 *   exit?: (code: number) => void,
 * }} [opts]
 * @returns {{ copied: number, planned: number, dryRun: boolean }} Summary
 *   (also returned in dry-run / error paths for testability).
 */
export function runSync({
  argv = [],
  resolvePackageRoot = defaultResolvePackageRoot,
  fs = nodeFs,
  cwd = () => process.cwd(),
  write = (s) => process.stdout.write(s),
  writeErr = (s) => process.stderr.write(s),
  exit = (code) => process.exit(code),
} = {}) {
  const dryRun = argv.includes('--dry-run');
  // `--force` overwrites local edits. The copy is overwrite-in-place
  // regardless, so the flag is accepted but does not branch behaviour.
  const projectRoot = cwd();

  let packageRoot;
  try {
    packageRoot = resolvePackageRoot(projectRoot);
  } catch {
    writeErr(
      `mandrel sync: cannot find '${PACKAGE_NAME}' in node_modules.\n` +
        `   → Install it first: npm install ${PACKAGE_NAME}\n`,
    );
    exit(1);
    return { copied: 0, planned: 0, dryRun };
  }

  const sourceRoot = path.join(packageRoot, '.agents');
  if (!fs.existsSync(sourceRoot)) {
    writeErr(
      `mandrel sync: '${PACKAGE_NAME}' is installed but ships no .agents/ payload at ${sourceRoot}.\n` +
        `   → Reinstall the package: npm install ${PACKAGE_NAME}\n`,
    );
    exit(1);
    return { copied: 0, planned: 0, dryRun };
  }

  const destRoot = path.join(projectRoot, '.agents');
  const files = listFiles(sourceRoot, fs);

  if (dryRun) {
    for (const rel of files) {
      write(`would copy  ${path.join('.agents', rel)}\n`);
    }
    write(
      `✅  Dry run: ${files.length} file(s) would be materialized into ./.agents/\n`,
    );
    return { copied: 0, planned: files.length, dryRun: true };
  }

  for (const rel of files) {
    const src = path.join(sourceRoot, rel);
    const dest = path.join(destRoot, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // copyFileSync overwrites the destination in place (idempotent) and
    // produces a plain regular file — never a symlink.
    fs.copyFileSync(src, dest);
  }

  write(`✅  Materialized ${files.length} file(s) into ./.agents/\n`);
  return { copied: files.length, planned: files.length, dryRun: false };
}

/**
 * Default export consumed by `bin/mandrel.js`.
 *
 * @param {string[]} argv - Subcommand arguments (after `mandrel sync`).
 * @returns {Promise<void>}
 */
export default async function run(argv = []) {
  runSync({ argv });
}

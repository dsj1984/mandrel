// lib/cli/sync.js
/**
 * `mandrel sync` subcommand — the .agents/ materializer.
 *
 * Copies the published package payload
 * (`node_modules/mandrel/.agents/`) into the consumer project's
 * `./.agents/` directory by **plain file copy** — never a symlink — so
 * Windows and POSIX behave identically (Tech Spec #3459, Feature #3461).
 *
 * Design contract (per Story #3467 AC, Tech Spec #3459 "API Changes", and
 * Story #4046 sync-prune):
 *   - Copy, not symlink. The materialized tree is plain regular files.
 *   - Idempotent. A second run overwrites in place and leaves ./.agents/
 *     byte-identical to the package payload.
 *   - Self-locating. The package root is resolved from the installed
 *     `mandrel` package metadata, not from the current working
 *     directory, so it works regardless of where `mandrel` is invoked.
 *   - Exits non-zero with an actionable message when `mandrel` is
 *     not resolvable in node_modules.
 *   - `--dry-run` reports the planned copies and writes nothing.
 *   - Local-additions zone. The `.agents/local/` subtree is never copied
 *     into nor pruned from the destination (Story #3498). It is the
 *     consumer-owned space for hand-authored additions that must survive
 *     every re-materialization.
 *   - Sync prune (Story #4046). After the copy pass, any file inside the
 *     managed `.agents/` zone (everything except `.agents/local/`) that has
 *     no counterpart in the package payload is deleted. Consumer additions
 *     under `.agents/local/` are never touched.
 *
 * Security (Tech Spec #3459 "Postinstall safety"):
 *   - Does nothing beyond a local file copy: no network, no shell, no writes
 *     outside `./.agents/`.
 *   - Logs only paths and counts, never file contents or environment values.
 *
 * Injectable seams (used by lib/cli/__tests__/sync.test.js):
 *   - `resolvePackageRoot` — replaces real `mandrel` resolution
 *   - `fs`                 — replaces the node:fs surface used here
 *   - `cwd`                — replaces process.cwd()
 *   - `write`              — replaces process.stdout.write
 *   - `writeErr`           — replaces process.stderr.write
 *   - `exit`               — replaces process.exit
 */

import nodeFs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

export const PACKAGE_NAME = 'mandrel';

/**
 * Top-level directory name (relative to `.agents/`) reserved as the
 * sync-exempt local-additions zone (Story #3498, f-drift-local-zone).
 *
 * `.agents/local/` is a sanctioned space for consumer hand-authored
 * additions: `mandrel sync` never copies a payload file into it (the
 * published payload ships none) and never prunes what a consumer has
 * placed there, so local additions survive every re-materialization. The
 * exemption is enforced by skipping this subtree during source enumeration,
 * which keeps both the dry-run plan and the real copy free of any
 * `.agents/local/**` path even if a future payload were to ship one.
 */
export const LOCAL_ZONE_DIR = 'local';

/**
 * Basename pattern for consumer local-override files (`*.local.<ext>`,
 * e.g. `instructions.local.md`, `foo.local.json`). Matches the gitignore
 * convention (`.agents/*.local.md`, `.agentrc.local.json`) and the override
 * mechanism documented in `.agents/instructions.md` § 1.E. These files never
 * ship in the payload and are exempt from the sync prune pass.
 */
export const LOCAL_OVERRIDE_RE = /\.local\.[^.]+$/;

/**
 * Default resolver: locate the installed `mandrel` package root by
 * resolving its `package.json` and returning the directory that contains it.
 *
 * Throws an Error with `code: 'MODULE_NOT_FOUND'` when the package is not
 * installed — the caller maps that to an actionable non-zero exit.
 *
 * @param {string} fromDir - Directory to resolve from (the consumer project).
 * @returns {string} Absolute path to the package root.
 */
export function defaultResolvePackageRoot(fromDir) {
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
 * The top-level `local/` subtree (`.agents/local/`) is skipped entirely:
 * it is the consumer-owned local-additions zone and is never materialized
 * from the package payload (Story #3498). See {@link LOCAL_ZONE_DIR}.
 *
 * @param {string} dir - Absolute directory to walk.
 * @param {typeof nodeFs} fsImpl
 * @param {string} [prefix] - Accumulated relative prefix (internal).
 * @returns {string[]} Relative file paths.
 */
export function listFiles(dir, fsImpl, prefix = '') {
  const out = [];
  for (const ent of fsImpl.readdirSync(dir, { withFileTypes: true })) {
    // Never enumerate the sync-exempt local-additions zone. Matching on the
    // empty prefix scopes the skip to the top-level `.agents/local/` only,
    // leaving any deeper directory that happens to be named `local` intact.
    if (prefix === '' && ent.name === LOCAL_ZONE_DIR && ent.isDirectory()) {
      continue;
    }
    const rel = prefix ? path.join(prefix, ent.name) : ent.name;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...listFiles(abs, fsImpl, rel));
    } else {
      out.push(rel);
    }
  }
  return out;
}

/**
 * Recursively enumerate every regular file under `dir`, returning paths
 * relative to `dir` using OS separators. The top-level `local/` subtree is
 * skipped so consumer additions inside `.agents/local/` are never pruned
 * (Story #3498). Files following the `*.local.*` naming convention (e.g.
 * `.agents/instructions.local.md` — the documented consumer override
 * mechanism, instructions.md § 1.E) are also skipped: they never ship in
 * the payload and must survive every sync.
 *
 * Mirrors `listFiles` but operates on the destination tree so we can
 * identify stale files that have no payload counterpart (Story #4046 A3).
 *
 * @param {string} dir - Absolute directory to walk.
 * @param {typeof nodeFs} fsImpl
 * @param {string} [prefix] - Accumulated relative prefix (internal).
 * @returns {string[]} Relative file paths.
 */
function listDestFiles(dir, fsImpl, prefix = '') {
  const out = [];
  let entries;
  try {
    entries = fsImpl.readdirSync(dir, { withFileTypes: true });
  } catch {
    // Directory absent — nothing to prune.
    return out;
  }
  for (const ent of entries) {
    // The local-additions zone is never pruned; skip it at the top level.
    if (prefix === '' && ent.name === LOCAL_ZONE_DIR && ent.isDirectory()) {
      continue;
    }
    // Consumer local-override files (`*.local.*`, e.g. instructions.local.md,
    // foo.local.json) are gitignored, never shipped in the payload, and a
    // documented override mechanism (instructions.md § 1.E) — never prune.
    if (!ent.isDirectory() && LOCAL_OVERRIDE_RE.test(ent.name)) {
      continue;
    }
    const rel = prefix ? path.join(prefix, ent.name) : ent.name;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...listDestFiles(abs, fsImpl, rel));
    } else {
      out.push(rel);
    }
  }
  return out;
}

/**
 * Materialize the package's `.agents/` tree into `./.agents/`.
 *
 * After the copy pass, any file inside the managed zone of the destination
 * `.agents/` tree (everything outside `.agents/local/`) that has no
 * counterpart in the package payload is deleted (sync-prune, Story #4046 A3).
 * Consumer additions placed under `.agents/local/` are never touched.
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
 * @returns {{ copied: number, planned: number, pruned: number, dryRun: boolean }}
 *   Summary (also returned in dry-run / error paths for testability).
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
    return { copied: 0, planned: 0, pruned: 0, dryRun };
  }

  const sourceRoot = path.join(packageRoot, '.agents');
  if (!fs.existsSync(sourceRoot)) {
    writeErr(
      `mandrel sync: '${PACKAGE_NAME}' is installed but ships no .agents/ payload at ${sourceRoot}.\n` +
        `   → Reinstall the package: npm install ${PACKAGE_NAME}\n`,
    );
    exit(1);
    return { copied: 0, planned: 0, pruned: 0, dryRun };
  }

  const destRoot = path.join(projectRoot, '.agents');
  const payloadFiles = listFiles(sourceRoot, fs);

  if (dryRun) {
    for (const rel of payloadFiles) {
      write(`would copy  ${path.join('.agents', rel)}\n`);
    }
    // Compute stale files (managed-zone destination files with no payload
    // counterpart) for the dry-run plan so operators can preview pruning.
    const payloadSet = new Set(payloadFiles);
    const destFiles = listDestFiles(destRoot, fs);
    const stale = destFiles.filter((f) => !payloadSet.has(f));
    for (const rel of stale) {
      write(`would prune ${path.join('.agents', rel)}\n`);
    }
    write(
      `✅  Dry run: ${payloadFiles.length} file(s) would be materialized, ${stale.length} stale file(s) would be pruned from ./.agents/\n`,
    );
    return {
      copied: 0,
      planned: payloadFiles.length,
      pruned: 0,
      dryRun: true,
    };
  }

  for (const rel of payloadFiles) {
    const src = path.join(sourceRoot, rel);
    const dest = path.join(destRoot, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // copyFileSync overwrites the destination in place (idempotent) and
    // produces a plain regular file — never a symlink.
    fs.copyFileSync(src, dest);
  }

  // Prune pass (Story #4046 A3): remove managed-zone destination files that
  // have no counterpart in the payload. The local-additions zone
  // (.agents/local/) is never enumerated by listDestFiles and is therefore
  // never pruned — consumer additions there are sanctioned, not stale.
  const payloadSet = new Set(payloadFiles);
  const destFiles = listDestFiles(destRoot, fs);
  const staleFiles = destFiles.filter((f) => !payloadSet.has(f));
  for (const rel of staleFiles) {
    const dest = path.join(destRoot, rel);
    fs.unlinkSync(dest);
  }

  if (staleFiles.length > 0) {
    write(
      `✅  Materialized ${payloadFiles.length} file(s) into ./.agents/ (pruned ${staleFiles.length} stale file(s))\n`,
    );
  } else {
    write(`✅  Materialized ${payloadFiles.length} file(s) into ./.agents/\n`);
  }
  return {
    copied: payloadFiles.length,
    planned: payloadFiles.length,
    pruned: staleFiles.length,
    dryRun: false,
  };
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

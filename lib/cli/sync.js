// lib/cli/sync.js
/**
 * `mandrel sync`: materialize `node_modules/mandrel/.agents/` into
 * `./.agents/` by plain file copy (never symlinks, so Windows and POSIX
 * match), then prune managed-zone files with no payload counterpart and write
 * the version marker. Idempotent; `--dry-run` writes nothing. `.agents/local/`
 * and `*.local.*` files are never copied into or pruned.
 *
 * No network, no shell. The one write outside `./.agents/` is the per-clone
 * `merge.mandrel-baseline.driver` git config, made only when the project's
 * tracked `.gitattributes` already declares the attribute — git will not run
 * a command shipped by the repo, so every fresh clone needs it installed
 * locally, and `sync` is the command every consumer runs.
 */

import nodeFs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { ensureBaselineMergeDriver } from '../../.agents/scripts/lib/bootstrap/baseline-merge-driver.js';
import { LEDGER_RELATIVE_PATH } from '../../.agents/scripts/lib/bootstrap/install-ledger.js';

export const PACKAGE_NAME = 'mandrel';

const AGENTS_DIR = '.agents';

/** Top-level `.agents/` subdirectory reserved for consumer additions. */
export const LOCAL_ZONE_DIR = 'local';

/** Consumer local-override basenames (`instructions.local.md`, …). */
export const LOCAL_OVERRIDE_RE = /\.local\.[^.]+$/;

/** `.agents/`-relative path of the version marker written after each sync. */
export const VERSION_MARKER_RELATIVE_PATH = '.mandrel-version';

/**
 * Convert a project-root-relative POSIX path into the `.agents/`-relative,
 * OS-separator form {@link listDestFiles} enumerates. Throws on a path
 * outside `.agents/` at module load, since registering one would be a silent
 * no-op that reads as protection.
 *
 * @param {string} projectRelativePosixPath - e.g. `.agents/.install-manifest.json`.
 * @returns {string} e.g. `.install-manifest.json` (OS separators).
 */
function toManagedZoneRelative(projectRelativePosixPath) {
  const segments = projectRelativePosixPath.split('/');
  if (segments[0] !== AGENTS_DIR || segments.length < 2) {
    throw new Error(
      `generated-files registry: '${projectRelativePosixPath}' is not inside ${AGENTS_DIR}/ — ` +
        'only files the sync prune pass walks can be registered as never-pruned.',
    );
  }
  return path.join(...segments.slice(1));
}

/**
 * Framework-generated `.agents/` files with no payload counterpart, which the
 * prune pass would otherwise delete (losing the install ledger makes
 * `mandrel uninstall` silently reverse nothing). Register a new one here,
 * keyed off the generator's exported constant — not as a branch in
 * {@link listDestFiles}. Consumer overrides are a separate concept.
 */
export const GENERATED_FILES = Object.freeze([
  VERSION_MARKER_RELATIVE_PATH,
  toManagedZoneRelative(LEDGER_RELATIVE_PATH),
]);

/**
 * Version of the payload just copied, read at `packageRoot` — not the
 * running CLI's own version, which may differ.
 *
 * @param {string} packageRoot - Absolute path to the resolved package root.
 * @param {typeof nodeFs} fsImpl
 * @returns {string}
 */
function resolvePackageVersion(packageRoot, fsImpl) {
  const pkgJsonPath = path.join(packageRoot, 'package.json');
  const parsed = JSON.parse(fsImpl.readFileSync(pkgJsonPath, 'utf8'));
  return String(parsed.version);
}

/**
 * `null` when absent (pre-marker install or never synced), so callers can
 * fall back to content-hash drift checks.
 *
 * @param {string} consumerRoot - Consumer project root (not `.agents/`).
 * @param {typeof nodeFs} [fsImpl]
 * @returns {string | null}
 */
export function readVersionMarker(consumerRoot, fsImpl = nodeFs) {
  const markerPath = path.join(
    consumerRoot,
    '.agents',
    VERSION_MARKER_RELATIVE_PATH,
  );
  try {
    const raw = fsImpl.readFileSync(markerPath, 'utf8').trim();
    return raw || null;
  } catch {
    return null;
  }
}

/**
 * Resolved from the consumer project so it finds their install, not a copy
 * hoisted next to this module. Throws `MODULE_NOT_FOUND` when not installed.
 *
 * @param {string} fromDir - Directory to resolve from (the consumer project).
 * @returns {string} Absolute path to the package root.
 */
export function defaultResolvePackageRoot(fromDir) {
  const requireFrom = createRequire(path.join(fromDir, 'noop.js'));
  const pkgJsonPath = requireFrom.resolve(`${PACKAGE_NAME}/package.json`);
  return path.dirname(pkgJsonPath);
}

/**
 * Every file under `dir` (relative, OS separators), skipping the top-level
 * local zone only.
 *
 * @param {string} dir - Absolute directory to walk.
 * @param {typeof nodeFs} fsImpl
 * @param {string} [prefix] - Accumulated relative prefix (internal).
 * @returns {string[]} Relative file paths.
 */
export function listFiles(dir, fsImpl, prefix = '') {
  const out = [];
  for (const ent of fsImpl.readdirSync(dir, { withFileTypes: true })) {
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
 * Destination-tree enumeration for pruning. Skips the top-level local zone,
 * `*.local.*` overrides, and {@link GENERATED_FILES}.
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
    return out;
  }
  for (const ent of entries) {
    if (prefix === '' && ent.name === LOCAL_ZONE_DIR && ent.isDirectory()) {
      continue;
    }
    if (!ent.isDirectory() && LOCAL_OVERRIDE_RE.test(ent.name)) {
      continue;
    }
    const rel = prefix ? path.join(prefix, ent.name) : ent.name;
    if (!ent.isDirectory() && GENERATED_FILES.includes(rel)) {
      continue;
    }
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
 * @param {{
 *   argv?: string[],
 *   resolvePackageRoot?: (fromDir: string) => string,
 *   fs?: typeof nodeFs,
 *   cwd?: () => string,
 *   write?: (s: string) => void,
 *   writeErr?: (s: string) => void,
 *   exit?: (code: number) => void,
 *   ensureMergeDriver?: typeof ensureBaselineMergeDriver,
 * }} [opts]
 * @returns {{ copied: number, planned: number, pruned: number, dryRun: boolean }}
 *   Summary (also returned in dry-run / error paths for testability).
 */
export function runSync({
  argv = [],
  resolvePackageRoot = defaultResolvePackageRoot,
  ensureMergeDriver = ensureBaselineMergeDriver,
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
    const payloadSet = new Set(payloadFiles);
    const destFiles = listDestFiles(destRoot, fs);
    const stale = destFiles.filter((f) => !payloadSet.has(f));
    for (const rel of stale) {
      write(`would prune ${path.join('.agents', rel)}\n`);
    }
    write(
      `✅  Dry run: ${payloadFiles.length} file(s) would be installed, ${stale.length} stale file(s) would be pruned from ./.agents/\n`,
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
    fs.copyFileSync(src, dest);
  }

  const payloadSet = new Set(payloadFiles);
  const destFiles = listDestFiles(destRoot, fs);
  const staleFiles = destFiles.filter((f) => !payloadSet.has(f));
  for (const rel of staleFiles) {
    const dest = path.join(destRoot, rel);
    fs.unlinkSync(dest);
  }

  // Written after the prune as a second safeguard beside GENERATED_FILES.
  const packageVersion = resolvePackageVersion(packageRoot, fs);
  fs.writeFileSync(
    path.join(destRoot, VERSION_MARKER_RELATIVE_PATH),
    `${packageVersion}\n`,
  );

  // Config half only; never allowed to fail the sync (no git, read-only config).
  const driver = ensureMergeDriver({
    projectRoot,
    configOnly: true,
    fsImpl: fs,
  });
  if (driver?.action === 'updated') {
    write('✅  Registered the baselines/*.json merge driver for this clone\n');
  }

  if (staleFiles.length > 0) {
    write(
      `✅  Installed ${payloadFiles.length} file(s) into ./.agents/ (pruned ${staleFiles.length} stale file(s))\n`,
    );
  } else {
    write(`✅  Installed ${payloadFiles.length} file(s) into ./.agents/\n`);
  }
  return {
    copied: payloadFiles.length,
    planned: payloadFiles.length,
    pruned: staleFiles.length,
    dryRun: false,
  };
}

/**
 * @param {string[]} argv - Subcommand arguments (after `mandrel sync`).
 * @returns {Promise<void>}
 */
export default async function run(argv = []) {
  runSync({ argv });
}

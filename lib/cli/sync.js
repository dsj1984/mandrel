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
 *   - Generated, never-pruned registry (Story #4534). Framework-generated
 *     `.agents/` files have no payload counterpart by design, so the prune
 *     pass would delete each one unless it is declared in
 *     {@link GENERATED_FILES}. That registry — not a per-file special case in
 *     {@link listDestFiles} — is the single place a generated artifact is
 *     exempted. Registered today: the version marker (Story #4530) and the
 *     install ledger the bootstrap writes and `mandrel uninstall` reads.
 *   - Version marker (Story #4530). After the prune pass, `.agents/.mandrel-
 *     version` is (re)written with the executing package's own version. See
 *     {@link readVersionMarker} for how callers consume it.
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

import { LEDGER_RELATIVE_PATH } from '../../.agents/scripts/lib/bootstrap/install-ledger.js';

export const PACKAGE_NAME = 'mandrel';

/**
 * Name of the managed destination directory, relative to the project root.
 * Generating modules export their artifact paths relative to the *project
 * root* (e.g. `install-ledger.js`'s `LEDGER_RELATIVE_PATH`), whereas the
 * prune pass compares paths relative to this directory — {@link
 * toManagedZoneRelative} is the one conversion between the two.
 */
const AGENTS_DIR = '.agents';

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
 * Relative path (from `.agents/`) of the version marker `runSync` writes
 * after every sync, carrying the executing package's own version.
 */
export const VERSION_MARKER_RELATIVE_PATH = '.mandrel-version';

/**
 * Convert a project-root-relative POSIX path — the shape a generating module
 * exports as its own source of truth (e.g. `install-ledger.js`'s
 * `LEDGER_RELATIVE_PATH`, `'.agents/.install-manifest.json'`) — into the
 * `.agents/`-relative, OS-separator form {@link listDestFiles} enumerates and
 * {@link GENERATED_FILES} is compared against.
 *
 * Throws on a path outside `.agents/`: a generated file the sync prune pass
 * never walks has no business in the registry, and registering one would be a
 * silent no-op that reads as protection. Failing at module load surfaces the
 * mistake at the first import rather than as a mystery deletion in a
 * consumer's tree.
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
 * The **generated, never-pruned registry**: every framework-generated
 * `.agents/` file that has no payload counterpart and must therefore be
 * exempted from the prune pass. Paths are `.agents/`-relative with OS
 * separators, matching what {@link listDestFiles} enumerates.
 *
 * The prune pass (Story #4046 A3) deletes any managed-zone file absent from
 * the payload. That is the correct rule for consumer drift, but it is also
 * exactly the shape of every file the framework itself generates into
 * `.agents/` outside the payload — so each such artifact is deleted by the very
 * sync that wrote it unless registered here. Two have hit this already: the
 * install ledger (`.agents/.install-manifest.json`), whose loss made
 * `mandrel uninstall` silently reverse nothing and exit 0 (Story #4534), and
 * the version marker (Story #4530).
 *
 * This is deliberately a **registry, not a list of special cases**. Register a
 * new generated file by adding one entry here — keyed off the generating
 * module's own exported constant wherever one exists, never a duplicated
 * string literal — rather than by adding another branch to
 * {@link listDestFiles}. That keeps the never-prune contract declared in one
 * place and keeps the registry honest: if the generator renames its artifact,
 * the exemption moves with it.
 *
 * This registry does **not** subsume the `.agents/local/` zone or the
 * `*.local.*` overrides ({@link LOCAL_ZONE_DIR}, {@link LOCAL_OVERRIDE_RE}).
 * Those are a different concept — consumer-authored overrides, not
 * framework-generated artifacts — and stay separate on purpose.
 */
export const GENERATED_FILES = Object.freeze([
  // Version marker (Story #4530) — written by runSync itself, below.
  VERSION_MARKER_RELATIVE_PATH,
  // Install ledger (Story #4534) — written by the bootstrap
  // (`install-ledger.js`), read by `mandrel uninstall` as its single source of
  // truth. Keyed off the generator's exported constant.
  toManagedZoneRelative(LEDGER_RELATIVE_PATH),
]);

/**
 * Resolve the version of the package whose `.agents/` payload was just
 * copied — i.e. the version the marker must carry. Reads `package.json` at
 * the already-resolved `packageRoot`, never the two-directories-up
 * self-referential pattern `lib/cli/update.js`'s pre-Story-#4530
 * `defaultCurrentVersion` used (that pattern conflates "the CLI that is
 * running" with "the payload that was materialized" — the exact confusion
 * #4525 fixes on the consumer-pin side of this Story).
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
 * Read the consumer's `.agents/.mandrel-version` marker. Returns `null` when
 * absent — a pre-marker install, or a tree that has never been synced —
 * so callers (the sync-commands mismatch refusal, the doctor pin check) can
 * degrade to their existing content-hash drift check rather than failing.
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
 * relative to `dir` using OS separators. Three disjoint classes are skipped,
 * so a caller diffing this against the payload never treats them as stale:
 *
 *   1. The top-level `local/` subtree — consumer additions inside
 *      `.agents/local/` are never pruned (Story #3498).
 *   2. Files matching the `*.local.*` convention (e.g.
 *      `.agents/instructions.local.md`) — the documented consumer override
 *      mechanism (instructions.md § 1.E); they never ship in the payload and
 *      must survive every sync.
 *   3. Everything declared in the {@link GENERATED_FILES} registry —
 *      framework-generated artifacts with no payload counterpart by design
 *      (Story #4534). New generated files are registered there, not added as
 *      a fourth branch here.
 *
 * (1) and (2) are consumer-authored; (3) is framework-generated. They are
 * kept separate deliberately — conflating them would muddy both contracts.
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
    // Framework-generated artifacts — declared once in the never-pruned
    // registry (Story #4534); see GENERATED_FILES.
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

  // Version marker (Story #4530): written AFTER the prune pass, never
  // before — the GENERATED_FILES registry already keeps listDestFiles from
  // ever enumerating it as stale, but ordering the write after prune is a
  // second, independent safeguard against the same class of bug (see the
  // GENERATED_FILES doc comment) surviving a future prune-pass reorder. The
  // install ledger gets no such belt-and-braces: it is written by the
  // bootstrap, not here, so the registry is its only protection.
  const packageVersion = resolvePackageVersion(packageRoot, fs);
  fs.writeFileSync(
    path.join(destRoot, VERSION_MARKER_RELATIVE_PATH),
    `${packageVersion}\n`,
  );

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
 * Default export consumed by `bin/mandrel.js`.
 *
 * @param {string[]} argv - Subcommand arguments (after `mandrel sync`).
 * @returns {Promise<void>}
 */
export default async function run(argv = []) {
  runSync({ argv });
}

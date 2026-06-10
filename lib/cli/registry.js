// lib/cli/registry.js
/**
 * Doctor check + remedy registry for `mandrel doctor`.
 *
 * Exports an ordered array of check objects each shaped `{ name, run() }`.
 * `run()` returns `{ ok, detail, remedy? }` — `remedy` is present and
 * non-empty only when `ok` is false. The registry is the single source of
 * truth for which checks the doctor command runs and in what order.
 *
 * Checks run sequentially in the doctor runner (not in parallel) because
 * some checks are meaningless without a prerequisite having passed first
 * (e.g. `gh-auth` requires `gh-available`).
 *
 * Design goals
 * - Every check is injectable via optional seam parameters so tests can
 *   drive every branch without spawning real child processes.
 * - The `github-token` check never echoes the token value in `detail` or
 *   `remedy` (security baseline §5 — Secrets Management).
 * - Node built-ins only; no third-party imports so the module loads inside
 *   the preflight guard before any third-party package is present.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readCache } from './version-check.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Synchronously spawn a binary and return `{ status, stdout, stderr, error }`.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @returns {{ status: number|null, stdout: string, stderr: string, error?: NodeJS.ErrnoException }}
 */
function spawn(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return {
    status: r.status,
    stdout: typeof r.stdout === 'string' ? r.stdout : '',
    stderr: typeof r.stderr === 'string' ? r.stderr : '',
    error: r.error,
  };
}

// ---------------------------------------------------------------------------
// check: node-version
// ---------------------------------------------------------------------------

/**
 * The minimum Node version the framework requires (`engines.node`).
 * Mirrors `lib/bootstrap/project-bootstrap.js#REQUIRED_NODE_FLOOR`.
 */
const REQUIRED_NODE_FLOOR = '22.22.1';
const REQUIRED_NODE_CEILING_MAJOR = 25;

/**
 * Return true when `version` satisfies `>=22.22.1 <25`.
 *
 * @param {string} version
 * @returns {boolean}
 */
function satisfiesNodeEngine(version) {
  const [majorRaw, minorRaw, patchRaw] = String(version).split('.');
  const major = Number.parseInt(majorRaw, 10) || 0;
  const minor = Number.parseInt(minorRaw, 10) || 0;
  const patch = Number.parseInt(patchRaw, 10) || 0;
  if (major >= REQUIRED_NODE_CEILING_MAJOR) return false;
  if (major > 22) return true;
  if (major < 22) return false;
  if (minor > 22) return true;
  if (minor < 22) return false;
  return patch >= 1;
}

/**
 * @param {{ nodeVersion?: string }} [opts]
 * @returns {{ ok: boolean, detail: string, remedy?: string }}
 */
function runNodeVersion({ nodeVersion = process.versions.node } = {}) {
  const ok = satisfiesNodeEngine(nodeVersion);
  const detail = `v${nodeVersion} (required >=${REQUIRED_NODE_FLOOR} <${REQUIRED_NODE_CEILING_MAJOR})`;
  if (ok) return { ok: true, detail };
  return {
    ok: false,
    detail,
    remedy: `Upgrade Node to >=${REQUIRED_NODE_FLOOR} <${REQUIRED_NODE_CEILING_MAJOR}: https://nodejs.org/`,
  };
}

// ---------------------------------------------------------------------------
// check: git-available
// ---------------------------------------------------------------------------

/**
 * @param {{ runner?: (cmd: string, args: string[]) => { status: number|null, stdout: string, stderr: string, error?: NodeJS.ErrnoException } }} [opts]
 * @returns {{ ok: boolean, detail: string, remedy?: string }}
 */
function runGitAvailable({ runner = spawn } = {}) {
  const r = runner('git', ['--version']);
  if (r.error?.code === 'ENOENT' || r.status !== 0) {
    const snippet = (r.stderr || r.stdout || '').trim().slice(0, 120);
    return {
      ok: false,
      detail: snippet || 'git not found on PATH',
      remedy: 'Install git: https://git-scm.com/downloads — then re-run.',
    };
  }
  return { ok: true, detail: r.stdout.trim().split('\n')[0] };
}

// ---------------------------------------------------------------------------
// check: gh-available
// ---------------------------------------------------------------------------

/**
 * @param {{ runner?: (cmd: string, args: string[]) => { status: number|null, stdout: string, stderr: string, error?: NodeJS.ErrnoException } }} [opts]
 * @returns {{ ok: boolean, detail: string, remedy?: string }}
 */
function runGhAvailable({ runner = spawn } = {}) {
  const r = runner('gh', ['--version']);
  if (r.error?.code === 'ENOENT' || r.status !== 0) {
    const snippet = (r.stderr || r.stdout || '').trim().slice(0, 120);
    return {
      ok: false,
      detail: snippet || 'gh not found on PATH',
      remedy: 'Install gh CLI: https://cli.github.com/ — then re-run.',
    };
  }
  return { ok: true, detail: r.stdout.trim().split('\n')[0] };
}

// ---------------------------------------------------------------------------
// check: github-token
// ---------------------------------------------------------------------------

/**
 * Verify a GitHub token is resolvable the way the runtime resolves it.
 *
 * Parity with `.agents/scripts/providers/github/auth.js#resolveToken`: a
 * token counts as present when either `GITHUB_TOKEN` / `GH_TOKEN` is set in
 * the environment **or** `gh auth token` returns a value. The `mandrel` CLI
 * does not load `.env`, so the previous env-only check false-blocked
 * operators who authenticate solely via `gh auth login` (Finding A.4) —
 * the runtime never needed `GITHUB_TOKEN` in that case because it falls back
 * to the `gh` CLI. Never echoes the token value in `detail` or `remedy`
 * (security baseline §5 — Secrets Management).
 *
 * @param {{ env?: Record<string,string|undefined>,
 *   runner?: (cmd: string, args: string[]) => {
 *     status: number|null, stdout: string, stderr: string,
 *     error?: NodeJS.ErrnoException } }} [opts]
 * @returns {{ ok: boolean, detail: string, remedy?: string }}
 */
function runGithubToken({ env = process.env, runner = spawn } = {}) {
  const envToken = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (envToken && envToken.length > 0) {
    return { ok: true, detail: 'GITHUB_TOKEN set' };
  }
  const r = runner('gh', ['auth', 'token']);
  const ghToken = !r.error && r.status === 0 ? (r.stdout || '').trim() : '';
  if (ghToken.length > 0) {
    return { ok: true, detail: 'token resolved via `gh auth token`' };
  }
  return {
    ok: false,
    detail: 'no GitHub token (env unset, `gh auth token` returned nothing)',
    remedy:
      'Run `gh auth login` (the CLI resolves the token via `gh auth token`), or export GITHUB_TOKEN=<your-token>.',
  };
}

// ---------------------------------------------------------------------------
// check: gh-auth
// ---------------------------------------------------------------------------

/**
 * @param {{ runner?: (cmd: string, args: string[]) => { status: number|null, stdout: string, stderr: string, error?: NodeJS.ErrnoException } }} [opts]
 * @returns {{ ok: boolean, detail: string, remedy?: string }}
 */
function runGhAuth({ runner = spawn } = {}) {
  const r = runner('gh', ['auth', 'status']);
  if (r.error?.code === 'ENOENT') {
    return {
      ok: false,
      detail: 'gh not found — auth check skipped',
      remedy: 'Install the GitHub CLI: https://cli.github.com',
    };
  }
  if (r.status !== 0) {
    return {
      ok: false,
      detail: 'not logged in',
      remedy:
        'Run `gh auth login` (choose GitHub.com → HTTPS → login with a web browser), then re-run.',
    };
  }
  // Extract "Logged in to github.com as <handle>" from stdout or stderr.
  const output = (r.stdout + r.stderr).trim();
  const match = /Logged in to \S+ as (\S+)/i.exec(output);
  const detail = match ? `logged in as ${match[1]}` : 'logged in';
  return { ok: true, detail };
}

// ---------------------------------------------------------------------------
// check: commands-in-sync
// ---------------------------------------------------------------------------

/**
 * Resolve the project root — the directory that contains `.agents/` and
 * `.claude/`. Walks up from this file's own location.
 *
 * @returns {string}
 */
function resolveProjectRoot() {
  // lib/cli/registry.js lives at <root>/lib/cli/registry.js, so walk up two
  // levels from __dirname to reach the project root.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..');
}

/**
 * Dry-run the sync-claude-commands logic: compare `.agents/workflows/*.md`
 * sources to the generated flat command tree `.claude/commands/*.md`
 * destinations and report parity (the projection is a flat `/<name>` command
 * surface; the #3576 plugin projection was reverted).
 *
 * Resolution anchor (Story #3588): the root defaults to `process.cwd()` —
 * the consumer project directory where `mandrel sync` materializes both
 * `.agents/` and the command tree — mirroring the `agents-materialized`
 * and `agents-drift` checks. It MUST NOT fall back to `resolveProjectRoot()`:
 * that walks up from this module's own location and lands on the *package*
 * directory in an npm-installed consumer
 * (`node_modules/@mandrelai/agents/`), where the generated command tree never
 * exists — yielding a permanent `N not synced` false positive whose
 * `npm run sync:commands` remedy can never clear it.
 *
 * Injectable seams (used by tests so no real filesystem is touched):
 * - `cwd()` replaces `process.cwd` so tests can pin the consumer root.
 * - `readDir` replaces `fs.readdirSync`.
 *
 * @param {{ projectRoot?: string, cwd?: () => string, readDir?: (dir: string) => string[] }} [opts]
 * @returns {{ ok: boolean, detail: string, remedy?: string }}
 */
function runCommandsInSync({ projectRoot, cwd, readDir } = {}) {
  const getCwd = cwd ?? (() => process.cwd());
  const root = projectRoot ?? getCwd();
  const listDir =
    readDir ??
    ((dir) => {
      try {
        return fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
      } catch {
        return [];
      }
    });

  const srcDir = path.join(root, '.agents', 'workflows');
  const destDir = path.join(root, '.claude', 'commands');

  // Only top-level .md files are synced (helpers/ subdirectory excluded by
  // the sync script — they are path-included modules, not slash commands).
  const sources = listDir(srcDir)
    .filter((f) => !f.startsWith('.'))
    .sort();
  const dests = listDir(destDir)
    .filter((f) => !f.startsWith('.'))
    .sort();

  const srcSet = new Set(sources);
  const dstSet = new Set(dests);
  const missing = sources.filter((f) => !dstSet.has(f));
  const extra = dests.filter((f) => !srcSet.has(f));

  if (missing.length === 0 && extra.length === 0) {
    return { ok: true, detail: `${sources.length} commands up to date` };
  }

  const parts = [];
  if (missing.length > 0) parts.push(`${missing.length} not synced`);
  if (extra.length > 0) parts.push(`${extra.length} stale`);
  return {
    ok: false,
    detail: parts.join(', '),
    remedy:
      'Run `npm run sync:commands` to regenerate the `.claude/commands/` tree.',
  };
}

// ---------------------------------------------------------------------------
// check: runtime-deps
// ---------------------------------------------------------------------------

/**
 * Verify that the framework's required runtime dependencies are resolvable
 * from the project's node_modules.
 *
 * Injectable seams:
 * - `resolve(dep)` — replaces the real `require.resolve`; throws when a dep
 *   is missing.
 * - `manifestRequired` — array of required package names, skips the
 *   filesystem read of `runtime-deps.json`.
 *
 * @param {{ projectRoot?: string, resolve?: (dep: string) => string, manifestRequired?: string[] }} [opts]
 * @returns {{ ok: boolean, detail: string, remedy?: string }}
 */
function runRuntimeDeps({
  projectRoot,
  resolve: resolveSeam,
  manifestRequired,
} = {}) {
  let required = manifestRequired;
  if (!required) {
    try {
      const root = projectRoot ?? resolveProjectRoot();
      const manifestPath = path.join(root, '.agents', 'runtime-deps.json');
      const raw = fs.readFileSync(manifestPath, 'utf8');
      const parsed = JSON.parse(raw);
      required = Object.keys(parsed.dependencies ?? {});
    } catch {
      required = [];
    }
  }

  if (required.length === 0) {
    return { ok: true, detail: 'all dependencies found' };
  }

  const missing = [];

  if (resolveSeam) {
    for (const dep of required) {
      try {
        resolveSeam(dep);
      } catch {
        missing.push(dep);
      }
    }
  } else {
    // Anchor resolution to the project root so it mirrors the context in which
    // the framework scripts run (they free-ride on the consumer's node_modules).
    const root = projectRoot ?? resolveProjectRoot();
    const req = createRequire(path.join(root, 'package.json'));
    for (const dep of required) {
      try {
        req.resolve(dep);
      } catch {
        missing.push(dep);
      }
    }
  }

  if (missing.length === 0) {
    return { ok: true, detail: 'all dependencies found' };
  }
  return {
    ok: false,
    detail: `missing: ${missing.join(', ')}`,
    remedy: `Run \`npm install\` in the repository root to install missing packages: ${missing.join(', ')}`,
  };
}

// ---------------------------------------------------------------------------
// check: agents-materialized
// ---------------------------------------------------------------------------

/**
 * Verify that the `.agents/` payload has been materialized into the consumer
 * project (`./.agents/instructions.md` exists). When it is absent but the
 * `@mandrelai/agents` package *is* installed in node_modules, the project is in
 * the "postinstall-skipped" state — the package was installed with scripts
 * disabled (e.g. `npm ci --ignore-scripts`, a sandboxed CI, or a package
 * manager that skips lifecycle scripts), so the materializer never ran. The
 * remedy is to run `mandrel sync` (lib/cli/sync.js) by hand.
 *
 * Resolution anchors:
 * - `./.agents/instructions.md` is resolved against `cwd` (the consumer
 *   project root), matching where `mandrel sync` writes the materialized tree.
 * - `@mandrelai/agents` is resolved from `cwd` so we detect *their* install, not
 *   a copy hoisted next to this CLI module — mirroring sync.js's resolver.
 *
 * Injectable seams (used by tests so no real filesystem or package is needed):
 * - `cwd()` — replaces `process.cwd`.
 * - `existsSync(p)` — replaces `fs.existsSync`.
 * - `resolvePackage(fromDir)` — replaces `@mandrelai/agents` resolution; throws
 *   when the package is not installed.
 *
 * @param {{
 *   cwd?: () => string,
 *   existsSync?: (p: string) => boolean,
 *   resolvePackage?: (fromDir: string) => string,
 * }} [opts]
 * @returns {{ ok: boolean, detail: string, remedy?: string }}
 */
function runAgentsMaterialized({ cwd, existsSync, resolvePackage } = {}) {
  const getCwd = cwd ?? (() => process.cwd());
  const exists = existsSync ?? ((p) => fs.existsSync(p));
  const root = getCwd();
  const instructionsPath = path.join(root, '.agents', 'instructions.md');

  if (exists(instructionsPath)) {
    return { ok: true, detail: '.agents/ materialized' };
  }

  const resolvePkg =
    resolvePackage ??
    ((fromDir) => {
      const requireFrom = createRequire(path.join(fromDir, 'noop.js'));
      return requireFrom.resolve('@mandrelai/agents/package.json');
    });

  let packageInstalled = false;
  try {
    resolvePkg(root);
    packageInstalled = true;
  } catch {
    packageInstalled = false;
  }

  if (packageInstalled) {
    return {
      ok: false,
      detail: '@mandrelai/agents installed but ./.agents/ not materialized',
      remedy:
        'Run `mandrel sync` to materialize the .agents/ payload (postinstall was skipped).',
    };
  }

  return {
    ok: false,
    detail: '@mandrelai/agents not installed and ./.agents/ absent',
    remedy:
      'Install the framework (`npm install @mandrelai/agents`), then run `mandrel sync`.',
  };
}

// ---------------------------------------------------------------------------
// check: agents-drift
// ---------------------------------------------------------------------------

/**
 * Package name whose `.agents/` payload is the drift baseline. Mirrors
 * `lib/cli/sync.js#PACKAGE_NAME`.
 */
const PACKAGE_NAME = '@mandrelai/agents';

/**
 * Top-level directory name (relative to `.agents/`) reserved as the
 * sync-exempt local-additions zone (Story #3498, f-drift-local-zone).
 *
 * `.agents/local/` is consumer-owned space that `mandrel sync` never
 * materializes nor prunes, so it is excluded from the drift comparison —
 * a hand-authored file under `.agents/local/` is sanctioned, not drift.
 * Mirrors `lib/cli/sync.js#LOCAL_ZONE_DIR`.
 */
const LOCAL_ZONE_DIR = 'local';

/**
 * Default resolver: locate the installed `@mandrelai/agents` package root by
 * resolving its `package.json` and returning the directory that contains it.
 * Mirrors `lib/cli/sync.js#defaultResolvePackageRoot` so the drift baseline
 * is exactly the payload that `mandrel sync` would copy.
 *
 * @param {string} fromDir - Directory to resolve from (the consumer project).
 * @returns {string} Absolute path to the package root.
 */
function defaultResolvePackageRoot(fromDir) {
  const requireFrom = createRequire(path.join(fromDir, 'noop.js'));
  const pkgJsonPath = requireFrom.resolve(`${PACKAGE_NAME}/package.json`);
  return path.dirname(pkgJsonPath);
}

/**
 * Recursively enumerate every regular file under `dir`, returning paths
 * relative to `dir` using OS separators. The top-level `local/` subtree is
 * skipped entirely — it is the consumer-owned local-additions zone and is
 * never part of the package payload (Story #3498). Mirrors
 * `lib/cli/sync.js#listFiles` so source enumeration matches the materializer.
 *
 * @param {string} dir - Absolute directory to walk.
 * @param {typeof fs} fsImpl
 * @param {string} [prefix] - Accumulated relative prefix (internal).
 * @returns {string[]} Relative file paths.
 */
function listPayloadFiles(dir, fsImpl, prefix = '') {
  const out = [];
  for (const ent of fsImpl.readdirSync(dir, { withFileTypes: true })) {
    // Scope the local-zone skip to the top-level `.agents/local/` only; a
    // deeper directory that happens to be named `local` stays in scope.
    if (prefix === '' && ent.name === LOCAL_ZONE_DIR && ent.isDirectory()) {
      continue;
    }
    const rel = prefix ? path.join(prefix, ent.name) : ent.name;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...listPayloadFiles(abs, fsImpl, rel));
    } else {
      out.push(rel);
    }
  }
  return out;
}

/**
 * Compare the consumer's materialized `./.agents/<f>` bytes against the
 * installed package payload (`node_modules/@mandrelai/agents/.agents/<f>`),
 * excluding the `.agents/local/` zone. Reports the first drifted (or
 * missing) materialized file so the operator can re-sync or move local edits
 * into `.agents/local/`.
 *
 * Security: logs only paths and counts — file contents are read for a byte
 * comparison but never placed into `detail` or `remedy` (security baseline
 * §5 — Data Leakage & Logging). The comparison is short-circuiting and never
 * accumulates file contents.
 *
 * Injectable seams (used by tests so no real filesystem or package is needed):
 * - `cwd()` — replaces `process.cwd`.
 * - `fsImpl` — replaces the `node:fs` surface (`existsSync`, `readdirSync`,
 *   `readFileSync`).
 * - `resolvePackageRoot(fromDir)` — replaces `@mandrelai/agents` resolution;
 *   throws when the package is not installed.
 *
 * @param {{
 *   cwd?: () => string,
 *   fsImpl?: { existsSync: (p: string) => boolean, readdirSync: Function, readFileSync: Function },
 *   resolvePackageRoot?: (fromDir: string) => string,
 * }} [opts]
 * @returns {{ ok: boolean, detail: string, remedy?: string }}
 */
function runAgentsDrift({ cwd, fsImpl = fs, resolvePackageRoot } = {}) {
  const getCwd = cwd ?? (() => process.cwd());
  const resolveRoot = resolvePackageRoot ?? defaultResolvePackageRoot;
  const projectRoot = getCwd();

  let packageRoot;
  try {
    packageRoot = resolveRoot(projectRoot);
  } catch {
    // Without the package installed there is no baseline to compare against;
    // agents-materialized owns the "not installed" remedy, so this check is
    // a no-op success rather than a false drift signal.
    return {
      ok: true,
      detail: '@mandrelai/agents not installed — drift skipped',
    };
  }

  const sourceRoot = path.join(packageRoot, '.agents');
  if (!fsImpl.existsSync(sourceRoot)) {
    return {
      ok: true,
      detail: '@mandrelai/agents ships no .agents/ payload — drift skipped',
    };
  }

  const destRoot = path.join(projectRoot, '.agents');
  if (!fsImpl.existsSync(destRoot)) {
    // Nothing materialized yet — agents-materialized owns that remedy.
    return { ok: true, detail: './.agents/ not materialized — drift skipped' };
  }

  const files = listPayloadFiles(sourceRoot, fsImpl);
  let comparedCount = 0;
  let missingCount = 0;

  for (const rel of files) {
    const src = path.join(sourceRoot, rel);
    const dest = path.join(destRoot, rel);
    const relLabel = path.join('.agents', rel);

    if (!fsImpl.existsSync(dest)) {
      missingCount += 1;
      return {
        ok: false,
        detail: `${relLabel} is missing from ./.agents/ (${missingCount} of ${files.length} payload files checked so far)`,
        remedy:
          'Run `mandrel sync` to restore the materialized .agents/ payload.',
      };
    }

    const srcBytes = fsImpl.readFileSync(src);
    const destBytes = fsImpl.readFileSync(dest);
    comparedCount += 1;
    if (!srcBytes.equals(destBytes)) {
      return {
        ok: false,
        detail: `${relLabel} differs from the installed package payload`,
        remedy:
          'Run `mandrel sync` to overwrite local edits, or move intentional changes into the `.agents/local/` zone.',
      };
    }
  }

  return {
    ok: true,
    detail: `${comparedCount} materialized file(s) match the package payload`,
  };
}

// ---------------------------------------------------------------------------
// check: version-current
// ---------------------------------------------------------------------------

/**
 * Parse a dotted semver-ish string into a numeric tuple. Non-numeric or
 * missing segments coerce to 0 so a partial version still compares sanely.
 * Mirrors `lib/cli/update.js#parseVersion`.
 *
 * @param {string} version
 * @returns {[number, number, number]}
 */
function parseVersionTuple(version) {
  const [major, minor, patch] = String(version).split('.');
  return [
    Number.parseInt(major, 10) || 0,
    Number.parseInt(minor, 10) || 0,
    Number.parseInt(patch, 10) || 0,
  ];
}

/**
 * Compare two version strings. Negative when `a < b`, zero when equal,
 * positive when `a > b`. Mirrors `lib/cli/update.js#compareVersions`.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareSemver(a, b) {
  const pa = parseVersionTuple(a);
  const pb = parseVersionTuple(b);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/**
 * Resolve the installed `@mandrelai/agents` version from this package's own
 * `package.json`. This module lives at `<root>/lib/cli/registry.js`, so the
 * manifest is two directories up. Mirrors `lib/cli/update.js#defaultCurrentVersion`.
 *
 * @param {typeof fs} fsImpl
 * @returns {string}
 */
function defaultInstalledVersion(fsImpl) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const manifestPath = path.resolve(here, '..', '..', 'package.json');
  const parsed = JSON.parse(fsImpl.readFileSync(manifestPath, 'utf8'));
  return String(parsed.version);
}

/**
 * Default cache filename — mirrors `version-check.js#DEFAULT_CACHE_FILENAME`.
 */
const DEFAULT_VERSION_CACHE_FILENAME = 'version-check.json';

/**
 * Default cache path: `<projectRoot>/temp/version-check.json`, the same daily
 * freshness cache that `lib/cli/version-check.js` reads and refreshes.
 *
 * @returns {string}
 */
function defaultVersionCachePath() {
  return path.join(
    resolveProjectRoot(),
    'temp',
    DEFAULT_VERSION_CACHE_FILENAME,
  );
}

/**
 * Cache-only stale-version advisory (Story #3507, Epic #3437 — f-notify-stale).
 *
 * Reads the daily freshness cache written by `lib/cli/version-check.js` and
 * reports whether a newer version than the installed one is already known
 * locally. This check is **cache-only**: it NEVER issues a network request
 * (it calls `readCache`, not `isStale`, so the network `runner` seam is never
 * reached) — the daily refresh is owned by `version-check.js`, invoked
 * elsewhere on the normal command path.
 *
 * **Non-fatal advisory contract.** A stale install is informational, not a
 * readiness failure, so this check ALWAYS returns `ok: true` and therefore can
 * never flip `mandrel doctor`'s exit code or block CI. When a newer version is
 * cached, the advisory is surfaced through `detail` ("a newer version is
 * available") and an actionable `remedy` (`mandrel update`); when the cache is
 * absent, malformed, or already current, the check reports the up-to-date /
 * unknown state with no remedy. The registry entry carries `advisory: true` so
 * downstream renderers can label it as informational.
 *
 * Security (security-baseline § 5 — Data Leakage & Logging): emits only version
 * strings; never reads or echoes tokens, credentials, or raw cache bytes beyond
 * the two version fields `readCache` already validates.
 *
 * Injectable seams (used by tests so no real filesystem is touched):
 * - `cachePath`        — absolute path to the freshness cache JSON.
 * - `installedVersion` — the currently installed version string.
 * - `fsImpl`           — `node:fs` surface forwarded to `readCache`.
 *
 * @param {{
 *   cachePath?: string,
 *   installedVersion?: string,
 *   fsImpl?: typeof fs,
 * }} [opts]
 * @returns {{ ok: boolean, detail: string, remedy?: string }}
 */
function runVersionCurrent({ cachePath, installedVersion, fsImpl = fs } = {}) {
  const resolvedPath = cachePath ?? defaultVersionCachePath();

  let current = installedVersion;
  if (!current) {
    try {
      current = defaultInstalledVersion(fsImpl);
    } catch {
      // Without a readable manifest we cannot compare; stay non-fatal.
      return {
        ok: true,
        detail: 'installed version unknown — advisory skipped',
      };
    }
  }

  const cached = readCache({ cachePath: resolvedPath, fs: fsImpl });
  if (!cached) {
    // Missing / malformed cache → nothing to advise on yet. Non-fatal.
    return {
      ok: true,
      detail: `v${current} (no cached freshness check yet)`,
    };
  }

  if (compareSemver(cached.latestVersion, current) > 0) {
    return {
      ok: true,
      detail: `a newer version is available: v${current} → v${cached.latestVersion} (advisory)`,
      remedy: 'Run `mandrel update` to upgrade to the latest version.',
    };
  }

  return { ok: true, detail: `v${current} is up to date` };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Ordered array of doctor checks. Each entry follows the
 * `{ name: string, run(opts?): { ok: boolean, detail: string, remedy?: string } }` contract.
 * The doctor runner iterates this array sequentially.
 *
 * The `run` functions return plain objects (not Promises) — the doctor runner
 * may call them with `await` but they do not need to be async.
 */
export const registry = [
  {
    name: 'node-version',
    run: (opts) => runNodeVersion(opts),
  },
  {
    name: 'git-available',
    run: (opts) => runGitAvailable(opts),
  },
  {
    name: 'gh-available',
    run: (opts) => runGhAvailable(opts),
  },
  {
    name: 'github-token',
    run: (opts) => runGithubToken(opts),
  },
  {
    name: 'gh-auth',
    run: (opts) => runGhAuth(opts),
  },
  {
    name: 'commands-in-sync',
    run: (opts) => runCommandsInSync(opts),
  },
  {
    name: 'runtime-deps',
    run: (opts) => runRuntimeDeps(opts),
  },
  {
    name: 'agents-materialized',
    run: (opts) => runAgentsMaterialized(opts),
  },
  {
    name: 'agents-drift',
    run: (opts) => runAgentsDrift(opts),
  },
  {
    name: 'version-current',
    // Non-fatal: surfaces a cache-only stale-version advisory. `run()` always
    // returns ok:true, so it never blocks `mandrel doctor`'s exit code or CI.
    advisory: true,
    run: (opts) => runVersionCurrent(opts),
  },
];

export default registry;

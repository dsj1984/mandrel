// lib/cli/update.js
/**
 * `mandrel update` subcommand — the auto-update orchestrator (f-update-command,
 * Story #3503, Epic #3437 — Auto-Update & Version Lifecycle).
 *
 * Advances `mandrel` to the newest published version, re-materializes
 * `.agents/`, runs applicable version-keyed migrations, surfaces the target
 * changelog, and verifies the result via the doctor registry. Major crossings
 * are applied like any other bump (hard-cutover doctrine —
 * `.agents/rules/git-conventions.md` § Contract Cutovers).
 *
 * ## Ordered cycle (happy path)
 *
 *   1. resolve target version (newest published) and the current version
 *   2. drift-aware short-circuit — version check gates on installed version AND
 *      materialized `.agents/` state (Story #4065). When already on newest AND
 *      no drift: nothing to do (true no-op). When already on newest BUT drift
 *      detected: skip npm-update/migrations, run sync + sync-commands to heal.
 *   3. install        — bump the dependency (lockfile bump left STAGED).
 *      The package manager is auto-detected from the lockfile in the project
 *      root: `pnpm-lock.yaml` ⇒ `pnpm add -D …` (with `-w` at a
 *      `pnpm-workspace.yaml` root), `yarn.lock` ⇒ `yarn add -D …`, otherwise
 *      `npm install …`. An explicit `--install-cmd "<pm> <args>"` overrides
 *      detection; a `{target}` placeholder in the override is substituted with
 *      the resolved version so an override can still consume the auto-probed
 *      newest. The registry probe in step 1 always stays on `npm view` (a
 *      PM-agnostic registry query).
 *   4. runSync        — re-materialize ./.agents/ **from the newly-installed
 *      binary** so the materialized payload is always the target version's.
 *   5. runMigrations  — apply version-keyed steps for the crossed range,
 *      **from the newly-installed binary**.
 *   6. doctor         — run the check registry **from the newly-installed
 *      binary** so `agents-drift` is never a false-green against stale payload.
 *   7. surface the changelog for the target version
 *
 * ## Re-exec of post-install phases (Story #4034)
 *
 * Steps 4–6 execute as **child processes spawned from the newly-installed
 * binary** (`<cwd>/node_modules/.bin/mandrel`) rather than in the running
 * process. Node cannot hot-swap a `require`d module mid-process, so without
 * re-exec, the still-running old binary's `runSync`/`runMigrations`/`runDoctor`
 * code would materialise the old payload even though the package on disk has
 * already been updated. This produced the silent stale-`.agents/`
 * materialization and `doctor` false-green observed in the v1.58.0 → v1.59.0
 * consumer upgrade.
 *
 * The orchestration (progress messages, step tracking, changelog surface, exit
 * code) stays in the parent process; only the version-sensitive phases run from
 * the new bin. The `spawnPhase` seam makes the child-process boundary fully
 * injectable so tests can verify the re-exec path without a real npm install.
 * It is the **only** post-install execution path — tests stub the spawn
 * boundary rather than swapping in an in-process implementation (No-Shim:
 * `.agents/rules/git-conventions.md` § Contract Cutovers).
 *
 * ## No git mutation
 *
 * The npm dependency bump rewrites `package.json` / `package-lock.json` in the
 * working tree but the orchestrator performs **no** `git add` / `git commit`:
 * the lockfile bump is left staged-on-disk for the operator to review and
 * commit. This module never shells out to git.
 *
 * ## `--dry-run`
 *
 * Prints the resolved target version and the ordered step plan, then returns
 * without invoking any effectful seam (no npm update, no sync, no migrations,
 * no doctor) and writing nothing.
 *
 * ## Changelog surface
 *
 * `defaultSurfaceChangelog` prints the `docs/CHANGELOG.md` section(s) for the
 * applied range `(current, target]`. It resolves the file against the target
 * version's install directory (the freshly bumped `node_modules/mandrel/`),
 * where the changelog is now included in the published tarball
 * (`docs/CHANGELOG.md` in the `files` allowlist — Story #4035).
 *
 * When the packaged file is absent (e.g. an older installed version predating
 * Story #4035), the seam attempts a one-shot HTTP GET of the raw file from
 * GitHub via the injectable `fetchChangelog` seam. If that fetch also fails,
 * the seam degrades gracefully — never throwing — and emits an actionable
 * message directing the operator to the GitHub Releases page.
 *
 * ## Injectable seams (used by lib/cli/__tests__/update*.test.js)
 *
 *   - `argv`                — subcommand args (after `mandrel update`)
 *   - `currentVersion`      — the installed `mandrel` version string
 *   - `resolveTargetVersion`— async, returns the newest published version
 *   - `checkDrift`          — sync or async, returns `true` when `.agents/`
 *                             differs from the installed payload. Used by the
 *                             drift-aware no-op short-circuit (Story #4065).
 *                             Defaults to `() => !runAgentsDrift().ok`, which
 *                             reuses the same `agents-drift` doctor signal.
 *   - `npmUpdate`           — async, performs the dependency bump (no git);
 *                             receives `(target, { installCmd })`
 *   - `spawnPhase`          — async, spawns a post-install phase from the new
 *                             binary; receives `(phase, args, { binPath, cwd })`
 *                             and returns `{ ok, stdout, stderr }`. This is the
 *                             sole post-install execution path. See § Re-exec of
 *                             post-install phases.
 *   - `surfaceChangelog`    — emits the target changelog section
 *   - `write` / `writeErr`  — stdout / stderr sinks
 *   - `exit`                — process.exit replacement
 *   - `cwd`                 — process.cwd() replacement (used to resolve the
 *                             new binary path the post-install phases spawn from)
 *
 * Security (security-baseline § 5 — Data Leakage & Logging): logs only version
 * strings and step names. No tokens, credentials, or env
 * values are read or logged; no shell-string interpolation occurs here (the
 * npm bump is delegated to the injected `npmUpdate` seam, which owns transport).
 *
 * ## Windows spawn (CVE-2024-27980)
 *
 * Both child-process boundaries — the `npm view` registry probe and the
 * install — route through helpers that pass `shell: process.platform ===
 * 'win32'`. On Windows `npm`/`pnpm`/`yarn` resolve to `.cmd` shims, and
 * Node 18.20+/20.12+/22+/24 refuses to spawn `.cmd`/`.bat` with `shell:false`
 * (the CVE-2024-27980 hardening), throwing `spawnSync npm ENOENT`. The win32
 * shell flag is the documented fix. It is injection-safe because every argv
 * here is a **fixed vector**: the probe argv is the constant package name, and
 * the install argv is a tokenized list whose only variable segment is a
 * resolved semver string — see `lib/install-cmd-parser.js` for the shared
 * tokenize-and-spawn rationale this module reuses (no duplicated workaround).
 *
 * The `spawnPhase` default (Story #4034) similarly uses `shell: true` only on
 * Windows: the new binary resolves from `node_modules/.bin/mandrel` (a fixed,
 * non-operator-supplied path) and the per-phase argv vector is a constant
 * fixed list (e.g. `['sync']`, `['migrate', '--from', v, '--to', v]`,
 * `['doctor']`) with no injection risk regardless of the shell flag.
 */

import { spawnSync } from 'node:child_process';
import nodeFs from 'node:fs';
import nodeHttps from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectPackageManagerWithWorkspace } from '../../.agents/scripts/lib/detect-package-manager.js';
import { runInstallCommand } from '../../.agents/scripts/lib/install-cmd-parser.js';
import { runAgentsDrift } from './registry.js';
import { defaultResolvePackageRoot } from './sync.js';
import { isStale } from './version-check.js';
import { compareVersions, resolveConsumerPinVersion } from './version-helpers.js';

/** The published package whose newest version `mandrel update` advances to. */
const PACKAGE_NAME = 'mandrel';

/**
 * GitHub raw-file base URL for fetching `docs/CHANGELOG.md` when the packaged
 * file is absent (Story #4035 — GitHub fallback). Resolves to the tagged
 * release, e.g. `.../mandrel-v1.59.0/docs/CHANGELOG.md`.
 */
const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com/dsj1984/mandrel/';

/**
 * Human-readable GitHub Releases page — surfaced in the actionable fallback
 * message when neither the packaged file nor the GitHub fetch succeeds.
 */
const GITHUB_RELEASES_URL = 'https://github.com/dsj1984/mandrel/releases';

/** Default freshness-cache filename — mirrors version-check.js. */
const DEFAULT_CACHE_FILENAME = 'version-check.json';

/**
 * Resolve the installed `mandrel` version from this package's own
 * `package.json`. The module lives at `<root>/lib/cli/update.js`, so the
 * manifest is two directories up.
 *
 * Pre-Story-#4525 this was the update decision's `current` — the exact
 * self-referential confusion #4525 filed: "the version of the mandrel that
 * is executing" is tautologically `>= target` whenever the installed
 * package is newest, which made the `npm-update` step unreachable whenever
 * a consumer's declared pin had fallen behind what happened to be resolved
 * in `node_modules`. It survives here only as the last-resort fallback
 * inside {@link resolveCurrentVersionForUpdate}, for the case where even
 * `node_modules` resolution from the consumer root fails.
 *
 * @param {typeof nodeFs} [fs]
 * @returns {string}
 */
function defaultCurrentVersion(fs = nodeFs) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const manifestPath = path.resolve(here, '..', '..', 'package.json');
  const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  return String(parsed.version);
}

/**
 * Resolve the "current" version for the `mandrel update` decision
 * (Story #4525 / #4530): the consumer's declared `mandrel` dependency pin
 * when it resolves to a plain semver, falling back — in order — to the
 * version actually resolvable in the consumer's `node_modules` (anchored at
 * `consumerRoot` via the same resolution `mandrel sync` uses, unlike the
 * pre-#4525 self-referential `defaultCurrentVersion`), and finally to
 * `defaultCurrentVersion` itself when neither resolves (a corrupted or
 * highly unusual install — keeps `mandrel update` from throwing outright
 * rather than silently misreporting "already current").
 *
 * The declared pin is preferred because it is exactly what the `npm-update`
 * step moves: a consumer whose `package.json` pin lags an inflated
 * `node_modules` resolution (e.g. an out-of-band symlink or manual
 * `npm install mandrel@latest --no-save`) must still see `planUpdate`
 * choose `updated`, not `resynced` — the bug #4525 reported.
 *
 * @param {string} consumerRoot
 * @param {typeof nodeFs} [fs]
 * @param {{ resolvePackageRoot?: (fromDir: string) => string }} [opts] - test
 *   seam for the `node_modules` resolution tier; defaults to the real
 *   `defaultResolvePackageRoot` from `sync.js`.
 * @returns {string}
 */
export function resolveCurrentVersionForUpdate(
  consumerRoot,
  fs = nodeFs,
  { resolvePackageRoot = defaultResolvePackageRoot } = {},
) {
  const pinned = resolveConsumerPinVersion(consumerRoot, fs);
  if (pinned) return pinned;
  try {
    const packageRoot = resolvePackageRoot(consumerRoot);
    const parsed = JSON.parse(
      fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
    );
    return String(parsed.version);
  } catch {
    return defaultCurrentVersion(fs);
  }
}

/**
 * Resolve the project root — the directory two levels up from this module
 * (`<root>/lib/cli/update.js`). Mirrors `lib/cli/registry.js#resolveProjectRoot`.
 *
 * @returns {string}
 */
function resolveProjectRoot() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..');
}

/**
 * Default `resolveTargetVersion` seam: determine the newest published
 * `mandrel` version via the daily freshness cache (`version-check.js`).
 *
 * When `bypassCache` is `true` (the default for an explicit `mandrel update`
 * call — Story #4046 A1b), the cache freshness window is effectively zeroed by
 * passing `now` as far in the future, which makes `isStale` treat any existing
 * cache as stale and always issue exactly one network probe. The cache is still
 * written so the post-update `version-current` advisory has a fresh baseline.
 *
 * When `bypassCache` is `false` (passive staleness checks only), the normal
 * 24h-cache semantics apply: a fresh cache returns the cached version with
 * zero network I/O.
 *
 * The network probe shells `npm view` through `spawnSync` with a fixed argument
 * vector (no shell-string interpolation; the package name is a constant). On
 * Windows the spawn sets `shell: true` so the `npm.cmd` shim resolves under the
 * CVE-2024-27980 hardening (mirrors `lib/install-cmd-parser.js`); the fixed
 * argv carries no injection risk even with the shell flag set
 * (security-baseline § Output & Rendering).
 *
 * @param {{
 *   cachePath?: string,
 *   fs?: typeof nodeFs,
 *   runner?: () => string,
 *   now?: Date,
 *   bypassCache?: boolean,
 *   log?: (msg: string) => void,
 * }} [opts]
 * @returns {Promise<string>} The newest published version string.
 */
async function defaultResolveTargetVersion({
  cachePath = path.join(resolveProjectRoot(), 'temp', DEFAULT_CACHE_FILENAME),
  fs = nodeFs,
  runner = defaultVersionRunner,
  now = new Date(),
  bypassCache = false,
  log = () => {},
} = {}) {
  // When bypassCache is true, push `now` far enough into the future that any
  // cached checkedAt value is guaranteed to be older than the STALE_AFTER_MS
  // window, forcing a fresh network probe (Story #4046 A1b).
  const effectiveNow = bypassCache
    ? new Date(now.getTime() + 48 * 60 * 60 * 1000)
    : now;
  const result = await isStale({
    cachePath,
    now: effectiveNow,
    runner,
    fs,
    log,
  });
  return String(result.latestVersion);
}

/**
 * Default network `runner` for the freshness probe: shells
 * `npm view mandrel version` synchronously and returns the trimmed
 * stdout. Fixed argv (the package name is a constant), and `shell:true` only on
 * Windows so the `npm.cmd` shim resolves under CVE-2024-27980 — the fixed
 * vector keeps it injection-safe with or without the shell flag.
 *
 * @param {{ spawnSync?: typeof spawnSync }} [deps] — test seam for the spawn
 *   boundary; defaults to the real `node:child_process` spawnSync.
 * @returns {string} The newest published version string.
 */
export function defaultVersionRunner({ spawnSync: spawn = spawnSync } = {}) {
  const r = spawn('npm', ['view', PACKAGE_NAME, 'version'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (r.error) {
    throw new Error(
      `mandrel update: failed to probe newest ${PACKAGE_NAME} version: ${r.error.message}`,
    );
  }
  if (r.status !== 0) {
    const snippet = (r.stderr || r.stdout || '').trim().slice(0, 200);
    throw new Error(
      `mandrel update: \`npm view ${PACKAGE_NAME} version\` exited ${r.status}: ${snippet}`,
    );
  }
  const version = String(r.stdout || '').trim();
  if (!version) {
    throw new Error(
      `mandrel update: \`npm view ${PACKAGE_NAME} version\` returned no version`,
    );
  }
  return version;
}

/**
 * Map a detected package manager to the command that re-runs a full install.
 * Surfaced in the repair hint when an install fails so the operator can restore
 * `node_modules` to a consistent state (Story #3575 AC-4).
 *
 * @param {'pnpm' | 'yarn' | 'npm'} packageManager
 * @returns {string}
 */
function repairInstallCommand(packageManager) {
  if (packageManager === 'pnpm') return 'pnpm install';
  if (packageManager === 'yarn') return 'yarn install';
  return 'npm install';
}

/**
 * Detect the project's package manager by probing for a lockfile in `cwd`.
 * Precedence mirrors the ecosystem norm: a `pnpm-lock.yaml` wins over a
 * `yarn.lock`, which wins over the npm default. `workspaceRoot` is true only
 * for pnpm when a `pnpm-workspace.yaml` sits alongside the lockfile — the
 * signal that `pnpm add` must carry `-w` to target the workspace-root manifest.
 *
 * Running the wrong package manager (e.g. `npm install` in a pnpm workspace) is
 * the root cause this resolves (Story #3575): npm chokes on the pnpm-managed
 * tree, exits non-zero, and can flip `node_modules` to a stale store entry.
 * Detecting the lockfile keeps the bump on the operator's real package manager
 * so the change lands in the matching lockfile.
 *
 * Delegates to the shared `detectPackageManagerWithWorkspace` helper
 * (Story #4048 B3 — one implementation per concept). The `fs` seam is adapted
 * to the shared module's `exists` contract; the shared module's `bun` return
 * value coerces to `npm` here because `bun add` is not yet a first-class update
 * path for this orchestrator.
 *
 * @param {string} [cwd] - Project root to probe (default `process.cwd()`).
 * @param {typeof nodeFs} [fs]
 * @returns {{ packageManager: 'pnpm' | 'yarn' | 'npm', workspaceRoot: boolean }}
 */
export function detectPackageManager(cwd = process.cwd(), fs = nodeFs) {
  const exists = (p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  };
  const result = detectPackageManagerWithWorkspace(cwd, exists);
  // Coerce `bun` → `npm` because this orchestrator's install-command builder
  // only handles pnpm / yarn / npm today.
  const packageManager =
    result.packageManager === 'bun' ? 'npm' : result.packageManager;
  return { packageManager, workspaceRoot: result.workspaceRoot };
}

/**
 * Resolve the install command string `defaultNpmUpdate` runs.
 *
 * With no override the command is built from the detected package manager:
 *   - `pnpm` ⇒ `pnpm add -D mandrel@<target>` (plus ` -w` at a pnpm
 *     workspace root)
 *   - `yarn` ⇒ `yarn add -D mandrel@<target>`
 *   - `npm`  ⇒ `npm install mandrel@<target>` (the unchanged default)
 *
 * An explicit `--install-cmd` override is used verbatim, except that a
 * `{target}` placeholder is substituted with the resolved semver so an override
 * can still consume the auto-probed newest version (Story #3575 AC-3).
 *
 * This function is pure: package-manager detection happens in
 * `detectPackageManager` (the only filesystem seam) and is passed in as
 * `detected`, keeping the command-string assembly trivially unit-testable.
 *
 * @param {string} target - The resolved semver to install.
 * @param {string} [override] - Operator-supplied `--install-cmd` value.
 * @param {{
 *   packageManager?: 'pnpm' | 'yarn' | 'npm',
 *   workspaceRoot?: boolean,
 * }} [detected]
 * @returns {string}
 */
export function resolveInstallCmd(
  target,
  override,
  { packageManager = 'npm', workspaceRoot = false } = {},
) {
  const trimmed = String(override ?? '').trim();
  if (trimmed.length > 0) {
    return trimmed.includes('{target}')
      ? trimmed.replaceAll('{target}', target)
      : trimmed;
  }
  if (packageManager === 'pnpm') {
    return `pnpm add -D ${PACKAGE_NAME}@${target}${workspaceRoot ? ' -w' : ''}`;
  }
  if (packageManager === 'yarn') {
    return `yarn add -D ${PACKAGE_NAME}@${target}`;
  }
  return `npm install ${PACKAGE_NAME}@${target}`;
}

/**
 * Default `npmUpdate` seam: install the resolved target version. The install
 * rewrites `package.json` / the lockfile on disk (left staged for the
 * operator); this performs no git mutation.
 *
 * The package manager is auto-detected from `cwd`'s lockfile (Story #3575) so
 * the bump lands in the operator's real lockfile rather than running
 * `npm install` against a pnpm/yarn-managed tree. The install routes through
 * the shared `runInstallCommand` helper from `lib/install-cmd-parser.js`, which
 * tokenizes the command and spawns with `shell: process.platform === 'win32'`
 * so the Windows `.cmd` shim resolves under CVE-2024-27980 — the win32 shell
 * handling and tokenization are reused, not re-implemented here. The resolved
 * argv is a fixed vector; an `--install-cmd` override is tokenized and escaped
 * per-arg by the parser even when the win32 shell flag is required.
 *
 * On any install failure the thrown error names the detected package manager's
 * own `install` command so the operator can restore `node_modules` to a
 * consistent state — `mandrel update` never silently leaves a half-mutated
 * tree (Story #3575 AC-4).
 *
 * @param {string} target - The version to install.
 * @param {{
 *   installCmd?: string,
 *   runInstall?: typeof runInstallCommand,
 *   cwd?: string,
 *   fs?: typeof nodeFs,
 * }} [opts]
 * @returns {void}
 */
export function defaultNpmUpdate(
  target,
  {
    installCmd,
    runInstall = runInstallCommand,
    cwd = process.cwd(),
    fs = nodeFs,
  } = {},
) {
  const detected = detectPackageManager(cwd, fs);
  const cmd = resolveInstallCmd(target, installCmd, detected);
  const repairHint =
    `\n   → If node_modules looks wrong, run \`${repairInstallCommand(detected.packageManager)}\`` +
    ' to restore it to a consistent state.';
  let r;
  try {
    r = runInstall(cmd, cwd);
  } catch (err) {
    throw new Error(
      `mandrel update: install command \`${cmd}\` failed to spawn: ${err.message}${repairHint}`,
    );
  }
  if (r.status !== 0) {
    const snippet = (r.stderr || '').trim().slice(0, 200);
    throw new Error(
      `mandrel update: install command \`${cmd}\` exited ${r.status}: ${snippet}${repairHint}`,
    );
  }
}

/**
 * Fetch `docs/CHANGELOG.md` for a specific mandrel tag from GitHub's raw
 * content endpoint. This is the fallback when the packaged file is absent
 * (e.g. an older install predating Story #4035 which added the file to the
 * npm `files` allowlist).
 *
 * Injectable via the `fetchChangelog` seam so tests can verify the fallback
 * path without issuing real network calls.
 *
 * The tag shape follows the `mandrel-vX.Y.Z` namespace (namespaced at
 * `mandrel-v1.44.0`; bare `vX.Y.Z` for earlier releases). This function
 * tries the namespaced tag first, then the bare-tag form, so it covers both
 * tag series without forcing callers to know the boundary.
 *
 * Security (security-baseline § Transport & Headers): the URL is constructed
 * from a constant base and a semver string — no user input, no shell
 * interpolation. The GET is a read-only fetch with no credentials.
 *
 * @param {string} version - The target semver string (e.g. `"1.59.0"`).
 * @param {{
 *   https?: typeof nodeHttps,
 * }} [deps]
 * @returns {Promise<string>} The raw changelog text.
 * @throws {Error} When both tag forms return a non-2xx response or the request
 *   errors out — the caller handles this gracefully.
 */
export async function fetchChangelogFromGitHub(
  version,
  { https: httpsImpl = nodeHttps } = {},
) {
  const tags = [`mandrel-v${version}`, `v${version}`];

  /**
   * @param {string} url
   * @returns {Promise<{ status: number, body: string }>}
   */
  const httpGet = (url) =>
    new Promise((resolve, reject) => {
      httpsImpl
        .get(url, (res) => {
          const chunks = [];
          res.on('data', (d) => chunks.push(d));
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
        })
        .on('error', reject);
    });

  for (const tag of tags) {
    const url = `${GITHUB_RAW_BASE}${tag}/docs/CHANGELOG.md`;
    // eslint-disable-next-line no-await-in-loop
    const { status, body } = await httpGet(url);
    if (status >= 200 && status < 300) {
      return body;
    }
  }

  throw new Error(
    `mandrel update: GitHub fetch for mandrel v${version} docs/CHANGELOG.md returned non-2xx for all tag forms (tried: ${tags.join(', ')})`,
  );
}

/**
 * Default `surfaceChangelog` seam: print the `docs/CHANGELOG.md` section(s)
 * covering the applied version range `(current, target]`. The changelog is
 * authored by release-please with `## [<version>](…)` section headers; this
 * prints every section whose version is newer than `current` and no newer than
 * `target`.
 *
 * Resolution order (Story #4035):
 *   1. Read `docs/CHANGELOG.md` from the target version's install directory
 *      (`node_modules/mandrel/docs/CHANGELOG.md` — now in the published
 *      tarball since `package.json` lists `docs/CHANGELOG.md` in `files`).
 *   2. When the packaged file is absent (older install), fetch it from GitHub
 *      via the injectable `fetchChangelog` seam.
 *   3. When both sources fail, emit an actionable warning with a link to the
 *      GitHub Releases page — never a bare "not found … skipping".
 *
 * Degrades gracefully (warns, never throws) — surfacing the changelog is
 * best-effort and must never fail an otherwise-successful upgrade.
 *
 * @param {string} target - The applied target version.
 * @param {{
 *   current?: string,
 *   changelogPath?: string,
 *   fs?: typeof nodeFs,
 *   fetchChangelog?: (version: string) => Promise<string>,
 *   write?: (s: string) => void,
 *   writeErr?: (s: string) => void,
 * }} [opts]
 * @returns {Promise<void>}
 */
async function defaultSurfaceChangelog(
  target,
  {
    current,
    changelogPath = path.join(resolveProjectRoot(), 'docs', 'CHANGELOG.md'),
    fs = nodeFs,
    fetchChangelog = fetchChangelogFromGitHub,
    write = (s) => process.stdout.write(s),
    writeErr = (s) => process.stderr.write(s),
  } = {},
) {
  let raw;

  // 1. Try the packaged file (present in installs since Story #4035).
  try {
    raw = fs.readFileSync(changelogPath, 'utf8');
  } catch {
    // File absent — fall through to GitHub fetch.
  }

  // 2. Packaged file absent: attempt a GitHub fetch for the target tag.
  if (raw === undefined) {
    try {
      raw = await fetchChangelog(target);
    } catch {
      // Both sources unavailable — emit an actionable message and return.
      writeErr(
        `mandrel update: changelog not available for v${target} — ` +
          `view the release notes at ${GITHUB_RELEASES_URL}\n`,
      );
      return;
    }
  }

  const sections = parseChangelogSections(raw);
  const relevant = sections.filter((s) => {
    const aboveFloor = current ? compareVersions(s.version, current) > 0 : true;
    const atOrBelowTarget = compareVersions(s.version, target) <= 0;
    return aboveFloor && atOrBelowTarget;
  });

  if (relevant.length === 0) {
    writeErr(
      `mandrel update: no CHANGELOG section found for v${target} — ` +
        `view the release notes at ${GITHUB_RELEASES_URL}\n`,
    );
    return;
  }

  write(`\nChangelog for v${target}:\n`);
  for (const section of relevant) {
    write(`${section.body.trimEnd()}\n`);
  }
}

/**
 * Split a release-please `CHANGELOG.md` into `{ version, body }` sections keyed
 * by the `## [<version>]…` headers. Each `body` includes the header line and
 * everything up to (but not including) the next version header.
 *
 * @param {string} raw
 * @returns {Array<{ version: string, body: string }>}
 */
function parseChangelogSections(raw) {
  const lines = String(raw).split('\n');
  const headerRe = /^## \[(\d+\.\d+\.\d+)\]/;
  const sections = [];
  let curVersion = null;
  let curLines = [];

  const flush = () => {
    if (curVersion) {
      sections.push({ version: curVersion, body: curLines.join('\n') });
    }
  };

  for (const line of lines) {
    const m = headerRe.exec(line);
    if (m) {
      flush();
      curVersion = m[1];
      curLines = [line];
    } else if (curVersion) {
      curLines.push(line);
    }
  }
  flush();
  return sections;
}

/**
 * Resolve the path to the `mandrel` binary inside `node_modules/.bin/` for the
 * given project root. On Windows the binary is a `.cmd` shim; on POSIX it is a
 * plain executable. The resolved path is used as the target for the post-install
 * phase re-exec (Story #4034).
 *
 * @param {string} projectRoot - Absolute path to the consumer project.
 * @returns {string} Absolute path to the new binary.
 */
export function resolveNewBinPath(projectRoot) {
  const binName = process.platform === 'win32' ? 'mandrel.cmd' : 'mandrel';
  return path.join(projectRoot, 'node_modules', '.bin', binName);
}

/**
 * Default `spawnPhase` seam (Story #4034): spawn a post-install phase from the
 * newly-installed `mandrel` binary and stream its stdout/stderr through the
 * parent's write sinks. Each phase runs as an isolated child process so the
 * newly-installed module code (not the currently-loaded old module) executes.
 *
 * The spawn uses `shell: true` only on Windows where the binary is a `.cmd`
 * shim (CVE-2024-27980 parity). The argv vector is a fixed constant list
 * per phase — no operator-supplied data enters the vector, so the shell flag
 * carries no injection risk (security-baseline § Output & Rendering).
 *
 * Throws when the child exits non-zero so the orchestrator can surface the
 * failure to the operator.
 *
 * @param {string} phase - The mandrel sub-command to run (e.g. `'sync'`).
 * @param {string[]} args - Additional arguments for the sub-command.
 * @param {{
 *   binPath: string,
 *   cwd: string,
 *   write: (s: string) => void,
 *   writeErr: (s: string) => void,
 *   spawnFn?: typeof spawnSync,
 * }} opts
 * @returns {{ ok: boolean, stdout: string, stderr: string }}
 */
export function defaultSpawnPhase(
  phase,
  args,
  { binPath, cwd, write, writeErr, spawnFn = spawnSync },
) {
  const argv = [phase, ...args];
  const r = spawnFn(binPath, argv, {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  const stdout = typeof r.stdout === 'string' ? r.stdout : '';
  const stderr = typeof r.stderr === 'string' ? r.stderr : '';
  if (stdout) write(stdout);
  if (stderr) writeErr(stderr);
  if (r.error) {
    throw new Error(
      `mandrel update: failed to spawn \`mandrel ${phase}\` from new binary: ${r.error.message}`,
    );
  }
  const ok = r.status === 0;
  return { ok, stdout, stderr };
}

/**
 * The ordered step names the orchestrator drives on an update. Shared
 * by the live path and the `--dry-run` plan printout so the two never drift.
 *
 * Step ordering (Story #4046 A1c):
 *   1. npm-update     — install the new version
 *   2. runSync        — re-materialize .agents/ from the new payload
 *   3. sync-commands  — regenerate .claude/commands/ from the new payload
 *   4. runMigrations  — apply version-keyed migrations
 *   5. doctor         — validate the post-upgrade state
 *   6. surface changelog — print the changelog (always last, best-effort)
 */
const STEP_PLAN = [
  'npm-update',
  'runSync',
  'sync-commands',
  'runMigrations',
  'doctor',
  'surface changelog',
];

/**
 * The ordered post-install phase descriptors for a full upgrade. Each entry is
 * a plain value (no I/O) describing one step the executor drives:
 *
 *   - `kind: 'npm-update'`  — bump the dependency via the `npmUpdate` seam.
 *   - `kind: 'spawn'`       — spawn `phase`/`args` from the new binary; a
 *                             non-zero exit is fatal and throws `failMessage`.
 *   - `kind: 'doctor'`      — spawn `doctor` from the new binary; a non-zero
 *                             exit is *soft* (maps to `action: 'doctor-failed'`
 *                             + exit 1), so it carries no `failMessage`.
 *
 * `label` is the name pushed into the run's `stepsRun[]` (the external return
 * contract). `migrate` is the only phase whose argv depends on the version
 * range, so its descriptor is built per-plan in `planUpdate`.
 *
 * @param {string} current
 * @param {string} target
 * @returns {Array<{ kind: 'npm-update' | 'spawn' | 'doctor', label: string, phase?: string, args?: string[], failMessage?: string }>}
 */
function fullUpgradeSteps(current, target) {
  return [
    { kind: 'npm-update', label: 'npm-update' },
    {
      kind: 'spawn',
      phase: 'sync',
      args: [],
      label: 'runSync',
      failMessage:
        'mandrel update: `mandrel sync` from new binary exited non-zero — ' +
        'the .agents/ materialization may be incomplete. ' +
        'Run `mandrel sync` manually to restore.',
    },
    {
      kind: 'spawn',
      phase: 'sync-commands',
      args: [],
      label: 'sync-commands',
      failMessage:
        'mandrel update: `mandrel sync-commands` from new binary exited non-zero — ' +
        'the .claude/commands/ tree may be out of sync. ' +
        'Run `npm run sync:commands` manually to restore.',
    },
    {
      kind: 'spawn',
      phase: 'migrate',
      args: ['--from', current, '--to', target],
      label: 'runMigrations',
      failMessage:
        'mandrel update: `mandrel migrate` from new binary exited non-zero — ' +
        `some migrations for v${current} → v${target} may not have applied. ` +
        `Run \`mandrel migrate --from ${current} --to ${target}\` manually to retry.`,
    },
    { kind: 'doctor', phase: 'doctor', args: [], label: 'doctor' },
  ];
}

/**
 * The ordered phase descriptors for a drift-heal (version already current, but
 * `.agents/` is stale). No npm-update, no migrations, no doctor — only the two
 * sync phases re-materialize the payload from the already-installed binary.
 *
 * @returns {Array<{ kind: 'spawn', phase: string, args: string[], label: string, failMessage: string }>}
 */
function driftHealSteps() {
  return [
    {
      kind: 'spawn',
      phase: 'sync',
      args: [],
      label: 'runSync',
      failMessage:
        'mandrel update: `mandrel sync` from installed binary exited non-zero — ' +
        'the .agents/ materialization may be incomplete. ' +
        'Run `mandrel sync` manually to restore.',
    },
    {
      kind: 'spawn',
      phase: 'sync-commands',
      args: [],
      label: 'sync-commands',
      failMessage:
        'mandrel update: `mandrel sync-commands` from installed binary exited non-zero — ' +
        'the .claude/commands/ tree may be out of sync. ' +
        'Run `npm run sync:commands` manually to restore.',
    },
  ];
}

/**
 * Pure decision function for `mandrel update`: given the resolved version
 * inputs and the two flags, decide which of the four actions to take and the
 * ordered phase plan for that action. **No I/O** — no filesystem, child
 * process, network, `write`, or `exit`. This isolates the scheduler-style
 * branch-selection and step-sequencing logic (the surface under review in
 * Story #4182 / audit::architecture) so it can be exercised as a table over
 * plain inputs rather than by running the whole async orchestration with every
 * seam stubbed.
 *
 * The four actions:
 *
 *   - `up-to-date` — version is current and no drift. True no-op; `steps: []`.
 *   - `dry-run`    — `dryRun` is set. `steps: []` (nothing is executed); the
 *                    `variant` distinguishes the drift-heal preview from the
 *                    full-upgrade preview so the executor prints the right plan.
 *   - `resynced`   — version is current but drift detected. Heal via the two
 *                    sync phases (`driftHealSteps()`).
 *   - `updated`    — a newer version is available. Full upgrade
 *                    (`fullUpgradeSteps(current, target)`).
 *
 * @param {{ current: string, target: string, dryRun: boolean, hasDrift: boolean }} input
 * @returns {{
 *   action: 'up-to-date' | 'dry-run' | 'resynced' | 'updated',
 *   steps: Array<{ kind: 'npm-update' | 'spawn' | 'doctor', label: string, phase?: string, args?: string[], failMessage?: string }>,
 *   variant?: 'drift-heal' | 'full-upgrade',
 * }}
 */
export function planUpdate({ current, target, dryRun, hasDrift }) {
  const versionCurrent = compareVersions(target, current) <= 0;

  if (versionCurrent) {
    // Version is already newest. The only remaining question is drift.
    if (!hasDrift) {
      return { action: 'up-to-date', steps: [] };
    }
    if (dryRun) {
      return { action: 'dry-run', steps: [], variant: 'drift-heal' };
    }
    return { action: 'resynced', steps: driftHealSteps() };
  }

  // A newer version is available — full upgrade (drift is irrelevant here; the
  // post-upgrade doctor phase re-checks materialization).
  if (dryRun) {
    return { action: 'dry-run', steps: [], variant: 'full-upgrade' };
  }
  return { action: 'updated', steps: fullUpgradeSteps(current, target) };
}

/**
 * Extract the `--install-cmd "<cmd>"` value from the subcommand argv. Accepts
 * both the space form (`--install-cmd npm install …`, captured as the single
 * following token group) and the `=` form (`--install-cmd="<cmd>"`). Returns
 * `undefined` when the flag is absent so the default package manager is used.
 *
 * The argv tokenizer hands us a pre-split array; with the space form the shell
 * has already collapsed a quoted value into one element, so the immediate next
 * token is the full command string.
 *
 * @param {string[]} argv
 * @returns {string | undefined}
 */
function parseInstallCmdFlag(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--install-cmd') {
      return argv[i + 1];
    }
    if (arg.startsWith('--install-cmd=')) {
      return arg.slice('--install-cmd='.length);
    }
  }
  return undefined;
}

/**
 * Resolve the drift signal for the no-op short-circuit. Prefers the injected
 * `checkDrift` seam (unit-test friendly); falls back to the production
 * `runAgentsDrift` helper. Only consulted when the installed version is already
 * the newest (Story #4065) — a real version bump skips drift entirely (the
 * post-upgrade doctor phase re-checks materialization).
 *
 * @param {(() => boolean | Promise<boolean>) | undefined} checkDrift
 * @returns {Promise<boolean>}
 */
async function resolveDrift(checkDrift) {
  const driftProbe =
    typeof checkDrift === 'function' ? checkDrift : () => !runAgentsDrift().ok;
  return Boolean(await driftProbe());
}

/**
 * Execute the ordered phase plan returned by `planUpdate` for the `updated` /
 * `resynced` actions. This is the thin side-effecting shell: it owns the
 * `npmUpdate` seam call, the `spawnPhase` re-exec boundary, the per-step
 * `stepsRun` accounting, and the soft doctor-fail (`exit(1)` +
 * `action: 'doctor-failed'`). The branch-selection logic that produced `steps`
 * lives in the pure `planUpdate`.
 *
 * @param {{
 *   steps: Array<{ kind: 'npm-update' | 'spawn' | 'doctor', label: string, phase?: string, args?: string[], failMessage?: string }>,
 *   target: string,
 *   installCmd: string | undefined,
 *   npmUpdate: ((version: string, opts: { installCmd?: string }) => unknown | Promise<unknown>) | undefined,
 *   spawnPhase: ((phase: string, args: string[], opts: object) => { ok: boolean } | Promise<{ ok: boolean }>) | undefined,
 *   surfaceChangelog: ((version: string) => unknown | Promise<unknown>) | undefined,
 *   binPath: string,
 *   projectRoot: string,
 *   write: (s: string) => void,
 *   writeErr: (s: string) => void,
 *   exit: (code: number) => void,
 * }} ctx
 * @returns {Promise<{ stepsRun: string[], doctorOk: boolean }>}
 */
async function executePlan({
  steps,
  target,
  installCmd,
  npmUpdate,
  spawnPhase,
  surfaceChangelog,
  binPath,
  projectRoot,
  write,
  writeErr,
  exit,
}) {
  const stepsRun = [];
  let doctorOk = true;

  for (const step of steps) {
    if (step.kind === 'npm-update') {
      // Bump the dependency. The lockfile change is left STAGED on disk; this
      // module never commits.
      if (typeof npmUpdate !== 'function') {
        throw new Error(
          'mandrel update: npmUpdate seam is required to bump the dependency',
        );
      }
      // eslint-disable-next-line no-await-in-loop
      await npmUpdate(target, { installCmd });
      stepsRun.push(step.label);
      continue;
    }

    // Both 'spawn' and 'doctor' kinds run a post-install phase from the
    // newly-installed binary (the Story #4034 re-exec boundary), so the new
    // package's module code — not the old loaded module — executes.
    // eslint-disable-next-line no-await-in-loop
    const result = await spawnPhase(step.phase, step.args, {
      binPath,
      cwd: projectRoot,
      write,
      writeErr,
    });
    stepsRun.push(step.label);

    if (step.kind === 'doctor') {
      // Doctor failure is SOFT: record it, keep going to surface the changelog,
      // then map to exit(1) + doctor-failed by the caller.
      doctorOk = result.ok;
    } else if (!result.ok) {
      // sync / sync-commands / migrate failures are FATAL.
      throw new Error(step.failMessage);
    }
  }

  // Surface the target changelog (best-effort; optional seam). Runs even when
  // doctor failed, so the operator still sees the changelog for the version
  // that landed on disk.
  if (typeof surfaceChangelog === 'function') {
    await surfaceChangelog(target);
  }

  if (!doctorOk) {
    writeErr(
      `mandrel update: upgraded to v${target} but doctor reported failures.\n` +
        '   → Run `mandrel doctor` for remedies.\n',
    );
    exit(1);
  }

  return { stepsRun, doctorOk };
}

/**
 * Run the `mandrel update` orchestration cycle.
 *
 * The cycle is split into a pure decision (`planUpdate`) and a side-effecting
 * shell (this function + `executePlan`). `runUpdate` resolves the inputs
 * (current / target / drift) through the injectable seams, calls `planUpdate`
 * to select the action and its ordered phase plan, then drives the plan through
 * the `spawnPhase` / `write` / `exit` shell.
 *
 * @param {{
 *   argv?: string[],
 *   currentVersion?: string | (() => string),
 *   resolveTargetVersion?: () => (string | Promise<string>),
 *   npmUpdate?: (version: string, opts: { installCmd?: string }) => unknown | Promise<unknown>,
 *   checkDrift?: () => (boolean | Promise<boolean>),
 *   spawnPhase?: (phase: string, args: string[], opts: { binPath: string, cwd: string, write: (s: string) => void, writeErr: (s: string) => void }) => Promise<{ ok: boolean, stdout: string, stderr: string }> | { ok: boolean, stdout: string, stderr: string },
 *   surfaceChangelog?: (version: string) => unknown | Promise<unknown>,
 *   write?: (s: string) => void,
 *   writeErr?: (s: string) => void,
 *   exit?: (code: number) => void,
 *   cwd?: () => string,
 * }} [opts]
 * @returns {Promise<{
 *   ok: boolean,
 *   action: 'updated' | 'resynced' | 'dry-run' | 'up-to-date' | 'doctor-failed',
 *   currentVersion: string,
 *   targetVersion: string | null,
 *   stepsRun: string[],
 *   dryRun: boolean,
 * }>}
 */
export async function runUpdate({
  argv = [],
  currentVersion,
  resolveTargetVersion,
  npmUpdate,
  checkDrift,
  spawnPhase,
  surfaceChangelog,
  write = (s) => process.stdout.write(s),
  writeErr = (s) => process.stderr.write(s),
  exit = (code) => process.exit(code),
  cwd = () => process.cwd(),
} = {}) {
  const dryRun = argv.includes('--dry-run');
  const installCmd = parseInstallCmdFlag(argv);

  const current =
    typeof currentVersion === 'function'
      ? currentVersion()
      : (currentVersion ?? defaultCurrentVersion());

  if (typeof resolveTargetVersion !== 'function') {
    throw new Error(
      'mandrel update: resolveTargetVersion seam is required to determine the newest version',
    );
  }
  const target = String(await resolveTargetVersion());

  // Drift only matters when the installed version is already the newest. Probe
  // it solely on that branch so a real version bump never calls the drift seam
  // (Story #4065).
  const hasDrift =
    compareVersions(target, current) <= 0
      ? await resolveDrift(checkDrift)
      : false;

  const plan = planUpdate({ current, target, dryRun, hasDrift });

  // --- up-to-date: true no-op ----------------------------------------------
  if (plan.action === 'up-to-date') {
    write(`✅  Already up to date (v${current} is the newest version).\n`);
    return {
      ok: true,
      action: 'up-to-date',
      currentVersion: current,
      targetVersion: target,
      stepsRun: [],
      dryRun,
    };
  }

  // --- dry-run: print the plan, execute nothing -----------------------------
  if (plan.action === 'dry-run') {
    if (plan.variant === 'drift-heal') {
      write(
        `mandrel update — drift detected, sync heal planned (v${current} is already current)\n`,
      );
      write(
        '  1. runSync        — re-materialize .agents/ from installed payload\n',
      );
      write(
        '  2. sync-commands  — regenerate .claude/commands/ from .agents/workflows/\n',
      );
      write('Dry run: no files written.\n');
    } else {
      write(`mandrel update — planned upgrade v${current} → v${target}\n`);
      STEP_PLAN.forEach((step, i) => {
        write(`  ${i + 1}. ${step}\n`);
      });
      write('Dry run: no files written, no dependency bumped.\n');
    }
    return {
      ok: true,
      action: 'dry-run',
      currentVersion: current,
      targetVersion: target,
      stepsRun: [],
      dryRun: true,
    };
  }

  // --- resynced / updated: execute the phase plan ---------------------------
  const projectRoot = cwd();
  const binPath = resolveNewBinPath(projectRoot);

  if (plan.action === 'resynced') {
    write(
      `Healing .agents/ drift (v${current} is already current, but .agents/ is stale)…\n`,
    );
  } else {
    write(`Updating v${current} → v${target}…\n`);
  }

  const { stepsRun, doctorOk } = await executePlan({
    steps: plan.steps,
    target,
    installCmd,
    npmUpdate,
    spawnPhase,
    surfaceChangelog,
    binPath,
    projectRoot,
    write,
    writeErr,
    exit,
  });

  if (plan.action === 'resynced') {
    write(
      `✅  Healed .agents/ drift (v${current}). The materialized payload is now current.\n`,
    );
    return {
      ok: true,
      action: 'resynced',
      currentVersion: current,
      targetVersion: target,
      stepsRun,
      dryRun: false,
    };
  }

  // plan.action === 'updated'
  if (!doctorOk) {
    return {
      ok: false,
      action: 'doctor-failed',
      currentVersion: current,
      targetVersion: target,
      stepsRun,
      dryRun: false,
    };
  }

  write(`✅  Updated to v${target}. The lockfile bump is staged for review.\n`);
  return {
    ok: true,
    action: 'updated',
    currentVersion: current,
    targetVersion: target,
    stepsRun,
    dryRun: false,
  };
}

/**
 * Default export consumed by `bin/mandrel.js`.
 *
 * Wires the production-default seams that `runUpdate` leaves injectable:
 *   - `resolveTargetVersion` always probes the registry via `isStale` with
 *     `bypassCache: true` — the 24h cache is overridden for explicit update
 *     calls so the resolved version is always fresh (Story #4046 A1b). The
 *     cache is still written so the `version-current` doctor advisory reads
 *     a current baseline after the upgrade.
 *   - `npmUpdate` runs the install command — auto-detected from the project
 *     lockfile (`pnpm`/`yarn`/`npm`), or the `--install-cmd` override —
 *     through the shared `runInstallCommand` helper — no git mutation;
 *     lockfile left staged.
 *   - `spawnPhase` is wired to `defaultSpawnPhase`, which spawns each
 *     post-install phase (sync, sync-commands, migrate, doctor) from the
 *     newly-installed binary (`node_modules/.bin/mandrel`). This is the
 *     Story #4034 fix: the new bin loads the new package's module code and
 *     resolves paths against the new install dir, so these phases can never
 *     observe the old payload.
 *   - `surfaceChangelog` prints the relevant `docs/CHANGELOG.md` section(s)
 *     for the applied range. Reads from the packaged file first; falls back to
 *     a GitHub raw-content fetch via the injectable `fetchChangelog` seam when
 *     the packaged file is absent; emits an actionable link to the GitHub
 *     Releases page when both sources fail (Story #4035).
 *
 * Every seam stays injectable on `runUpdate`; these are merely the
 * no-seam-provided fallbacks, so the existing seam-driven tests stay green.
 * `--dry-run` / `--install-cmd` are parsed from `argv` by
 * `runUpdate` itself.
 *
 * The second `deps` argument exposes the **process boundaries** the production
 * defaults shell out across (`versionRunner` = `npm view`, `runInstall` =
 * the install spawn, `spawnFn` = the phase-spawn boundary) plus `fs` /
 * `cachePath` / `now`, so the entrypoint can be driven end-to-end with the
 * network/npm boundary stubbed and no real I/O.
 * `bin/mandrel.js` calls `run(argv)` with no `deps`, getting the production
 * wiring; tests pass fakes. The `deps` surface is NOT part of the public
 * subcommand contract — `bin/mandrel.js` only ever supplies `argv`.
 *
 * @param {string[]} argv - Subcommand arguments (after `mandrel update`).
 * @param {{
 *   currentVersion?: string,
 *   cachePath?: string,
 *   fs?: typeof nodeFs,
 *   now?: Date,
 *   versionRunner?: () => string,
 *   runInstall?: (installCmd: string, cwd: string) => { status: number, stderr: string },
 *   spawnFn?: typeof spawnSync,
 *   changelogPath?: string,
 *   fetchChangelog?: (version: string) => Promise<string>,
 *   runUpdate?: typeof runUpdate,
 *   cwd?: () => string,
 *   checkDrift?: () => (boolean | Promise<boolean>),
 *   write?: (s: string) => void,
 *   writeErr?: (s: string) => void,
 *   exit?: (code: number) => void,
 *   log?: (msg: string) => void,
 * }} [deps]
 * @returns {Promise<void>}
 */
export default async function run(argv = [], deps = {}) {
  const {
    fs = nodeFs,
    cachePath,
    now,
    versionRunner,
    runInstall,
    spawnFn,
    changelogPath,
    fetchChangelog,
    runUpdate: runUpdateImpl = runUpdate,
    write = (s) => process.stdout.write(s),
    writeErr = (s) => process.stderr.write(s),
    exit = (code) => process.exit(code),
    log,
    cwd,
    checkDrift,
  } = deps;

  const cwdFn = typeof cwd === 'function' ? cwd : () => process.cwd();

  // Story #4525/#4530: prefer the consumer's declared dependency pin over
  // the pre-#4525 self-referential read — see resolveCurrentVersionForUpdate.
  const current =
    deps.currentVersion ?? resolveCurrentVersionForUpdate(cwdFn(), fs);

  // The production spawnPhase: spawn each post-install phase from
  // node_modules/.bin/mandrel (the newly-installed binary). This is the sole
  // post-install execution path (No-Shim — Story #4182 retired the in-process
  // runSync/runMigrations/runDoctor seam set). spawnFn is injectable so tests
  // can stub the spawn boundary without running a real child process.
  const productionSpawnPhase = (phase, args, opts) =>
    defaultSpawnPhase(phase, args, {
      ...opts,
      ...(spawnFn ? { spawnFn } : {}),
    });

  await runUpdateImpl({
    argv,
    currentVersion: current,
    // Always bypass the 24h cache on an explicit `mandrel update` so the
    // resolved target is fresh from the registry (Story #4046 A1b).
    resolveTargetVersion: () =>
      defaultResolveTargetVersion({
        cachePath:
          cachePath ?? path.join(process.cwd(), 'temp', DEFAULT_CACHE_FILENAME),
        fs,
        runner: versionRunner ?? defaultVersionRunner,
        now: now ?? new Date(),
        bypassCache: true,
        log: log ?? (() => {}),
      }),
    npmUpdate: (target, { installCmd } = {}) =>
      defaultNpmUpdate(target, {
        ...(installCmd ? { installCmd } : {}),
        runInstall: runInstall ?? runInstallCommand,
        fs,
      }),
    ...(checkDrift ? { checkDrift } : {}),
    spawnPhase: productionSpawnPhase,
    surfaceChangelog: (target) =>
      defaultSurfaceChangelog(target, {
        current,
        fs,
        ...(changelogPath ? { changelogPath } : {}),
        fetchChangelog: fetchChangelog ?? fetchChangelogFromGitHub,
        write,
        writeErr,
      }),
    write,
    writeErr,
    exit,
    cwd: cwdFn,
  });
}

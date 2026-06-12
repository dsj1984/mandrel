// lib/cli/update.js
/**
 * `mandrel update` subcommand — the auto-update orchestrator (f-update-command,
 * Story #3503, Epic #3437 — Auto-Update & Version Lifecycle).
 *
 * Advances `mandrel` to the newest **non-major** published version,
 * re-materializes `.agents/`, runs applicable version-keyed migrations,
 * surfaces the target changelog, and verifies the result via the doctor
 * registry. A **major** crossing (e.g. `1.x → 2.0`) is gated: the orchestrator
 * refuses to apply it without `--major`, prints a pointer to
 * `.agents/docs/upgrade-major.md`, and exits non-zero without touching anything.
 *
 * ## Ordered cycle (happy path, non-major bump)
 *
 *   1. resolve target version (newest published) and the current version
 *   2. **major gate** — decline + non-zero exit when the target crosses a
 *      major boundary and `--major` is absent
 *   3. no-op short-circuit — already on the newest version ⇒ nothing to do
 *   4. install        — bump the dependency (lockfile bump left STAGED).
 *      The package manager is auto-detected from the lockfile in the project
 *      root: `pnpm-lock.yaml` ⇒ `pnpm add -D …` (with `-w` at a
 *      `pnpm-workspace.yaml` root), `yarn.lock` ⇒ `yarn add -D …`, otherwise
 *      `npm install …`. An explicit `--install-cmd "<pm> <args>"` overrides
 *      detection; a `{target}` placeholder in the override is substituted with
 *      the resolved version so an override can still consume the auto-probed
 *      newest. The registry probe in step 1 always stays on `npm view` (a
 *      PM-agnostic registry query).
 *   5. runSync        — re-materialize ./.agents/ **from the newly-installed
 *      binary** so the materialized payload is always the target version's.
 *   6. runMigrations  — apply version-keyed steps for the crossed range,
 *      **from the newly-installed binary**.
 *   7. doctor         — run the check registry **from the newly-installed
 *      binary** so `agents-drift` is never a false-green against stale payload.
 *   8. surface the changelog for the target version
 *
 * ## Re-exec of post-install phases (Story #4034)
 *
 * Steps 5–7 execute as **child processes spawned from the newly-installed
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
 *
 * Backward compatibility: when `runSync`, `runMigrations`, or `runDoctor`
 * are explicitly injected (the historical test-seam pattern) and `spawnPhase`
 * is NOT injected, the in-process seams are used unchanged (old tests stay
 * green). When `spawnPhase` IS injected, it takes priority over the in-process
 * seams for the live phases — so new tests targeting the re-exec boundary can
 * inject `spawnPhase` without touching the old seam interface.
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
 * ## Major gate
 *
 * The project sits on the **1.x** line under release-please
 * `always-bump-minor` ([AGENTS.md § Major-version policy]); a major release is
 * a deliberate manual operator decision, so adopting one must be equally
 * deliberate. When the newest version's major exceeds the current major:
 *   - **without `--major`**: print the available version + the
 *     `.agents/docs/upgrade-major.md` runbook pointer, exit non-zero, and invoke
 *     **no** npm-update / sync / migration / doctor seam.
 *   - **with `--major`**: apply the major target and print the runbook inline.
 * Routine minor/patch bumps within the 1.x line are never gated.
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
 *   - `npmUpdate`           — async, performs the dependency bump (no git);
 *                             receives `(target, { installCmd })`
 *   - `spawnPhase`          — async, spawns a post-install phase from the new
 *                             binary; receives `(phase, args, { binPath, cwd })`
 *                             and returns `{ ok, stdout, stderr }`. When
 *                             injected, it takes priority over `runSync`,
 *                             `runMigrations`, and `runDoctor` for the live
 *                             phases. See § Re-exec of post-install phases.
 *   - `runSync`             — re-materializes ./.agents/ (lib/cli/sync.js).
 *                             Used when `spawnPhase` is NOT injected (backward
 *                             compat for tests that pre-date Story #4034).
 *   - `runMigrations`       — version-keyed migration runner (lib/migrations).
 *                             Used when `spawnPhase` is NOT injected.
 *   - `runDoctor`           — async, returns { ok, results } from the registry.
 *                             Used when `spawnPhase` is NOT injected.
 *   - `surfaceChangelog`    — emits the target changelog section
 *   - `write` / `writeErr`  — stdout / stderr sinks
 *   - `exit`                — process.exit replacement
 *   - `cwd`                 — process.cwd() replacement (used to resolve the
 *                             new binary path when `spawnPhase` is absent)
 *
 * Security (security-baseline § 5 — Data Leakage & Logging): logs only version
 * strings, step names, and the runbook path. No tokens, credentials, or env
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
import { runMigrations as defaultRunMigrations } from '../migrations/index.js';
import { registry } from './registry.js';
import { runSync as defaultRunSync } from './sync.js';
import { isStale } from './version-check.js';
import { compareVersions, crossesMajor } from './version-helpers.js';

/** Path (relative to project root) of the major-upgrade runbook. */
const RUNBOOK_PATH = '.agents/docs/upgrade-major.md';

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
 * Default doctor seam: run every check in the registry sequentially and
 * report whether all passed. Mirrors lib/cli/doctor.js's pass accounting
 * without the formatted report (the orchestrator owns its own output).
 *
 * This is used only when `spawnPhase` is NOT injected (backward-compat path).
 *
 * @param {{ checks?: typeof registry }} [opts]
 * @returns {Promise<{ ok: boolean, results: Array<{ name: string, ok: boolean }> }>}
 */
async function defaultRunDoctor({ checks = registry } = {}) {
  const results = [];
  for (const check of checks) {
    const r = await check.run();
    results.push({ name: check.name, ok: Boolean(r.ok) });
  }
  return { ok: results.every((r) => r.ok), results };
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
 * The ordered step names the orchestrator drives on a non-major bump. Shared
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
 * Print the major-gate refusal: the available version, the runbook pointer,
 * and the re-run hint. No effectful seam runs after this.
 *
 * @param {string} target
 * @param {(s: string) => void} writeErr
 */
function emitMajorRefusal(target, writeErr) {
  writeErr(
    `mandrel update: a newer MAJOR version (${target}) is available; ` +
      'this is a breaking upgrade.\n' +
      `   → Review ${RUNBOOK_PATH}, then re-run with --major to apply it.\n`,
  );
}

/**
 * Run the `mandrel update` orchestration cycle.
 *
 * @param {{
 *   argv?: string[],
 *   currentVersion?: string | (() => string),
 *   resolveTargetVersion?: () => (string | Promise<string>),
 *   npmUpdate?: (version: string, opts: { installCmd?: string }) => unknown | Promise<unknown>,
 *   spawnPhase?: (phase: string, args: string[], opts: { binPath: string, cwd: string, write: (s: string) => void, writeErr: (s: string) => void }) => Promise<{ ok: boolean, stdout: string, stderr: string }> | { ok: boolean, stdout: string, stderr: string },
 *   runSync?: typeof defaultRunSync,
 *   runMigrations?: typeof defaultRunMigrations,
 *   runDoctor?: typeof defaultRunDoctor,
 *   surfaceChangelog?: (version: string) => unknown | Promise<unknown>,
 *   write?: (s: string) => void,
 *   writeErr?: (s: string) => void,
 *   exit?: (code: number) => void,
 *   cwd?: () => string,
 * }} [opts]
 * @returns {Promise<{
 *   ok: boolean,
 *   action: 'updated' | 'declined-major' | 'dry-run' | 'up-to-date' | 'doctor-failed',
 *   currentVersion: string,
 *   targetVersion: string | null,
 *   major: boolean,
 *   stepsRun: string[],
 *   dryRun: boolean,
 * }>}
 */
export async function runUpdate({
  argv = [],
  currentVersion,
  resolveTargetVersion,
  npmUpdate,
  spawnPhase,
  runSync = defaultRunSync,
  runMigrations = defaultRunMigrations,
  runDoctor = defaultRunDoctor,
  surfaceChangelog,
  write = (s) => process.stdout.write(s),
  writeErr = (s) => process.stderr.write(s),
  exit = (code) => process.exit(code),
  cwd = () => process.cwd(),
} = {}) {
  const dryRun = argv.includes('--dry-run');
  const allowMajor = argv.includes('--major');
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

  const major = crossesMajor(current, target);

  // --- Major gate -----------------------------------------------------------
  // A major crossing without --major is refused outright: no npm-update, no
  // sync, no migration, no doctor — print the runbook pointer and exit non-zero.
  if (major && !allowMajor) {
    emitMajorRefusal(target, writeErr);
    exit(1);
    return {
      ok: false,
      action: 'declined-major',
      currentVersion: current,
      targetVersion: target,
      major: true,
      stepsRun: [],
      dryRun,
    };
  }

  // --- No-op short-circuit --------------------------------------------------
  // Already on (or ahead of) the newest version: nothing to apply.
  if (compareVersions(target, current) <= 0) {
    write(`✅  Already up to date (v${current} is the newest version).\n`);
    return {
      ok: true,
      action: 'up-to-date',
      currentVersion: current,
      targetVersion: target,
      major,
      stepsRun: [],
      dryRun,
    };
  }

  // --- Dry run --------------------------------------------------------------
  // Print the resolved target and the ordered step plan; invoke no seam and
  // write nothing to disk.
  if (dryRun) {
    write(`mandrel update — planned upgrade v${current} → v${target}\n`);
    if (major) {
      write('  (major upgrade — --major supplied)\n');
    }
    STEP_PLAN.forEach((step, i) => {
      write(`  ${i + 1}. ${step}\n`);
    });
    write('Dry run: no files written, no dependency bumped.\n');
    return {
      ok: true,
      action: 'dry-run',
      currentVersion: current,
      targetVersion: target,
      major,
      stepsRun: [],
      dryRun: true,
    };
  }

  // --- Major runbook (inline, when --major applies) -------------------------
  if (major) {
    write(
      `Applying MAJOR upgrade v${current} → v${target} (--major). ` +
        `Review the runbook: ${RUNBOOK_PATH}\n`,
    );
  } else {
    write(`Updating v${current} → v${target}…\n`);
  }

  const stepsRun = [];

  // 1. npm update — bump the dependency. The lockfile change is left STAGED
  //    on disk; this module never commits.
  if (typeof npmUpdate !== 'function') {
    throw new Error(
      'mandrel update: npmUpdate seam is required to bump the dependency',
    );
  }
  await npmUpdate(target, { installCmd });
  stepsRun.push('npm-update');

  // Decide whether to use the re-exec path (spawnPhase) or the in-process
  // backward-compat seams (runSync / runMigrations / runDoctor).
  //
  // spawnPhase injected → re-exec path: all post-install phases run from the
  //   newly-installed binary. This is the production path and is what fixes
  //   the stale-materialization bug (Story #4034).
  //
  // spawnPhase NOT injected → in-process path: the original pre-Story-#4034
  //   behaviour. Tests that pre-date this change inject runSync/runMigrations/
  //   runDoctor and rely on the in-process path; they stay green without any
  //   modification.
  const useReExec = typeof spawnPhase === 'function';

  if (useReExec) {
    // Re-exec path: post-install phases run from the new binary.
    const projectRoot = cwd();
    const binPath = resolveNewBinPath(projectRoot);

    // 2. runSync from new bin — re-materialize ./.agents/ from the freshly
    //    installed payload. Running from the new bin ensures the copied files
    //    come from the new package's .agents/ tree, not the old loaded module.
    const syncResult = await spawnPhase('sync', [], {
      binPath,
      cwd: projectRoot,
      write,
      writeErr,
    });
    if (!syncResult.ok) {
      throw new Error(
        `mandrel update: \`mandrel sync\` from new binary exited non-zero — ` +
          'the .agents/ materialization may be incomplete. ' +
          'Run `mandrel sync` manually to restore.',
      );
    }
    stepsRun.push('runSync');

    // 3. sync-commands from new bin — regenerate .claude/commands/ from the
    //    freshly-materialized .agents/workflows/. Running from the new bin
    //    ensures the command tree is consistent with the new payload; an
    //    upstream-renamed workflow will be projected correctly and the old
    //    command file will be reaped. This step must follow runSync so the
    //    workflow sources are up to date before the command tree is rebuilt
    //    (Story #4046 A1c — `commands-in-sync` validates the post-sync state).
    const syncCommandsResult = await spawnPhase('sync-commands', [], {
      binPath,
      cwd: projectRoot,
      write,
      writeErr,
    });
    if (!syncCommandsResult.ok) {
      throw new Error(
        `mandrel update: \`mandrel sync-commands\` from new binary exited non-zero — ` +
          'the .claude/commands/ tree may be out of sync. ' +
          'Run `npm run sync:commands` manually to restore.',
      );
    }
    stepsRun.push('sync-commands');

    // 4. runMigrations from new bin — apply version-keyed steps for the
    //    crossed range. The new binary's migration registry contains any steps
    //    added in the target version; the old process's registry does not.
    const migrateResult = await spawnPhase(
      'migrate',
      ['--from', current, '--to', target],
      { binPath, cwd: projectRoot, write, writeErr },
    );
    if (!migrateResult.ok) {
      throw new Error(
        `mandrel update: \`mandrel migrate\` from new binary exited non-zero — ` +
          `some migrations for v${current} → v${target} may not have applied. ` +
          `Run \`mandrel migrate --from ${current} --to ${target}\` manually to retry.`,
      );
    }
    stepsRun.push('runMigrations');

    // 5. doctor from new bin — verify the resulting install. Running from the
    //    new bin is critical: the agents-drift check compares the materialized
    //    .agents/ against the installed package payload. When the old process
    //    runs this check, it resolves the package root to its own (old) install
    //    dir, so drift against the new payload is invisible. The new binary
    //    resolves the package root to the now-installed new version, producing
    //    an accurate result.
    const doctorResult = await spawnPhase('doctor', [], {
      binPath,
      cwd: projectRoot,
      write,
      writeErr,
    });
    stepsRun.push('doctor');

    // 6. surface the target changelog (best-effort; optional seam).
    if (typeof surfaceChangelog === 'function') {
      await surfaceChangelog(target);
    }

    if (!doctorResult.ok) {
      writeErr(
        `mandrel update: upgraded to v${target} but doctor reported failures.\n` +
          '   → Run `mandrel doctor` for remedies.\n',
      );
      exit(1);
      return {
        ok: false,
        action: 'doctor-failed',
        currentVersion: current,
        targetVersion: target,
        major,
        stepsRun,
        dryRun: false,
      };
    }
  } else {
    // In-process backward-compat path (pre-Story-#4034 behaviour).
    // Used when no `spawnPhase` seam is injected — preserves full backward
    // compatibility with existing tests that inject runSync/runMigrations/
    // runDoctor directly.

    // 2. runSync — re-materialize ./.agents/ from the new payload.
    runSync({ argv: [] });
    stepsRun.push('runSync');

    // 3. runMigrations — apply version-keyed steps for the crossed range.
    // Note: the in-process path (pre-Story-#4034) does not run sync-commands
    // here because sync-commands runs as a child process and there is no
    // in-process seam for it. The re-exec path (spawnPhase) handles it.
    runMigrations({ fromVersion: current, toVersion: target, ctx: {} });
    stepsRun.push('runMigrations');

    // 4. doctor — verify the resulting install.
    const doctor = await runDoctor();
    stepsRun.push('doctor');

    // 5. surface the target changelog (best-effort; optional seam).
    if (typeof surfaceChangelog === 'function') {
      await surfaceChangelog(target);
    }

    if (!doctor.ok) {
      const failed = doctor.results.filter((r) => !r.ok).map((r) => r.name);
      writeErr(
        `mandrel update: upgraded to v${target} but doctor reported failures: ` +
          `${failed.join(', ')}\n` +
          '   → Run `mandrel doctor` for remedies.\n',
      );
      exit(1);
      return {
        ok: false,
        action: 'doctor-failed',
        currentVersion: current,
        targetVersion: target,
        major,
        stepsRun,
        dryRun: false,
      };
    }
  }

  write(`✅  Updated to v${target}. The lockfile bump is staged for review.\n`);
  return {
    ok: true,
    action: 'updated',
    currentVersion: current,
    targetVersion: target,
    major,
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
 * `--major` / `--dry-run` / `--install-cmd` are parsed from `argv` by
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
 *   runSync?: typeof defaultRunSync,
 *   runMigrations?: typeof defaultRunMigrations,
 *   runDoctor?: typeof defaultRunDoctor,
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
    runSync,
    runMigrations,
    runDoctor,
    write = (s) => process.stdout.write(s),
    writeErr = (s) => process.stderr.write(s),
    exit = (code) => process.exit(code),
    log,
  } = deps;

  const current = deps.currentVersion ?? defaultCurrentVersion(fs);

  // The production spawnPhase default: spawn each post-install phase from
  // node_modules/.bin/mandrel (the newly-installed binary). spawnFn is
  // injectable so tests can stub the spawn boundary without running a real
  // child process.
  const productionSpawnPhase = (phase, args, opts) =>
    defaultSpawnPhase(phase, args, {
      ...opts,
      ...(spawnFn ? { spawnFn } : {}),
    });

  // Resolve which seam set to use for post-install phases. If any old-style
  // in-process seam (runSync/runMigrations/runDoctor) is injected, fall back
  // to the pre-Story-#4034 in-process path so the entrypoint test stays green.
  // Otherwise use the re-exec path (spawnPhase). This is a single ternary
  // rather than stacked optional spreads (tidy, Story #4046).
  const phaseSeams =
    runSync || runMigrations || runDoctor
      ? {
          ...(runSync ? { runSync } : {}),
          ...(runMigrations ? { runMigrations } : {}),
          ...(runDoctor ? { runDoctor } : {}),
        }
      : { spawnPhase: productionSpawnPhase };

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
    ...phaseSeams,
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
  });
}

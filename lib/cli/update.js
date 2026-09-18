// lib/cli/update.js
/**
 * `mandrel update`: install the newest published version, then re-materialize
 * `.agents/`, run migrations and doctor from the NEW binary (Node cannot
 * hot-swap loaded modules, so in-process phases would materialize the old
 * payload), and surface the changelog. Already-newest with `.agents/` drift
 * runs only the sync phases. Never mutates git: it reports the real index state.
 * Windows: `npm`/`pnpm`/`yarn` are `.cmd` shims that need `shell: true` under
 * CVE-2024-27980; every argv here is a fixed vector, so that stays safe.
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
import {
  compareVersions,
  resolveConsumerPinVersion,
} from './version-helpers.js';

const PACKAGE_NAME = 'mandrel';

const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com/dsj1984/mandrel/';

const GITHUB_RELEASES_URL = 'https://github.com/dsj1984/mandrel/releases';

const DEFAULT_CACHE_FILENAME = 'version-check.json';

/**
 * The version of the EXECUTING package — last-resort fallback only: as the
 * update decision's `current` it is tautologically newest and would hide a
 * lagging consumer pin.
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
 * The update decision's `current`: the consumer's declared pin (it is what
 * `npm-update` moves, so a pin lagging an inflated `node_modules` still
 * updates), else the consumer's resolved `node_modules` version, else the
 * executing package's own.
 *
 * @param {string} consumerRoot
 * @param {typeof nodeFs} [fs]
 * @param {{ resolvePackageRoot?: (fromDir: string) => string }} [opts]
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

/** @returns {string} */
function resolveProjectRoot() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..');
}

/**
 * Newest published version via the daily freshness cache. `bypassCache` forces
 * one probe but still writes the cache.
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
  // Bypass via forceRefresh, never by shifting `now`: `now` is persisted as
  // `checkedAt`, and a shifted stamp would defeat the 24h window.
  const result = await isStale({
    cachePath,
    now,
    runner,
    forceRefresh: bypassCache,
    fs,
    log,
  });
  return String(result.latestVersion);
}

/**
 * `npm view mandrel version`, trimmed.
 *
 * @param {{ spawnSync?: typeof spawnSync }} [deps]
 * @returns {string}
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
 * The full-install command named in the failed-install repair hint.
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
 * The lockfile-detected package manager, so the bump runs under the tool that
 * owns the tree (npm in a pnpm workspace fails and can corrupt `node_modules`).
 * `workspaceRoot` means `pnpm add` needs `-w`. `bun` coerces to `npm`: the
 * install builder has no bun command.
 *
 * @param {string} [cwd]
 * @param {typeof nodeFs} [fs]
 * @returns {{ packageManager: 'pnpm' | 'yarn' | 'npm', workspaceRoot: boolean }}
 */
export function detectPackageManager(cwd = process.cwd(), fs = nodeFs) {
  const result = probePackageManager(cwd, fs);
  const packageManager =
    result.packageManager === 'bun' ? 'npm' : result.packageManager;
  return { packageManager, workspaceRoot: result.workspaceRoot };
}

/**
 * The uncoerced probe; the staging report must name bun's real lockfile.
 *
 * @param {string} cwd
 * @param {typeof nodeFs} [fs]
 * @returns {{ packageManager: 'pnpm'|'yarn'|'bun'|'npm', workspaceRoot: boolean }}
 */
function probePackageManager(cwd, fs = nodeFs) {
  const exists = (p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  };
  return detectPackageManagerWithWorkspace(cwd, exists);
}

/**
 * The install command. An `--install-cmd` override is used verbatim except
 * that `{target}` is replaced with the resolved semver.
 *
 * @param {string} target
 * @param {string} [override]
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

const LOCKFILE_BY_PACKAGE_MANAGER = {
  pnpm: 'pnpm-lock.yaml',
  yarn: 'yarn.lock',
  bun: 'bun.lockb',
  npm: 'package-lock.json',
};

const MANIFEST_FILENAME = 'package.json';

const AGENTS_DIR = '.agents';

/**
 * @param {string} cwd
 * @param {typeof nodeFs} [fs]
 * @returns {string}
 */
export function defaultDetectLockfile(cwd, fs = nodeFs) {
  const { packageManager } = probePackageManager(cwd, fs);
  return LOCKFILE_BY_PACKAGE_MANAGER[packageManager] ?? 'package-lock.json';
}

const NEUTRAL_STAGING_LINE =
  'Review the working tree and commit the bump (git not available to report staging state).';

const DEGRADED_GIT_STATE = Object.freeze({
  ok: false,
  stagedManifest: false,
  stagedLockfile: false,
  stagedPayload: false,
  tracksAgents: false,
});

const spawnOk = (result) =>
  Boolean(result) && !result.error && result.status === 0;

/**
 * The path a porcelain v1 record reports as staged, else `null`. Staged means
 * index differs from HEAD AND the worktree agrees (`Y` blank), so a pair staged
 * before the install and rewritten by it (`MM`) is not staged. Renames yield
 * the new path; porcelain quoting is stripped.
 *
 * @param {string} record
 * @returns {string | null}
 */
function stagedPathFromPorcelain(record) {
  if (record.length < 4 || record[1] !== ' ') return null;
  if (record[0] === ' ' || record[0] === '?') return null;
  const raw = record.slice(3).trim();
  const arrow = raw.lastIndexOf(' -> ');
  const pathPart = arrow === -1 ? raw : raw.slice(arrow + 4);
  const path =
    pathPart.startsWith('"') && pathPart.endsWith('"')
      ? pathPart.slice(1, -1)
      : pathPart;
  return path.length > 0 ? path : null;
}

/**
 * The probe-state slot a staged path fills. Payload is tested first (a
 * `package.json` inside `.agents/` is payload). The manifest/lockfile tests
 * accept a leading prefix because porcelain paths are repo-root-relative;
 * that is safe only because the caller's pathspec anchors the query at `cwd`.
 *
 * @param {string} path
 * @param {string} lockfile
 * @returns {'stagedPayload' | 'stagedManifest' | 'stagedLockfile' | null}
 */
function stagedSlotFor(path, lockfile) {
  if (path === AGENTS_DIR || /(^|\/)\.agents\//.test(path))
    return 'stagedPayload';
  const isRootFile = (name) => path === name || path.endsWith(`/${name}`);
  if (isRootFile(MANIFEST_FILENAME)) return 'stagedManifest';
  return isRootFile(lockfile) ? 'stagedLockfile' : null;
}

/**
 * Read-only index probe: a `cwd`-anchored `git status --porcelain` over the
 * manifest, lockfile and `.agents`, plus `git ls-files .agents` (is the
 * payload tracked?). Never throws; any failure degrades to `{ ok: false }`.
 *
 * @param {{
 *   cwd?: string,
 *   lockfile?: string,
 *   spawnSync?: typeof spawnSync,
 * }} [opts]
 * @returns {{
 *   ok: boolean,
 *   stagedManifest: boolean,
 *   stagedLockfile: boolean,
 *   stagedPayload: boolean,
 *   tracksAgents: boolean,
 * }}
 */
export function defaultGitStatus({
  cwd = process.cwd(),
  lockfile = LOCKFILE_BY_PACKAGE_MANAGER.npm,
  spawnSync: spawn = spawnSync,
} = {}) {
  const run = (args) => spawn('git', args, { cwd, encoding: 'utf8' });
  try {
    const status = run([
      'status',
      '--porcelain',
      '--',
      MANIFEST_FILENAME,
      lockfile,
      AGENTS_DIR,
    ]);
    if (!spawnOk(status)) return DEGRADED_GIT_STATE;
    const agents = run(['ls-files', AGENTS_DIR]);
    const state = {
      ...DEGRADED_GIT_STATE,
      ok: true,
      tracksAgents: spawnOk(agents) && String(agents.stdout).trim().length > 0,
    };
    for (const record of String(status.stdout).split('\n')) {
      const path = stagedPathFromPorcelain(record);
      const slot = path && stagedSlotFor(path, lockfile);
      if (slot) state[slot] = true;
    }
    return state;
  } catch {
    return DEGRADED_GIT_STATE;
  }
}

/**
 * The staging line a successful run closes with. `bump` reports the manifest +
 * lockfile pair, and a not-staged hint also names a tracked `.agents/` (else
 * that diff is silently dropped). `payload` (drift heal) reports only
 * `.agents/`, or `''` when it is untracked.
 *
 * @param {{
 *   ok?: boolean,
 *   stagedManifest?: boolean,
 *   stagedLockfile?: boolean,
 *   stagedPayload?: boolean,
 *   tracksAgents?: boolean,
 * }} gitState
 * @param {string} lockfile
 * @param {{ scope?: 'bump' | 'payload' }} [opts]
 * @returns {string}
 */
export function formatStagingReport(
  gitState,
  lockfile,
  { scope = 'bump' } = {},
) {
  const {
    ok = false,
    stagedManifest = false,
    stagedLockfile = false,
    stagedPayload = false,
    tracksAgents = false,
  } = gitState ?? {};

  if (!ok) return NEUTRAL_STAGING_LINE;

  if (scope === 'payload') {
    if (!tracksAgents) return '';
    return stagedPayload
      ? `The re-materialized ${AGENTS_DIR}/ payload is staged for review.`
      : `The re-materialized ${AGENTS_DIR}/ payload is NOT staged. Review and stage it: git add ${AGENTS_DIR}/`;
  }

  if (stagedManifest && stagedLockfile) {
    return `The dependency bump is staged for review (${MANIFEST_FILENAME}, ${lockfile}).`;
  }

  const targets = [MANIFEST_FILENAME, lockfile];
  let note = '';
  if (tracksAgents) {
    targets.push(`${AGENTS_DIR}/`);
    note = ` ${AGENTS_DIR}/ is tracked here, so stage the re-materialized payload too.`;
  }
  return `The dependency bump is NOT staged.${note} Review and stage it: git add ${targets.join(' ')}`;
}

/**
 * The staging line, degrading any seam failure to the neutral line so a
 * courtesy report never crashes a completed update.
 *
 * @param {{
 *   gitStatus: (opts: { cwd: string, lockfile: string }) => object,
 *   detectLockfile: (cwd: string) => string,
 *   projectRoot: string,
 *   scope?: 'bump' | 'payload',
 * }} deps
 * @returns {string}
 */
function resolveStagingReport({
  gitStatus,
  detectLockfile,
  projectRoot,
  scope = 'bump',
}) {
  try {
    const lockfile = detectLockfile(projectRoot);
    return formatStagingReport(
      gitStatus({ cwd: projectRoot, lockfile }),
      lockfile,
      { scope },
    );
  } catch {
    return NEUTRAL_STAGING_LINE;
  }
}

/**
 * Install `target` with the detected package manager (no git mutation). The
 * shared `runInstallCommand` tokenizes and escapes per-arg under the win32
 * shell. A failure names the repair install so `node_modules` is never left
 * silently half-mutated.
 *
 * @param {string} target
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
 * `docs/CHANGELOG.md` from GitHub raw, for installs whose package lacks it.
 * Tags are `mandrel-vX.Y.Z` from 1.44.0 and bare `vX.Y.Z` before, so both
 * are tried.
 *
 * @param {string} version
 * @param {{
 *   https?: typeof nodeHttps,
 * }} [deps]
 * @returns {Promise<string>}
 * @throws {Error} When every tag form is non-2xx or the request errors.
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
 * Print the changelog sections in `(current, target]` — packaged file first,
 * then GitHub, then a Releases link. Best-effort: warns, never throws.
 *
 * @param {string} target
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

  try {
    raw = fs.readFileSync(changelogPath, 'utf8');
  } catch {
    // Absent: fall through to the GitHub fetch.
  }

  if (raw === undefined) {
    try {
      raw = await fetchChangelog(target);
    } catch {
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
 * Split a release-please changelog on `## [<version>]` headers; each body
 * includes its header line.
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
 * The consumer's installed `bin/mandrel.js`, NOT the `.bin` shim: the script
 * ships non-executable and pnpm symlinks the shim straight at it, so spawning
 * the shim fails with EACCES. Node runs the script directly instead.
 *
 * @param {string} projectRoot
 * @param {{ resolvePackageRoot?: (fromDir: string) => string }} [opts]
 * @returns {string}
 */
export function resolveNewBinScriptPath(
  projectRoot,
  { resolvePackageRoot = defaultResolvePackageRoot } = {},
) {
  const packageRoot = resolvePackageRoot(projectRoot);
  return path.join(packageRoot, 'bin', 'mandrel.js');
}

/**
 * Run one post-install phase as `node <binScript> <phase> …` so the new
 * package's code executes; no shell is needed on any platform. Throws only on
 * a spawn error.
 *
 * @param {string} phase
 * @param {string[]} args
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
  const r = spawnFn(process.execPath, [binPath, ...argv], {
    cwd,
    encoding: 'utf8',
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

/** The `--dry-run` printout of the full-upgrade step order. */
const STEP_PLAN = [
  'npm-update',
  'runSync',
  'sync-commands',
  'sync-agents',
  'runMigrations',
  'doctor',
  'surface changelog',
];

/**
 * Full-upgrade phases. A `spawn` non-zero exit is fatal (throws
 * `failMessage`); a `doctor` failure is soft (`doctor-failed`, exit 1).
 * `label` is what `stepsRun[]` reports.
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
      // Required for the `agents-in-sync` doctor check to be satisfiable.
      kind: 'spawn',
      phase: 'sync-agents',
      args: [],
      label: 'sync-agents',
      failMessage:
        'mandrel update: `mandrel sync-agents` from new binary exited non-zero — ' +
        'the .claude/agents/ tree may be out of sync. ' +
        'Run `mandrel sync-agents` manually to restore.',
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
 * Drift-heal phases: the sync phases only, from the installed binary.
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
    {
      kind: 'spawn',
      phase: 'sync-agents',
      args: [],
      label: 'sync-agents',
      failMessage:
        'mandrel update: `mandrel sync-agents` from installed binary exited non-zero — ' +
        'the .claude/agents/ tree may be out of sync. ' +
        'Run `mandrel sync-agents` manually to restore.',
    },
  ];
}

/**
 * Pure (no I/O) choice of action and phase plan.
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
    if (!hasDrift) {
      return { action: 'up-to-date', steps: [] };
    }
    if (dryRun) {
      return { action: 'dry-run', steps: [], variant: 'drift-heal' };
    }
    return { action: 'resynced', steps: driftHealSteps() };
  }

  // Drift is irrelevant here: the post-upgrade doctor re-checks it.
  if (dryRun) {
    return { action: 'dry-run', steps: [], variant: 'full-upgrade' };
  }
  return { action: 'updated', steps: fullUpgradeSteps(current, target) };
}

/**
 * `--install-cmd <cmd>` or `--install-cmd=<cmd>`; the shell has already joined
 * a quoted value into one token.
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
 * @param {(() => boolean | Promise<boolean>) | undefined} checkDrift
 * @returns {Promise<boolean>}
 */
async function resolveDrift(checkDrift) {
  const driftProbe =
    typeof checkDrift === 'function' ? checkDrift : () => !runAgentsDrift().ok;
  return Boolean(await driftProbe());
}

/**
 * Drive `planUpdate`'s steps. A doctor failure still surfaces the changelog,
 * then exits 1.
 *
 * @param {{
 *   steps: Array<{ kind: 'npm-update' | 'spawn' | 'doctor', label: string, phase?: string, args?: string[], failMessage?: string }>,
 *   target: string,
 *   installCmd: string | undefined,
 *   npmUpdate: ((version: string, opts: { installCmd?: string }) => unknown | Promise<unknown>) | undefined,
 *   spawnPhase: ((phase: string, args: string[], opts: object) => { ok: boolean } | Promise<{ ok: boolean }>) | undefined,
 *   surfaceChangelog: ((version: string) => unknown | Promise<unknown>) | undefined,
 *   resolveBinScript: (projectRoot: string) => string,
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
  resolveBinScript,
  projectRoot,
  write,
  writeErr,
  exit,
}) {
  const stepsRun = [];
  let doctorOk = true;

  // Resolved lazily after `npm-update`, so a missing npmUpdate seam reports
  // its own error first.
  let binPath;
  const binScript = () => {
    if (binPath === undefined) binPath = resolveBinScript(projectRoot);
    return binPath;
  };

  for (const step of steps) {
    if (step.kind === 'npm-update') {
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

    // eslint-disable-next-line no-await-in-loop
    const result = await spawnPhase(step.phase, step.args, {
      binPath: binScript(),
      cwd: projectRoot,
      write,
      writeErr,
    });
    stepsRun.push(step.label);

    if (step.kind === 'doctor') {
      doctorOk = result.ok;
    } else if (!result.ok) {
      throw new Error(step.failMessage);
    }
  }

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
 * @param {{
 *   argv?: string[],
 *   currentVersion?: string | (() => string),
 *   resolveTargetVersion?: () => (string | Promise<string>),
 *   npmUpdate?: (version: string, opts: { installCmd?: string }) => unknown | Promise<unknown>,
 *   checkDrift?: () => (boolean | Promise<boolean>),
 *   spawnPhase?: (phase: string, args: string[], opts: { binPath: string, cwd: string, write: (s: string) => void, writeErr: (s: string) => void }) => Promise<{ ok: boolean, stdout: string, stderr: string }> | { ok: boolean, stdout: string, stderr: string },
 *   surfaceChangelog?: (version: string) => unknown | Promise<unknown>,
 *   gitStatus?: (opts: { cwd: string }) => { ok: boolean, staged?: string[], unstaged?: string[], tracksAgents?: boolean },
 *   detectLockfile?: (cwd: string) => string,
 *   write?: (s: string) => void,
 *   writeErr?: (s: string) => void,
 *   exit?: (code: number) => void,
 *   cwd?: () => string,
 *   resolveBinScript?: (projectRoot: string) => string,
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
  gitStatus = defaultGitStatus,
  detectLockfile = defaultDetectLockfile,
  write = (s) => process.stdout.write(s),
  writeErr = (s) => process.stderr.write(s),
  exit = (code) => process.exit(code),
  cwd = () => process.cwd(),
  resolveBinScript = resolveNewBinScriptPath,
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

  // Probe drift only when already newest; a real bump never calls the seam.
  const hasDrift =
    compareVersions(target, current) <= 0
      ? await resolveDrift(checkDrift)
      : false;

  const plan = planUpdate({ current, target, dryRun, hasDrift });

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
      write(
        '  3. sync-agents    — regenerate .claude/agents/ from .agents/agents/\n',
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

  const projectRoot = cwd();

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
    resolveBinScript,
    projectRoot,
    write,
    writeErr,
    exit,
  });

  if (plan.action === 'resynced') {
    // No dependency is bumped here, so the re-materialized payload IS the diff.
    const payloadLine = resolveStagingReport({
      gitStatus,
      detectLockfile,
      projectRoot,
      scope: 'payload',
    });
    write(
      `✅  Healed .agents/ drift (v${current}). The materialized payload is now current.` +
        `${payloadLine ? ` ${payloadLine}` : ''}\n`,
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

  write(
    `✅  Updated to v${target}. ${resolveStagingReport({ gitStatus, detectLockfile, projectRoot })}\n`,
  );
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
 * Entry point for `bin/mandrel.js`: wires the production seams. `deps` exposes
 * the process boundaries for tests only; it is not public contract.
 *
 * @param {string[]} argv
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
 *   resolveBinScript?: (projectRoot: string) => string,
 *   checkDrift?: () => (boolean | Promise<boolean>),
 *   gitStatus?: (opts: { cwd: string }) => object,
 *   detectLockfile?: (cwd: string) => string,
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
    resolveBinScript,
    checkDrift,
    gitStatus,
    detectLockfile,
  } = deps;

  const cwdFn = typeof cwd === 'function' ? cwd : () => process.cwd();

  const current =
    deps.currentVersion ?? resolveCurrentVersionForUpdate(cwdFn(), fs);

  const productionSpawnPhase = (phase, args, opts) =>
    defaultSpawnPhase(phase, args, {
      ...opts,
      ...(spawnFn ? { spawnFn } : {}),
    });

  await runUpdateImpl({
    argv,
    currentVersion: current,
    // An explicit update always bypasses the 24h cache.
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
    ...(gitStatus ? { gitStatus } : {}),
    ...(detectLockfile
      ? { detectLockfile }
      : { detectLockfile: (dir) => defaultDetectLockfile(dir, fs) }),
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
    resolveBinScript,
  });
}

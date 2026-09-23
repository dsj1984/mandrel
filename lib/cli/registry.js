// lib/cli/registry.js
/**
 * Ordered `mandrel doctor` check registry: each entry is `{ name, run() }`,
 * `run()` returning `{ ok, detail, remedy? }` (`remedy` present whenever
 * `ok` is false). Checks run sequentially because some presuppose an earlier
 * one (`gh-auth` needs `gh-available`). Node built-ins only, so the module
 * loads inside the preflight guard before third-party packages exist; no
 * check ever echoes a token value.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BASELINE_MERGE_DRIVER_CONFIG_KEY,
  BASELINE_MERGE_DRIVER_REMEDY,
  parseBaselineMergeDriverCommand,
  probeBaselineMergeDriver,
} from '../../.agents/scripts/lib/bootstrap/baseline-merge-driver.js';
import {
  REQUIRED_NODE_CEILING_MAJOR,
  REQUIRED_NODE_FLOOR,
  satisfiesNodeEngine,
} from '../../.agents/scripts/lib/bootstrap/project-bootstrap.js';
import { isCommandExcluded } from '../../.agents/scripts/lib/command-header.js';
import { getDeliveryRouting } from '../../.agents/scripts/lib/config/delivery-routing.js';
import { isResolvable } from '../../.agents/scripts/lib/runtime-deps/dep-resolution.js';
import { describeParserMajorError } from '../../.agents/scripts/lib/runtime-deps/parser-major.js';
import { runClaudeCodeVersion } from './claude-code-version.js';
import {
  defaultResolvePackageRoot,
  listFiles as listPayloadFiles,
} from './sync.js';
import { readCache } from './version-check.js';
import {
  compareVersions as compareSemver,
  resolveConsumerPinSpec,
  satisfiesPinSpec,
} from './version-helpers.js';

/**
 * @param {string} cmd
 * @param {string[]} args
 * @returns {{ status: number|null, stdout: string, stderr: string, error?: NodeJS.ErrnoException }}
 */
function spawn(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return {
    status: r.status,
    stdout: typeof r.stdout === 'string' ? r.stdout : '',
    stderr: typeof r.stderr === 'string' ? r.stderr : '',
    error: r.error,
  };
}

// check: node-version

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

// check: git-available

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

// check: gh-available

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

// check: github-token

/**
 * Resolve a token the way `providers/github/auth.js#resolveToken` does: env
 * `GITHUB_TOKEN`/`GH_TOKEN`, else `gh auth token`. The CLI does not load
 * `.env`, so an env-only check would false-block `gh auth login` users.
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

// check: gh-auth

/**
 * `gh auth status` live-validates the token, which an Actions installation
 * token (and some fine-grained tokens) cannot pass even though they work for
 * everything mandrel does. The runtime never consults it, so a failing status
 * with an env token present is warn-and-skip (ok); only "no token and not
 * logged in" fails.
 *
 * @param {{ runner?: (cmd: string, args: string[]) => { status: number|null, stdout: string, stderr: string, error?: NodeJS.ErrnoException }, env?: Record<string,string|undefined> }} [opts]
 * @returns {{ ok: boolean, detail: string, remedy?: string }}
 */
function runGhAuth({ runner = spawn, env = process.env } = {}) {
  const r = runner('gh', ['auth', 'status']);
  if (r.error?.code === 'ENOENT') {
    return {
      ok: false,
      detail: 'gh not found — auth check skipped',
      remedy: 'Install the GitHub CLI: https://cli.github.com',
    };
  }
  if (r.status !== 0) {
    const envToken = env.GITHUB_TOKEN || env.GH_TOKEN;
    if (envToken && envToken.length > 0) {
      return {
        ok: true,
        detail:
          '`gh auth status` could not validate the active token, but GITHUB_TOKEN/GH_TOKEN is set (the runtime authenticates non-interactively with it)',
      };
    }
    return {
      ok: false,
      detail: 'not logged in',
      remedy:
        'Run `gh auth login` (choose GitHub.com → HTTPS → login with a web browser), then re-run.',
    };
  }
  const output = (r.stdout + r.stderr).trim();
  const match = /Logged in to \S+ as (\S+)/i.exec(output);
  const detail = match ? `logged in as ${match[1]}` : 'logged in';
  return { ok: true, detail };
}

// check: commands-in-sync

/**
 * Parity of `.claude/commands/*.md` against the union of `.agents/workflows/`
 * and `.agents/local/workflows/`. A basename is expected iff at least one
 * source copy is not `command: false`, mirroring the sync script's
 * payload-wins shadowing; an unreadable source counts as projected.
 *
 * The root defaults to `process.cwd()`, never `resolveProjectRoot()` — that
 * lands on `node_modules/mandrel/` in an installed consumer, where the
 * command tree never exists, producing a permanent false "not synced".
 *
 * @param {{ projectRoot?: string, cwd?: () => string, readDir?: (dir: string) => string[], readFile?: (file: string) => string | null }} [opts]
 * @returns {{ ok: boolean, detail: string, remedy?: string }}
 */
function runCommandsInSync({ projectRoot, cwd, readDir, readFile } = {}) {
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
  const readSource =
    readFile ??
    ((file) => {
      try {
        return fs.readFileSync(file, 'utf8');
      } catch {
        return null;
      }
    });

  const srcDirs = [
    path.join(root, '.agents', 'workflows'),
    path.join(root, '.agents', 'local', 'workflows'),
  ];
  const destDir = path.join(root, '.claude', 'commands');

  // Top-level .md only (helpers/ are included modules, not commands).
  const expected = new Set();
  for (const srcDir of srcDirs) {
    for (const f of listDir(srcDir)) {
      if (f.startsWith('.')) continue;
      const content = readSource(path.join(srcDir, f));
      if (content != null && isCommandExcluded(content)) continue;
      expected.add(f);
    }
  }
  const sources = [...expected].sort();
  const dests = listDir(destDir)
    .filter((f) => !f.startsWith('.'))
    .sort();

  const dstSet = new Set(dests);
  const missing = sources.filter((f) => !dstSet.has(f));
  const extra = dests.filter((f) => !expected.has(f));

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

// check: agents-in-sync

/**
 * Raw JSON read; any failure degrades to `null`.
 *
 * @param {string} absPath
 * @param {typeof fs} fsImpl
 * @returns {object | null}
 */
function readJsonSafe(absPath, fsImpl) {
  try {
    return JSON.parse(fsImpl.readFileSync(absPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Resolve `delivery.routing.roleScopedAgents` without `resolveConfig()`,
 * which pulls in AJV and would break the built-ins-only contract. Shallow-
 * merges only `delivery.routing` from `.agentrc.json` and
 * `.agentrc.local.json` (local wins).
 *
 * @param {string} projectRoot
 * @param {typeof fs} fsImpl
 * @returns {boolean}
 */
function resolveRoleScopedAgentsFlag(projectRoot, fsImpl) {
  const base = readJsonSafe(path.join(projectRoot, '.agentrc.json'), fsImpl);
  const local = readJsonSafe(
    path.join(projectRoot, '.agentrc.local.json'),
    fsImpl,
  );
  const merged = {
    delivery: {
      routing: {
        ...(base?.delivery?.routing ?? {}),
        ...(local?.delivery?.routing ?? {}),
      },
    },
  };
  return getDeliveryRouting(merged).roleScopedAgents;
}

/**
 * Parity of `.claude/agents/*.md` against `.agents/agents/*.md` (root anchored
 * at `process.cwd()` as in `commands-in-sync`). A never-materialized tree is
 * fatal while `roleScopedAgents` is on — the acceptance critic would silently
 * fail to spawn and fall back to a weaker inline critic — and advisory when it
 * is off. Drift in a materialized tree always fails.
 *
 * @param {{
 *   projectRoot?: string,
 *   cwd?: () => string,
 *   readDir?: (dir: string) => string[],
 *   fsImpl?: typeof fs,
 *   roleScopedAgents?: boolean,
 * }} [opts]
 * @returns {{ ok: boolean, detail: string, remedy?: string }}
 */
function runAgentsInSync({
  projectRoot,
  cwd,
  readDir,
  fsImpl = fs,
  roleScopedAgents,
} = {}) {
  const getCwd = cwd ?? (() => process.cwd());
  const root = projectRoot ?? getCwd();
  const listDir =
    readDir ??
    ((dir) => {
      try {
        return fsImpl.readdirSync(dir).filter((f) => f.endsWith('.md'));
      } catch {
        return [];
      }
    });

  const srcDir = path.join(root, '.agents', 'agents');
  const destDir = path.join(root, '.claude', 'agents');

  const sources = listDir(srcDir)
    .filter((f) => !f.startsWith('.'))
    .sort();
  const dests = listDir(destDir)
    .filter((f) => !f.startsWith('.'))
    .sort();

  if (dests.length === 0) {
    if (sources.length === 0) {
      return { ok: true, detail: '0 agents up to date' };
    }
    const resolvedFlag =
      typeof roleScopedAgents === 'boolean'
        ? roleScopedAgents
        : resolveRoleScopedAgentsFlag(root, fsImpl);
    if (!resolvedFlag) {
      return {
        ok: true,
        detail: `${sources.length} agent def(s) not materialized (roleScopedAgents is disabled)`,
      };
    }
    return {
      ok: false,
      detail: `${sources.length} agent def(s) not yet materialized in .claude/agents/`,
      remedy:
        'Run `mandrel sync-agents` to regenerate the `.claude/agents/` tree.',
    };
  }

  const srcSet = new Set(sources);
  const dstSet = new Set(dests);
  const missing = sources.filter((f) => !dstSet.has(f));
  const extra = dests.filter((f) => !srcSet.has(f));

  if (missing.length === 0 && extra.length === 0) {
    return { ok: true, detail: `${sources.length} agents up to date` };
  }

  const parts = [];
  if (missing.length > 0) parts.push(`${missing.length} not synced`);
  if (extra.length > 0) parts.push(`${extra.length} stale`);
  return {
    ok: false,
    detail: parts.join(', '),
    remedy:
      'Run `mandrel sync-agents` to regenerate the `.claude/agents/` tree.',
  };
}

// check: runtime-deps

/**
 * Presence is not enough: a declared range cannot pin which `@babel/parser`
 * major the consumer's node_modules supplies, and the wrong one fails
 * scoring mid-scan with an opaque error — so report it here.
 *
 * @param {() => string|null} parserMajorError
 * @returns {{ ok: boolean, detail: string, remedy?: string }}
 */
function allPresentVerdict(parserMajorError) {
  const parserProblem = parserMajorError();
  if (parserProblem === null) {
    return { ok: true, detail: 'all dependencies found' };
  }
  return {
    ok: false,
    detail: 'dependency version unsupported',
    remedy: parserProblem,
  };
}

/**
 * Are the runtime deps resolvable from the consumer root? Anchored at
 * `process.cwd()`, not the package root: under pnpm isolated mode the
 * consumer's node_modules are invisible from `node_modules/mandrel/`.
 *
 * @param {{ projectRoot?: string, resolve?: (dep: string) => string, manifestRequired?: string[] }} [opts]
 * @returns {{ ok: boolean, detail: string, remedy?: string }}
 */
function runRuntimeDeps({
  projectRoot,
  resolve: resolveSeam,
  manifestRequired,
  parserMajorError = describeParserMajorError,
} = {}) {
  const root = projectRoot ?? process.cwd();

  let required = manifestRequired;
  if (!required) {
    try {
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

  // `isResolvable` also probes `<name>/package.json`: a dep with no `main`
  // and no `exports` cannot be resolved by bare name yet is installed.
  const resolve =
    resolveSeam ?? createRequire(path.join(root, 'package.json')).resolve;
  for (const dep of required) {
    if (!isResolvable(dep, resolve)) missing.push(dep);
  }

  if (missing.length === 0) return allPresentVerdict(parserMajorError);
  return {
    ok: false,
    detail: `missing: ${missing.join(', ')}`,
    remedy:
      'The framework runtime deps are not resolvable from the consumer root, ' +
      'where the materialized .agents/scripts/*.js run. npm and yarn hoist ' +
      "them automatically — run the installer if you haven't. pnpm's default " +
      'isolated layout does NOT hoist transitive deps to the top level: add ' +
      '`shamefully-hoist=true` (or a scoped `public-hoist-pattern[]` for ' +
      'each dep) to your `.npmrc` and reinstall. ' +
      `Missing: ${missing.join(', ')}`,
  };
}

// check: agents-materialized

/**
 * Is `./.agents/instructions.md` present? Absent with the package installed
 * means postinstall was skipped (`--ignore-scripts`, sandboxed CI). Both
 * lookups anchor at the consumer's cwd.
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
      return requireFrom.resolve('mandrel/package.json');
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
      detail: 'mandrel installed but ./.agents/ not materialized',
      remedy:
        'Run `mandrel sync` to materialize the .agents/ payload (postinstall was skipped).',
    };
  }

  return {
    ok: false,
    detail: 'mandrel not installed and ./.agents/ absent',
    remedy:
      'Install the framework (`npm install mandrel`), then run `mandrel sync`.',
  };
}

// check: agents-drift

/**
 * A size mismatch proves drift without reading contents; equal sizes fall
 * through to a byte compare. `statSync` is optional on the seam.
 *
 * @param {string} src - absolute path to the package-payload file
 * @param {string} dest - absolute path to the materialized file
 * @param {{ readFileSync: Function, statSync?: Function }} fsImpl
 * @returns {boolean} `true` when the files differ
 */
function payloadFileDrifted(src, dest, fsImpl) {
  if (
    typeof fsImpl.statSync === 'function' &&
    fsImpl.statSync(src).size !== fsImpl.statSync(dest).size
  ) {
    return true;
  }
  return !fsImpl.readFileSync(src).equals(fsImpl.readFileSync(dest));
}

/**
 * Compare materialized `./.agents/` bytes to the installed package payload
 * (excluding `.agents/local/`) and report the first missing or drifted file.
 * Only paths and counts are reported, never contents.
 *
 * @param {{
 *   cwd?: () => string,
 *   fsImpl?: { existsSync: (p: string) => boolean, readdirSync: Function, readFileSync: Function, statSync?: Function },
 *   resolvePackageRoot?: (fromDir: string) => string,
 * }} [opts]
 * @returns {{ ok: boolean, detail: string, remedy?: string }}
 */
export function runAgentsDrift({ cwd, fsImpl = fs, resolvePackageRoot } = {}) {
  const getCwd = cwd ?? (() => process.cwd());
  const resolveRoot = resolvePackageRoot ?? defaultResolvePackageRoot;
  const projectRoot = getCwd();

  let packageRoot;
  try {
    packageRoot = resolveRoot(projectRoot);
  } catch {
    // agents-materialized owns the "not installed" remedy.
    return {
      ok: true,
      detail: 'mandrel not installed — drift skipped',
    };
  }

  const sourceRoot = path.join(packageRoot, '.agents');
  if (!fsImpl.existsSync(sourceRoot)) {
    return {
      ok: true,
      detail: 'mandrel ships no .agents/ payload — drift skipped',
    };
  }

  const destRoot = path.join(projectRoot, '.agents');
  if (!fsImpl.existsSync(destRoot)) {
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

    comparedCount += 1;
    if (payloadFileDrifted(src, dest, fsImpl)) {
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

// check: pin-current

/**
 * Fatal: does the installed `mandrel` satisfy the consumer's declared range?
 * Distinct from `agents-drift` (file contents) and `version-current` (newer
 * published). Graded by range satisfaction, not identity, because `^2.1.0` +
 * 2.4.0 after `npm update` is the normal steady state:
 * - satisfies and equals the base → pass;
 * - satisfies but newer than the base → pass, advisory in `detail`;
 * - behind the base → fail (distinct message);
 * - otherwise outside the range → fail.
 * No resolvable semver pin (absent, `workspace:`, `git+`, `latest`, …) skips.
 *
 * @param {{
 *   cwd?: () => string,
 *   fsImpl?: typeof fs,
 *   resolvePackageRoot?: (fromDir: string) => string,
 * }} [opts]
 * @returns {{ ok: boolean, detail: string, remedy?: string }}
 */
export function runPinCurrent({ cwd, fsImpl = fs, resolvePackageRoot } = {}) {
  const getCwd = cwd ?? (() => process.cwd());
  const resolveRoot = resolvePackageRoot ?? defaultResolvePackageRoot;
  const projectRoot = getCwd();

  const spec = resolveConsumerPinSpec(projectRoot, fsImpl);
  if (!spec) {
    return {
      ok: true,
      detail: 'no resolvable mandrel dependency pin — skipped',
    };
  }

  let installedRoot;
  try {
    installedRoot = resolveRoot(projectRoot);
  } catch {
    return {
      ok: true,
      detail: 'mandrel not installed — pin check skipped',
    };
  }

  let installed;
  try {
    const parsed = JSON.parse(
      fsImpl.readFileSync(path.join(installedRoot, 'package.json'), 'utf8'),
    );
    installed = String(parsed.version);
  } catch {
    return {
      ok: true,
      detail: 'installed version unreadable — pin check skipped',
    };
  }

  const declared = `${spec.operator}${spec.version}`;

  if (compareSemver(installed, spec.version) < 0) {
    return {
      ok: false,
      detail: `package.json pins ${declared} but an older v${installed} is installed`,
      remedy:
        'Run `npm install` to install a version satisfying the package.json pin.',
    };
  }

  if (!satisfiesPinSpec(installed, spec)) {
    return {
      ok: false,
      detail: `package.json pins ${declared} but v${installed} is installed — outside the declared range`,
      remedy:
        'Run `mandrel update` to reconcile the package.json pin with the installed version.',
    };
  }

  if (compareSemver(installed, spec.version) > 0) {
    // The doctor prints only `detail` for a pass, so the advisory rides there.
    return {
      ok: true,
      detail: `v${installed} satisfies the ${declared} pin but is newer than it — run \`mandrel update\` to re-pin (advisory)`,
    };
  }

  return {
    ok: true,
    detail: `pin ${declared} matches the installed version`,
  };
}

// check: version-current

/**
 * @param {typeof fs} fsImpl
 * @returns {string}
 */
function defaultInstalledVersion(fsImpl) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const manifestPath = path.resolve(here, '..', '..', 'package.json');
  const parsed = JSON.parse(fsImpl.readFileSync(manifestPath, 'utf8'));
  return String(parsed.version);
}

/** Mirrors `version-check.js#DEFAULT_CACHE_FILENAME`. */
const DEFAULT_VERSION_CACHE_FILENAME = 'version-check.json';

/**
 * Anchored at the consumer root so the cache survives reinstalls that
 * replace `node_modules/`.
 *
 * @returns {string}
 */
function defaultVersionCachePath() {
  return path.join(process.cwd(), 'temp', DEFAULT_VERSION_CACHE_FILENAME);
}

/**
 * Cache-only stale-version advisory: reads the freshness cache and never hits
 * the network. Always `ok: true`, so it can never fail doctor or CI.
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
      return {
        ok: true,
        detail: 'installed version unknown — advisory skipped',
      };
    }
  }

  const cached = readCache({ cachePath: resolvedPath, fs: fsImpl });
  if (!cached) {
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

// check: merge-driver

/**
 * Is this clone's `baselines/*.json` merge driver registered? `.gitattributes`
 * ships with the repo but the driver command is per-clone `git config`, and a
 * missing one silently falls back to a text merge. Skipped when
 * `.gitattributes` does not declare the driver.
 *
 * @param {{cwd?: () => string, fsImpl?: typeof fs, runner?: typeof spawn}} [opts]
 * @returns {{ ok: boolean, detail: string, remedy?: string }}
 */
export function runMergeDriver({ cwd, fsImpl = fs, runner = spawn } = {}) {
  const projectRoot = (cwd ?? (() => process.cwd()))();
  // Git runs from projectRoot: the config key is per-clone.
  const { declared, command } = probeBaselineMergeDriver({
    projectRoot,
    fsImpl,
    runGit: (args) => runner('git', args, { cwd: projectRoot }),
  });
  if (!declared) {
    return {
      ok: true,
      detail:
        'skipped — .gitattributes does not route baselines/*.json through the mandrel merge driver',
    };
  }
  if (command === '') {
    return {
      ok: false,
      detail: `${BASELINE_MERGE_DRIVER_CONFIG_KEY} is unset — baselines/*.json will fall back to git's text merge, which conflicts on adjacent rows and can splice rows neither branch scored`,
      remedy: BASELINE_MERGE_DRIVER_REMEDY,
    };
  }
  return probeConfiguredDriver(command, runner, projectRoot);
}

/**
 * Execute the configured driver with `--help` (the real invocation mutates
 * `%A`): a set-but-broken command — typically an absolute node path moved by
 * an nvm/volta bump — fails as silently as an unset key. The command is
 * tokenised, never shell-run, since a config value must not become arbitrary
 * command execution. Runs from projectRoot, where git invokes drivers.
 *
 * @param {string} command
 * @param {typeof spawn} runner
 * @param {string} projectRoot
 * @returns {{ ok: boolean, detail: string, remedy?: string }}
 */
function probeConfiguredDriver(command, runner, projectRoot) {
  const parsed = parseBaselineMergeDriverCommand(command);
  if (!parsed) {
    return {
      ok: false,
      detail: `${BASELINE_MERGE_DRIVER_CONFIG_KEY} is set to ${JSON.stringify(command)}, which has no runnable command in it`,
      remedy: BASELINE_MERGE_DRIVER_REMEDY,
    };
  }
  const probe = runner(parsed.file, [...parsed.args, '--help'], {
    cwd: projectRoot,
  });
  if (probe.status === 0) return { ok: true, detail: command };
  const why = probe.error?.message ?? `exit ${probe.status}`;
  return {
    ok: false,
    detail: `${BASELINE_MERGE_DRIVER_CONFIG_KEY} is set to ${JSON.stringify(command)} but running it failed (${why}) — git would fall back to text-merging baselines/*.json exactly as if the key were unset`,
    remedy: BASELINE_MERGE_DRIVER_REMEDY,
  };
}

// check: test-credit-path

/** The runner whose green full run deposits the close `test` credit itself. */
const MANDREL_TEST_RUNNER = 'run-tests.js';

/** Deposits the credit whatever `npm test` resolves to. */
const TEST_CREDIT_DEPOSIT_COMMAND =
  'node .agents/scripts/evidence-gate.js --standalone --scope-id <storyId> --gate test --worktree <workCwd> -- npm test';

const TEST_CREDIT_REMEDY = `run the suite through the depositor instead of bare \`npm test\`: ${TEST_CREDIT_DEPOSIT_COMMAND}`;

/**
 * Read from `package.json`, not `project.commands.test`: the close gate's argv
 * is the literal `npm test`.
 *
 * @param {string} projectRoot
 * @param {typeof fs.readFileSync} readFileImpl
 * @returns {string|null} The trimmed script, or null when there is none.
 */
function readProjectTestScript(projectRoot, readFileImpl) {
  try {
    const raw = readFileImpl(path.join(projectRoot, 'package.json'), 'utf8');
    const script = JSON.parse(raw)?.scripts?.test;
    return typeof script === 'string' && script.trim().length > 0
      ? script.trim()
      : null;
  } catch {
    return null;
  }
}

/**
 * Does a bare `npm test` reach mandrel's runner and so deposit the close
 * `test` credit? Always `ok: true` — another runner is supported, it just
 * needs the explicit depositor — so the remedy rides a passing verdict and is
 * repeated in `detail`. Detected by name only, never executed.
 *
 * @param {{ projectRoot?: string, readFile?: typeof fs.readFileSync }} [opts]
 * @returns {{ ok: boolean, detail: string, remedy?: string }}
 */
function runTestCreditPath({ projectRoot, readFile = fs.readFileSync } = {}) {
  const script = readProjectTestScript(projectRoot ?? process.cwd(), readFile);
  if (script === null) {
    return {
      ok: true,
      detail: `no \`test\` script in package.json — close still spawns \`npm test\`, so ${TEST_CREDIT_REMEDY}`,
      remedy: TEST_CREDIT_REMEDY,
    };
  }
  if (script.includes(MANDREL_TEST_RUNNER)) {
    return {
      ok: true,
      detail: `\`npm test\` → \`${script}\` reaches mandrel's runner — a green full run on a story branch deposits the close \`test\` credit itself`,
    };
  }
  return {
    ok: true,
    detail: `\`npm test\` → \`${script}\` is this project's own runner and never reaches \`${MANDREL_TEST_RUNNER}\`, so it deposits no close \`test\` credit and prints nothing — ${TEST_CREDIT_REMEDY}`,
    remedy: TEST_CREDIT_REMEDY,
  };
}

/** `advisory: true` marks a check whose `run()` never fails. */
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
    name: 'agents-in-sync',
    run: (opts) => runAgentsInSync(opts),
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
    name: 'claude-code-version',
    run: (opts) => runClaudeCodeVersion(opts),
  },
  {
    name: 'merge-driver',
    run: (opts) => runMergeDriver(opts),
  },
  {
    name: 'pin-current',
    run: (opts) => runPinCurrent(opts),
  },
  {
    name: 'version-current',
    advisory: true,
    run: (opts) => runVersionCurrent(opts),
  },
  {
    name: 'test-credit-path',
    advisory: true,
    run: (opts) => runTestCreditPath(opts),
  },
];

export default registry;

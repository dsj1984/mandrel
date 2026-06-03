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
 * Verify that `GITHUB_TOKEN` is set in the environment. Never echoes the
 * token value (security baseline §5 — Secrets Management).
 *
 * @param {{ env?: Record<string,string|undefined> }} [opts]
 * @returns {{ ok: boolean, detail: string, remedy?: string }}
 */
function runGithubToken({ env = process.env } = {}) {
  const token = env.GITHUB_TOKEN;
  if (token && token.length > 0) {
    return { ok: true, detail: 'GITHUB_TOKEN set' };
  }
  return {
    ok: false,
    detail: 'GITHUB_TOKEN not set',
    remedy: 'Run: export GITHUB_TOKEN=<your-token>  (or add to .env)',
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
 * sources to `.claude/commands/*.md` destinations and report parity.
 *
 * Injectable seam: `readDir` replaces `fs.readdirSync` so tests can
 * exercise without touching the real filesystem.
 *
 * @param {{ projectRoot?: string, readDir?: (dir: string) => string[] }} [opts]
 * @returns {{ ok: boolean, detail: string, remedy?: string }}
 */
function runCommandsInSync({ projectRoot, readDir } = {}) {
  const root = projectRoot ?? resolveProjectRoot();
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
    remedy: 'Run `npm run sync:commands` to synchronise .claude/commands/.',
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
 * `@mandrel/agents` package *is* installed in node_modules, the project is in
 * the "postinstall-skipped" state — the package was installed with scripts
 * disabled (e.g. `npm ci --ignore-scripts`, a sandboxed CI, or a package
 * manager that skips lifecycle scripts), so the materializer never ran. The
 * remedy is to run `mandrel sync` (lib/cli/sync.js) by hand.
 *
 * Resolution anchors:
 * - `./.agents/instructions.md` is resolved against `cwd` (the consumer
 *   project root), matching where `mandrel sync` writes the materialized tree.
 * - `@mandrel/agents` is resolved from `cwd` so we detect *their* install, not
 *   a copy hoisted next to this CLI module — mirroring sync.js's resolver.
 *
 * Injectable seams (used by tests so no real filesystem or package is needed):
 * - `cwd()` — replaces `process.cwd`.
 * - `existsSync(p)` — replaces `fs.existsSync`.
 * - `resolvePackage(fromDir)` — replaces `@mandrel/agents` resolution; throws
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
      return requireFrom.resolve('@mandrel/agents/package.json');
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
      detail: '@mandrel/agents installed but ./.agents/ not materialized',
      remedy:
        'Run `mandrel sync` to materialize the .agents/ payload (postinstall was skipped).',
    };
  }

  return {
    ok: false,
    detail: '@mandrel/agents not installed and ./.agents/ absent',
    remedy:
      'Install the framework (`npm install @mandrel/agents`), then run `mandrel sync`.',
  };
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
];

export default registry;

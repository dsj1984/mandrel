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
import {
  REQUIRED_NODE_CEILING_MAJOR,
  REQUIRED_NODE_FLOOR,
  satisfiesNodeEngine,
} from '../../.agents/scripts/lib/bootstrap/project-bootstrap.js';
import { isCommandExcluded } from '../../.agents/scripts/lib/command-header.js';
import { getDeliveryRouting } from '../../.agents/scripts/lib/config/delivery-routing.js';
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
 * Verify the GitHub CLI can authenticate.
 *
 * `gh auth status` performs **live token validation** (it probes the API for
 * the active token). A GitHub Actions installation token — and some
 * fine-grained tokens — cannot pass that probe (`GET /user` returns 403
 * "Resource not accessible by integration") even though the token works for
 * every git/API operation mandrel actually performs. The non-interactive
 * runtime never consults `gh auth status`: it resolves auth via the env token
 * or `gh auth token` (`.agents/scripts/providers/github/auth.js#resolveToken`,
 * mirrored by the `github-token` check above). So when `gh auth status` fails
 * but a token is present in the environment, degrade to **warn-and-skip**
 * (ok=true) rather than false-blocking the ready verdict — the same
 * warn-and-skip resolution #3915 applied to the project-scope preflight.
 * A genuine "no token anywhere and not logged in" condition still fails.
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
 * (`node_modules/mandrel/`), where the generated command tree never
 * exists — yielding a permanent `N not synced` false positive whose
 * `npm run sync:commands` remedy can never clear it.
 *
 * Injectable seams (used by tests so no real filesystem is touched):
 * - `cwd()` replaces `process.cwd` so tests can pin the consumer root.
 * - `readDir` replaces `fs.readdirSync`.
 * - `readFile` replaces `fs.readFileSync` (frontmatter `command: false`
 *   projection opt-out, #4482 — an unreadable source is treated as
 *   projected, matching the sync script's fail-loud read).
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

  const srcDir = path.join(root, '.agents', 'workflows');
  const destDir = path.join(root, '.claude', 'commands');

  // Only top-level .md files are synced (helpers/ subdirectory excluded by
  // the sync script — they are path-included modules, not slash commands).
  // Workflows whose frontmatter carries `command: false` (#4482) opt out of
  // projection and must not count toward the expected command set.
  const sources = listDir(srcDir)
    .filter((f) => !f.startsWith('.'))
    .filter((f) => {
      const content = readSource(path.join(srcDir, f));
      return content == null || !isCommandExcluded(content);
    })
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
// check: agents-in-sync
// ---------------------------------------------------------------------------

/**
 * Best-effort raw JSON read — no AJV, no merge validation. Absent, unreadable,
 * or malformed files degrade to `null` so a config problem never crashes a
 * doctor check; the caller applies framework defaults on `null`.
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
 * Resolve `delivery.routing.roleScopedAgents` (default `true`) for
 * `agents-in-sync`'s fatal/advisory branch below, WITHOUT importing the full
 * `resolveConfig()` chain — that chain pulls in AJV (`config-schema.js`),
 * which would violate this module's own "Node built-ins only" contract (see
 * the module doc: registry.js must load inside the preflight guard, before
 * any third-party package is guaranteed present).
 *
 * Reads `.agentrc.json` and `.agentrc.local.json` directly and shallow-merges
 * only the `delivery.routing` block (local wins per-key) — narrower than the
 * resolver's full deep-merge, but sufficient for this one boolean, and it
 * still honours a local override rather than silently ignoring it. Delegates
 * the actual default/coercion to `getDeliveryRouting` (`config/delivery-
 * routing.js`), which has zero imports of its own and is already the single
 * source of truth for this default elsewhere in the framework.
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
 * Dry-run the sync-claude-agents logic: compare `.agents/agents/*.md` sources
 * to the generated `.claude/agents/*.md` role-agent tree and report parity.
 * Exact sibling of `commands-in-sync` for the role-agent surface (#4478); the
 * agent tree is a flat projection with no `loops/` namespace and no
 * frontmatter projection opt-out.
 *
 * Resolution anchor: the root defaults to `process.cwd()` — the consumer
 * project directory where `mandrel sync` materializes both `.agents/` and the
 * agent tree — mirroring `commands-in-sync`. It MUST NOT fall back to
 * `resolveProjectRoot()`: that walks up from this module's own location and
 * lands on the *package* directory in an npm-installed consumer, where the
 * generated agent tree never exists.
 *
 * A repo with no `.agents/agents/` sources and no `.claude/agents/` tree is a
 * clean no-op (0 sources, 0 dests → "up to date").
 *
 * **Tightened from advisory to fatal (Story #4530, M7-B).** Prior to this
 * Story, a **never materialized** agent tree (sources present, `.claude/
 * agents/` empty) was reported as advisory — "inert", because no workflow
 * spawned the role agents yet. M7-B has landed: `helpers/deliver-story` Step
 * 1a dispatches `subagent_type: acceptance-critic` on the **default** path
 * (`roleScopedAgents` defaults `true`). An unmaterialized tree under that
 * default is no longer a benign scaffolding gap — it is the acceptance
 * ceremony's fresh-context critic silently failing to spawn and falling back
 * to a weaker inline critic, with doctor reporting green throughout. This
 * check now fails in exactly that case. When `roleScopedAgents` is `false`
 * (the operator kill-switch), an unmaterialized tree is expected — the check
 * stays advisory. Once the tree HAS been materialized, drift (a source
 * missing from the dest, or a stale dest file) fails the check exactly like
 * `commands-in-sync`, unconditionally, exactly as before this Story.
 *
 * Injectable seams (used by tests so no real filesystem is touched):
 * - `cwd()` replaces `process.cwd` so tests can pin the consumer root.
 * - `readDir` replaces `fs.readdirSync`.
 * - `fsImpl` replaces the `node:fs` surface used for the `.agentrc.json` /
 *   `.agentrc.local.json` reads.
 * - `roleScopedAgents` overrides the resolved flag directly, bypassing the
 *   config reads entirely.
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
      // Kill-switch off: an unmaterialized tree is expected, not a defect.
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

// ---------------------------------------------------------------------------
// check: runtime-deps
// ---------------------------------------------------------------------------

/**
 * Verify that the framework's required runtime dependencies are resolvable
 * from the project's node_modules.
 *
 * `projectRoot` defaults to `process.cwd()` (the consumer project root) so
 * the manifest path and the require-resolution context mirror the context in
 * which the framework scripts actually run (Story #4046 A2). Using
 * `resolveProjectRoot()` (the package root inside `node_modules/mandrel/`)
 * breaks the check under pnpm isolated-mode layouts where the consumer's
 * node_modules are hoisted above `node_modules/mandrel/` and are invisible
 * from the package root's resolver.
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
  // Anchor at process.cwd() (the consumer root), not resolveProjectRoot() (the
  // package root). Under pnpm isolated-mode the consumer's node_modules are not
  // visible from inside node_modules/mandrel/, so the old anchor produced false
  // "missing" reports on a clean install (Story #4046 A2).
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

  if (resolveSeam) {
    for (const dep of required) {
      try {
        resolveSeam(dep);
      } catch {
        missing.push(dep);
      }
    }
  } else {
    // Anchor resolution to the consumer project root so it mirrors the context
    // in which the framework scripts run (they free-ride on the consumer's
    // node_modules). Under pnpm isolated-mode the consumer's node_modules are
    // not reachable from inside node_modules/mandrel/; anchoring at process.cwd()
    // finds them correctly.
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

// ---------------------------------------------------------------------------
// check: agents-materialized
// ---------------------------------------------------------------------------

/**
 * Verify that the `.agents/` payload has been materialized into the consumer
 * project (`./.agents/instructions.md` exists). When it is absent but the
 * `mandrel` package *is* installed in node_modules, the project is in
 * the "postinstall-skipped" state — the package was installed with scripts
 * disabled (e.g. `npm ci --ignore-scripts`, a sandboxed CI, or a package
 * manager that skips lifecycle scripts), so the materializer never ran. The
 * remedy is to run `mandrel sync` (lib/cli/sync.js) by hand.
 *
 * Resolution anchors:
 * - `./.agents/instructions.md` is resolved against `cwd` (the consumer
 *   project root), matching where `mandrel sync` writes the materialized tree.
 * - `mandrel` is resolved from `cwd` so we detect *their* install, not
 *   a copy hoisted next to this CLI module — mirroring sync.js's resolver.
 *
 * Injectable seams (used by tests so no real filesystem or package is needed):
 * - `cwd()` — replaces `process.cwd`.
 * - `existsSync(p)` — replaces `fs.existsSync`.
 * - `resolvePackage(fromDir)` — replaces `mandrel` resolution; throws
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

// ---------------------------------------------------------------------------
// check: agents-drift
// ---------------------------------------------------------------------------

// defaultResolvePackageRoot and listPayloadFiles (re-exported as `listFiles`
// from sync.js) are imported from `lib/cli/sync.js` at the top of this file
// (Story #4048 B3 — no mirror copies).

/**
 * Decide whether a single materialized payload file has drifted from its
 * package-payload source.
 *
 * Size short-circuit (Story #4193): when the injected `fsImpl` exposes
 * `statSync`, a `statSync(src).size !== statSync(dest).size` mismatch is
 * sufficient proof of drift, so it returns `true` on two `stat` syscalls
 * **without reading either file's contents** — the overwhelmingly common
 * drift shape after a stale `sync` is a size change. Equal sizes do not
 * guarantee equal content, so an equal-size pair falls through to the
 * `readFileSync` + `Buffer.equals` byte comparison. The short-circuit is
 * opt-in on `statSync` being present; a seam that omits it (e.g. a legacy
 * test double) transparently uses the byte-read path, preserving the prior
 * behaviour exactly.
 *
 * Security: returns only a boolean — it never surfaces file contents to the
 * caller (security baseline §5 — Data Leakage & Logging).
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
 * Compare the consumer's materialized `./.agents/<f>` bytes against the
 * installed package payload (`node_modules/mandrel/.agents/<f>`),
 * excluding the `.agents/local/` zone. Reports the first drifted (or
 * missing) materialized file so the operator can re-sync or move local edits
 * into `.agents/local/`.
 *
 * Security: logs only paths and counts — file contents are read for a byte
 * comparison but never placed into `detail` or `remedy` (security baseline
 * §5 — Data Leakage & Logging). The comparison is short-circuiting and never
 * accumulates file contents.
 *
 * Performance: per-file drift is decided by `payloadFileDrifted`, which gates
 * the byte read behind a cheap `statSync` size comparison (Story #4193) so a
 * size-changed file — the common drift shape after a stale `sync` — reports
 * without reading either file's contents.
 *
 * Injectable seams (used by tests so no real filesystem or package is needed):
 * - `cwd()` — replaces `process.cwd`.
 * - `fsImpl` — replaces the `node:fs` surface (`existsSync`, `readdirSync`,
 *   `readFileSync`, and optionally `statSync` for the size short-circuit).
 * - `resolvePackageRoot(fromDir)` — replaces `mandrel` resolution;
 *   throws when the package is not installed.
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
    // Without the package installed there is no baseline to compare against;
    // agents-materialized owns the "not installed" remedy, so this check is
    // a no-op success rather than a false drift signal.
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

// ---------------------------------------------------------------------------
// check: pin-current
// ---------------------------------------------------------------------------

/**
 * Fatal doctor check (Story #4525 / #4530): is the version actually
 * resolvable in `node_modules` **consistent with** the consumer's declared
 * `mandrel` dependency range (`package.json`)?
 *
 * This is a **different** signal from `agents-drift` (are the materialized
 * `.agents/` file *contents* byte-identical to the installed payload) and
 * from `version-current` below (is a *newer* version *published*). Neither
 * of those catches the shape of bug #4525 reported: a `package.json` pin
 * that has fallen out of agreement with what `node_modules` actually
 * resolves to — e.g. an out-of-band symlink, or `npm install mandrel@latest
 * --no-save` — which `mandrel doctor` graded as fully green before this
 * check existed, because the only version `defaultCurrentVersion` ever read
 * WAS the inflated `node_modules` one.
 *
 * **Range-aware.** The declared pin is a *range*, not an equality, so the
 * question this check asks is satisfaction, not identity. A consumer who
 * declares `^2.1.0` and runs a routine `npm update` gets 2.4.0 in
 * `node_modules` with `package.json` untouched — that is npm behaving
 * exactly as documented, and under this project's `always-bump-minor`
 * release cadence it is the *normal* steady state, not a defect. Grading it
 * fatal (as this check originally did, comparing only the pin's base
 * version) made `mandrel doctor` cry wolf on healthy installs.
 *
 * The graded contract:
 * - installed **satisfies** the declared range and equals its base version
 *   → pass, quietly.
 * - installed **satisfies** the declared range but is newer than its base
 *   (`^2.1.0` + 2.4.0) → pass with an **advisory** `detail`. Re-pinning via
 *   `mandrel update` is tidier, but nothing is broken. This mirrors how
 *   `version-current` stays non-fatal: `ok: true` with the advisory carried
 *   in `detail` (the registry's `advisory: true` flag documents an entry
 *   whose `run()` *never* fails, which is not true of this check).
 * - installed does **not** satisfy the declared range (`^2.1.0` + 3.0.0, or
 *   an exact `2.1.0` pin + 2.4.0) → **fail**. The declared dependency does
 *   not describe the code that is running.
 * - installed is **behind** the pin's base version (`^2.4.0` + 2.1.0) →
 *   **fail**, and note that `<` the base never satisfies any of the ranges
 *   `resolveConsumerPinSpec` yields, so this is a sub-case of the above
 *   given a distinct, more actionable message.
 *
 * Skips cleanly (not a failure) when there is no resolvable pin at all — no
 * `package.json`, no `mandrel` entry in `dependencies`/`devDependencies`, or
 * a non-semver specifier (`workspace:`, `git+`, `latest`, a comparator
 * range) — via {@link resolveConsumerPinSpec}'s own `null` contract. This
 * is also how mandrel's own repo (no self-dependency) and workspace/npx
 * consumers degrade to a clean pass rather than a false failure.
 *
 * Injectable seams (used by tests so no real filesystem or package is
 * needed):
 * - `cwd()` — replaces `process.cwd`, anchoring both the pin read and the
 *   `node_modules` resolution at the same consumer root (mirrors
 *   `agents-drift` / `agents-in-sync`).
 * - `fsImpl` — replaces the `node:fs` surface.
 * - `resolvePackageRoot(fromDir)` — replaces `mandrel` resolution; throws
 *   when the package is not installed.
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
    // No baseline to compare the pin against; agents-materialized /
    // runtime-deps own the "not installed" remedy.
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
    // In range, just newer than the declared base — the ordinary result of an
    // `npm update` under a caret/tilde pin. Healthy, so `ok: true`; the
    // advisory rides in `detail` (the doctor runner only prints `remedy` for
    // failures).
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

// ---------------------------------------------------------------------------
// check: version-current
// ---------------------------------------------------------------------------

// parseVersion and compareVersions are imported from `lib/cli/version-helpers.js`
// at the top of this file (Story #4048 B3 — no mirror copies). `compareSemver`
// is the registry-local alias for the imported `compareVersions`.

/**
 * Resolve the installed `mandrel` version from this package's own
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
 * Default cache path: `<consumerRoot>/temp/version-check.json`, anchored at
 * `process.cwd()` (the consumer project root) so the cache file survives
 * npm/pnpm reinstalls that may replace `node_modules/` entirely (Story #4046
 * A2). Mirrors `commands-in-sync` / `agents-materialized` / `agents-drift`
 * which all anchor at `process.cwd()`.
 *
 * @returns {string}
 */
function defaultVersionCachePath() {
  return path.join(process.cwd(), 'temp', DEFAULT_VERSION_CACHE_FILENAME);
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
    name: 'pin-current',
    // Fatal, unlike version-current below (Story #4525/#4530): a pin/install
    // disagreement means the declared dependency does not describe the code
    // that is running.
    run: (opts) => runPinCurrent(opts),
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

// tests/e2e/helpers/cli-harness.js
/**
 * Real-binary e2e harness for the `mandrel` CLI (Story #4123).
 *
 * Spawns the **real** entry point — `node <repoRoot>/bin/mandrel.js <args>` —
 * against a fresh `mkdtemp` temp consumer directory, with no shell, no network,
 * and no in-memory fakes. This is the e2e counterpart to the unit-tier seam
 * tests in `lib/cli/__tests__/sync.test.js`: instead of injecting fakes into
 * `runSync`, it exercises the binary's own argv parsing, dispatch, package
 * resolution, and disk I/O exactly as a consumer would.
 *
 * Why a symlinked package, not a real `npm install`:
 *   The CLI resolves its `.agents/` payload from the installed `mandrel`
 *   package (`defaultResolvePackageRoot` → `require.resolve('mandrel/package.json')`
 *   from the consumer dir). A full `npm install mandrel` into every temp dir
 *   would be slow and would need network/registry access, breaking determinism.
 *   Instead each temp consumer gets a `node_modules/mandrel` **directory
 *   symlink** pointing at this repo root — which *is* the `mandrel` package
 *   (it ships `.agents/`, `bin/`, `lib/`, and `package.json`). Resolution then
 *   yields the real, in-tree payload with zero network and ~150ms per run.
 *
 * macOS note: `os.tmpdir()` is itself a symlink (`/var` → `/private/var`), so
 * every temp path is `realpathSync`'d. Without this the child's `process.cwd()`
 * (which the CLI uses as the consumer project root) and the harness's own path
 * assertions can disagree about the `/var` vs `/private/var` prefix.
 *
 * The harness owns temp-dir lifecycle: `makeTempConsumer()` registers each dir
 * for cleanup, and `cleanupAll()` (call from `afterEach`/`finally`) removes
 * every dir it created. Individual dirs can also be cleaned via the returned
 * `cleanup()` handle.
 *
 * ## PTY runner ({@link runMandrelPTY})
 *
 * `runMandrel` (above) spawns the binary over plain pipes, which leaves
 * `process.stdin.isTTY` / `process.stdout.isTTY` **false** in the child — so any
 * code path gated on `isTTY` (the `mandrel init` interactive prompt) is skipped.
 * To exercise the real interactive prompt, {@link runMandrelPTY} spawns the same
 * binary under a **pseudo-terminal** (via `node-pty`), which makes both `isTTY`
 * flags true exactly as a real terminal would. It is used by the `#4106`
 * regression guard in `tests/e2e/init-interactive.integration.test.js`.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Absolute path to this repo's root, resolved from the harness file location
 * (`tests/e2e/helpers/` → three levels up) and `realpathSync`'d so it never
 * disagrees with a `realpathSync`'d temp dir on symlink-prefixed platforms.
 * This is also the `mandrel` package root the temp consumers symlink to.
 *
 * @type {string}
 */
export const REPO_ROOT = fs.realpathSync(
  path.resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..'),
);

/**
 * Absolute path to the real CLI entry point spawned by {@link runMandrel}.
 *
 * @type {string}
 */
export const BIN_PATH = path.join(REPO_ROOT, 'bin', 'mandrel.js');

/** Package name the consumer symlink advertises (matches `package.json`). */
const PACKAGE_NAME = 'mandrel';

/**
 * Temp dirs created by this harness, in creation order. {@link cleanupAll}
 * removes every entry and clears the list.
 *
 * @type {string[]}
 */
const createdDirs = [];

/**
 * Build a webhook-safe environment for the spawned child.
 *
 * Mirrors the scrub that `run-tests.js` applies to the whole suite: unset
 * `NOTIFICATION_WEBHOOK_URL` and pin `NODE_ENV=test` so that even if a future
 * code path transitively reaches `notify()`, it never POSTs to a live
 * endpoint. `mandrel sync` does no network I/O today, but the guard keeps the
 * harness safe for any subcommand a future e2e test drives through it.
 *
 * @param {NodeJS.ProcessEnv} [base]
 * @returns {NodeJS.ProcessEnv}
 */
function webhookSafeEnv(base = process.env) {
  const env = { ...base, NODE_ENV: 'test' };
  delete env.NOTIFICATION_WEBHOOK_URL;
  return env;
}

/**
 * Create a fresh temp consumer project rooted at an `mkdtemp` directory, wired
 * so the real `mandrel` binary can resolve its payload.
 *
 * The directory gets a `node_modules/mandrel` directory symlink pointing at
 * {@link REPO_ROOT}, which makes `require.resolve('mandrel/package.json')` from
 * inside the consumer succeed and return the in-tree `.agents/` payload. The
 * dir is registered for {@link cleanupAll}; the returned `cleanup()` removes
 * just this one.
 *
 * @param {object} [opts]
 * @param {string} [opts.prefix='mandrel-e2e-'] - mkdtemp basename prefix.
 * @returns {{ dir: string, agentsDir: string, cleanup: () => void }}
 *   `dir` — the consumer project root (realpath'd).
 *   `agentsDir` — `<dir>/.agents`, the materialization target.
 *   `cleanup` — idempotent recursive remove of `dir`.
 */
export function makeTempConsumer({ prefix = 'mandrel-e2e-' } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  createdDirs.push(dir);

  // Wire a node_modules/mandrel directory symlink → repo root so the real
  // binary's package resolution finds this package without an npm install.
  const nodeModules = path.join(dir, 'node_modules');
  fs.mkdirSync(nodeModules, { recursive: true });
  // 'dir' (=> a Windows junction on win32) keeps creation working without the
  // Developer-Mode / admin requirement of a true symlink on Windows.
  fs.symlinkSync(REPO_ROOT, path.join(nodeModules, PACKAGE_NAME), 'dir');

  return {
    dir,
    agentsDir: path.join(dir, '.agents'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Spawn the real `mandrel` binary against a consumer directory.
 *
 * Runs `node <repoRoot>/bin/mandrel.js <...args>` with `cwd` set to the
 * consumer dir (the CLI treats `process.cwd()` as the project root). No shell
 * is used — args are passed as an argv array, so there is no quoting or
 * injection surface. The child inherits a {@link webhookSafeEnv}.
 *
 * @param {string} consumerDir - cwd for the child (a {@link makeTempConsumer} dir).
 * @param {string[]} [args=[]] - Subcommand and flags, e.g. `['sync', '--dry-run']`.
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env] - Base env (default `process.env`, scrubbed).
 * @returns {{ status: number | null, stdout: string, stderr: string }}
 */
export function runMandrel(consumerDir, args = [], { env } = {}) {
  const result = spawnSync(process.execPath, [BIN_PATH, ...args], {
    cwd: consumerDir,
    encoding: 'utf8',
    env: webhookSafeEnv(env),
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Make the `node-pty` `spawn-helper` prebuild executable on POSIX hosts.
 *
 * node-pty ships per-platform prebuilds under `prebuilds/<platform>-<arch>/`.
 * On macOS/Linux it execs a `spawn-helper` companion binary to set the child's
 * controlling TTY — but npm/yarn extraction frequently **strips the exec bit**
 * off that file (it lands `0644`), and node-pty then dies at `pty.spawn` with
 * `Error: posix_spawnp failed.` rather than a readable diagnostic. This makes
 * the bit deterministic before any PTY spawn, so the regression guard is stable
 * across fresh `npm ci` checkouts and CI. It is a no-op on win32 (the conpty
 * backend has no `spawn-helper`) and idempotent (a second chmod is harmless).
 *
 * @returns {void}
 */
export function ensurePtySpawnHelperExecutable() {
  if (process.platform === 'win32') return;
  const helper = path.join(
    REPO_ROOT,
    'node_modules',
    'node-pty',
    'prebuilds',
    `${process.platform}-${process.arch}`,
    'spawn-helper',
  );
  if (!fs.existsSync(helper)) return;
  // 0o755 = rwxr-xr-x — owner-exec is what posix_spawnp needs; group/other
  // read+exec mirror node-pty's own packaged mode.
  fs.chmodSync(helper, 0o755);
}

/**
 * Spawn the real `mandrel` binary **under a pseudo-terminal** and drive it
 * interactively.
 *
 * Unlike {@link runMandrel} (plain pipes → `isTTY === false` in the child),
 * this routes the child's stdio through a `node-pty` PTY so both
 * `process.stdin.isTTY` and `process.stdout.isTTY` are **true** — the only way
 * to reach `mandrel init`'s interactive `[Y/n]` prompt and its `node:readline`
 * confirm path. `node-pty` is imported lazily so the rest of the harness (and
 * the non-PTY e2e suites) never pay the native-module load, and a missing
 * install surfaces a clear import error only on this path.
 *
 * The promise NEVER hangs: a `timeoutMs` watchdog kills the PTY and resolves
 * with `timedOut: true`, so a regression that reintroduces the `#4106`
 * EOF-blocking read manifests as a fast, explicit failure instead of a hung
 * suite. The PTY is always torn down (`onExit` or watchdog), so no child or fd
 * leaks past the call.
 *
 * @param {string} consumerDir - cwd for the child (a {@link makeTempConsumer} dir).
 * @param {string[]} [args=[]] - Subcommand and flags, e.g. `['init']`.
 * @param {object} [opts]
 * @param {string} [opts.input] - Keystrokes to send once the child has settled
 *   (e.g. `'n\r'` — the `\r` is the Enter key). Sent after `inputDelayMs`.
 * @param {number} [opts.inputDelayMs=400] - Delay before sending `input`, giving
 *   the child time to render the prompt first (so the capture proves the prompt
 *   text both appeared and survived).
 * @param {number} [opts.timeoutMs=15000] - Hard cap; on breach the PTY is killed
 *   and the result carries `timedOut: true`.
 * @param {NodeJS.ProcessEnv} [opts.env] - Base env (default `process.env`, scrubbed).
 * @returns {Promise<{ exitCode: number | null, signal: number | null, output: string, timedOut: boolean }>}
 *   `output` is the full raw PTY byte stream decoded as UTF-8 (includes any
 *   terminal escape sequences the child emitted).
 */
export async function runMandrelPTY(
  consumerDir,
  args = [],
  { input, inputDelayMs = 400, timeoutMs = 15000, env } = {},
) {
  ensurePtySpawnHelperExecutable();
  // Lazy native import — only the PTY path loads node-pty.
  const pty = await import('node-pty');

  return await new Promise((resolve) => {
    const child = pty.spawn(process.execPath, [BIN_PATH, ...args], {
      name: 'xterm-color',
      cols: 80,
      rows: 30,
      cwd: consumerDir,
      env: webhookSafeEnv(env),
    });

    let output = '';
    let settled = false;
    /** @type {NodeJS.Timeout | undefined} */
    let inputTimer;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(inputTimer);
      clearTimeout(watchdog);
      resolve(result);
    };

    const watchdog = setTimeout(() => {
      // EOF-blocking-read regression (or any genuine hang): kill and report.
      try {
        child.kill();
      } catch {
        // Child may already be gone; the onExit handler will have resolved.
      }
      finish({ exitCode: null, signal: null, output, timedOut: true });
    }, timeoutMs);

    child.onData((data) => {
      output += data;
    });

    child.onExit(({ exitCode, signal }) => {
      finish({ exitCode, signal: signal ?? null, output, timedOut: false });
    });

    if (typeof input === 'string') {
      inputTimer = setTimeout(() => {
        try {
          child.write(input);
        } catch {
          // Child exited before the write landed — onExit/watchdog resolves.
        }
      }, inputDelayMs);
    }
  });
}

/**
 * Remove every temp dir created by {@link makeTempConsumer} this run and clear
 * the registry. Safe to call when nothing was created. Call from `afterEach`
 * (or a `finally`) so no temp tree leaks even if an assertion throws.
 */
export function cleanupAll() {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

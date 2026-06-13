// lib/cli/init.js
/**
 * `mandrel init` subcommand — one-command cold start (Story #3975).
 *
 * Folds the former `create-mandrel` launcher logic into a subcommand of the
 * single published `mandrel` package. `npx mandrel init` (≡ `npm exec --
 * mandrel init`, or `mandrel init` once installed) takes a project from a
 * blank folder to a configured Mandrel environment in one command:
 *
 *   1. **Install-if-absent.** When `./.agents/` is missing in the cwd, install
 *      the framework deterministically — `npm install mandrel --ignore-scripts`
 *      followed by an explicit sync run against the freshly installed bin
 *      (`node ./node_modules/mandrel/bin/mandrel.js sync`, NOT a bare `mandrel`
 *      on `PATH` — see `SYNC_BIN` below). The `--ignore-scripts` install
 *      skips the package's best-effort `postinstall` sync so the explicit
 *      `sync` is the single, deterministic materialization (review rec D.3 —
 *      no postinstall-then-init double-sync, and no arbitrary install
 *      lifecycle scripts during cold start). When `./.agents/` already exists
 *      (the operator ran `npm install mandrel` first), step 1 is skipped and
 *      `init` goes straight to the prompt — the one subcommand is idempotent
 *      across both the cold-start and post-install entry points.
 *
 *   2. **Yes/no prompt.** Ask whether to begin the interactive setup now
 *      (yes → run `node .agents/scripts/bootstrap.js`, forwarding every
 *      passthrough flag unchanged) or stop at "just the files" (no → print a
 *      re-run hint and exit 0). Yes is the default, so a bare Enter configures
 *      (mirrors the `[Y/n]` convention in bootstrap.js). `--assume-yes` skips
 *      the prompt and configures (the flag is also forwarded to bootstrap for
 *      its own non-interactive run). A non-TTY stdin without `--assume-yes`
 *      defaults to no (files-only) so the side-effecting GitHub provisioning
 *      never runs unattended.
 *
 * ## Cold-start provenance
 *
 * The installed package name is the **hardcoded build-time constant**
 * `PACKAGE_NAME` below — it is NEVER read from argv or the environment. A
 * cold start fetches `mandrel` from npx's temp cache and runs this bin; the
 * package it then installs into the project must be the same `mandrel`, not an
 * attacker-influenced name supplied on the command line. The forwarded
 * passthrough flags reach `bootstrap.js` (the sole bootstrap orchestrator),
 * which owns its own summary + confirm loop and validates its own inputs.
 *
 * ## Injectable seams (used by tests/cli/init.test.js)
 *
 * The plan/decision logic is a pure function (`planInit`) over injected
 * boundaries so the suite is hermetic — no real TTY, npm, or network:
 *
 *   - `argv`     — subcommand args (after `mandrel init`)
 *   - `exists`   — `(path) => boolean`; defaults to an `fs.existsSync` probe
 *                  for `./.agents/` in the cwd
 *   - `runStep`  — `(cmd, args) => { status }`; runs one install/sync/bootstrap
 *                  step. Defaults to a `spawnSync` runner with `stdio: inherit`.
 *   - `confirm`  — `() => boolean | Promise<boolean>`; reads the operator's
 *                  yes/no answer (true = configure now). Defaults to a
 *                  `node:readline` stdin prompt (awaited) with yes as the
 *                  default.
 *   - `stdout`   — `(s) => void`; defaults to `process.stdout.write`.
 *   - `isTTY`    — boolean; defaults to `process.stdin.isTTY`.
 *   - `exit`     — `(code) => void`; defaults to `process.exit`.
 *
 * Security (security-baseline § 5/6): logs only flag/step descriptions and
 * never reads or echoes tokens, credentials, or env values. The package name
 * is a hardcoded constant rather than interpolated input, and the step runner
 * passes argv as an array (no shell-string concatenation of user input).
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { pathToFileURL } from 'node:url';

// Lazily resolved at runtime so cold-start `npx mandrel init` (where
// `.agents/` is absent) does not try to import from a directory that does not
// exist yet. The import is performed after bootstrap succeeds and `.agents/`
// is guaranteed to be materialised.
let _runInitTail = null;
async function getRunInitTail(projectRoot) {
  if (_runInitTail) return _runInitTail;
  const tailPath = path.join(
    projectRoot,
    '.agents',
    'scripts',
    'lib',
    'onboard',
    'init-tail.js',
  );
  // pathToFileURL handles Windows drive letters correctly (a raw
  // `file://C:\…` template treats the drive letter as a URL host — same
  // fix as commit 2e3d210b in lib/transpile.js).
  const mod = await import(pathToFileURL(tailPath).href);
  _runInitTail = mod.runInitTail;
  return _runInitTail;
}

/**
 * Hardcoded build-time package name. NEVER read from argv or env — cold-start
 * provenance requires the install target to be the same package this bin
 * shipped from. See the module header.
 */
const PACKAGE_NAME = 'mandrel';

// The `mandrel sync` and `node .agents/scripts/bootstrap.js` invocations both
// resolve relative to the consumer's cwd at run time (the materialized
// `.agents/` lives there), so they are expressed as cwd-relative steps rather
// than against PROJECT_ROOT (which, under npx, is npx's throwaway cache).
const BOOTSTRAP_SCRIPT = path.join('.agents', 'scripts', 'bootstrap.js');

// The `sync` step is dispatched against the **locally installed** Mandrel bin
// rather than a bare `mandrel` on `PATH`. A bare `spawnSync('mandrel', …)` only
// resolves while npx keeps its throwaway `.bin` on `PATH`; reached any other
// way (a documented `npm install mandrel` then `mandrel init`, or a plain
// `node bin/mandrel.js init`), the freshly installed binary lives at
// `./node_modules/mandrel/bin/mandrel.js` — off `PATH` — and a bare spawn dies
// with ENOENT, leaving `.agents/` un-materialized. Spawning `process.execPath`
// against the package entrypoint resolves identically under npx, under a
// post-install invocation, and in tests — and, by going through `node`, also
// sidesteps the win32 `.cmd`-shim concern entirely (no `shell: true` needed for
// this step). The path is cwd-relative because the package is installed into
// the consumer's cwd (the same reason BOOTSTRAP_SCRIPT is cwd-relative).
const SYNC_BIN = path.join('node_modules', PACKAGE_NAME, 'bin', 'mandrel.js');

const PROMPT_TEXT =
  'The Mandrel .agents package has been copied to your directory.\n' +
  'Would you like to begin the interactive process to setup your local and ' +
  'github environments now? [Y/n]: ';

const FILES_ONLY_HINT = 'Configure any time with: npx mandrel init\n';

// On win32, `npm` resolves to a `.cmd` shim that Node refuses to spawn without
// a shell after the CVE-2024-27980 hardening; mirror update.js and set
// `shell: true` only there. Off win32, never shell out — array argv stays
// injection-proof. (The `sync` step no longer hits a `.cmd` shim at all: it is
// dispatched as `process.execPath` + `SYNC_BIN`, a plain `node` spawn — but the
// `npm install` step still needs the shim handling, so `NEEDS_SHELL` stays.)
const NEEDS_SHELL = process.platform === 'win32';

/**
 * Strip the `--assume-yes` flag from a passthrough argv, returning the
 * remaining flags. `--assume-yes` is consumed by `init` to skip the prompt but
 * is ALSO forwarded to bootstrap (see `buildBootstrapArgs`), so this helper
 * exists only to detect its presence, not to drop it from the forward set.
 *
 * @param {string[]} argv
 * @returns {boolean} whether `--assume-yes` is present
 */
function hasAssumeYes(argv) {
  return argv.includes('--assume-yes');
}

/**
 * Build the forwarded argv for the bootstrap step. Every passthrough flag is
 * forwarded unchanged; `--assume-yes` is appended when chosen but absent so
 * bootstrap runs non-interactively without the operator having typed it.
 *
 * @param {string[]} argv
 * @param {boolean} assumeYes
 * @returns {string[]}
 */
function buildBootstrapArgs(argv, assumeYes) {
  if (assumeYes && !argv.includes('--assume-yes')) {
    return [...argv, '--assume-yes'];
  }
  return [...argv];
}

/**
 * Decide and execute the cold-start plan over injected boundaries.
 *
 * This is the testable core: it consults `exists` to decide whether to run the
 * install + sync steps, resolves the prompt outcome from `isTTY` / `--assume-yes`
 * / `confirm`, and either runs the bootstrap step or prints the files-only hint.
 * Every effectful boundary is injected so the suite never touches a real TTY,
 * npm, or the network.
 *
 * @param {{
 *   argv?: string[],
 *   exists?: (relPath: string) => boolean,
 *   runStep?: (cmd: string, args: string[]) => { status: number | null },
 *   confirm?: () => boolean | Promise<boolean>,
 *   stdout?: (s: string) => void,
 *   isTTY?: boolean,
 *   afterBootstrap?: (root: string) => Promise<{ ok?: boolean } | void> | { ok?: boolean } | void,
 * }} [opts]
 * @returns {Promise<{
 *   installed: boolean,
 *   ranBootstrap: boolean,
 *   steps: Array<{ cmd: string, args: string[] }>,
 *   exitCode: number,
 * }>}
 */
export async function planInit({
  argv = [],
  exists,
  runStep,
  confirm,
  stdout = (s) => process.stdout.write(s),
  isTTY,
  afterBootstrap,
} = {}) {
  const steps = [];

  /**
   * Run one step through the injected runner and record it. A non-zero status
   * short-circuits the plan with that exit code (the runner inherits stdio, so
   * the failing tool's own output already reached the terminal).
   *
   * @param {string} cmd
   * @param {string[]} args
   * @returns {number} the step's exit code (0 on success)
   */
  const step = (cmd, args) => {
    steps.push({ cmd, args });
    const result = runStep(cmd, args);
    return result?.status ?? 1;
  };

  // --- Step 1: install-if-absent ------------------------------------------
  // When `./.agents/` is missing, materialize the framework deterministically:
  // `npm install <pkg> --ignore-scripts` then explicit `mandrel sync`. When it
  // is present, skip straight to the prompt (idempotent post-install path).
  const agentsPresent = exists('.agents');
  if (!agentsPresent) {
    const installStatus = step('npm', [
      'install',
      PACKAGE_NAME,
      '--ignore-scripts',
    ]);
    if (installStatus !== 0) {
      return {
        installed: false,
        ranBootstrap: false,
        steps,
        exitCode: installStatus,
      };
    }

    const syncStatus = step(process.execPath, [SYNC_BIN, 'sync']);
    if (syncStatus !== 0) {
      return {
        installed: true,
        ranBootstrap: false,
        steps,
        exitCode: syncStatus,
      };
    }
  }

  const installed = !agentsPresent;

  // --- Step 2: configure-or-files prompt ----------------------------------
  const assumeYes = hasAssumeYes(argv);

  // Decide the outcome: configure (run bootstrap) vs. files-only.
  // - `--assume-yes` → configure, prompt skipped entirely.
  // - non-TTY without `--assume-yes` → files-only (never provision unattended).
  // - TTY → consult the confirm seam for the yes/no answer (yes = configure).
  let proceed;
  if (assumeYes) {
    proceed = true;
  } else if (!isTTY) {
    proceed = false;
  } else {
    stdout(PROMPT_TEXT);
    proceed = await confirm();
  }

  if (proceed) {
    const bootstrapArgs = buildBootstrapArgs(argv, assumeYes);
    const bootstrapStatus = step(process.execPath, [
      BOOTSTRAP_SCRIPT,
      ...bootstrapArgs,
    ]);
    if (bootstrapStatus !== 0) {
      return {
        installed,
        ranBootstrap: true,
        steps,
        exitCode: bootstrapStatus,
      };
    }

    // Bootstrap succeeded — run the onboarding tail: stack detection, docs
    // scaffolding offer, doctor gate, and /plan handoff. A tail that reports
    // `ok: false` (the doctor gate failed) makes the whole init exit
    // non-zero; the tail already printed its own remediation message, and the
    // earlier install/sync/bootstrap phases' results stand as completed.
    if (afterBootstrap) {
      const tail = await afterBootstrap(process.cwd());
      if (tail && tail.ok === false) {
        return {
          installed,
          ranBootstrap: true,
          steps,
          exitCode: 1,
        };
      }
    }

    return {
      installed,
      ranBootstrap: true,
      steps,
      exitCode: 0,
    };
  }

  // Declined (files-only): print the re-run hint and exit cleanly.
  stdout(FILES_ONLY_HINT);
  return { installed, ranBootstrap: false, steps, exitCode: 0 };
}

/**
 * Default `exists` seam — probe for `./.agents/` in the consumer's cwd.
 *
 * @param {string} relPath
 * @returns {boolean}
 */
function defaultExists(relPath) {
  return fs.existsSync(path.resolve(process.cwd(), relPath));
}

/**
 * Default step runner — spawn the tool synchronously, inheriting stdio so its
 * output streams to the terminal. Sets `shell: true` only on win32 so the
 * `npm.cmd` shim resolves under CVE-2024-27980 hardening. The `sync` and
 * bootstrap steps spawn `process.execPath` (a plain `node`), which needs no
 * shell on any platform.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @returns {{ status: number | null }}
 */
function defaultRunStep(cmd, args) {
  return spawnSync(cmd, args, {
    stdio: 'inherit',
    env: process.env,
    shell: NEEDS_SHELL,
  });
}

/**
 * Default `confirm` seam — yes/no prompt read via `node:readline` (mirrors the
 * prompt mechanism in `bootstrap.js`). Returns on Enter and never blocks
 * waiting for EOF the way `fs.readFileSync(0)` did — that EOF-blocking read hung
 * `mandrel init` on an interactive TTY. Any input other than an explicit "no"
 * (`n`/`no`, case-insensitive) — including bare Enter — resolves to `true`
 * (configure), matching the `[Y/n]` convention where yes is the default. The
 * prompt text is written by `planInit` via `stdout`, so the question string
 * passed here is empty.
 *
 * `terminal: false` is **load-bearing**, not cosmetic: with terminal mode on
 * (the default when stdout is a TTY) readline emits cursor-control escapes
 * (`\x1b[1G\x1b[0J` — column-1 + erase-to-end-of-screen) when it takes over the
 * line, which **erases the `[Y/n]:` prompt already written via `stdout`** — the
 * operator then sees only the first prompt line and a dead-looking cursor.
 * Disabling terminal mode leaves the pre-written prompt intact and reads the
 * line via the TTY's own cooked-mode echo. `createInterface` is injectable so a
 * test can assert this option is set (regression guard).
 *
 * @param {{ createInterface?: typeof readline.createInterface }} [opts]
 * @returns {Promise<boolean>}
 */
export async function defaultConfirm({
  createInterface = readline.createInterface,
} = {}) {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });
  try {
    const answer = (await rl.question('')).trim().toLowerCase();
    return answer !== 'n' && answer !== 'no';
  } catch {
    // No readable line (e.g. stdin closed) → default to yes (configure).
    return true;
  } finally {
    rl.close();
  }
}

/**
 * Default export consumed by `bin/mandrel.js`.
 *
 * @param {string[]} [argv] - Subcommand arguments (after `mandrel init`).
 * @returns {Promise<void>}
 */
export default async function run(argv = []) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(
      'Usage: mandrel init [bootstrap flags]\n\n' +
        '  One-command cold start: install Mandrel (if absent), then prompt to\n' +
        '  configure now or stop at the files.\n\n' +
        '  --assume-yes   Skip the prompt and configure non-interactively\n' +
        '                 (forwarded to bootstrap.js). All other flags are\n' +
        '                 forwarded to bootstrap.js unchanged.\n',
    );
    return;
  }

  const result = await planInit({
    argv,
    exists: defaultExists,
    runStep: defaultRunStep,
    confirm: defaultConfirm,
    isTTY: Boolean(process.stdin.isTTY),
    afterBootstrap: async (projectRoot) => {
      const runInitTail = await getRunInitTail(projectRoot);
      return runInitTail({
        root: projectRoot,
        isTTY: Boolean(process.stdin.isTTY),
      });
    },
  });

  if (result.exitCode !== 0) {
    process.exit(result.exitCode);
  }
}

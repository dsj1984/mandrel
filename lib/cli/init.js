// lib/cli/init.js
/**
 * `mandrel init`: cold start. When `./.agents/` is absent, run
 * `npm install mandrel --ignore-scripts` then an explicit sync through the
 * installed bin (one deterministic materialization, no lifecycle scripts);
 * then ask whether to run `bootstrap.js` now (default yes). `--assume-yes`
 * skips the prompt; a non-TTY without it stays files-only so GitHub
 * provisioning never runs unattended.
 *
 * The installed package is the hardcoded `PACKAGE_NAME`, never argv or env,
 * so a cold start cannot be steered to another package.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { pathToFileURL } from 'node:url';

// Lazy: `.agents/` does not exist until the cold start has materialized it.
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
  // A raw `file://C:\…` template would read the drive letter as a URL host.
  const mod = await import(pathToFileURL(tailPath).href);
  _runInitTail = mod.runInitTail;
  return _runInitTail;
}

/** Never read from argv or env (see the module header). */
const PACKAGE_NAME = 'mandrel';

// Cwd-relative: under npx the package root is npx's throwaway cache.
const BOOTSTRAP_SCRIPT = path.join('.agents', 'scripts', 'bootstrap.js');

// Spawned as `node <installed bin>`, not a bare `mandrel`: the bare name only
// resolves while npx's `.bin` is on PATH (ENOENT after a plain `npm install`),
// and going through node avoids the win32 `.cmd` shim.
const SYNC_BIN = path.join('node_modules', PACKAGE_NAME, 'bin', 'mandrel.js');

const PROMPT_TEXT =
  '\n' +
  'Welcome to Mandrel!\n\n' +
  'Check .agents/README.md for more quick start instructions, flag options, and documentation.\n\n' +
  'Begin interactive setup? [Y/n]: ';

const FILES_ONLY_HINT = 'Setup any time with: npx mandrel init\n';

// `String.raw` keeps the art's backslashes literal; avoid backticks and `${`.
const BANNER = String.raw`

   ______  ___             _________           ______
   ___   |/  /_____ _____________  /______________  /
   __  /|_/ /_  __ '/_  __ \  __  /__  ___/  _ \_  /
   _  /  / / / /_/ /_  / / / /_/ / _  /   /  __/  /
   /_/  /_/  \__,_/ /_/ /_/\__,_/  /_/    \___//_/
____________________________________________________

`;

// Win32 `npm` is a `.cmd` shim Node will not spawn without a shell
// (CVE-2024-27980); shell nowhere else, so array argv stays injection-proof.
const NEEDS_SHELL = process.platform === 'win32';

/**
 * @param {string[]} argv
 * @returns {boolean} whether `--assume-yes` is present
 */
function hasAssumeYes(argv) {
  return argv.includes('--assume-yes');
}

/**
 * All flags forwarded unchanged, plus `--assume-yes` when chosen but absent.
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
 * The cold-start plan over injected boundaries.
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
   * @param {string} cmd
   * @param {string[]} args
   * @returns {number} the step's exit code (0 on success)
   */
  const step = (cmd, args) => {
    steps.push({ cmd, args });
    const result = runStep(cmd, args);
    return result?.status ?? 1;
  };

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

  const assumeYes = hasAssumeYes(argv);

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

    // A tail reporting `ok: false` (doctor gate failed) fails init; it has
    // already printed its own remediation.
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

  stdout(FILES_ONLY_HINT);
  return { installed, ranBootstrap: false, steps, exitCode: 0 };
}

/**
 * @param {string} relPath
 * @returns {boolean}
 */
function defaultExists(relPath) {
  return fs.existsSync(path.resolve(process.cwd(), relPath));
}

/**
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
 * Anything but `n`/`no` (including bare Enter) means yes. Reads a line rather
 * than waiting for EOF, which would hang on a TTY. `terminal: false` is
 * load-bearing: terminal mode emits erase-line escapes that wipe the
 * `[Y/n]:` prompt `planInit` already wrote.
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
    return true;
  } finally {
    rl.close();
  }
}

/**
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

  process.stdout.write(BANNER);

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

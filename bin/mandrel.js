#!/usr/bin/env node
// bin/mandrel.js — mandrel CLI entry point

/**
 * Allowlist-based subcommand dispatcher.
 *
 * Only modules listed in SUBCOMMANDS are dispatchable. Each entry declares the
 * name, a one-line description for help output, and the set of known flags so
 * the dispatcher can reject unknown flags before loading the subcommand.
 *
 * Supported top-level flags:
 *   --help / -h    Print subcommand list and exit 0.
 *   --version      Print installed version and exit 0.
 *
 * Each subcommand module must export a default function `run(argv)`.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Subcommand registry — the ONLY allowed dispatch targets
// ---------------------------------------------------------------------------

/**
 * @typedef {{ description: string, knownFlags: Set<string> }} SubcommandMeta
 * @type {Map<string, SubcommandMeta>}
 */
const SUBCOMMANDS = new Map([
  [
    'init',
    {
      description: 'install and configure mandrel in the current project',
      knownFlags: new Set([
        '--assume-yes',
        '--skip-github',
        '--owner',
        '--repo',
        '--base-branch',
        '--project-number',
        '--operator-handle',
        '--dry-run',
      ]),
    },
  ],
  [
    'sync',
    {
      description: 'materialize .agents/ payload from installed package',
      knownFlags: new Set(['--dry-run']),
    },
  ],
  [
    'sync-commands',
    {
      description: 'regenerate .claude/commands/ from .agents/workflows/',
      // No --dry-run: the projection scripts have no preview mode, and
      // accepting the flag while syncing for real overwrote .claude/ on an
      // operator who asked for a preview. Reject it at the dispatcher.
      knownFlags: new Set([]),
    },
  ],
  [
    'sync-agents',
    {
      description: 'regenerate .claude/agents/ from .agents/agents/',
      // Same contract as sync-commands: no preview mode, so no --dry-run.
      knownFlags: new Set([]),
    },
  ],
  [
    'doctor',
    {
      description: 'run readiness checks and report remedies',
      knownFlags: new Set([]),
    },
  ],
  [
    'update',
    {
      description: 'upgrade mandrel to the newest published version',
      knownFlags: new Set(['--dry-run', '--install-cmd']),
    },
  ],
  [
    'migrate',
    {
      description: 'apply version-keyed migrations for a version range',
      knownFlags: new Set(['--from', '--to', '--dry-run']),
    },
  ],
  [
    'explain',
    {
      description: 'print resolved config values and their sources',
      knownFlags: new Set(['--json']),
    },
  ],
  [
    'uninstall',
    {
      description: 'reverse a recorded install using the install ledger',
      knownFlags: new Set(['--include-github', '--dry-run']),
    },
  ],
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read the installed mandrel version from the root package.json.
 *
 * @returns {string}
 */
function installedVersion() {
  const req = createRequire(import.meta.url);
  const manifest = req('../package.json');
  return String(manifest.version);
}

/**
 * Print the help screen listing all subcommands with descriptions.
 *
 * @param {(s: string) => void} [write]
 */
function printHelp(write = (s) => process.stdout.write(s)) {
  const lines = ['Usage: mandrel <subcommand> [args]\n', '\nSubcommands:\n'];
  for (const [name, meta] of SUBCOMMANDS) {
    const pad = ' '.repeat(Math.max(1, 16 - name.length));
    lines.push(`  ${name}${pad}${meta.description}\n`);
  }
  lines.push(
    '\nFlags:\n',
    '  --help, -h    Print this help message\n',
    '  --version     Print the installed version\n',
    '\nRun `mandrel <subcommand> --help` for subcommand-specific flags.\n',
  );
  write(lines.join(''));
}

/**
 * Suggest the closest known subcommand name for a typo (Levenshtein-1).
 *
 * @param {string} input
 * @returns {string | undefined}
 */
function suggest(input) {
  for (const name of SUBCOMMANDS.keys()) {
    if (levenshtein(input, name) <= 2) return name;
  }
  return undefined;
}

/**
 * Compute Levenshtein edit distance between two strings (capped at 3 for
 * performance — we only care about small distances).
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function levenshtein(a, b) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 3) return 4;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const curr = [i + 1];
    for (let j = 0; j < b.length; j++) {
      curr[j + 1] = Math.min(
        curr[j] + 1,
        prev[j + 1] + 1,
        prev[j] + (a[i] === b[j] ? 0 : 1),
      );
    }
    prev.splice(0, prev.length, ...curr);
  }
  return prev[b.length];
}

/**
 * Universal flags that all subcommands accept and that bypass per-subcommand
 * flag validation. Subcommands may handle these themselves internally.
 */
const UNIVERSAL_FLAGS = new Set(['--help', '-h']);

/**
 * Validate the argv array against the known flags for a subcommand.
 * Returns null when all flags are known; an error message string when an
 * unknown flag is detected. Values following `=` or the next positional are
 * allowed — only the flag name prefix is checked.
 *
 * Universal flags (--help, -h) are always allowed and bypass this check.
 *
 * @param {string} subName
 * @param {Set<string>} knownFlags
 * @param {string[]} argv
 * @returns {string | null}
 */
function findUnknownFlag(subName, knownFlags, argv) {
  for (const arg of argv) {
    if (!arg.startsWith('-')) continue;
    // Strip value portion for `--flag=value` form.
    const flagName = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    if (UNIVERSAL_FLAGS.has(flagName)) continue;
    if (!knownFlags.has(flagName)) {
      const names = [...knownFlags].sort().join(', ');
      const hint = names.length > 0 ? `  Known flags: ${names}\n` : '';
      return (
        `mandrel: unknown flag '${flagName}' for subcommand '${subName}'\n` +
        hint
      );
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const sub = args[0];

// --- Top-level flags (no subcommand) ---
if (!sub || sub === '--help' || sub === '-h') {
  printHelp();
  process.exit(0);
}

if (sub === '--version') {
  process.stdout.write(`${installedVersion()}\n`);
  process.exit(0);
}

// --- Subcommand lookup ---
const meta = SUBCOMMANDS.get(sub);
if (!meta) {
  const subcommandList = [...SUBCOMMANDS.keys()].join(', ');
  const hint = suggest(sub);
  const didYouMean = hint ? `\n  Did you mean '${hint}'?` : '';
  process.stderr.write(
    `mandrel: unknown subcommand '${sub}'${didYouMean}\n` +
      `  Available subcommands: ${subcommandList}\n`,
  );
  process.exit(1);
}

// --- Unknown-flag rejection ---
const subArgv = args.slice(1);
const unknownFlagError = findUnknownFlag(sub, meta.knownFlags, subArgv);
if (unknownFlagError) {
  process.stderr.write(unknownFlagError);
  process.exit(1);
}

// --- Load and dispatch ---
const subFile = path.resolve(__dirname, '..', 'lib', 'cli', `${sub}.js`);
const subFileUrl = pathToFileURL(subFile).href;

let mod;
try {
  mod = await import(subFileUrl);
} catch (err) {
  if (err.code === 'ERR_MODULE_NOT_FOUND' && err.message.includes(subFile)) {
    process.stderr.write(
      `mandrel: subcommand '${sub}' module not found — this is a bug\n`,
    );
    process.exit(1);
  }
  // Re-throw broken-module errors so they are visible rather than masked.
  throw err;
}

if (typeof mod.default !== 'function') {
  process.stderr.write(
    `mandrel: subcommand '${sub}' does not export a default function\n`,
  );
  process.exit(1);
}

await mod.default(subArgv);

// lib/cli/explain.js
/**
 * `mandrel explain` subcommand.
 *
 * Prints, for every resolved config key, its effective value, the source
 * layer the value came from (default / profile / agentrc), and a one-line
 * meaning. Secret-shaped keys report `<redacted>` in place of a value — only
 * their source is shown.
 *
 * Usage:
 *   mandrel explain                 # explain the project's resolved config
 *   mandrel explain --profile <p>   # attribute omitted keys to a named profile
 *   mandrel explain --json          # emit the raw report as JSON
 *
 * Output goes to process.stdout so it is capturable by tests. Exit code 0 on
 * success, 1 on an unknown profile or resolution failure.
 *
 * Injectable seams (used by tests):
 *   - `explain` — replaces the default `explainConfig` implementation
 *   - `write`   — replaces process.stdout.write
 *   - `errOut`  — replaces process.stderr.write
 *   - `exit`    — replaces process.exit
 */

import { explainConfig } from '../../.agents/scripts/lib/config/explain.js';

const SOURCE_BADGES = Object.freeze({
  agentrc: '[agentrc]',
  profile: '[profile]',
  default: '[default]',
});

/**
 * Format a single report row for human-readable output.
 *
 * @param {{ key: string, value: unknown, source: string, meaning: string, redacted: boolean }} entry
 * @returns {string}
 */
function formatRow(entry) {
  const badge = SOURCE_BADGES[entry.source] ?? `[${entry.source}]`;
  const value = entry.redacted ? '<redacted>' : JSON.stringify(entry.value);
  return `${badge} ${entry.key} = ${value}\n    ${entry.meaning}\n`;
}

/**
 * Parse the subcommand argv into options.
 *
 * @param {string[]} argv
 * @returns {{ profile: string|null, json: boolean }}
 */
export function parseArgs(argv) {
  let profile = null;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      json = true;
    } else if (arg === '--profile') {
      profile = argv[i + 1] ?? null;
      i += 1;
    } else if (arg.startsWith('--profile=')) {
      profile = arg.slice('--profile='.length);
    }
  }
  return { profile, json };
}

/**
 * Run the explain report and emit it.
 *
 * @param {string[]} argv
 * @param {{
 *   explain?: typeof explainConfig,
 *   write?: (s: string) => void,
 *   errOut?: (s: string) => void,
 *   exit?: (code: number) => void,
 * }} [deps]
 * @returns {void}
 */
export function runExplain(
  argv = [],
  {
    explain = explainConfig,
    write = (s) => process.stdout.write(s),
    errOut = (s) => process.stderr.write(s),
    exit = (code) => process.exit(code),
  } = {},
) {
  const { profile, json } = parseArgs(argv);

  let report;
  try {
    report = explain({ profile });
  } catch (err) {
    errOut(`mandrel explain: ${err.message}\n`);
    exit(1);
    return;
  }

  if (json) {
    write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  for (const entry of report) {
    write(formatRow(entry));
  }
}

/**
 * Default export consumed by `bin/mandrel.js`.
 *
 * @param {string[]} argv
 * @returns {Promise<void>}
 */
export default async function run(argv) {
  runExplain(argv);
}

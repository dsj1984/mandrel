// lib/cli/doctor.js
/**
 * `mandrel doctor` subcommand.
 *
 * Runs every check from lib/cli/registry.js in registration order,
 * prints a ✔/✘ per-check report with remedies for failures, prints a
 * final summary line, and exits 0 when all checks pass or non-zero when
 * any check fails.
 *
 * Output contract (per Story #3450 AC):
 *   pass  → "✔  <name>   <detail>"
 *   fail  → "✘  <name>   <detail>\n   → <remedy>"
 *   final → "✅  Ready (N/N checks passed)"
 *         | "❌  Not ready (N/N checks failed)"
 *
 * All output goes to process.stdout so it can be captured by tests.
 * Exit code 0 = all pass, 1 = any fail.
 *
 * Injectable seams (used by tests):
 *   - `checks`  — replaces the default registry array
 *   - `write`   — replaces process.stdout.write
 *   - `exit`    — replaces process.exit
 */

import { registry } from './registry.js';

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/**
 * Pad or truncate `name` to `width` characters so columns line up neatly.
 *
 * @param {string} name
 * @param {number} width
 * @returns {string}
 */
function padName(name, width) {
  return name.length >= width ? name : name + ' '.repeat(width - name.length);
}

// Column width for the check-name field (longest registry name is
// "commands-in-sync" = 16 chars; use 18 for breathing room).
const NAME_COL = 18;

/**
 * Format a single check result line (or lines when a remedy is present).
 *
 * @param {{ name: string, ok: boolean, detail: string, remedy?: string }} result
 * @returns {string}
 */
function formatResult({ name, ok, detail, remedy }) {
  const icon = ok ? '✔' : '✘';
  const paddedName = padName(name, NAME_COL);
  const line = `${icon}  ${paddedName}  ${detail}\n`;
  if (!ok && remedy) {
    return `${line}   → ${remedy}\n`;
  }
  return line;
}

/**
 * Format the final summary line.
 *
 * @param {number} passed
 * @param {number} total
 * @returns {string}
 */
function formatSummary(passed, total) {
  if (passed === total) {
    return `✅  Ready (${passed}/${total} checks passed)\n`;
  }
  const failed = total - passed;
  return `❌  Not ready (${failed}/${total} checks failed)\n`;
}

// ---------------------------------------------------------------------------
// Doctor runner (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Run all checks and emit a formatted report.
 *
 * @param {{
 *   checks?: Array<{ name: string, run(opts?: unknown): { ok: boolean, detail: string, remedy?: string } }>,
 *   write?: (s: string) => void,
 *   exit?: (code: number) => void,
 * }} [opts]
 * @returns {void}
 */
export async function runDoctor({
  checks = registry,
  write = (s) => process.stdout.write(s),
  exit = (code) => process.exit(code),
} = {}) {
  let passed = 0;

  for (const check of checks) {
    const result = await check.run();
    if (result.ok) passed++;
    write(formatResult({ name: check.name, ...result }));
  }

  const total = checks.length;
  write(formatSummary(passed, total));

  if (passed < total) {
    exit(1);
  }
}

// ---------------------------------------------------------------------------
// Subcommand entry point (called by bin/mandrel.js)
// ---------------------------------------------------------------------------

/**
 * Default export consumed by `bin/mandrel.js`.
 *
 * @param {string[]} _argv  Unused — `mandrel doctor` takes no arguments.
 * @returns {Promise<void>}
 */
export default async function run(_argv) {
  await runDoctor();
}

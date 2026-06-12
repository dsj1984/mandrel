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
 *   - `checks`           — replaces the default registry array
 *   - `write`            — replaces process.stdout.write
 *   - `exit`             — replaces process.exit
 *   - `writeResultCache` — replaces the temp/doctor-result.json writer
 */

import nodeFs from 'node:fs';
import path from 'node:path';

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
// "agents-materialized" = 19 chars; use 21 for breathing room).
const NAME_COL = 21;

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
// Result cache
// ---------------------------------------------------------------------------

/**
 * Best-effort write of the doctor verdict to `temp/doctor-result.json` under
 * the consumer root so downstream workflows (e.g. the `/plan` first-run
 * preflight) can read the last recorded verdict without re-running doctor.
 * `temp/` is the gitignored scratch root, so neither git nor the sync prune
 * pass ever sees the cache. Any write failure is swallowed — the cache is
 * advisory, never a gate.
 *
 * Exported for testing.
 *
 * @param {'ready'|'unready'} verdict
 * @param {{ fs?: typeof nodeFs, cwd?: () => string }} [opts]
 * @returns {void}
 */
export function writeDoctorResultCache(
  verdict,
  { fs = nodeFs, cwd = process.cwd } = {},
) {
  try {
    const dir = path.join(cwd(), 'temp');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'doctor-result.json'),
      `${JSON.stringify({ verdict, checkedAt: new Date().toISOString() }, null, 2)}\n`,
    );
  } catch {
    // Best-effort only — an unwritable temp/ must never fail the doctor run.
  }
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
 *   writeResultCache?: (verdict: 'ready'|'unready') => void,
 * }} [opts]
 * @returns {void}
 */
export async function runDoctor({
  checks = registry,
  write = (s) => process.stdout.write(s),
  exit = (code) => process.exit(code),
  writeResultCache = writeDoctorResultCache,
} = {}) {
  let passed = 0;

  for (const check of checks) {
    const result = await check.run();
    if (result.ok) passed++;
    write(formatResult({ name: check.name, ...result }));
  }

  const total = checks.length;
  write(formatSummary(passed, total));

  writeResultCache(passed === total ? 'ready' : 'unready');

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

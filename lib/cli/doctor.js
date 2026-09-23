// lib/cli/doctor.js
/**
 * `mandrel doctor`: run the registry checks in order, print a ✔/✘ line per
 * check (with the remedy under a failure) and a summary; exit 1 on any
 * failure.
 */

import nodeFs from 'node:fs';
import path from 'node:path';

import {
  resolveAlwaysLoadedClosure,
  tierTotalBytes,
} from '../../.agents/scripts/lib/doc-tiers.js';
import { registry } from './registry.js';

/**
 * @param {string} name
 * @param {number} width
 * @returns {string}
 */
function padName(name, width) {
  return name.length >= width ? name : name + ' '.repeat(width - name.length);
}

// Longest check name is 19 chars.
const NAME_COL = 21;

/**
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

/**
 * Informational line for the host entry doc's always-loaded closure (file count,
 * KB). Never counted toward the verdict; a resolve failure degrades to a
 * neutral line.
 *
 * @param {{ cwd?: () => string, resolveClosure?: (root: string) => Array<{ path: string, bytes: number }> }} [opts]
 * @returns {string} a single line terminated by `\n`
 */
export function formatClosureReport({
  cwd = process.cwd,
  resolveClosure = (root) => resolveAlwaysLoadedClosure(root),
} = {}) {
  const label = padName('context-closure', NAME_COL);
  let files = [];
  try {
    files = resolveClosure(cwd()) ?? [];
  } catch {
    return `ℹ  ${label}  always-loaded closure unavailable\n`;
  }
  if (files.length === 0) {
    return `ℹ  ${label}  no entry-doc closure found (CLAUDE.md or AGENTS.md)\n`;
  }
  const kb = (tierTotalBytes(files) / 1024).toFixed(1);
  return `ℹ  ${label}  ${files.length} file(s), ${kb} KB always-loaded\n`;
}

/**
 * Record the verdict in `temp/doctor-result.json` for workflows that read it
 * without re-running doctor. Advisory: write failures are swallowed.
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
    // An unwritable temp/ must never fail the doctor run.
  }
}

/**
 * @param {{
 *   checks?: Array<{ name: string, run(opts?: unknown): { ok: boolean, detail: string, remedy?: string } }>,
 *   write?: (s: string) => void,
 *   exit?: (code: number) => void,
 *   writeResultCache?: (verdict: 'ready'|'unready') => void,
 *   closureReport?: () => string,
 * }} [opts]
 * @returns {void}
 */
export async function runDoctor({
  checks = registry,
  write = (s) => process.stdout.write(s),
  exit = (code) => process.exit(code),
  writeResultCache = writeDoctorResultCache,
  closureReport = () => formatClosureReport(),
} = {}) {
  let passed = 0;

  for (const check of checks) {
    const result = await check.run();
    if (result.ok) passed++;
    write(formatResult({ name: check.name, ...result }));
  }

  // Report-only: not counted toward passed/total.
  write(closureReport());

  const total = checks.length;
  write(formatSummary(passed, total));

  writeResultCache(passed === total ? 'ready' : 'unready');

  if (passed < total) {
    exit(1);
  }
}

/**
 * @param {string[]} _argv  Unused — `mandrel doctor` takes no arguments.
 * @returns {Promise<void>}
 */
export default async function run(_argv) {
  await runDoctor();
}

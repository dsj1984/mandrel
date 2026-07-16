/**
 * dead-exports-knip.js — the knip driver behind the dead-export ratchet.
 *
 * Owns everything about talking to knip and normalising what comes back:
 * spawning it, reading a pre-captured report, and flattening its report into
 * `{ file, symbol }` rows. `check-dead-exports.js` stays a thin CLI over this.
 *
 * @module lib/dead-exports-knip
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import process from 'node:process';

/**
 * Spawn `npx knip --reporter json --no-progress` and return the parsed
 * envelope. Never throws — the caller logs the error and treats current rows as
 * empty, which surfaces every baseline row as "removed": loud, but safe.
 *
 * `production` adds knip's `--production` flag, which restricts analysis to
 * entry/project patterns carrying the `!` suffix in `knip.json`. The test globs
 * deliberately lack that suffix, so production mode drops them as entry points
 * and an export reachable only from a test reads as dead. Without those
 * suffixes production mode has no entry patterns at all and reports nothing —
 * `knip.json` and this flag are a matched pair.
 *
 * Exported as a hook so tests can stub the spawn without a working knip
 * workspace.
 *
 * @param {{ cwd?: string, spawn?: typeof spawnSync, production?: boolean }} [opts]
 * @returns {{ ok: true, envelope: unknown } | { ok: false, error: string }}
 */
export function runKnip({
  cwd = process.cwd(),
  spawn = spawnSync,
  production = false,
} = {}) {
  const args = ['knip', '--reporter', 'json', '--no-progress'];
  if (production) args.push('--production');
  const result = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
    shell: process.platform === 'win32',
  });
  if (result.error) {
    return { ok: false, error: `spawn failed: ${result.error.message}` };
  }
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  if (stdout.trim().length === 0) {
    return { ok: false, error: 'knip produced empty stdout' };
  }
  try {
    return { ok: true, envelope: JSON.parse(stdout) };
  } catch (err) {
    return {
      ok: false,
      error: `knip JSON parse failed: ${err?.message ?? err}`,
    };
  }
}

/**
 * Read a pre-captured knip JSON envelope from disk (the `--knip-output` test
 * seam). Returns the parsed envelope or `null` on failure.
 *
 * @param {string} filePath
 * @returns {unknown}
 */
export function readKnipOutput(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Flatten knip's `--reporter json` output into `{ file, symbol }` rows. Knip
 * emits `{ issues: [{ file, exports: [{ name, ... }], ... }, ...] }`. Only
 * `exports` rows are mapped — the ratchet ignores file-, dependency- and
 * duplicate-level issues, which knip surfaces under separate `rules` keys.
 *
 * @param {unknown} knipEnvelope The parsed knip JSON report.
 * @returns {Array<{ file: string, symbol: string }>}
 */
export function extractRowsFromKnip(knipEnvelope) {
  const rows = [];
  if (!knipEnvelope || typeof knipEnvelope !== 'object') return rows;
  const issues = Array.isArray(knipEnvelope.issues) ? knipEnvelope.issues : [];
  for (const issue of issues) {
    const file = issue?.file;
    if (typeof file !== 'string' || file.length === 0) continue;
    const exports_ = Array.isArray(issue.exports) ? issue.exports : [];
    for (const e of exports_) {
      const symbol =
        (e && typeof e.name === 'string' && e.name) ||
        (e && typeof e.symbol === 'string' && e.symbol) ||
        null;
      if (!symbol) continue;
      rows.push({ file, symbol });
    }
  }
  return rows;
}

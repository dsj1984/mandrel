/**
 * dead-exports-knip.js — run knip and flatten its report into
 * `{ file, symbol }` rows for the dead-export ratchet.
 *
 * @module lib/dead-exports-knip
 */

import fs from 'node:fs';
import process from 'node:process';
import { spawnChild } from './child-exec.js';

const KNIP_MAX_ISSUE_STATUS = 1;

/**
 * Never throws; the caller fails closed on `{ ok: false }`. `spawn` is the
 * run seam inside `spawnChild`, so a fake still gets the buffer ceiling.
 *
 * `production` requires the `!`-suffixed entry patterns in `knip.json`
 * (test globs deliberately lack it, so test-only exports read as dead);
 * without them production mode silently reports nothing.
 *
 * @param {{ cwd?: string, spawn?: Function, production?: boolean }} [opts]
 * @returns {{ ok: true, envelope: unknown } | { ok: false, error: string }}
 */
export function runKnip({
  cwd = process.cwd(),
  spawn,
  production = false,
} = {}) {
  const args = ['knip', '--reporter', 'json', '--no-progress'];
  if (production) args.push('--production');
  const isWindows = process.platform === 'win32';
  const result = spawnChild(isWindows ? 'npx.cmd' : 'npx', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: isWindows,
    run: spawn,
  });
  return interpretKnipResult(result);
}

/** Knip exits 1 when it reports issues, so only a status above 1 fails. */
function interpretKnipResult(result) {
  if (result.error) {
    return { ok: false, error: `spawn failed: ${result.error.message}` };
  }
  if (result.status > KNIP_MAX_ISSUE_STATUS) {
    return {
      ok: false,
      error: `knip exited ${result.status}: ${String(result.stderr ?? '').trim()}`,
    };
  }
  return parseKnipStdout(result.stdout);
}

function parseKnipStdout(stdout) {
  const text = typeof stdout === 'string' ? stdout : '';
  if (text.trim().length === 0) {
    return { ok: false, error: 'knip produced empty stdout' };
  }
  try {
    return { ok: true, envelope: JSON.parse(text) };
  } catch (err) {
    return {
      ok: false,
      error: `knip JSON parse failed: ${err?.message ?? err}`,
    };
  }
}

/**
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

/** Whole-file death row symbol; not a legal identifier, so it cannot collide. */
const WHOLE_FILE_SYMBOL = '*';

/**
 * Tolerates bare strings and falls back to the issue's own `file`, so a
 * reporter-shape change degrades to one row rather than silence.
 *
 * @param {{ files?: unknown }} issue
 * @param {string} fallbackFile
 * @returns {string[]}
 */
function extractDeadFileNames(issue, fallbackFile) {
  const entries = Array.isArray(issue.files) ? issue.files : [];
  const names = [];
  for (const entry of entries) {
    const name =
      (typeof entry === 'string' && entry) ||
      (entry && typeof entry.name === 'string' && entry.name) ||
      fallbackFile;
    if (typeof name === 'string' && name.length > 0) names.push(name);
  }
  return names;
}

/**
 * Accepts `name` or the older `symbol` field.
 *
 * @param {{ exports?: unknown }} issue
 * @returns {string[]}
 */
function extractDeadExportSymbols(issue) {
  const entries = Array.isArray(issue.exports) ? issue.exports : [];
  const symbols = [];
  for (const e of entries) {
    const symbol =
      (e && typeof e.name === 'string' && e.name) ||
      (e && typeof e.symbol === 'string' && e.symbol) ||
      null;
    if (symbol) symbols.push(symbol);
  }
  return symbols;
}

/**
 * Maps `exports` (one row per unused export) and `files` (one `'*'` row per
 * unimported module, de-duplicated). The `files` leg is required: knip
 * suppresses a dead module's per-export rows, so an export-only reading is
 * blind to whole-file death. Dependency issues are not code death and are
 * ignored.
 *
 * @param {unknown} knipEnvelope
 * @returns {Array<{ file: string, symbol: string }>}
 */
export function extractRowsFromKnip(knipEnvelope) {
  const rows = [];
  if (!knipEnvelope || typeof knipEnvelope !== 'object') return rows;
  const issues = Array.isArray(knipEnvelope.issues) ? knipEnvelope.issues : [];
  const seenDeadFiles = new Set();
  for (const issue of issues) {
    const file = issue?.file;
    if (typeof file !== 'string' || file.length === 0) continue;
    for (const name of extractDeadFileNames(issue, file)) {
      if (seenDeadFiles.has(name)) continue;
      seenDeadFiles.add(name);
      rows.push({ file: name, symbol: WHOLE_FILE_SYMBOL });
    }
    for (const symbol of extractDeadExportSymbols(issue)) {
      rows.push({ file, symbol });
    }
  }
  return rows;
}

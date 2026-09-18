/**
 * format-generated-json.js — run generated JSON through Biome so a fresh
 * generator run matches the Biome-shaped committed artifact (lint-staged
 * formats at commit; `JSON.stringify` does not collapse short arrays).
 * Stdin mode keeps it a pure transform — the configured `formatWrite` is
 * whole-tree.
 */

import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { Logger } from './Logger.js';

/** A hung formatter must not wedge a generator run. */
const FORMATTER_TIMEOUT_MS = 30_000;

/** Callers write `formatGeneratedJson(...) ?? serialized`. */
function fallback(filename) {
  Logger.warn(
    `project formatter (biome) unavailable — writing unformatted ${filename}; ` +
      'run your formatter over it if a format gate rejects it',
  );
  return null;
}

/**
 * Best-effort: consumers may lack Biome, so failure warns and returns `null`
 * — safe where freshness compares parsed objects, not bytes. `--no` stops
 * npx installing from the network; `filename` is a bare basename so it
 * cannot carry spaces that break Windows shell quoting.
 *
 * @param {string} source Text to format.
 * @param {object} opts
 * @param {string} opts.cwd Directory to resolve the formatter and its config from.
 * @param {string} [opts.filename] Basename Biome attributes the stdin text to.
 * @param {typeof spawnSync} [opts.spawn] Injection seam for tests.
 * @returns {string|null} Formatted text with a trailing newline, or null to fall back.
 */
export function formatGeneratedJson(
  source,
  { cwd, filename = 'generated.json', spawn = spawnSync },
) {
  let result;
  try {
    result = spawn(
      'npx',
      ['--no', 'biome', 'format', `--stdin-file-path=${filename}`],
      {
        cwd,
        input: source,
        encoding: 'utf8',
        // `.cmd` shims need a shell on Windows since CVE-2024-27980.
        shell: process.platform === 'win32',
        timeout: FORMATTER_TIMEOUT_MS,
      },
    );
  } catch {
    return fallback(filename);
  }
  if (!result || result.error || result.status !== 0) return fallback(filename);
  const stdout = result.stdout;
  if (typeof stdout !== 'string' || stdout.trim() === '') {
    return fallback(filename);
  }
  return stdout.endsWith('\n') ? stdout : `${stdout}\n`;
}

/**
 * format-generated-json.js — run generated JSON through the project
 * formatter (Biome) so a generator's output matches what the repo's
 * commit-time formatting would have produced anyway.
 *
 * Why this exists. Generators serialize with `JSON.stringify`, which
 * expands every array across multiple lines. Biome collapses short ones
 * that fit inside `lineWidth` (`"allowedTools": ["Read", "Bash"]`), and
 * lint-staged runs `biome format --write` over staged JSON at commit
 * time — so the committed artifact is Biome-shaped while a fresh
 * generator run is not. The gap means regenerating on a clean tree
 * always leaves format drift, and a `<generate>` → `lint` sequence fails
 * on `biome ci` even when the generator's own `--check` reports the
 * artifact semantically fresh (Story #4546).
 *
 * Running the real formatter, rather than hand-matching its array
 * collapsing, keeps this correct by construction across future formatter
 * and `lineWidth` changes.
 *
 * Stdin mode is deliberate: Biome's configured `formatWrite` command is
 * whole-tree (`biome format --write .`), which is a far broader side
 * effect than a generator should have. `--stdin-file-path` makes this a
 * pure content transform with no filesystem writes.
 */

import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { Logger } from './Logger.js';

/** Wall-clock ceiling for the formatter spawn, so a hung child cannot wedge a generator run. */
const FORMATTER_TIMEOUT_MS = 30_000;

/**
 * Warn once about a fallback and return null for the caller to act on.
 * Owning the message here keeps every caller's write path a single
 * `formatGeneratedJson(...) ?? serialized` expression.
 */
function fallback(filename) {
  Logger.warn(
    `project formatter (biome) unavailable — writing unformatted ${filename}; ` +
      'run your formatter over it if a format gate rejects it',
  );
  return null;
}

/**
 * Format `source` as JSON using the project formatter.
 *
 * Best-effort by design: `.agents/` is materialized into consumer
 * projects that need not have Biome installed, so an unavailable or
 * failing formatter warns and returns `null` for the caller to fall back
 * on its own serialization rather than failing the generator. That is
 * safe wherever the artifact's freshness check compares parsed objects
 * rather than bytes — formatting carries no semantic content.
 *
 * `--no` keeps npx from reaching the network to install a missing Biome.
 * `filename` is passed as a bare basename: Biome only needs it to infer
 * the language and match config overrides, and a basename cannot carry
 * the spaces that would break arg quoting under the Windows `shell:
 * true` spawn.
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
        // npm/npx ship as `.cmd` shims on Windows, which Node refuses to
        // spawn without a shell since CVE-2024-27980.
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

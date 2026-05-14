/**
 * lib/mutation/config-detector.js — Detect a Stryker config in a repo
 * (Story #1736, Task #1754).
 *
 * The mutation gate is on-by-default but self-skips when Stryker is not
 * configured. The detector recognises the canonical Stryker config
 * surfaces:
 *
 *   - `stryker.conf.js`
 *   - `stryker.conf.cjs`
 *   - `stryker.conf.mjs`
 *   - `stryker.conf.json`
 *   - `stryker.config.js` / `.cjs` / `.mjs` / `.json` (Stryker's alternate name)
 *   - a `"stryker"` key in the repo-root `package.json`
 *
 * When an explicit `configPath` is supplied (from the gate's
 * `strykerConfigPath` block), that path takes precedence — the file is
 * checked for existence and returned without re-walking the canonical
 * surfaces.
 *
 * Pure with respect to the injected fs surface; never invokes Stryker
 * or any child process.
 */

import fs from 'node:fs';
import path from 'node:path';

const CANONICAL_FILES = Object.freeze([
  'stryker.conf.js',
  'stryker.conf.cjs',
  'stryker.conf.mjs',
  'stryker.conf.json',
  'stryker.config.js',
  'stryker.config.cjs',
  'stryker.config.mjs',
  'stryker.config.json',
]);

/**
 * @typedef {Object} DetectionResult
 * @property {boolean} found
 * @property {'config-file' | 'package-json' | 'explicit' | null} via
 * @property {string | null} path  Absolute path to the config artifact (or
 *   the package.json that carries the `stryker` key).
 * @property {string} [reason]     Populated when `found` is false.
 */

/**
 * Detect a Stryker configuration in `cwd`.
 *
 * @param {{
 *   cwd?: string,
 *   configPath?: string | null,
 *   fsImpl?: { existsSync: typeof fs.existsSync, readFileSync: typeof fs.readFileSync },
 * }} [opts]
 * @returns {DetectionResult}
 */
export function detectStrykerConfig(opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const fsImpl = opts.fsImpl ?? fs;
  const explicit = opts.configPath;

  if (typeof explicit === 'string' && explicit.length > 0) {
    const abs = path.isAbsolute(explicit)
      ? explicit
      : path.resolve(cwd, explicit);
    if (fsImpl.existsSync(abs)) {
      return { found: true, via: 'explicit', path: abs };
    }
    return {
      found: false,
      via: null,
      path: null,
      reason: `explicit strykerConfigPath '${explicit}' does not exist`,
    };
  }

  for (const filename of CANONICAL_FILES) {
    const abs = path.resolve(cwd, filename);
    if (fsImpl.existsSync(abs)) {
      return { found: true, via: 'config-file', path: abs };
    }
  }

  const pkgPath = path.resolve(cwd, 'package.json');
  if (fsImpl.existsSync(pkgPath)) {
    try {
      const raw = fsImpl.readFileSync(pkgPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed === 'object' &&
        parsed.stryker &&
        typeof parsed.stryker === 'object'
      ) {
        return { found: true, via: 'package-json', path: pkgPath };
      }
    } catch {
      // Malformed package.json — fall through to "not found". The repo
      // is already broken in other ways; the mutation gate skip is a
      // benign symptom, not the cause.
    }
  }

  return {
    found: false,
    via: null,
    path: null,
    reason: 'no Stryker config found',
  };
}

/**
 * Exposed for testing — the canonical filename list, frozen.
 * @returns {readonly string[]}
 */
export function getCanonicalConfigFilenames() {
  return CANONICAL_FILES;
}

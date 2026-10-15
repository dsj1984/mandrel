// lib/cli/doctor-checks/version-current.js — Doctor check: version-current.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCache } from '../version-check.js';
import { compareVersions as compareSemver } from '../version-helpers.js';

// check: version-current

/**
 * @param {typeof fs} fsImpl
 * @returns {string}
 */
function defaultInstalledVersion(fsImpl) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const manifestPath = path.resolve(here, '..', '..', '..', 'package.json');
  const parsed = JSON.parse(fsImpl.readFileSync(manifestPath, 'utf8'));
  return String(parsed.version);
}

/** Mirrors `version-check.js#DEFAULT_CACHE_FILENAME`. */
const DEFAULT_VERSION_CACHE_FILENAME = 'version-check.json';

/**
 * Anchored at the consumer root so the cache survives reinstalls that
 * replace `node_modules/`.
 *
 * @returns {string}
 */
function defaultVersionCachePath() {
  return path.join(process.cwd(), 'temp', DEFAULT_VERSION_CACHE_FILENAME);
}

/**
 * Cache-only stale-version advisory: reads the freshness cache and never hits
 * the network. Always `ok: true`, so it can never fail doctor or CI.
 *
 * @param {{
 *   cachePath?: string,
 *   installedVersion?: string,
 *   fsImpl?: typeof fs,
 * }} [opts]
 * @returns {{ ok: boolean, detail: string, remedy?: string }}
 */
export function runVersionCurrent({
  cachePath,
  installedVersion,
  fsImpl = fs,
} = {}) {
  const resolvedPath = cachePath ?? defaultVersionCachePath();

  let current = installedVersion;
  if (!current) {
    try {
      current = defaultInstalledVersion(fsImpl);
    } catch {
      return {
        ok: true,
        detail: 'installed version unknown — advisory skipped',
      };
    }
  }

  const cached = readCache({ cachePath: resolvedPath, fs: fsImpl });
  if (!cached) {
    return {
      ok: true,
      detail: `v${current} (no cached freshness check yet)`,
    };
  }

  if (compareSemver(cached.latestVersion, current) > 0) {
    return {
      ok: true,
      detail: `a newer version is available: v${current} → v${cached.latestVersion} (advisory)`,
      remedy: 'Run `mandrel update` to upgrade to the latest version.',
    };
  }

  return { ok: true, detail: `v${current} is up to date` };
}

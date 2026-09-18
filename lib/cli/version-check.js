// lib/cli/version-check.js
/**
 * Daily-cached newest-version check: `{ latestVersion, checkedAt }` JSON under
 * the temp root, so commands learn of a newer release without a network call
 * each time. Logs only versions and paths.
 */

import nodeFs from 'node:fs';
import path from 'node:path';

export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_CACHE_FILENAME = 'version-check.json';

/**
 * `null` (never a throw) for any absent, unreadable or malformed cache.
 *
 * @param {{
 *   cachePath: string,
 *   fs?: typeof import('node:fs'),
 * }} opts
 * @returns {{ latestVersion: string, checkedAt: string } | null}
 */
export function readCache({ cachePath, fs = nodeFs }) {
  if (!cachePath) return null;

  let raw;
  try {
    raw = fs.readFileSync(cachePath, 'utf8');
  } catch {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof parsed.latestVersion !== 'string' ||
    typeof parsed.checkedAt !== 'string'
  ) {
    return null;
  }

  return { latestVersion: parsed.latestVersion, checkedAt: parsed.checkedAt };
}

/**
 * @param {{
 *   cachePath: string,
 *   latestVersion: string,
 *   now?: Date,
 *   fs?: typeof import('node:fs'),
 *   log?: (msg: string) => void,
 * }} opts
 * @returns {{ latestVersion: string, checkedAt: string }}
 */
export function refreshCache({
  cachePath,
  latestVersion,
  now = new Date(),
  fs = nodeFs,
  log = () => {},
}) {
  const record = {
    latestVersion,
    checkedAt: now.toISOString(),
  };

  const dir = path.dirname(cachePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(cachePath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');

  log(`version-check: cached latestVersion=${latestVersion} at ${cachePath}`);

  return record;
}

/**
 * A cache under 24h old returns without calling `runner`; otherwise one probe
 * refreshes it. Bypass with `forceRefresh`, never by shifting `now`: `now` is
 * stamped as `checkedAt`, and a future stamp defeats every later reader.
 *
 * @param {{
 *   cachePath: string,
 *   now?: Date,
 *   runner: () => (string | Promise<string>),
 *   forceRefresh?: boolean,
 *   fs?: typeof import('node:fs'),
 *   log?: (msg: string) => void,
 * }} opts
 * @returns {Promise<{
 *   stale: boolean,
 *   refreshed: boolean,
 *   latestVersion: string | null,
 *   checkedAt: string | null,
 * }>}
 */
export async function isStale({
  cachePath,
  now = new Date(),
  runner,
  forceRefresh = false,
  fs = nodeFs,
  log = () => {},
}) {
  const cached = forceRefresh ? null : readCache({ cachePath, fs });

  if (cached) {
    const ageMs = now.getTime() - new Date(cached.checkedAt).getTime();
    const cacheIsFresh =
      Number.isFinite(ageMs) && ageMs >= 0 && ageMs < STALE_AFTER_MS;

    if (cacheIsFresh) {
      log(
        `version-check: cache fresh latestVersion=${cached.latestVersion} (no network)`,
      );
      return {
        stale: false,
        refreshed: false,
        latestVersion: cached.latestVersion,
        checkedAt: cached.checkedAt,
      };
    }
  }

  if (typeof runner !== 'function') {
    throw new Error(
      'version-check: runner seam is required to refresh a stale cache',
    );
  }

  log(
    `version-check: cache stale or absent at ${cachePath} — probing for latest version`,
  );
  const latestVersion = await runner();
  const record = refreshCache({ cachePath, latestVersion, now, fs, log });

  return {
    stale: true,
    refreshed: true,
    latestVersion: record.latestVersion,
    checkedAt: record.checkedAt,
  };
}

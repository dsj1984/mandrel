// lib/cli/version-check.js
/**
 * Daily-cached version freshness check (Story #3500, Epic #3437 — Auto-Update
 * & Version Lifecycle).
 *
 * Detects a stale install ("f-notify-stale") via a daily on-disk JSON cache so
 * callers learn that a newer version exists **without** issuing a network call
 * on every command. The cache lives under the project's temp root as a small
 * JSON document:
 *
 *   { "latestVersion": "<semver>", "checkedAt": "<ISO-8601 timestamp>" }
 *
 * `isStale` reads that cache and only invokes the injected network `runner`
 * seam when the cached `checkedAt` is older than 24h. A fresh cache short-
 * circuits with zero network I/O; a missing, unreadable, or stale cache
 * triggers exactly one `runner` call and a cache refresh.
 *
 * Security (security-baseline § 5 — Data Leakage & Logging):
 *   - Logs only version strings and filesystem paths. Never logs tokens,
 *     credentials, environment values, or raw file contents.
 *   - Performs no shell-string interpolation; the network probe is delegated
 *     to the injected `runner` seam so the host owns transport and auth.
 *
 * Injectable seams (used by lib/cli/__tests__/version-check.test.js):
 *   - `cachePath` — absolute path to the daily cache JSON file
 *   - `now`       — Date provider (defaults to `new Date()`)
 *   - `runner`    — async network seam returning the latest version string
 *   - `fs`        — node:fs surface (readFileSync / writeFileSync / mkdirSync)
 *   - `log`       — structured logger seam (defaults to a no-op)
 *
 * Following the lib/cli/*.js convention: Node built-ins only, every effectful
 * dependency is an injectable seam, and the default export is the seam-free
 * production wiring.
 */

import nodeFs from 'node:fs';
import path from 'node:path';

/** Cache freshness window in milliseconds (24 hours). */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/** Default cache filename under the temp root. */
export const DEFAULT_CACHE_FILENAME = 'version-check.json';

/**
 * Read and parse the daily cache JSON.
 *
 * Returns `null` when the file is absent, unreadable, malformed, or missing
 * the required `checkedAt` / `latestVersion` fields — every one of those is a
 * "treat as no cache" condition for `isStale`, so callers never have to
 * distinguish them.
 *
 * Never throws: a corrupt or missing cache must degrade to a refresh, not a
 * crash.
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
    // Missing or unreadable file → no cache.
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Malformed JSON → no cache.
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
 * Persist `{ latestVersion, checkedAt }` JSON to the cache path, creating the
 * parent directory (the temp root) when needed.
 *
 * Logs only the version string and the cache path — never the raw payload.
 *
 * @param {{
 *   cachePath: string,
 *   latestVersion: string,
 *   now?: Date,
 *   fs?: typeof import('node:fs'),
 *   log?: (msg: string) => void,
 * }} opts
 * @returns {{ latestVersion: string, checkedAt: string }} The persisted record.
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

  // Safe to log: version string + path only (security-baseline § 5).
  log(`version-check: cached latestVersion=${latestVersion} at ${cachePath}`);

  return record;
}

/**
 * Decide whether the cached freshness check is stale and, when it is, refresh
 * it through the network `runner` seam.
 *
 * Behaviour:
 *   - **Fresh cache** (`checkedAt` within 24h): returns immediately with the
 *     cached version. The `runner` seam is **never** invoked — no per-command
 *     network call.
 *   - **Missing / corrupt / stale cache**: invokes `runner` exactly once to
 *     fetch the latest version, persists the result via `refreshCache`, and
 *     returns the refreshed record.
 *
 * The freshness comparison uses `>=` so an exactly-24h-old cache counts as
 * stale (the boundary is treated as "due for refresh").
 *
 * @param {{
 *   cachePath: string,
 *   now?: Date,
 *   runner: () => (string | Promise<string>),
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
  fs = nodeFs,
  log = () => {},
}) {
  const cached = readCache({ cachePath, fs });

  if (cached) {
    const ageMs = now.getTime() - new Date(cached.checkedAt).getTime();
    const cacheIsFresh =
      Number.isFinite(ageMs) && ageMs >= 0 && ageMs < STALE_AFTER_MS;

    if (cacheIsFresh) {
      // Fresh cache → no network call.
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

  // Missing, corrupt, or stale cache → one network probe + refresh.
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

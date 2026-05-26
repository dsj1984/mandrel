/**
 * preflight-cache.js — Epic #3019 / Story #3027.
 *
 * Cache adapter for the snapshot/DAG envelope produced by
 * `epic-deliver-preflight.js` so `epic-deliver-prepare.js` can skip the
 * second walk of Epic → Feature → Story when the underlying Epic ticket
 * has not drifted between the two operator invocations.
 *
 * Contract:
 *   - Cache file lives at `<cwd>/temp/epic-<epicId>/preflight-snapshot.json`.
 *   - Envelope shape:
 *       {
 *         epicId: number,
 *         baseSha: string,        // deterministic fingerprint of the Epic
 *                                 // snapshot returned by provider.getTicket
 *         capturedAt: string,     // ISO-8601 timestamp
 *         epic: object,           // the snapshot from runSnapshotPhase
 *         stories: object[],      // the open Story tickets from runBuildWaveDagPhase
 *         waves: Array<Array<object>>, // wave DAG (ids + labels preserved)
 *       }
 *   - `computeBaseSha(epic)` derives the cache key from the same provider
 *     call (`getTicket(epicId)`) used to walk the hierarchy. The hash
 *     covers the Epic's id, body, labels (sorted), and (when present)
 *     `updatedAt` — the same fields that drive Story discovery and the
 *     acceptance-spec gate.
 *   - Cache miss is signalled by `readCache` returning `null`. Callers
 *     MUST fall back to a fresh snapshot/DAG pass.
 *   - `writeCache` creates the parent directory recursively and writes
 *     atomically (write to `<path>.tmp` then rename).
 *
 * The module is pure JS / node:fs — no provider dependency — so tests
 * can exercise it without spinning up a GitHub mock.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Resolve the on-disk path for an Epic's preflight cache.
 *
 * @param {{ epicId: number, cwd?: string }} args
 * @returns {string}
 */
export function preflightCachePath({ epicId, cwd }) {
  if (!Number.isInteger(epicId) || epicId <= 0) {
    throw new TypeError(
      'preflightCachePath: epicId must be a positive integer',
    );
  }
  const root = cwd ?? process.cwd();
  return path.join(root, 'temp', `epic-${epicId}`, 'preflight-snapshot.json');
}

/**
 * Stable string fingerprint of an Epic snapshot. The hash is keyed on the
 * exact fields `runSnapshotPhase` reads (`getTicket(epicId)` return value)
 * so that any drift the snapshot phase would observe forces a cache miss.
 *
 * Labels are sorted to absorb GitHub's non-deterministic label order
 * across responses. The hash is sha256; we return the full hex digest so
 * the cache key is collision-resistant for the lifetime of a delivery.
 *
 * @param {{ id?: number|string, number?: number|string, body?: string, labels?: string[], updatedAt?: string }} epic
 * @returns {string}
 */
export function computeBaseSha(epic) {
  if (!epic || typeof epic !== 'object') {
    throw new TypeError('computeBaseSha: epic snapshot must be an object');
  }
  const id = epic.id ?? epic.number ?? null;
  const body = typeof epic.body === 'string' ? epic.body : '';
  const labels = Array.isArray(epic.labels)
    ? [...epic.labels].map(String).sort()
    : [];
  const updatedAt = typeof epic.updatedAt === 'string' ? epic.updatedAt : null;
  const payload = JSON.stringify({ id, body, labels, updatedAt });
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * Read the cached preflight envelope from disk. Returns `null` when the
 * file is missing or unreadable — callers MUST treat that as a cache
 * miss and fall back to a fresh snapshot/DAG pass.
 *
 * The function intentionally swallows `ENOENT` and JSON-parse errors so
 * a stale or partially-written file does not poison `epic-deliver-prepare`.
 *
 * @param {{ epicId: number, cwd?: string }} args
 * @returns {Promise<object | null>}
 */
export async function readPreflightCache({ epicId, cwd }) {
  const cachePath = preflightCachePath({ epicId, cwd });
  let raw;
  try {
    raw = await readFile(cachePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.epicId !== epicId) return null;
    if (typeof parsed.baseSha !== 'string' || !parsed.baseSha) return null;
    if (!parsed.epic || typeof parsed.epic !== 'object') return null;
    if (!Array.isArray(parsed.stories)) return null;
    if (!Array.isArray(parsed.waves)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Persist the preflight envelope to disk. Writes atomically via tmp +
 * rename so concurrent readers never observe a partial file.
 *
 * @param {{ epicId: number, baseSha: string, epic: object, stories: object[], waves: Array<Array<object>>, cwd?: string, capturedAt?: string }} args
 * @returns {Promise<{ cachePath: string, baseSha: string }>}
 */
export async function writePreflightCache({
  epicId,
  baseSha,
  epic,
  stories,
  waves,
  cwd,
  capturedAt,
}) {
  if (!Number.isInteger(epicId) || epicId <= 0) {
    throw new TypeError(
      'writePreflightCache: epicId must be a positive integer',
    );
  }
  if (typeof baseSha !== 'string' || !baseSha) {
    throw new TypeError(
      'writePreflightCache: baseSha must be a non-empty string',
    );
  }
  if (!epic || typeof epic !== 'object') {
    throw new TypeError('writePreflightCache: epic must be an object');
  }
  if (!Array.isArray(stories)) {
    throw new TypeError('writePreflightCache: stories must be an array');
  }
  if (!Array.isArray(waves)) {
    throw new TypeError('writePreflightCache: waves must be an array');
  }
  const cachePath = preflightCachePath({ epicId, cwd });
  await mkdir(path.dirname(cachePath), { recursive: true });
  const envelope = {
    epicId,
    baseSha,
    capturedAt: capturedAt ?? new Date().toISOString(),
    epic,
    stories,
    waves,
  };
  const tmp = `${cachePath}.tmp`;
  await writeFile(tmp, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
  await rename(tmp, cachePath);
  return { cachePath, baseSha };
}

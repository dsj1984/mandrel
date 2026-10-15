// lib/cli/doctor-checks/read-json.js — shared JSON read for the doctor checks.

/**
 * Raw JSON read; any failure degrades to `null`.
 *
 * @param {string} absPath
 * @param {{ readFileSync: Function }} fsImpl
 * @returns {object | null}
 */
export function readJsonSafe(absPath, fsImpl) {
  try {
    return JSON.parse(fsImpl.readFileSync(absPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Epic IDs reserved for tests that create `<repo>/temp/epic-<id>/` trees (or
 * other on-disk artefacts keyed by Epic number in the framework repo).
 *
 * Real GitHub Epic / issue numbers live outside this inclusive band. Tests
 * MUST use IDs in [TEST_EPIC_TEMP_ID_MIN, TEST_EPIC_TEMP_ID_MAX] whenever they
 * write per-Epic temp paths under the repository root so post-test cleanup and
 * tripwire helpers never collide with real delivery scratch.
 */

export const TEST_EPIC_TEMP_ID_MIN = 999_000;
export const TEST_EPIC_TEMP_ID_MAX = 999_999;

/**
 * @param {unknown} id
 * @returns {boolean}
 */
export function isReservedTestEpicTempId(id) {
  return (
    typeof id === 'number' &&
    Number.isInteger(id) &&
    id >= TEST_EPIC_TEMP_ID_MIN &&
    id <= TEST_EPIC_TEMP_ID_MAX
  );
}

/**
 * @param {string} dirName  Directory basename, e.g. `epic-999007`
 * @returns {boolean}
 */
export function isReservedTestEpicTempDirName(dirName) {
  const m = /^epic-([0-9]+)$/.exec(dirName);
  if (!m) return false;
  return isReservedTestEpicTempId(Number(m[1]));
}

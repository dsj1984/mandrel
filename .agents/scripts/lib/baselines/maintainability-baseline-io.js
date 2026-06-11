import fs from 'node:fs';
import path from 'node:path';
import { Logger } from '../Logger.js';

/**
 * Story #1895: project the canonical maintainability envelope back to the
 * legacy flat `{ path: mi }` map so existing gate consumers keep working
 * without churn — Story #1912 will replace this shim with the shared
 * reader. Returns the parsed input unchanged when it doesn't look like an
 * envelope (legacy flat shape stays flat).
 */
function projectMaintainabilityEnvelopeToFlat(parsed) {
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    !Array.isArray(parsed.rows) ||
    typeof parsed.$schema !== 'string'
  ) {
    return parsed;
  }
  const flat = {};
  for (const row of parsed.rows) {
    if (row && typeof row.path === 'string' && typeof row.mi === 'number') {
      flat[row.path] = row.mi;
    }
  }
  return flat;
}

/**
 * Loads the current maintainability baseline from disk. The on-disk path is
 * resolved by the caller via {@link getBaselines}; passing it explicitly
 * removes the silent-default behaviour the framework dropped in Epic #730
 * Story 5.5.
 *
 * @param {string} baselinePath  Repo-relative or absolute path to the baseline
 *   JSON. Required.
 * @returns {Record<string, number>}
 */
export function getBaseline(baselinePath) {
  if (typeof baselinePath !== 'string' || baselinePath.length === 0) {
    throw new TypeError(
      'maintainability-utils.getBaseline: baselinePath is required (Epic #730 ' +
        'Story 5.5 — callers resolve the path via getBaselines(config).maintainability.path).',
    );
  }
  const abs = path.isAbsolute(baselinePath)
    ? baselinePath
    : path.resolve(process.cwd(), baselinePath);
  if (!fs.existsSync(abs)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(abs, 'utf-8'));
    return projectMaintainabilityEnvelopeToFlat(parsed);
  } catch (err) {
    Logger.warn(`[Maintainability] Failed to parse baseline: ${err.message}`);
    return {};
  }
}

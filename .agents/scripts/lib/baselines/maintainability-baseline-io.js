import fs from 'node:fs';
import path from 'node:path';
import { Logger } from '../Logger.js';

/**
 * Project an envelope to the flat `{ path: mi }` map the gate consumers read;
 * a non-envelope passes through unchanged.
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
 * No default path: the caller resolves it via {@link getBaselines}.
 *
 * @param {string} baselinePath  Repo-relative or absolute.
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

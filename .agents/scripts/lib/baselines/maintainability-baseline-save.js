import path from 'node:path';
import {
  write as writeBaselineEnvelope,
  writeFile as writeBaselineFile,
} from './writer.js';

/**
 * Saves a new maintainability baseline to disk at `baselinePath`.
 *
 * Accepts the legacy flat `{ path: mi }` shape for backwards compatibility
 * with existing callers (`regenerateMainFromTree`, refresh helpers). The
 * map is transformed into the canonical envelope shape (`$schema`,
 * `kernelVersion`, `generatedAt`, `rollup`, `rows`) via the shared
 * `lib/baselines/writer.js` pipeline before being persisted, so every
 * write produces a file that round-trips through `lib/baselines/reader.js`
 * without schema errors.
 *
 * @param {Record<string, number>} baseline  path→MI flat map.
 * @param {string} baselinePath  Required — caller supplies via getBaselines().
 */
export function saveBaseline(baseline, baselinePath) {
  if (typeof baselinePath !== 'string' || baselinePath.length === 0) {
    throw new TypeError(
      'maintainability-utils.saveBaseline: baselinePath is required.',
    );
  }
  const abs = path.isAbsolute(baselinePath)
    ? baselinePath
    : path.resolve(process.cwd(), baselinePath);

  const rows = Object.entries(baseline ?? {}).map(([p, mi]) => ({
    path: p,
    mi,
  }));
  const envelope = writeBaselineEnvelope({ kind: 'maintainability', rows });
  writeBaselineFile(abs, envelope);
}

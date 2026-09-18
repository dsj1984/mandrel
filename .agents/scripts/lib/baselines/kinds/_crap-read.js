/**
 * The single CRAP baseline read path, built on `baselines/reader.js` so every
 * gate feeds the compat axes the same stamps. Re-exported by `kinds/crap.js`.
 */

import path from 'node:path';
import { readBaselineAtRef } from '../../baseline-loader.js';
import { loadBaseline } from '../../gates/baseline-store.js';
import {
  loadFile as loadBaselineFile,
  load as loadBaselineKind,
} from '../reader.js';

/**
 * Read the working-tree baseline, projected onto the `file`-keyed comparator
 * shape. `null` on any failure; the preview gate then fails open.
 *
 * @param {{baselinePath?: string, projectRoot?: string}} [opts]
 * @returns {object|null}
 */
function readCrapBaselineFromTree({ baselinePath, projectRoot } = {}) {
  const cwd = projectRoot ?? process.cwd();
  let envelope;
  try {
    envelope = baselinePath
      ? loadBaselineFile(
          path.isAbsolute(baselinePath)
            ? baselinePath
            : path.resolve(cwd, baselinePath),
          { kind: 'crap' },
        )
      : loadBaselineKind('crap', { cwd });
  } catch {
    return null;
  }
  return {
    kernelVersion: envelope.kernelVersion,
    scoringSemantics: envelope.scoringSemantics ?? null,
    tsTranspilerVersion:
      typeof envelope.tsTranspilerVersion === 'string'
        ? envelope.tsTranspilerVersion
        : null,
    provenanceStamped: envelope.provenanceStamped,
    rows: (envelope.rows ?? []).map(projectBaselineRow),
  };
}

/**
 * Re-key `path` to `file`, carrying `coordinateSystem` and `anonymous`
 * verbatim: dropping either breaks a compat axis or the comparator.
 *
 * @param {{path: string, method: string, startLine: number, crap: number,
 *   coordinateSystem?: string, anonymous?: boolean}} row
 * @returns {object}
 */
function projectBaselineRow(row) {
  return {
    crap: row.crap,
    file: row.path,
    method: row.method,
    startLine: row.startLine,
    ...(row.coordinateSystem === undefined
      ? {}
      : { coordinateSystem: row.coordinateSystem }),
    ...(row.anonymous === undefined ? {} : { anonymous: row.anonymous }),
  };
}

/**
 * From the working tree, or from `<epicRef>:<baselinePath>` when `epicRef` is
 * set; only the ref path needs the shape-check and transpiler back-fill.
 */
export function loadCrapBaseline({
  baselinePath,
  epicRef,
  readAtRef = readBaselineAtRef,
  readFromTree = readCrapBaselineFromTree,
  logger = console,
}) {
  const parsed = loadBaseline({
    baselinePath,
    epicRef,
    readAtRef,
    readFromTree,
    logger,
    label: 'CRAP',
  });
  if (!epicRef) return parsed;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  if (typeof parsed.kernelVersion !== 'string') return null;
  if (typeof parsed.escomplexVersion !== 'string') return null;
  if (!Array.isArray(parsed.rows)) return null;
  if (typeof parsed.tsTranspilerVersion !== 'string') {
    parsed.tsTranspilerVersion = '0.0.0';
  }
  return parsed;
}

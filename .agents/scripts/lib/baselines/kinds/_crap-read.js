/**
 * _crap-read.js — the CRAP baseline read path (Story #5002).
 *
 * Underscore-prefixed like `_shared-metric.js`: a helper for the per-kind
 * modules in this directory, not a kind of its own. `kinds/crap.js` re-exports
 * `loadCrapBaseline` so existing importers keep one door.
 *
 * **This module is the whole read path, and there is only one.** `crap-utils.js`
 * used to carry a second one — `projectCrapEnvelopeToLegacy` plus its
 * `COMPAT_STAMP_*` allow-lists — so `check-baselines` (through
 * `baselines/reader.js`) and the `quality-preview` pre-commit arm (through that
 * projection) fed the same compat axes from two hand-maintained field lists. A
 * stamp added to one and not the other yielded two opposite verdicts on one
 * envelope, three times over: Story #4866 (`scoringSemantics`,
 * `tsTranspilerVersion`), #4969 (`rows[].anonymous`), #4986
 * (`provenanceStamped`). Every one of those axes keys on a POSITIVE marker, so
 * a dropped field read `undefined` and failed the baseline closed with a remedy
 * that could not work — re-deriving it wrote the stamp the read path then
 * discarded. With one reader that drift class is structurally impossible, so no
 * allow-list needs maintaining.
 */

import path from 'node:path';
import { readBaselineAtRef } from '../../baseline-loader.js';
import { loadBaseline } from '../../gates/baseline-store.js';
import {
  loadFile as loadBaselineFile,
  load as loadBaselineKind,
} from '../reader.js';

/**
 * Read the committed CRAP baseline off the working tree through
 * `baselines/reader.js` and project it onto the `file`-keyed shape the
 * comparator and the compat axes consume.
 *
 * `baselinePath` selects the explicit-path reader variant (the worktree /
 * epic-ref callers always know their own path); without one the reader
 * resolves the configured location for the `crap` kind itself.
 *
 * Returns `null` on any read/parse/schema failure; the preview gate maps that
 * to "no baseline" and fails open, as it always did.
 *
 * Deliberately module-local: `loadCrapBaseline`'s `readFromTree` default is the
 * single production door to it, and tests inject their own loader.
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
 * Re-key one on-disk row (`path`) onto the `file` field `compareCrap` matches
 * on, carrying the two write-only-when-non-default row markers verbatim.
 *
 * Both markers are BASELINE facts. Dropping `anonymous` would leave every
 * re-keyed row looking like an unmarked anonymous one — precisely the shape the
 * `anon-identity-unstamped` axis fails closed (Story #4969) — and dropping
 * `coordinateSystem` would let the comparator drift-resolve across two
 * coordinate systems (Story #4866).
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
 * Pure helper: resolve the CRAP baseline either from the working tree (via
 * `readCrapBaselineFromTree`) or, when `epicRef` is supplied, from
 * `git show <epicRef>:<baselinePath>` via `readBaselineAtRef`.
 *
 * Story #1120 threads `epic/<id>` into close-validation so the comparison runs
 * against the Epic-branch HEAD's committed baseline. This helper delegates the
 * read to baseline-store and applies the CRAP shape-check +
 * `tsTranspilerVersion` back-fill on top.
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
  // No-epicRef path delegates to readFromTree which already applies the
  // shape-check + tsTranspilerVersion back-fill, so a tree read returns either
  // a valid envelope or null. Epic-ref path bypasses that helper — shape-check
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

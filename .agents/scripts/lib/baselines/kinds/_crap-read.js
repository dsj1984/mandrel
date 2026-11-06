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
 * Scoring-semantics stamp. The scorer version does not move when this repo's
 * coverage join changes, yet rows scored under different joins are not
 * comparable (phantom regressions and phantom passes), so the stamp fails
 * closed across that boundary. Bump it whenever the coverage join, the line
 * coordinate system, the unresolved-method policy, or the method identity
 * rule changes. Read it via `envelopeExtras().scoringSemantics`.
 */
export const SCORING_SEMANTICS = 'method-identity-v5';

const STAMP_RE = /^method-identity-v(\d+)$/;

/**
 * Order a baseline's `scoringSemantics` against the running stamp: `ahead`
 * only for a higher `method-identity-v<N>`; any other mismatch is `behind`.
 *
 * @param {unknown} stamp
 * @returns {'current'|'ahead'|'behind'}
 */
export function classifyScoringSemantics(stamp) {
  if (stamp === SCORING_SEMANTICS) return 'current';
  const theirs = STAMP_RE.exec(typeof stamp === 'string' ? stamp : '');
  const ours = STAMP_RE.exec(SCORING_SEMANTICS);
  return theirs && Number(theirs[1]) > Number(ours[1]) ? 'ahead' : 'behind';
}

/**
 * A raw envelope stamped ahead of this code: no CRAP path writes or compares
 * it, whatever its layout. `null` when not ahead.
 *
 * @param {unknown} envelope Parsed JSON, unvalidated.
 * @returns {{baseline: string, running: string, message: string}|null}
 */
export function aheadStampOf(envelope) {
  const stamp = envelope?.scoringSemantics;
  if (classifyScoringSemantics(stamp) !== 'ahead') return null;
  return {
    baseline: stamp,
    running: SCORING_SEMANTICS,
    message:
      `[CRAP] gate skipped: baseline scoringSemantics=${stamp} is ahead of ` +
      `running=${SCORING_SEMANTICS}, so this code leaves the baseline untouched ` +
      "and compares nothing; CI, running the branch's own code, is the check of record.",
  };
}

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
    rows: (envelope.rows ?? []).map(projectBaselineRow),
  };
}

/**
 * Re-key `path` to `file`, the field the comparator matches on.
 *
 * @param {{path: string, method: string, crap: number}} row
 * @returns {{file: string, method: string, crap: number}}
 */
function projectBaselineRow(row) {
  return { crap: row.crap, file: row.path, method: row.method };
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
  // A newer layout is the caller's to skip, not a shape failure.
  return aheadStampOf(parsed) ? parsed : shapeCheckedAtRef(parsed);
}

/** The ref read's shape-check and `tsTranspilerVersion` back-fill. */
function shapeCheckedAtRef(parsed) {
  if (typeof parsed.kernelVersion !== 'string') return null;
  if (typeof parsed.escomplexVersion !== 'string') return null;
  if (!Array.isArray(parsed.rows)) return null;
  if (typeof parsed.tsTranspilerVersion !== 'string') {
    parsed.tsTranspilerVersion = '0.0.0';
  }
  return parsed;
}

/**
 * Stale-row prune for the CRAP baseline: statically derived, so it runs
 * before any coverage exists.
 */

import nodeFs from 'node:fs';
import path from 'node:path';
import { execFileCaptureAsync } from '../child-exec.js';
import { calculateCrapForSource, UNSCORABLE } from '../crap-engine.js';
import { methodStem } from '../crap-method-identity.js';
import { prepareSourceForScoring } from '../transpile.js';
import { assertEnvelope } from './envelope.js';
import { canonicalizeBaselinePath } from './path-canon.js';
import { readPriorState } from './refresh-service.js';
import { assertCrapPriorCurrent } from './seat-missing.js';
import { writeFile as writeEnvelopeFile } from './writer.js';

/** The branch's changed files, both sides of a rename. */
async function changedFiles({ baseRef, headRef, cwd }) {
  const { stdout } = await execFileCaptureAsync(
    'git',
    ['diff', '--name-only', '--no-renames', `${baseRef}...${headRef}`],
    { cwd },
  );
  return stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

/**
 * The method stems a source file yields now: empty for a deleted file,
 * `null` when it cannot be scored, so its rows are kept.
 *
 * @param {string} abs
 * @param {typeof nodeFs} fs
 * @returns {Set<string>|null}
 */
function currentMethodStems(abs, fs) {
  if (!fs.existsSync(abs)) return new Set();
  const prepared = prepareSourceForScoring(abs);
  if (prepared.error) return null;
  const rows = calculateCrapForSource(prepared.code, null, prepared.mapLine);
  if (rows === UNSCORABLE) return null;
  return new Set(rows.map((row) => methodStem(row.method)));
}

/** Prior rows minus each change-set file's rows whose stem no longer exists. */
function withoutStaleRows(rows, changed, stemsOf) {
  const stems = new Map();
  return rows.filter((row) => {
    if (!changed.has(row.path)) return true;
    if (!stems.has(row.path)) stems.set(row.path, stemsOf(row.path));
    return stems.get(row.path)?.has(methodStem(row.method)) ?? true;
  });
}

/**
 * Drop the CRAP rows of change-set files whose method no longer exists.
 * Siblings collapse by stem, so a surviving namesake keeps the row.
 *
 * @param {{writePath: string, baseRef: string, headRef?: string, cwd?: string,
 *   gitDiff?: Function, fs?: typeof nodeFs}} opts
 * @returns {Promise<{pruned: number}>}
 */
export async function pruneStaleCrapRows({
  writePath,
  baseRef,
  headRef = 'HEAD',
  cwd = process.cwd(),
  gitDiff = changedFiles,
  fs = nodeFs,
}) {
  const { envelope, ahead } = readPriorState(writePath, fs, 'crap');
  if (ahead || !envelope) return { pruned: 0 };
  assertCrapPriorCurrent('crap', envelope);
  const changed = new Set(
    (await gitDiff({ baseRef, headRef, cwd })).map(canonicalizeBaselinePath),
  );
  const rows = withoutStaleRows(envelope.rows, changed, (relPath) =>
    currentMethodStems(path.resolve(cwd, relPath), fs),
  );
  const pruned = envelope.rows.length - rows.length;
  if (pruned === 0) return { pruned };
  const next = { ...envelope, rows };
  assertEnvelope(next);
  writeEnvelopeFile(writePath, next, { fsImpl: fs });
  return { pruned };
}

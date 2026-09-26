/**
 * Insert-only baseline seating (`--seat-missing`): write ONLY rows whose seat
 * key is absent from the committed baseline; prior rows keep their parsed
 * objects, so they serialise byte-identically. The CRAP key is
 * `path::method` — the gate matches a moved method by name, so it is not
 * missing.
 */

import nodeFs from 'node:fs';
import path from 'node:path';
import { execFileCaptureAsync } from '../child-exec.js';
import { getBaselines, resolveConfig } from '../config-resolver.js';
import { Logger } from '../Logger.js';
import { parseDiffScopeFlag } from './diff-scope-cli.js';
import { assertEnvelope } from './envelope.js';
import { getKindModule } from './kernel.js';
import { canonicalizeBaselinePath } from './path-canon.js';
import {
  deriveScopeFromDiff,
  fileFilterFor,
  readPriorEnvelope,
  resolveDefaultScorer,
} from './refresh-service.js';
import {
  write as writeEnvelope,
  writeFile as writeEnvelopeFile,
} from './writer.js';

/** Thrown when a seat must not write; the CLI prints `message` and exits 1. */
export class SeatRefusal extends Error {
  constructor(message) {
    super(message);
    this.name = 'SeatRefusal';
  }
}

const SEAT_KEYS = Object.freeze({
  crap: (row) => `${row.path}::${row.method}`,
  maintainability: (row) => row.path,
});

/**
 * @param {string} kind
 * @returns {(row: object) => string}
 */
export function seatKeyFor(kind) {
  const key = SEAT_KEYS[kind];
  if (!key) throw new Error(`seat-missing: unsupported kind "${kind}"`);
  return key;
}

/**
 * Candidate rows whose seat key no prior row carries. Pure.
 *
 * @param {{kind: string, priorRows: object[], candidateRows: object[]}} args
 * @returns {object[]}
 */
export function selectMissingRows({ kind, priorRows, candidateRows }) {
  const key = seatKeyFor(kind);
  const present = new Set((priorRows ?? []).map(key));
  return (candidateRows ?? []).filter((row) => !present.has(key(row)));
}

/**
 * The CRAP seat's fail-closed precondition: every joinable method in scope
 * resolved a coverage entry. Returns the refusal text, or `null` to proceed.
 * Anything below 100% means the artifact's coordinates predate the tree.
 *
 * @param {{resolvedMethods?: number, joinableMethods?: number, rate?: number,
 *   worstFiles?: Array<{file: string, unresolved: number, total: number}>}
 *   | undefined} resolution
 * @param {string} fixCommand
 * @returns {string|null}
 */
export function checkSeatResolution(resolution, fixCommand) {
  const { joinableMethods = 0, resolvedMethods = 0 } = resolution ?? {};
  if (resolvedMethods >= joinableMethods) return null;
  const rate = ((resolvedMethods / joinableMethods) * 100).toFixed(1);
  const files = (resolution.worstFiles ?? [])
    .map((w) => `  - ${w.file} (${w.unresolved}/${w.total} unresolved)`)
    .join('\n');
  return (
    `[CRAP] --seat-missing refused: method resolution ${resolvedMethods}/${joinableMethods} ` +
    `(${rate}%) over the in-scope files; seating requires 100%.\n` +
    (files ? `Unresolved files:\n${files}\n` : '') +
    `Fix: re-capture coverage for the current tree — ${fixCommand}`
  );
}

/**
 * Three-dot range (from the merge-base): the files this branch changed.
 *
 * @param {{baseRef: string, headRef: string, cwd: string}} args
 * @returns {Promise<string[]>}
 */
async function mergeBaseGitDiff({ baseRef, headRef, cwd }) {
  const { stdout } = await execFileCaptureAsync(
    'git',
    ['diff', '--name-only', `${baseRef}...${headRef}`],
    { cwd },
  );
  return stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

/**
 * Prior rows are kept as parsed; only the seated rows are projected. With no
 * prior baseline the writer builds a fresh envelope.
 */
function buildSeatedEnvelope({ kind, priorEnvelope, seated }) {
  if (!priorEnvelope) return writeEnvelope({ kind, rows: seated });
  const mod = getKindModule(kind);
  const envelope = {
    ...priorEnvelope,
    rows: mod.sortRows([...priorEnvelope.rows, ...seated.map(mod.projectRow)]),
  };
  assertEnvelope(envelope);
  return envelope;
}

/**
 * Seat the missing rows of `kind` for the files changed in `baseRef...HEAD`.
 * `score(files)` may throw a {@link SeatRefusal}. No missing row, no write.
 *
 * @param {{kind: string, writePath: string, score: Function, baseRef: string,
 *   headRef?: string, cwd?: string, gitDiff?: Function, fs?: typeof nodeFs}} opts
 * @returns {Promise<{seated: number, wrote: boolean, files: string[]}>}
 */
export async function seatMissingBaseline({
  kind,
  writePath,
  score,
  baseRef,
  headRef = 'HEAD',
  cwd = process.cwd(),
  gitDiff = mergeBaseGitDiff,
  fs = nodeFs,
}) {
  const files = await deriveScopeFromDiff({
    baseRef,
    headRef,
    predicate: fileFilterFor(kind),
    gitDiff,
    cwd,
  });
  if (files.length === 0) return { seated: 0, wrote: false, files };

  const candidateRows = (await score(files)).map((row) => ({
    ...row,
    path: canonicalizeBaselinePath(row.path ?? row.file),
  }));
  const priorEnvelope = readPriorEnvelope(writePath, fs);
  const seated = selectMissingRows({
    kind,
    priorRows: priorEnvelope?.rows,
    candidateRows,
  });
  if (seated.length === 0) return { seated: 0, wrote: false, files };

  const envelope = buildSeatedEnvelope({ kind, priorEnvelope, seated });
  writeEnvelopeFile(writePath, envelope, { fsImpl: fs });
  return { seated: seated.length, wrote: true, files };
}

/**
 * The updater CLIs' `--seat-missing` entry: prints `seated: N`; a
 * {@link SeatRefusal} is an expected outcome, so exit 1 with its message.
 *
 * @param {{kind: string, label: string, writePath: string,
 *   diffScopeRef?: string|null, fullScope?: boolean, baseBranch?: string,
 *   score?: Function, cwd?: string, logger?: object, seat?: Function}} opts
 * @returns {Promise<number>} The exit code.
 */
export async function runSeatMissing({
  kind,
  label,
  writePath,
  diffScopeRef = null,
  fullScope = false,
  baseBranch = 'main',
  score,
  cwd = process.cwd(),
  logger = Logger,
  seat = seatMissingBaseline,
}) {
  if (fullScope) {
    throw new Error(
      `[${label}] --full-scope is incompatible with --seat-missing; pick one`,
    );
  }
  try {
    const { seated } = await seat({
      kind,
      writePath,
      baseRef: diffScopeRef ?? `origin/${baseBranch}`,
      score: score ?? ((files) => resolveDefaultScorer(kind, { cwd })(files)),
      cwd,
    });
    logger.info(`[${label}] seated: ${seated}`);
    return 0;
  } catch (err) {
    if (!(err instanceof SeatRefusal)) throw err;
    logger.error(err.message);
    return 1;
  }
}

/**
 * `update-maintainability-baseline.js --seat-missing`. MI is static, so the
 * default scorer needs no coverage precondition. Resolves to the exit code.
 *
 * @param {string[]} argv
 * @param {{config?: object, cwd?: string}} [deps]
 * @returns {Promise<number>}
 */
export function seatMaintainabilityBaseline(
  argv,
  { config = resolveConfig(), cwd = process.cwd() } = {},
) {
  return runSeatMissing({
    kind: 'maintainability',
    label: 'Maintainability',
    writePath: path.resolve(cwd, getBaselines(config).maintainability.path),
    diffScopeRef: parseDiffScopeFlag(argv),
    fullScope: argv.includes('--full-scope'),
    baseBranch: config.project.baseBranch,
    cwd,
  });
}

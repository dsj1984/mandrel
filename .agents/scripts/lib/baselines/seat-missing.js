/**
 * Insert-only baseline seating (`--seat-missing`): write ONLY rows whose seat
 * key is absent from the committed baseline; prior rows keep their parsed
 * objects, so they serialise byte-identically. The CRAP key is
 * `path::method` — the gate matches a moved method by name, so it is not
 * missing; MI and coverage key on `path`.
 */

import nodeFs from 'node:fs';
import path from 'node:path';
import { execFileCaptureAsync } from '../child-exec.js';
import { getBaselines, getQuality, resolveConfig } from '../config-resolver.js';
import {
  buildScopePredicate,
  scoreCoverageFinal,
} from '../coverage-baseline.js';
import { isCoverageFresh } from '../coverage-capture.js';
import { Logger } from '../Logger.js';
import {
  coverageUpdaterTargets,
  loadC8ScopeConfig,
} from './coverage-updater-cli.js';
import { parseDiffScopeFlag } from './diff-scope-cli.js';
import { assertEnvelope } from './envelope.js';
import { getKindModule } from './kernel.js';
import { canonicalizeBaselinePath } from './path-canon.js';
import {
  deriveScopeFromDiff,
  fileFilterFor,
  readPriorState,
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
  coverage: (row) => row.path,
});

/** Stamp scopes a capture may have written; any one fresh stamp suffices. */
const CAPTURE_SCOPES = ['full', 'incremental', 'affected'];

/**
 * Whether any capture stamp marks the coverage artifact fresh for the
 * current tree. `targetDirs` is the stamp's digest scope.
 *
 * @param {{coveragePath: string, targetDirs: string[]}} options
 * @param {{isFresh?: Function, cwd: string}} deps
 * @returns {boolean}
 */
export function isCaptureFresh(
  { coveragePath, targetDirs },
  { isFresh = isCoverageFresh, cwd },
) {
  return CAPTURE_SCOPES.some(
    (requireScope) =>
      isFresh({ coveragePath, targetDirs, cwd, requireScope }).fresh,
  );
}

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

/** An ahead baseline is left untouched: nothing seated, nothing scored. */
function handOff(ahead) {
  return { seated: 0, wrote: false, files: [], ahead };
}

/** `seated: N`, preceded by the hand-off line when the baseline was ahead. */
function logSeated(logger, label, { seated, ahead }) {
  if (ahead) logger.info(ahead.message);
  logger.info(`[${label}] seated: ${seated}`);
}

/**
 * Seat the missing rows of `kind` for the files changed in `baseRef...HEAD`.
 * `score(files)` may throw a {@link SeatRefusal}. No missing row, no write.
 *
 * @param {{kind: string, writePath: string, score: Function, baseRef: string,
 *   headRef?: string, cwd?: string, gitDiff?: Function, fs?: typeof nodeFs}} opts
 * @returns {Promise<{seated: number, wrote: boolean, files: string[],
 *   ahead?: object}>} `ahead`: a baseline stamped newer than this code is
 *   left untouched.
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
  const prior = readPriorState(writePath, fs, kind);
  if (prior.ahead) return handOff(prior.ahead);
  return seatScoped({
    kind,
    writePath,
    score,
    baseRef,
    headRef,
    cwd,
    gitDiff,
    fs,
    prior,
  });
}

async function seatScoped({
  kind,
  writePath,
  score,
  baseRef,
  headRef,
  cwd,
  gitDiff,
  fs,
  prior,
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
  const priorEnvelope = prior.envelope;
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
    const result = await seat({
      kind,
      writePath,
      baseRef: diffScopeRef ?? `origin/${baseBranch}`,
      score: score ?? ((files) => resolveDefaultScorer(kind, { cwd })(files)),
      cwd,
    });
    logSeated(logger, label, result);
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

/** One coverage baseline row from a file's scores. */
const coverageRow = (relPath, s) => ({
  path: relPath,
  lines: s?.lines ?? 0,
  branches: s?.branches ?? 0,
  functions: s?.functions ?? 0,
});

/** @param {string} coveragePath @param {string[]} inScope @param {string} cwd */
function staleRefusal(coveragePath, inScope, cwd) {
  return new SeatRefusal(
    `[Coverage] --seat-missing refused: no coverage artifact at ${coveragePath} is fresh for the current tree ` +
      `(in-scope files: ${inScope.join(', ')}).\n` +
      `Fix: re-capture coverage for the current tree — node .agents/scripts/coverage-capture.js --cwd ${cwd}`,
  );
}

/** Rows for the measured files; an unmeasured one is named, never seated. */
function measuredRows(scores, inScope, logger) {
  const measured = inScope.filter((file) => Object.hasOwn(scores, file));
  const unmeasured = inScope.filter((file) => !measured.includes(file));
  if (unmeasured.length > 0) {
    logger.info(
      `[Coverage] not seated — the fresh artifact did not measure: ${unmeasured.join(', ')}`,
    );
  }
  return measured.map((file) => coverageRow(file, scores[file]));
}

/**
 * The `--seat-missing` scorer. Refuses (throws {@link SeatRefusal}) unless a
 * capture stamp marks the artifact fresh for the current tree; a diff file
 * the artifact did not measure is never seated at 0%. A diff with no
 * c8-scoped file never consults coverage.
 *
 * @param {{ coveragePath: string, readCoverage: Function }} targets
 * @param {{ targetDirs: string[], cwd: string, logger: object }} deps
 *   `targetDirs` is the capture stamp's digest scope.
 * @returns {(files: string[]) => object[]}
 */
function buildCoverageSeatScorer(
  { coveragePath, readCoverage },
  { targetDirs, cwd, logger },
) {
  return (files) => {
    const scope = buildScopePredicate(loadC8ScopeConfig(cwd));
    const inScope = files.filter((file) => scope(file));
    if (inScope.length === 0) return [];
    if (!isCaptureFresh({ coveragePath, targetDirs }, { cwd })) {
      throw staleRefusal(coveragePath, inScope, cwd);
    }
    const scores = scoreCoverageFinal({ raw: readCoverage(cwd), cwd, scope });
    return measuredRows(scores, inScope, logger);
  };
}

/**
 * `update-coverage-baseline.js --seat-missing`: seat rows for the diff's
 * files that have none. Resolves to the exit code.
 *
 * @param {string[]} argv
 * @param {{ config?: object, cwd?: string, logger?: object }} [deps]
 * @returns {Promise<number>}
 */
export function seatCoverageBaseline(
  argv,
  { config = resolveConfig(), cwd = process.cwd(), logger = Logger } = {},
) {
  const quality = getQuality(config);
  const targets = coverageUpdaterTargets(quality.coverage, cwd);
  return runSeatMissing({
    kind: 'coverage',
    label: 'Coverage',
    writePath: targets.absBaselinePath,
    diffScopeRef: parseDiffScopeFlag(argv),
    fullScope: argv.includes('--full-scope'),
    baseBranch: config.project.baseBranch,
    score: buildCoverageSeatScorer(targets, {
      targetDirs: quality.crap.targetDirs,
      cwd,
      logger,
    }),
    cwd,
    logger,
  });
}

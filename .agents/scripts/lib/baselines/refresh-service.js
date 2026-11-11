/**
 * Baseline refresh service: `refreshBaseline()` is the single funnel for
 * every baseline regeneration. It is scoring-agnostic policy — resolve scope,
 * score via the kind's (default or injected) scorer, canonicalize paths, and
 * write through `writer.write()` so out-of-scope rows survive byte-for-byte.
 *
 * @module .agents/scripts/lib/baselines/refresh-service
 */

import nodeFs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { execFileCaptureAsync } from '../child-exec.js';
import { COVERAGE_CAPTURE_DEFAULTS } from '../config/gates/coverage.schema.js';
import { COVERAGE_GATE_DEFAULTS } from '../config/quality.js';
import { getQuality, resolveConfig } from '../config-resolver.js';
import {
  buildScopePredicate,
  coverageRowFromScores,
  scoreCoverageFinal,
} from '../coverage-baseline.js';
import { MissingCoverageArtifactError } from '../coverage-capture.js';
import { loadCoverage } from '../coverage-utils.js';
import {
  resolveEscomplexVersion,
  resolveTsTranspilerVersion,
  scanAndScore,
} from '../crap-utils.js';
import { isObject } from '../json-utils.js';
import {
  calculateAll as calculateAllMi,
  isIgnoredByGlobs as isIgnoredByGlobsMi,
  scanDirectory as scanDirectoryMi,
} from '../maintainability-utils.js';
import { isScorableSourceFile } from '../source-extensions.js';
import { toPosix } from '../util/paths.js';
import { buildBundleSizeScorer } from './bundle-size-scorer.js';
import { decodeEnvelope } from './codec.js';
import { runDuplicationScan } from './duplication-scan-fork.js';
import { resolveFormatExtensions } from './duplication-scanner.js';
import { checkBaselineAhead, getKindModule } from './kernel.js';
import { filterExcludedRows } from './kinds/maintainability.js';
import { canonicalizeBaselinePath } from './path-canon.js';
import {
  write as writeEnvelope,
  writeFile as writeEnvelopeFile,
} from './writer.js';

const nodeRequire = createRequire(import.meta.url);

const SUPPORTED_KINDS = Object.freeze([
  'maintainability',
  'crap',
  'coverage',
  'duplication',
  'bundle-size',
]);

/**
 * Widened by `additionalFormats`.
 *
 * @param {{ additionalFormats?: string[] }} [opts]
 * @returns {(p: string) => boolean}
 */
function duplicationFileFilter({ additionalFormats } = {}) {
  const extra = resolveFormatExtensions(additionalFormats);
  if (extra.size === 0) return isScorableSourceFile;
  return (p) =>
    isScorableSourceFile(p) || extra.has(path.extname(p).toLowerCase());
}

/**
 * Per-kind extension filter for diff-derived scope, over canonical POSIX paths.
 *
 * @type {Record<string, (opts: object) => (p: string) => boolean>}
 */
const KIND_FILE_FILTERS = Object.freeze({
  // The scanner walks exactly this set, so a scoped file it never scores
  // cannot trip the "produced no baseline rows" refusal.
  maintainability: () => isScorableSourceFile,
  crap: () => isScorableSourceFile,
  coverage: () => isScorableSourceFile,
  duplication: duplicationFileFilter,
  // Bundle names are not paths: no changed file scopes a bundle row.
  'bundle-size': () => () => false,
});

/**
 * The defaulted `getQuality(config)` shape the production scorers read — never
 * the raw, un-defaulted gates path. Explicit `quality` wins over `config`.
 *
 * @param {{ quality?: object, config?: object }} opts
 * @returns {object}
 */
function resolveQualityBlock({ quality, config } = {}) {
  if (quality && typeof quality === 'object') return quality;
  if (config && typeof config === 'object') return getQuality(config) ?? {};
  return {};
}

/** @param {string} absPath */
function refuseMissingArtifact(absPath) {
  throw new MissingCoverageArtifactError(absPath);
}

/**
 * @param {{ cwd: string, config?: object, quality?: object }} opts
 * @returns {(files: string[], opts: object) => Promise<object[]>}
 */
function buildDefaultCrapScorer({ cwd, config, quality } = {}) {
  const crapCfg = resolveQualityBlock({ quality, config })?.crap ?? {};
  const targetDirs = Array.isArray(crapCfg.targetDirs)
    ? crapCfg.targetDirs
    : [];
  const ignoreGlobs = Array.isArray(crapCfg.ignoreGlobs)
    ? crapCfg.ignoreGlobs
    : [];
  const requireCoverage = crapCfg.requireCoverage !== false;
  const coverageRelPath =
    crapCfg.coveragePath ?? COVERAGE_CAPTURE_DEFAULTS.coveragePath;
  return async (files, opts) => {
    const effectiveCwd = opts?.cwd ?? cwd ?? process.cwd();
    const coverageAbs = path.isAbsolute(coverageRelPath)
      ? coverageRelPath
      : path.resolve(effectiveCwd, coverageRelPath);
    const coverage = loadCoverage(coverageAbs);
    if (!coverage && requireCoverage) refuseMissingArtifact(coverageAbs);
    const scopeFiles = opts?.fullScope ? null : (files ?? null);
    const { rows } = await scanAndScore({
      targetDirs,
      coverage,
      requireCoverage,
      cwd: effectiveCwd,
      ignoreGlobs,
      scopeFiles,
    });
    resolveEscomplexVersion(effectiveCwd);
    resolveTsTranspilerVersion({ cwd: effectiveCwd, targetDirs });
    return (rows ?? []).filter(
      (r) => typeof r?.crap === 'number' && Number.isFinite(r.crap),
    );
  };
}

/**
 * Coverage rows from the configured `coverage.coveragePath` artifact, scoped by
 * the optional `.c8rc.cjs`. A missing artifact throws on every scope.
 *
 * @param {{ cwd: string, config?: object, quality?: object }} opts
 * @returns {(files: string[], opts: object) => object[]}
 */
function buildDefaultCoverageScorer({ cwd, config, quality } = {}) {
  const coverageRelPath =
    resolveQualityBlock({ quality, config })?.coverage?.coveragePath ??
    COVERAGE_GATE_DEFAULTS.coveragePath;
  return (files, opts) => {
    const effectiveCwd = opts?.cwd ?? cwd ?? process.cwd();
    const coverageFinalPath = path.resolve(effectiveCwd, coverageRelPath);
    if (!nodeFs.existsSync(coverageFinalPath)) {
      refuseMissingArtifact(coverageFinalPath);
    }
    const raw = JSON.parse(nodeFs.readFileSync(coverageFinalPath, 'utf-8'));
    let c8Scope;
    try {
      const c8rcPath = path.resolve(effectiveCwd, '.c8rc.cjs');
      const c8Config = nodeRequire(c8rcPath);
      c8Scope = buildScopePredicate({
        include: c8Config.include ?? [],
        exclude: c8Config.exclude ?? [],
      });
    } catch {
      c8Scope = buildScopePredicate({});
    }
    const scores = scoreCoverageFinal({
      raw,
      cwd: effectiveCwd,
      scope: c8Scope,
    });
    const inScope =
      !opts?.fullScope && Array.isArray(files) && files.length > 0
        ? new Set(files)
        : null;
    return Object.entries(scores)
      .filter(([relPath]) => inScope === null || inScope.has(relPath))
      .map(([relPath, score]) => coverageRowFromScores(relPath, score));
  };
}

/**
 * @param {{ cwd: string, config?: object, quality?: object }} opts
 * @returns {(files: string[], opts: object) => Promise<object[]>}
 */
function buildDefaultMaintainabilityScorer({ cwd, config, quality } = {}) {
  const miCfg = resolveQualityBlock({ quality, config })?.maintainability ?? {};
  const targetDirs = Array.isArray(miCfg.targetDirs) ? miCfg.targetDirs : [];
  const ignoreGlobs = Array.isArray(miCfg.ignoreGlobs) ? miCfg.ignoreGlobs : [];
  return async (files, opts) => {
    const effectiveCwd = opts?.cwd ?? cwd ?? process.cwd();
    const targetAbsDirs = targetDirs.map((dir) =>
      path.isAbsolute(dir) ? dir : path.resolve(effectiveCwd, dir),
    );
    let sourceList;
    if (opts?.fullScope) {
      sourceList = [];
      for (const abs of targetAbsDirs) {
        scanDirectoryMi(abs, sourceList, { cwd: effectiveCwd, ignoreGlobs });
      }
    } else {
      sourceList = [];
      for (const rel of files ?? []) {
        const abs = path.resolve(effectiveCwd, rel);
        const underTarget = targetAbsDirs.some(
          (root) => abs === root || abs.startsWith(`${root}${path.sep}`),
        );
        // Same ignore matcher as the full-scope walk, or an ignored-but-changed
        // file enters `rows` and drags the rollup min below the floor.
        if (
          underTarget &&
          !isIgnoredByGlobsMi(abs, ignoreGlobs, effectiveCwd)
        ) {
          sourceList.push(abs);
        }
      }
    }
    const scores = await calculateAllMi(sourceList);
    return filterExcludedRows(
      Object.entries(scores).map(([p, mi]) => {
        const rel = path.isAbsolute(p) ? path.relative(effectiveCwd, p) : p;
        return { path: toPosix(rel), mi };
      }),
    );
  };
}

/**
 * Built lazily per call so each scorer sees the config resolved against the
 * call's `cwd`; an unconfigured scorer silently drops valid rows.
 *
 * @type {Record<string, (input: { cwd: string, config?: object, quality?: object }) => ((files: string[], opts: object) => Promise<object[]> | object[])>}
 */
const KIND_SCORER_BUILDERS = Object.freeze({
  maintainability: buildDefaultMaintainabilityScorer,
  crap: buildDefaultCrapScorer,
  coverage: buildDefaultCoverageScorer,
  duplication: buildDefaultDuplicationScorer,
  'bundle-size': buildBundleSizeScorer,
});

/**
 * Default scorer for `kind`, configured from `cwd`. Config resolution is
 * best-effort (a throw yields a config-less scorer). Exported so the drift
 * detector re-scores through the same scorer that writes the baseline; a
 * parallel implementation would report its own disagreement as drift.
 *
 * @param {string} kind
 * @param {{ cwd: string, detect?: (opts: object) => Promise<object[]> }} opts
 * @returns {((files: string[], opts: object) => Promise<object[]> | object[]) | undefined}
 */
export function resolveDefaultScorer(kind, { cwd, detect } = {}) {
  const builder = KIND_SCORER_BUILDERS[kind];
  if (typeof builder !== 'function') return undefined;
  const effectiveCwd = cwd ?? process.cwd();
  let quality;
  try {
    quality = getQuality(resolveConfig({ cwd: effectiveCwd })) ?? undefined;
  } catch {
    quality = undefined;
  }
  return builder({ cwd: effectiveCwd, quality, detect });
}

/** The CRAP stamp anchors where check-baselines does: target dirs + root. */
function defaultExtrasContext(kind, cwd) {
  if (kind !== 'crap') return { cwd };
  let targetDirs;
  try {
    targetDirs = getQuality(resolveConfig({ cwd }))?.crap?.targetDirs;
  } catch {
    targetDirs = undefined;
  }
  return { cwd, targetDirs };
}

/**
 * A full scope is the operator's explicit re-seed: it overwrites even an
 * ahead baseline. Any narrower scope hands off before scoring.
 */
function aheadHandOff({ prior, fullScope, kind, writePath, scopeFiles }) {
  if (!prior.ahead || fullScope) return null;
  return {
    kind,
    writePath,
    scope: { mode: scopeFiles ? 'explicit' : 'diff', files: [] },
    envelope: null,
    wrote: false,
    ahead: prior.ahead,
  };
}

function requireScorer(kind, scorer, cwd) {
  const resolved = scorer ?? resolveDefaultScorer(kind, { cwd });
  if (typeof resolved !== 'function') {
    throw new Error(
      `refreshBaseline: no scorer registered for kind "${kind}" (inject one via opts.scorer)`,
    );
  }
  return resolved;
}

/**
 * Refresh the on-disk baseline for `kind`. `scopeFiles: null` without
 * `fullScope` derives scope from `git diff baseRef..headRef`; `fullScope`
 * requires `scopeFiles: null`. `requireRowsForScopeFiles` fails loud when a
 * scoped file produced no row. A scoped refresh never rewrites an
 * `excludeWriteFiles` row. `write: false` computes the envelope and reports
 * `changed` without touching the file.
 *
 * @param {{
 *   kind: 'maintainability' | 'crap' | 'coverage' | 'duplication' | 'bundle-size',
 *   baseRef?: string,
 *   headRef?: string,
 *   scopeFiles?: string[] | null,
 *   epsilon?: number,
 *   fullScope?: boolean,
 *   writePath: string,
 *   scorer?: (files: string[], opts: object) => Promise<object[]> | object[],
 *   fs?: typeof nodeFs,
 *   gitDiff?: (args: { baseRef: string, headRef: string, cwd: string }) => Iterable<string> | Promise<Iterable<string>>,
 *   cwd?: string,
 *   requireRowsForScopeFiles?: boolean,
 *   requiredScopeFilePredicate?: (file: string) => boolean,
 *   extrasContext?: { cwd?: string, targetDirs?: string[] },
 *   excludeWriteFiles?: string[],
 *   write?: boolean,
 * }} opts
 * @returns {Promise<{
 *   kind: string,
 *   writePath: string,
 *   scope: { mode: 'full' | 'diff' | 'explicit', ref?: string, files: string[] },
 *   envelope: object | null,
 *   wrote: boolean,
 *   changed?: boolean,
 *   partners?: Record<string, string[]>,
 *   ahead?: object,
 * }>} `partners`: each write-scope file's scored clone partners. `ahead` (with a null `envelope`): a narrower-than-full refresh left a
 *   baseline stamped newer than this code untouched.
 */
export async function refreshBaseline(opts = {}) {
  const {
    kind,
    baseRef = 'origin/main',
    headRef = 'HEAD',
    scopeFiles = null,
    epsilon,
    fullScope = false,
    writePath,
    scorer,
    fs = nodeFs,
    gitDiff = defaultGitDiff,
    cwd = process.cwd(),
    requireRowsForScopeFiles = false,
    requiredScopeFilePredicate,
    extrasContext,
    excludeWriteFiles = [],
    write = true,
  } = opts;

  validateOptions({ kind, scopeFiles, fullScope, writePath });

  const prior = readPriorState(writePath, fs, kind);
  const handedOff = aheadHandOff({
    prior,
    fullScope,
    kind,
    writePath,
    scopeFiles,
  });
  if (handedOff) return handedOff;

  const resolvedScorer = requireScorer(kind, scorer, cwd);

  const scope = await resolveScope({
    kind,
    scopeFiles,
    fullScope,
    baseRef,
    headRef,
    gitDiff,
    cwd,
  });

  // On full scope `files` is empty: the scorer owns the directory walk.
  const scoredRows = await resolvedScorer(scope.files, {
    kind,
    fullScope: scope.mode === 'full',
    baseRef,
    headRef,
    cwd,
  });
  if (!Array.isArray(scoredRows)) {
    throw new TypeError(
      `refreshBaseline: scorer for kind "${kind}" must return an array of rows`,
    );
  }

  const canonicalRows = canonicalizeRows(kind, scoredRows);

  assertRequiredScopeRows({
    kind,
    scope,
    canonicalRows,
    requireRowsForScopeFiles,
    requiredScopeFilePredicate,
  });

  const priorEnvelope = prior.envelope;
  const writeFiles = resolveWriteScopeFiles({
    kind,
    scope,
    rows: canonicalRows,
    priorRows: priorEnvelope?.rows,
    exclude: excludeWriteFiles,
  });

  const envelope = writeEnvelope({
    kind,
    rows: canonicalRows,
    prior: priorEnvelope?.rows,
    priorEnvelope,
    epsilon,
    extrasContext: extrasContext ?? defaultExtrasContext(kind, cwd),
    scope:
      scope.mode === 'full'
        ? null
        : { mode: 'diff', files: new Set(writeFiles) },
  });

  // The writer returns the prior object itself when nothing changed; skip the
  // write so on-disk bytes stay verbatim.
  const changed = priorEnvelope === null || envelope !== priorEnvelope;
  if (changed && write) writeEnvelopeFile(writePath, envelope, { fsImpl: fs });

  return {
    kind,
    writePath,
    scope: {
      mode: scope.mode,
      ref: scope.ref,
      files: writeFiles,
    },
    envelope,
    wrote: changed && write,
    changed,
    partners: partnersOf(canonicalRows, writeFiles),
  };
}

/** Each listed file's scored clone partners; the envelope never stores them. */
function partnersOf(rows, files) {
  const byPath = new Map(rows.map((row) => [row.path, row.partners]));
  const out = {};
  for (const file of files) {
    const partners = byPath.get(file);
    if (partners?.length) out[file] = partners.map(canonicalizeBaselinePath);
  }
  return out;
}

/**
 * The files whose rows a scoped refresh rewrites. Duplication is pairwise, so
 * a changed file also moves the rows of files it shares (or shared) a clone
 * with; for that kind the scope widens to the head clone partners of every
 * scoped file, plus every out-of-scope prior row that vanished or shrank (a
 * removed clone's partner appears in no head pair). A rise in an unrelated
 * file stays out of scope, so a branch never owns drift it did not cause.
 *
 * `exclude` is subtracted last.
 *
 * @param {{ kind: string, scope: { mode: string, files: string[] }, rows: object[], priorRows?: object[], exclude?: string[] }} args
 * @returns {string[]}
 */
function resolveWriteScopeFiles({ exclude = [], ...args }) {
  const excluded = new Set(exclude.map(canonicalizeBaselinePath));
  return widenWriteScope(args).filter((file) => !excluded.has(file));
}

function widenWriteScope({ kind, scope, rows, priorRows }) {
  if (kind !== 'duplication' || scope.mode === 'full') return [...scope.files];
  const headByPath = new Map(rows.map((row) => [row.path, row]));
  const partners = scope.files.flatMap(
    (file) => headByPath.get(file)?.partners ?? [],
  );
  const shrunk = (priorRows ?? [])
    .filter((prior) => isShrunk(prior, headByPath.get(prior.path)))
    .map((prior) => prior.path);
  return [
    ...new Set([
      ...scope.files,
      ...partners.map(canonicalizeBaselinePath),
      ...shrunk,
    ]),
  ];
}

/** A prior row whose clones vanished (no head row) or shrank. */
function isShrunk(prior, head) {
  return !head || head.percentage < prior.percentage;
}

/**
 * Rows leave the service canonical whatever scorer produced them. Only
 * path-keyed kinds carry a path; bundle-size rows are keyed on a name.
 *
 * @param {string} kind
 * @param {object[]} rows
 * @returns {object[]}
 */
function canonicalizeRows(kind, rows) {
  if (getKindModule(kind).keyField !== 'path') return rows;
  return rows.map((row) => ({
    ...row,
    path: canonicalizeBaselinePath(row.path ?? row.file),
  }));
}

function assertRequiredScopeRows({
  kind,
  scope,
  canonicalRows,
  requireRowsForScopeFiles,
  requiredScopeFilePredicate,
}) {
  if (!requireRowsForScopeFiles || scope.mode === 'full') return;
  const predicate =
    typeof requiredScopeFilePredicate === 'function'
      ? requiredScopeFilePredicate
      : () => true;
  const requiredFiles = scope.files.filter(predicate);
  if (requiredFiles.length === 0) return;

  const rowPaths = new Set(
    canonicalRows
      .map((row) => row?.path)
      .filter((rowPath) => typeof rowPath === 'string' && rowPath.length > 0),
  );
  const missing = requiredFiles.filter((file) => !rowPaths.has(file));
  if (missing.length === 0) return;

  throw new Error(
    `refreshBaseline(${kind}): scoped file(s) produced no baseline rows: ${missing.join(', ')}. ` +
      'Run coverage/scoring for the changed files or use full-scope refresh; refusing to write a baseline that would silently drop Story-owned files.',
  );
}

/**
 * Two-dot range (not triple-dot): exactly the files that differ between the
 * two refs now. `execFile`, never a shell.
 *
 * @param {{ baseRef: string, headRef: string, cwd: string }} args
 * @returns {Promise<string[]>}
 */
async function defaultGitDiff({ baseRef, headRef, cwd }) {
  const range = `${baseRef}..${headRef}`;
  try {
    const { stdout } = await execFileCaptureAsync(
      'git',
      ['diff', '--name-only', range],
      { cwd },
    );
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch (err) {
    throw new Error(
      `refreshBaseline: git diff --name-only ${range} failed in ${cwd}: ${err.message}`,
    );
  }
}

/**
 * Diff-derived scope; paths are canonicalized before `predicate` sees them.
 *
 * @param {{
 *   baseRef: string,
 *   headRef: string,
 *   predicate: (canonicalPath: string) => boolean,
 *   gitDiff?: (args: { baseRef: string, headRef: string, cwd: string }) => Iterable<string> | Promise<Iterable<string>>,
 *   cwd?: string,
 * }} args
 * @returns {Promise<string[]>}
 */
export async function deriveScopeFromDiff({
  baseRef,
  headRef,
  predicate,
  gitDiff = defaultGitDiff,
  cwd = process.cwd(),
}) {
  if (typeof predicate !== 'function') {
    throw new TypeError('deriveScopeFromDiff: predicate must be a function');
  }
  const raw = await gitDiff({ baseRef, headRef, cwd });
  const out = [];
  for (const item of raw ?? []) {
    if (typeof item !== 'string' || item.length === 0) continue;
    const canonical = canonicalizeBaselinePath(item);
    if (predicate(canonical)) out.push(canonical);
  }
  return out;
}

/**
 * `opts.additionalFormats` widens only the duplication filter.
 *
 * @param {string} kind
 * @param {{ additionalFormats?: string[] }} [opts]
 * @returns {(p: string) => boolean}
 */
export function fileFilterFor(kind, opts) {
  const build = KIND_FILE_FILTERS[kind];
  if (!build) {
    throw new Error(
      `fileFilterFor: no predicate registered for kind "${kind}"`,
    );
  }
  return build(opts);
}

/**
 * The diff-scope filter for `kind`.
 * Best-effort config read:
 * an unreadable config widens nothing.
 *
 * @param {string} kind
 * @param {string} cwd
 * @returns {(p: string) => boolean}
 */
function diffScopeFilterFor(kind, cwd) {
  let additionalFormats;
  try {
    additionalFormats = getQuality(resolveConfig({ cwd }))?.gates?.duplication
      ?.additionalFormats;
  } catch {
    additionalFormats = undefined;
  }
  return fileFilterFor(kind, { additionalFormats });
}

/** Full, then explicit list, then diff-derived. */
async function resolveScope({
  kind,
  scopeFiles,
  fullScope,
  baseRef,
  headRef,
  gitDiff,
  cwd,
}) {
  if (fullScope) {
    return { mode: 'full', files: [] };
  }
  if (Array.isArray(scopeFiles)) {
    return {
      mode: 'explicit',
      files: scopeFiles.map((p) => canonicalizeBaselinePath(p)),
    };
  }
  const files = await deriveScopeFromDiff({
    baseRef,
    headRef,
    predicate: diffScopeFilterFor(kind, cwd),
    gitDiff,
    cwd,
  });
  return { mode: 'diff', ref: `${baseRef}..${headRef}`, files };
}

/**
 * `null` on any read/parse/shape failure, which the caller treats as a fresh write.
 *
 * @param {string} writePath
 * @param {typeof nodeFs} fs
 * @returns {object | null}
 */
export function readPriorEnvelope(writePath, fs) {
  return readPriorState(writePath, fs).envelope;
}

/**
 * The prior envelope (as {@link readPriorEnvelope}), or `ahead` when its stamp
 * is newer than this code: then `envelope` is null and nothing may write it
 * short of a full-scope re-seed.
 *
 * @param {string} writePath
 * @param {typeof nodeFs} fs
 * @param {string} [kind]
 * @returns {{envelope: object|null, ahead: object|null}}
 */
export function readPriorState(writePath, fs, kind) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(writePath, 'utf8'));
  } catch {
    return { envelope: null, ahead: null };
  }
  const ahead = kind ? checkBaselineAhead(kind, raw) : null;
  if (ahead) return { envelope: null, ahead };
  try {
    const parsed = decodeEnvelope(raw);
    const valid = isObject(parsed) && Array.isArray(parsed.rows);
    return { envelope: valid ? parsed : null, ahead: null };
  } catch {
    return { envelope: null, ahead: null };
  }
}

function validateOptions({ kind, scopeFiles, fullScope, writePath }) {
  if (typeof kind !== 'string' || !SUPPORTED_KINDS.includes(kind)) {
    throw new Error(
      `refreshBaseline: unknown kind "${kind}" (supported: ${SUPPORTED_KINDS.join(', ')})`,
    );
  }
  if (typeof writePath !== 'string' || writePath.length === 0) {
    throw new TypeError(
      'refreshBaseline: writePath is required and must be a non-empty string',
    );
  }
  if (scopeFiles !== null && !Array.isArray(scopeFiles)) {
    throw new TypeError(
      `refreshBaseline: scopeFiles must be null or an array (got ${typeof scopeFiles})`,
    );
  }
  if (fullScope === true && scopeFiles !== null) {
    throw new Error(
      'refreshBaseline: fullScope=true is incompatible with an explicit scopeFiles array; pass scopeFiles=null',
    );
  }
}

/**
 * Always scans the whole tree: duplication is pairwise, so a diff-narrowed
 * scan would miss clones between changed and unchanged files. Scope applies
 * write-side only. Config comes from `gates.duplication`; `quality.duplication`
 * is always undefined.
 *
 * @param {{ cwd: string, config?: object, quality?: object, detect?: (opts: object) => Promise<object[]> }} opts
 * @returns {(files: string[], opts: object) => Promise<object[]>}
 */
function buildDefaultDuplicationScorer({ cwd, config, quality, detect } = {}) {
  const dupCfg =
    resolveQualityBlock({ quality, config })?.gates?.duplication ?? {};
  const targetDirs = Array.isArray(dupCfg.targetDirs) ? dupCfg.targetDirs : [];
  const ignoreGlobs = Array.isArray(dupCfg.ignoreGlobs)
    ? dupCfg.ignoreGlobs
    : [];
  return async (_files, opts) => {
    const effectiveCwd = opts?.cwd ?? cwd ?? process.cwd();
    return runDuplicationScan(
      {
        targetDirs,
        cwd: effectiveCwd,
        ignoreGlobs,
        additionalFormats: dupCfg.additionalFormats,
      },
      { detect, scanHeapMb: dupCfg.scanHeapMb },
    );
  };
}

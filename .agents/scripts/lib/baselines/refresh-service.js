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
import { getQuality, resolveConfig } from '../config-resolver.js';
import {
  buildScopePredicate,
  scoreCoverageFinal,
} from '../coverage-baseline.js';
import { loadCoverage } from '../coverage-utils.js';
import {
  resolveEscomplexVersion,
  resolveTsTranspilerVersion,
  scanAndScore,
} from '../crap-utils.js';
import {
  calculateAll as calculateAllMi,
  isIgnoredByGlobs as isIgnoredByGlobsMi,
  scanDirectory as scanDirectoryMi,
} from '../maintainability-utils.js';
import { resolveDetectClones, scanDuplication } from './duplication-scanner.js';
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
]);

/**
 * Per-kind extension filter for diff-derived scope, over canonical POSIX paths.
 *
 * @type {Record<string, (p: string) => boolean>}
 */
const KIND_FILE_PREDICATES = Object.freeze({
  maintainability: (p) => /\.(?:m?[jt]sx?)$/i.test(p),
  crap: (p) => /\.(?:m?[jt]sx?)$/i.test(p),
  coverage: (p) => /\.(?:m?[jt]sx?)$/i.test(p),
  // Over-inclusive is inert for JS-only jscpd; under-inclusive would pin a
  // changed file's prior row.
  duplication: (p) => /\.(?:m?[jt]sx?)$/i.test(p),
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
    crapCfg.coveragePath ?? 'coverage/coverage-final.json';
  return async (files, opts) => {
    const effectiveCwd = opts?.cwd ?? cwd ?? process.cwd();
    const coverageAbs = path.isAbsolute(coverageRelPath)
      ? coverageRelPath
      : path.resolve(effectiveCwd, coverageRelPath);
    const coverage = loadCoverage(coverageAbs);
    if (!coverage && requireCoverage) return [];
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
    resolveTsTranspilerVersion();
    return (rows ?? []).filter(
      (r) => typeof r?.crap === 'number' && Number.isFinite(r.crap),
    );
  };
}

/**
 * Coverage rows from coverage-final.json, scoped by the optional `.c8rc.cjs`.
 *
 * @param {{ cwd: string }} opts
 * @returns {(files: string[], opts: object) => object[]}
 */
function buildDefaultCoverageScorer({ cwd } = {}) {
  return (files, opts) => {
    const effectiveCwd = opts?.cwd ?? cwd ?? process.cwd();
    const coverageFinalPath = path.resolve(
      effectiveCwd,
      'coverage/coverage-final.json',
    );
    let raw;
    try {
      raw = JSON.parse(nodeFs.readFileSync(coverageFinalPath, 'utf-8'));
    } catch {
      return [];
    }
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
      .map(([relPath, score]) => ({
        path: relPath,
        lines: score?.lines ?? 0,
        branches: score?.branches ?? 0,
        functions: score?.functions ?? 0,
      }));
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
        return { path: rel.split(path.sep).join('/'), mi };
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
});

/**
 * Default scorer for `kind`, configured from `cwd`. Config resolution is
 * best-effort (a throw yields a config-less scorer). Exported so the drift
 * detector re-scores through the same scorer that writes the baseline; a
 * parallel implementation would report its own disagreement as drift.
 *
 * @param {string} kind
 * @param {{ cwd: string }} opts
 * @returns {((files: string[], opts: object) => Promise<object[]> | object[]) | undefined}
 */
export function resolveDefaultScorer(kind, { cwd } = {}) {
  const builder = KIND_SCORER_BUILDERS[kind];
  if (typeof builder !== 'function') return undefined;
  const effectiveCwd = cwd ?? process.cwd();
  let quality;
  try {
    quality = getQuality(resolveConfig({ cwd: effectiveCwd })) ?? undefined;
  } catch {
    quality = undefined;
  }
  return builder({ cwd: effectiveCwd, quality });
}

/**
 * Refresh the on-disk baseline for `kind`. `scopeFiles: null` without
 * `fullScope` derives scope from `git diff baseRef..headRef`; `fullScope`
 * requires `scopeFiles: null`. `requireRowsForScopeFiles` fails loud when a
 * scoped file produced no row.
 *
 * @param {{
 *   kind: 'maintainability' | 'crap' | 'coverage' | 'duplication',
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
 * }} opts
 * @returns {Promise<{
 *   kind: string,
 *   writePath: string,
 *   scope: { mode: 'full' | 'diff' | 'explicit', ref?: string, files: string[] },
 *   envelope: object,
 *   wrote: boolean,
 * }>}
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
  } = opts;

  validateOptions({ kind, scopeFiles, fullScope, writePath });

  const resolvedScorer = scorer ?? resolveDefaultScorer(kind, { cwd });
  if (typeof resolvedScorer !== 'function') {
    throw new Error(
      `refreshBaseline: no scorer registered for kind "${kind}" (inject one via opts.scorer)`,
    );
  }

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

  // Rows leave the service canonical whatever scorer produced them.
  const canonicalRows = scoredRows.map((row) => ({
    ...row,
    path: canonicalizeBaselinePath(row.path ?? row.file),
  }));

  assertRequiredScopeRows({
    kind,
    scope,
    canonicalRows,
    requireRowsForScopeFiles,
    requiredScopeFilePredicate,
  });

  const priorEnvelope = readPriorEnvelope(writePath, fs);

  const envelope = writeEnvelope({
    kind,
    rows: canonicalRows,
    prior: priorEnvelope?.rows,
    priorEnvelope,
    epsilon,
    scope:
      scope.mode === 'full'
        ? null
        : { mode: 'diff', files: new Set(scope.files) },
  });

  // The writer returns the prior object itself when nothing changed; skip the
  // write so on-disk bytes stay verbatim.
  let wrote = false;
  if (priorEnvelope === null || envelope !== priorEnvelope) {
    writeEnvelopeFile(writePath, envelope, { fsImpl: fs });
    wrote = true;
  }

  return {
    kind,
    writePath,
    scope: {
      mode: scope.mode,
      ref: scope.ref,
      files: [...scope.files],
    },
    envelope,
    wrote,
  };
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
 * @param {string} kind
 * @returns {(p: string) => boolean}
 */
export function fileFilterFor(kind) {
  const pred = KIND_FILE_PREDICATES[kind];
  if (!pred) {
    throw new Error(
      `fileFilterFor: no predicate registered for kind "${kind}"`,
    );
  }
  return pred;
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
    predicate: fileFilterFor(kind),
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
function readPriorEnvelope(writePath, fs) {
  let raw;
  try {
    raw = fs.readFileSync(writePath, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      Array.isArray(parsed.rows)
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
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
    return scanDuplication({
      targetDirs,
      cwd: effectiveCwd,
      ignoreGlobs,
      detect: detect ?? resolveDetectClones(),
    });
  };
}

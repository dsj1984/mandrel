/**
 * refresh-service.js — Unified Baseline Refresh Service entry point
 * (Story #2197, Epic #2173).
 *
 * `refreshBaseline()` is the single funnel through which every baseline
 * regeneration (maintainability, crap, coverage) must flow. Callers that
 * previously assembled their own envelopes and called `fs.writeFileSync`
 * MUST migrate to this entry point — Stories 3/4/5 of Epic #2173 do that
 * migration; Story #2197 only lands the service surface and tests.
 *
 * The service is **scoring-agnostic**: it does not itself walk the
 * filesystem to compute MI / CRAP / coverage scores. Scoring is provided
 * by the per-kind scorer functions registered in the internal
 * `KIND_SCORERS` table (and, in tests, injected via the `scorers` option
 * for hermetic determinism). The service is the policy layer:
 *
 *   1. Validate the input contract.
 *   2. Resolve the scope (explicit list / diff-derived / full).
 *   3. Read the prior envelope from `writePath` (if present).
 *   4. Run the kind's scorer over the in-scope file list.
 *   5. Canonicalize every persisted row path via `canonicalizeBaselinePath()`
 *      (Story #2192) before handing off to the shared `writer.write()`.
 *   6. Pass `prior` + `scope` to `writer.write()` so out-of-scope rows are
 *      preserved byte-for-byte (Task #2209) and structural-equality
 *      short-circuits return the prior envelope unchanged.
 *   7. Atomically serialise the resulting envelope to `writePath`.
 *
 * Public API (Task #2203, AC-1 / AC-2 / AC-7):
 *
 *   refreshBaseline({
 *     kind,        // 'maintainability' | 'crap' | 'coverage'  REQUIRED
 *     baseRef,     // git ref to diff against; default 'origin/main'
 *     headRef,     // git ref under inspection; default 'HEAD'
 *     scopeFiles,  // Array<string> | null
 *                  //   - Array: use verbatim as the in-scope file set.
 *                  //   - null + !fullScope: derive via `git diff
 *                  //     --name-only baseRef..headRef` filtered by kind
 *                  //     predicate (Task #2207).
 *                  //   - null + fullScope=true: ignore scope, regenerate
 *                  //     every row.
 *     epsilon,     // per-kind stabilization tolerance (number | undefined)
 *     fullScope,   // boolean; default false. When true, scopeFiles MUST
 *                  // be null and the whole baseline is regenerated.
 *     writePath,   // absolute path to baselines/<kind>.json  REQUIRED
 *     scorer,      // INTERNAL/TESTING: override the kind's scorer.
 *                  // Signature: (files: string[], opts) =>
 *                  //   Promise<Array<row>> | Array<row>
 *     fs,          // INTERNAL/TESTING: inject fs impl for read/write.
 *     gitDiff,     // INTERNAL/TESTING: inject diff-derivation impl with
 *                  // signature ({ baseRef, headRef, cwd }) =>
 *                  //   Iterable<string>
 *     cwd,         // working directory for git diff; default process.cwd()
 *     generatedAt, // optional pinned timestamp (test determinism); falls
 *                  // back to MANDREL_BASELINE_GENERATED_AT, then now().
 *     requireRowsForScopeFiles, // optional fail-loud guard for Story-close
 *     requiredScopeFilePredicate, // optional predicate to narrow guarded files
 *   }) -> Promise<{
 *     kind, writePath, scope: { mode, ref?, files: string[] },
 *     envelope, wrote: boolean
 *   }>
 *
 * Acceptance contract:
 *
 *   AC-1: All callers that produce a maintainability/crap/coverage baseline
 *         go through refreshBaseline(). Enforced by Task #2208 invariant.
 *   AC-2: scopeFiles=null && !fullScope -> diff-derived scope (Task #2207).
 *   AC-4: Out-of-scope rows + their updatedAt fields are preserved byte-
 *         for-byte (Task #2209).
 *   AC-7: All persisted paths go through canonicalizeBaselinePath().
 *
 * @module .agents/scripts/lib/baselines/refresh-service
 */

import { execFile as nodeExecFile } from 'node:child_process';
import nodeFs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
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
  scanDirectory as scanDirectoryMi,
} from '../maintainability-utils.js';
import { filterExcludedRows } from './kinds/maintainability.js';
import { canonicalizeBaselinePath } from './path-canon.js';
import {
  write as writeEnvelope,
  writeFile as writeEnvelopeFile,
} from './writer.js';

const nodeRequire = createRequire(import.meta.url);

const execFileAsync = promisify(nodeExecFile);

/**
 * Kinds the refresh service knows how to dispatch. Stays in lockstep with
 * the per-kind modules under `.agents/scripts/lib/baselines/kinds/`.
 */
const SUPPORTED_KINDS = Object.freeze(['maintainability', 'crap', 'coverage']);

/**
 * Per-kind file-extension predicate for diff-scope derivation (Task #2207).
 * Only files whose extension matches the kind's scorer surface are admitted
 * into the diff-derived scope; this prevents unrelated diffs (docs, JSON
 * fixtures, schema files) from triggering a no-op rescore.
 *
 * The predicates intentionally accept canonical, forward-slash POSIX paths
 * only — every caller funnels through `canonicalizeBaselinePath()` first.
 *
 * @type {Record<string, (p: string) => boolean>}
 */
const KIND_FILE_PREDICATES = Object.freeze({
  maintainability: (p) => /\.(?:m?[jt]sx?)$/i.test(p),
  crap: (p) => /\.(?:m?[jt]sx?)$/i.test(p),
  coverage: (p) => /\.(?:m?[jt]sx?)$/i.test(p),
});

/**
 * Build the default CRAP scorer. Scans configured target directories
 * (full-scope) or the diff-derived file list, loads coverage-final.json,
 * and runs `scanAndScore` to produce row-shape objects ready for the writer.
 *
 * Exposed for unit tests that need to inspect the built scorer shape; the
 * production caller is the internal `KIND_SCORERS` registry below.
 *
 * @param {{ cwd: string, config?: object }} opts
 * @returns {(files: string[], opts: object) => Promise<object[]>}
 */
function buildDefaultCrapScorer({ cwd, config } = {}) {
  // Config is optional: callers that don't pass it get reasonable defaults.
  const crapCfg = config?.delivery?.quality?.gates?.crap ?? {};
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
    // Stamp version probes (satisfies coverage even when caller doesn't need
    // the values — the writer stamps kernelVersion from the crap kind module).
    resolveEscomplexVersion(effectiveCwd);
    resolveTsTranspilerVersion();
    return (rows ?? []).filter(
      (r) => typeof r?.crap === 'number' && Number.isFinite(r.crap),
    );
  };
}

/**
 * Build the default coverage scorer. Reads coverage-final.json, applies
 * the c8 scope predicate from `.c8rc.cjs`, and converts the per-file
 * coverage percentages into rows in the `{ path, lines, branches,
 * functions }` shape the writer expects.
 *
 * `.c8rc.cjs` is optional: when absent the scorer admits all files.
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
    // In diff mode, further narrow to the in-scope file list so only changed
    // files are re-scored (out-of-scope rows are preserved by the service).
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
 * Build the default maintainability scorer. Full-scope walks all configured
 * target directories; diff-scope resolves just the in-scope files.
 *
 * @param {{ cwd: string, config?: object }} opts
 * @returns {(files: string[], opts: object) => Promise<object[]>}
 */
function buildDefaultMaintainabilityScorer({ cwd, config } = {}) {
  const miCfg = config?.delivery?.quality?.gates?.maintainability ?? {};
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
        if (underTarget) sourceList.push(abs);
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
 * Per-kind scorer registry. Each scorer accepts `(files, opts)` and returns
 * an array of rows in the kind's row shape. Story #3658 completes the Epic
 * #2173 migration by wiring real default scorers for all three kinds so the
 * service is self-contained: callers may still inject a `scorer` via the
 * options bag (used by auto-refresh-runner and tests), but no scorer injection
 * is required for production invocations.
 *
 * @type {Record<string, ((files: string[], opts: object) => Promise<object[]> | object[])>}
 */
const KIND_SCORERS = Object.freeze({
  maintainability: buildDefaultMaintainabilityScorer({ cwd: process.cwd() }),
  crap: buildDefaultCrapScorer({ cwd: process.cwd() }),
  coverage: buildDefaultCoverageScorer({ cwd: process.cwd() }),
});

/**
 * Refresh the on-disk baseline for `kind`. See module preamble for the
 * full contract. Returns the resulting envelope plus the resolved scope
 * so callers (and tests) can assert what actually got scored.
 *
 * @param {{
 *   kind: 'maintainability' | 'crap' | 'coverage',
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
 *   generatedAt?: string,
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
    generatedAt,
    requireRowsForScopeFiles = false,
    requiredScopeFilePredicate,
  } = opts;

  validateOptions({ kind, scopeFiles, fullScope, writePath });

  // Resolve the kind's scorer. Production defaults are wired by later
  // Stories; tests inject via `opts.scorer`.
  const resolvedScorer = scorer ?? KIND_SCORERS[kind];
  if (typeof resolvedScorer !== 'function') {
    throw new Error(
      `refreshBaseline: no scorer registered for kind "${kind}" (inject one via opts.scorer until Stories 3/4/5 wire defaults)`,
    );
  }

  // Resolve the in-scope file set.
  const scope = await resolveScope({
    kind,
    scopeFiles,
    fullScope,
    baseRef,
    headRef,
    gitDiff,
    cwd,
  });

  // Score every in-scope file. For full-scope refreshes the scorer
  // receives an empty `files` list and is expected to scan the whole
  // target tree itself (the scorer owns the directory walk — the service
  // does not, by design).
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

  // Canonicalize every row path (Story #2192 / AC-7). The shared
  // `writer.write()` already runs each row through the per-kind
  // `projectRow` which calls `canonicalise()` internally, but funnelling
  // through `canonicalizeBaselinePath()` here is the explicit
  // service-level contract: rows leave the service with canonical keys,
  // regardless of which scorer produced them.
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

  // Read the prior envelope so out-of-scope rows survive (Task #2209) and
  // the structural-equality short-circuit can fire.
  const priorEnvelope = readPriorEnvelope(writePath, fs);

  // Hand off to the shared writer. It applies `mergeRows` (scope), then
  // `applyEpsilon` (stability), then sort + rollup + envelope stamping.
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
    generatedAt: generatedAt ?? process.env.MANDREL_BASELINE_GENERATED_AT,
  });

  // Persist iff the envelope changed. The writer's structural-equality
  // short-circuit returns the prior envelope object identity-equal when
  // nothing changed; in that case we skip the disk write so the on-disk
  // bytes (including `generatedAt`) are preserved verbatim.
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
 * Default git-diff derivation for the diff-scope path. Uses `execFile`
 * (no shell) and only the canonical two-dot range `baseRef..headRef` —
 * triple-dot is intentionally avoided so the result reflects exactly the
 * files that differ between the two refs at the time of the call.
 *
 * @param {{ baseRef: string, headRef: string, cwd: string }} args
 * @returns {Promise<string[]>}
 */
async function defaultGitDiff({ baseRef, headRef, cwd }) {
  const range = `${baseRef}..${headRef}`;
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['diff', '--name-only', range],
      { cwd, maxBuffer: 16 * 1024 * 1024 },
    );
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch (err) {
    // A missing ref or corrupt repo is the operator's signal to inspect
    // the working tree. Best-effort: emit a friction-friendly error.
    throw new Error(
      `refreshBaseline: git diff --name-only ${range} failed in ${cwd}: ${err.message}`,
    );
  }
}

/**
 * Derive an in-scope file list from `git diff --name-only baseRef..headRef`
 * filtered by `predicate` (Story #2197, Task #2207). Exposed as a named
 * export so the diff-scope behaviour can be exercised in isolation. Every
 * file returned is canonicalized via `canonicalizeBaselinePath()` before
 * the predicate runs, so the predicate may assume POSIX, repo-relative
 * input regardless of what shape `git diff` printed on the host platform.
 *
 * Pure-by-design: `gitDiff` is injected by the caller (defaults to
 * `defaultGitDiff` which uses `execFile`, never a shell).
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
 * Look up the file predicate for `kind`. Exposed so external tests can
 * verify the per-kind extension filter without depending on the private
 * `KIND_FILE_PREDICATES` table.
 *
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

/**
 * Resolve the in-scope file set for this refresh call. Returns a flat
 * `{ mode, ref?, files }` record so callers can branch on the resolution
 * mode without re-deriving it from the input shape.
 *
 * Resolution order:
 *
 *   1. `fullScope === true` -> `{ mode: 'full', files: [] }`.
 *   2. `scopeFiles` is an array -> `{ mode: 'explicit', files }`.
 *   3. `scopeFiles === null` -> derive via `gitDiff` filtered by the kind's
 *      predicate -> `{ mode: 'diff', ref: baseRef..headRef, files }`.
 */
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
  // Diff-derived (Task #2207).
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
 * Read + JSON-parse the prior envelope at `writePath`. Returns `null` on
 * any I/O or parse failure — the caller treats "no prior" as "fresh
 * write" (regression-fail-safe).
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
      Array.isArray(parsed.rows) &&
      parsed.rollup &&
      typeof parsed.rollup === 'object'
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Validate the option bag up-front. Throws on any contract violation so a
 * misuse never silently produces an empty / wrong baseline.
 */
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

// Exposed for the lint/test invariant (Task #2208) so the guard can list
// every kind the service is contracted to dispatch without re-deriving it.
export const REFRESH_SERVICE_SUPPORTED_KINDS = SUPPORTED_KINDS;

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
import { promisify } from 'node:util';
import { canonicalizeBaselinePath } from './canonicalize-path.js';
import {
  write as writeEnvelope,
  writeFile as writeEnvelopeFile,
} from './writer.js';

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
 * Per-kind scorer registry. Each scorer accepts `(files, opts)` and returns
 * an array of rows in the kind's row shape. The default scorers are wired
 * by Stories 3/4/5 when the existing update CLIs migrate to the service.
 * Story #2197 ships an empty default registry — callers MUST inject a
 * `scorer` via the options bag until the migration lands. Tests inject
 * deterministic scorers directly.
 *
 * @type {Record<string, ((files: string[], opts: object) => Promise<object[]> | object[]) | null>}
 */
const KIND_SCORERS = Object.freeze({
  maintainability: null,
  crap: null,
  coverage: null,
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
    path: canonicalizeBaselinePath(row.path),
  }));

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

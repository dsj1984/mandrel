import escomplex from 'typhonjs-escomplex';
import { coverageForMethodInEntry } from './coverage-utils.js';
// `finalizeMethodRowsWithBaseline` (Story #4981) lives in
// crap-baseline-join.js — `resolveRawRow`, the per-row policy it shares with
// `finalizeMethodRows` below, is imported from there so the two stay a
// single implementation.
import { resolveRawRow } from './crap-baseline-join.js';
// `COORDINATE_ORIGINAL` / `COORDINATE_TRANSPILED` / `crapFormula` (Story
// #4866 / this module's original home) now live in crap-coordinates.js —
// re-exported here so every existing importer of this module is unaffected.
import {
  COORDINATE_ORIGINAL,
  COORDINATE_TRANSPILED,
  crapFormula,
} from './crap-coordinates.js';
import { deriveMethodIdentities } from './crap-method-identity.js';
import { install as installAstCompat } from './escomplex-ast-compat.js';

export { COORDINATE_ORIGINAL, COORDINATE_TRANSPILED, crapFormula };

/**
 * Sentinel returned by {@link calculateCrapForSource} for a source the kernel
 * cannot parse. Deliberately **not** `[]`: a caller receiving an empty array
 * cannot tell an unscorable file from one with no methods, which is how a
 * parse failure used to reach the baseline as a silent zero (Story #5311).
 */
export const UNSCORABLE = null;

// The kernel's code generator predates the Babel AST its own parser emits, so
// ordinary modern syntax (`?.`, `await` or a regex in a loop head, object
// spread in a default parameter) aborts `analyzeModule` for the WHOLE file —
// see `escomplex-ast-compat.js` for the defect and the upstream status.
//
// Story #5311: the install belongs here, at the scoring kernel, because this
// is where both CRAP scorers converge — `calculateCrapForSource` (the worker
// path) and `crap-utils.js#analyzeOnce` (the serial path, which reaches this
// module for `methodRowsFromReport`). It used to be reached only as a side
// effect of `maintainability-engine.js` sitting somewhere in the serial path's
// import graph, which the worker's graph never included: 362 methods across
// 21 files scored zero via workers and scored fine serially, and
// `POOL_SERIAL_THRESHOLD` makes the worker path the only one a real repo
// takes. Anchoring it at the kernel makes the next worker entrypoint correct
// by construction rather than by an import nobody would guess is load-bearing.
installAstCompat();

/**
 * Derive the raw per-method CRAP rows from an escomplex report.
 *
 * Single-sourced between `calculateCrapForSource` (CRAP-only path) and
 * `analyzeOnce` (combined MI + CRAP path) so the two cannot drift on how a
 * method's line is remapped or its coverage joined — the parity the
 * combined-parity suite asserts.
 *
 * **Coordinates (Story #4775, corrected by Story #4866).** `mapLine`
 * translates escomplex's `lineStart` — which is in *transpiled* coordinates
 * for a TS/TSX source — into the *original source* coordinates istanbul's
 * `fnMap` uses. A `null` mapper means the two coordinate systems already
 * coincide (plain JavaScript).
 *
 * #4775 let an unresolvable line fall back to the un-remapped value, which
 * made one scan emit rows in two coordinate systems with nothing on the row
 * saying which. Each row now records its own `coordinateSystem`, and an
 * un-remapped row joins no coverage at all: joining a transpiled line against
 * an original-source `fnMap` does not merely miss, it can land inside an
 * unrelated function's range and mis-attribute that function's coverage. An
 * honest `coverage: null` lets the scanner's `requireCoverage` policy decide,
 * exactly as it does for a genuinely uninstrumented method.
 *
 * @param {object|null} report An `escomplex.analyzeModule` report.
 * @param {object|null} coverageForFile Istanbul coverage entry for this file.
 * @param {((line: number) => number|null)|null} [mapLine]
 * @returns {Array<{
 *   method: string,
 *   anonymous: boolean,
 *   startLine: number,
 *   cyclomatic: number,
 *   coverage: number|null,
 *   crap: number|null,
 *   coordinateSystem: 'original'|'transpiled',
 * }>}
 */
/**
 * Resolve one method's line into a coordinate and the provenance of that
 * coordinate — the single place the rule lives.
 *
 * No mapper means the source was never transpiled, so its line already IS an
 * original-source coordinate. A mapper that resolves yields one. A mapper
 * that does not leaves the transpiled line, said so.
 *
 * @param {number} rawStartLine escomplex's `lineStart`.
 * @param {((line: number) => number|null)|null} mapLine
 * @returns {{startLine: number, coordinateSystem: 'original'|'transpiled'}}
 */
function resolveCoordinate(rawStartLine, mapLine) {
  if (typeof mapLine !== 'function') {
    return { startLine: rawStartLine, coordinateSystem: COORDINATE_ORIGINAL };
  }
  const mapped = mapLine(rawStartLine);
  return typeof mapped === 'number'
    ? { startLine: mapped, coordinateSystem: COORDINATE_ORIGINAL }
    : { startLine: rawStartLine, coordinateSystem: COORDINATE_TRANSPILED };
}

export function methodRowsFromReport(report, coverageForFile, mapLine = null) {
  const methods = report?.methods ?? [];
  // Identities are derived over the WHOLE method list, before any row is
  // skipped, and read back by index (Story #4969). Deriving them from the
  // surviving rows instead would let an unscorable method's absence shift its
  // siblings' ordinals — reintroducing, through the back door, exactly the
  // position dependence this replaces.
  const identities = deriveMethodIdentities(methods);
  const rows = [];
  for (const [i, m] of methods.entries()) {
    const rawStartLine = m?.lineStart;
    if (typeof rawStartLine !== 'number') continue;
    const { startLine, coordinateSystem } = resolveCoordinate(
      rawStartLine,
      mapLine,
    );
    const cyclomatic = m?.cyclomatic ?? 0;
    const coverage =
      coverageForFile && coordinateSystem === COORDINATE_ORIGINAL
        ? coverageForMethodInEntry(coverageForFile, startLine)
        : null;
    const crap = coverage === null ? null : crapFormula(cyclomatic, coverage);
    rows.push({
      ...identities[i],
      startLine,
      cyclomatic,
      coverage,
      crap,
      coordinateSystem,
    });
  }
  return rows;
}

/**
 * Apply the scanner's `requireCoverage` policy to raw method rows and report
 * how much of the coverage join actually landed.
 *
 * Two policies, one honest each way (Story #4775, fix part 3):
 *
 *   - `requireCoverage: true` — an unresolved method is skipped and counted,
 *     exactly as before. The baseline stays a record of measured code.
 *   - `requireCoverage: false` — an unresolved method scores as **0%
 *     covered** (`crap = c² + c`, the formula's own treatment of untested
 *     code) and lands in the baseline. Previously the flag only stopped
 *     whole *files* being skipped while each individual method was still
 *     dropped, which made it a no-op for baseline population — the caller
 *     asked for "score it anyway" and got silence.
 *
 * **Absent coverage is not zero coverage (Story #4871).** The 0%-covered
 * inference above is only defensible when a coverage **artifact** exists and
 * simply reports nothing for this method — "the tests ran and never reached
 * it" is a measurement. When no artifact was produced at all — a freshly
 * initialized story worktree, whose `coverage/` directory does not exist —
 * nothing was measured, and filling the gap with 0% manufactures a maximal
 * CRAP out of an absent observation, failing the first commit on files the
 * change never touched. `coverageAvailable: false` therefore makes such a
 * method **unscorable** under either policy: skipped and counted, never
 * filled. It is deliberately keyed on the artifact, not the per-file entry,
 * so `requireCoverage: false` keeps meaning "score untested code" whenever a
 * real coverage run stands behind the verdict.
 *
 * **Unjoinable is not untested (Story #4901).** Both policies above are about
 * a method whose coverage is *absent*; neither is about one whose coverage
 * could not be **joined**. A transpiled `startLine` is the latter — not in
 * the coordinate space the `fnMap` or the baseline is keyed against — so 0%
 * is not a measurement but a number invented for it, and `crapFormula(c, 0)`
 * is the maximal `c² + c`. Excluded under **either** policy, and counted.
 *
 * `resolvedMethods` / `totalMethods` count the *join*, not the fill, which is
 * what makes them a health signal for the updater's fail-closed
 * resolution-rate floor — so the exclusion is applied *after* both counters.
 *
 * @param {Array<object>} rawRows Rows from `methodRowsFromReport`.
 * @param {{requireCoverage?: boolean, coverageAvailable?: boolean}} [opts]
 * @returns {{
 *   rows: Array<object>,
 *   skippedMethodsNoCoverage: number,
 *   resolvedMethods: number,
 *   totalMethods: number,
 * }}
 */
export function finalizeMethodRows(
  rawRows,
  { requireCoverage = true, coverageAvailable = true } = {},
) {
  const rows = [];
  let skippedMethodsNoCoverage = 0;
  let resolvedMethods = 0;
  let totalMethods = 0;
  for (const mr of rawRows ?? []) {
    totalMethods += 1;
    const resolution = resolveRawRow(mr, {
      requireCoverage,
      coverageAvailable,
    });
    if (resolution.resolved) resolvedMethods += 1;
    if (resolution.row === null) {
      skippedMethodsNoCoverage += 1;
      continue;
    }
    rows.push(resolution.row);
  }
  return { rows, skippedMethodsNoCoverage, resolvedMethods, totalMethods };
}

// The incremental-mode join (Story #4981) lives in crap-baseline-join.js;
// re-exported here so it stays reachable from the scoring kernel's existing
// public surface.
export { finalizeMethodRowsWithBaseline } from './crap-baseline-join.js';

/**
 * Score each method in a JavaScript source for Change Risk Anti-Patterns
 * (CRAP): `c² · (1 − cov)³ + c`, where `c` is cyclomatic complexity and `cov`
 * is the per-method statement-coverage ratio in [0, 1].
 *
 * Kernel contract:
 *   - Pure (no I/O, no AST parse beyond the one delegated to escomplex via
 *     `analyzeModule`).
 *   - Methods whose coverage cannot be resolved from `coverageForFile` —
 *     including every method whose line stayed in transpiled coordinates —
 *     produce `coverage: null` and `crap: null`. Callers apply their own
 *     `requireCoverage` policy at the scanner level (`finalizeMethodRows`);
 *     this kernel never decides to skip.
 *   - A parse error returns {@link UNSCORABLE} (`null`) — the file could not
 *     be scored at all, which is a different fact from "it has no methods"
 *     (`[]`). Story #5311: returning `[]` for both collapsed them, and every
 *     caller's drop path for an unscorable file became unreachable — the
 *     whole parse-failure class landed in the baseline as a clean zero.
 *     Callers MUST branch on `rows === null` before iterating.
 *
 * @param {string} source JavaScript source text (possibly transpiled).
 * @param {object|null} coverageForFile The inner value from a
 *   `coverage-final.json` map keyed by this file's path, or null when no
 *   coverage data is available for this file.
 * @param {((line: number) => number|null)|null} [mapLine] Transpiled →
 *   original line resolver; see `methodRowsFromReport`.
 * @returns {Array<{
 *   method: string,
 *   anonymous: boolean,
 *   startLine: number,
 *   cyclomatic: number,
 *   coverage: number|null,
 *   crap: number|null,
 *   coordinateSystem: 'original'|'transpiled',
 * }>|null} The method rows, or {@link UNSCORABLE} when the source did not
 *   parse.
 */
export function calculateCrapForSource(
  source,
  coverageForFile,
  mapLine = null,
) {
  let report;
  try {
    report = escomplex.analyzeModule(source);
  } catch {
    return UNSCORABLE;
  }
  return methodRowsFromReport(report, coverageForFile, mapLine);
}

/**
 * Derive the deterministic single-axis fixes that would bring a method at
 * cyclomatic complexity `c` at or under the `target` CRAP score.
 *
 * Two orthogonal remediations are surfaced:
 *   - `minComplexityAt100Cov`: branch count a refactor must reach so that,
 *     even untested, the method would pass (`CRAP@cov=1 = c` → `c ≤ target`).
 *     Computed as `floor(sqrt(target))`.
 *   - `minCoverageAtCurrentComplexity`: ratio a test-addition must reach at
 *     the current complexity to pass, derived by inverting the formula:
 *     `cov = 1 − ((target − c) / c²)^(1/3)`. Null when unachievable — i.e.
 *     `c > target` (CRAP at 100% coverage still exceeds the target) or when
 *     `c ≤ 0` (no branches; coverage is meaningless).
 *
 * Callers apply the target convention: `baseline` for regressions,
 * `newMethodCeiling` for new violations. The helper stays scalar so it can
 * be re-used by MI-parity output or future guidance surfaces.
 *
 * @param {{ cyclomatic: number, target: number }} params
 * @returns {{
 *   crapCeiling: number,
 *   minComplexityAt100Cov: number,
 *   minCoverageAtCurrentComplexity: number | null,
 * } | null}
 */
export function deriveFixGuidance({ cyclomatic, target } = {}) {
  const c = Number(cyclomatic);
  const t = Number(target);
  if (!Number.isFinite(c) || !Number.isFinite(t) || t < 0) return null;

  const minComplexityAt100Cov = Math.max(0, Math.floor(Math.sqrt(t)));

  let minCoverageAtCurrentComplexity = null;
  if (c > 0 && t >= c) {
    // `(t - c) / c²` lies in `[0, 1]` for `t ∈ [c, c + c²]`; Math.cbrt stays
    // real-valued for any input so a numeric clamp is the only safeguard.
    const ratio = (t - c) / (c * c);
    const minCov = 1 - Math.cbrt(ratio);
    minCoverageAtCurrentComplexity = Math.max(0, Math.min(1, minCov));
  }

  return {
    crapCeiling: t,
    minComplexityAt100Cov,
    minCoverageAtCurrentComplexity,
  };
}

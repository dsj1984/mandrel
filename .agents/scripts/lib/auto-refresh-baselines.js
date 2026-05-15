/**
 * auto-refresh-baselines.js — pure delta-cap evaluator for the bounded
 * baseline auto-refresh at story-close (Story #1398, Epic #1386).
 *
 * After the close-validation chain has passed (`runPreMergeGatesWithAttribution`
 * already auto-refreshed any attributable drift), `story-close` regenerates
 * the baseline rows scoped to the Story diff and asks this evaluator whether
 * the regenerated rows are within bounded delta caps. If yes, `story-close`
 * amends the regenerated rows into the close commit (no separate
 * `baseline-refresh:` commit). If no, `story-close` refuses to amend, leaves
 * the close commit untouched, and appends a `baseline-refresh-regression`
 * friction signal naming the offending file(s)/method(s).
 *
 * The evaluator is a pure function — no I/O, no spawn, no provider calls.
 * Inputs are fixtures the caller has already loaded; outputs are plain
 * objects ready for the friction-signal renderer.
 *
 * Contract:
 *
 *   evaluateAutoRefresh({ scoredRows, baseline, caps }) →
 *     {
 *       canAutoRefresh: boolean,
 *       miOverCap:   Array<{ path, baseline, scored, delta }>,
 *       crapOverCap: Array<{ file, method, startLine, baseline, scored, delta }>,
 *       refusalReasons: string[],
 *     }
 *
 *   - `scoredRows` carries the *just-regenerated* rows, partitioned by kind:
 *       { mi: Array<{ path, mi }>, crap: Array<{ file, method, startLine, crap }> }
 *     Either kind may be absent or empty — the evaluator treats a missing
 *     kind as "no rows of that kind to evaluate".
 *
 *   - `baseline` carries the *previously committed* rows, in the same shape:
 *       { mi: Array<{ path, mi }>, crap: Array<{ file, method, startLine, crap }> }
 *     A scored row whose path/method has no matching baseline row is treated
 *     as "new" and evaluated against the cap with `baseline = null` — its
 *     delta is the scored value vs an absent prior, which by convention
 *     never breaches a cap (the row didn't exist before, there is no drop /
 *     jump to bound). New rows therefore never block auto-refresh.
 *
 *   - `caps = { miDropCap: number, crapJumpCap: number }` carries the
 *     bounded delta thresholds. The defaults (`miDropCap: 1.5`,
 *     `crapJumpCap: 5`) live in `.agents/full-agentrc.json` under
 *     `agentSettings.quality.autoRefresh` (Story #1413). Callers always
 *     pass an explicit caps object; the evaluator does not default-fill.
 *
 * Cap semantics:
 *
 *   - MI is "higher is better". A *drop* (baseline.mi − scored.mi) greater
 *     than `miDropCap` breaches the cap. Improvements (scored.mi ≥ baseline.mi
 *     or any negative drop) never breach.
 *
 *   - CRAP is "lower is better". A *jump* (scored.crap − baseline.crap)
 *     greater than `crapJumpCap` breaches the cap. Improvements (scored.crap
 *     ≤ baseline.crap or any negative jump) never breach.
 *
 *   - Equality at the cap (delta === cap) is *under* the cap — the cap is
 *     the maximum allowed delta, not the strict maximum. This matches the
 *     Tech Spec's "at or below" wording and the AC1 phrasing ("every scored
 *     row delta is at or below the configured caps").
 *
 *   - Missing baseline rows (path/method new in the scored set) are recorded
 *     with `baseline: null` and a `delta` of 0 — they never push
 *     `canAutoRefresh` to `false`. The evaluator does not surface them in
 *     `miOverCap` / `crapOverCap`. The friction renderer therefore never
 *     names a file that was newly introduced by the Story.
 *
 * The renderer is pure so callers can unit-test the cap math against fixed
 * inputs without spawning git or reading the filesystem. Story-close wires
 * it into the post-validation amend path; tests for the wiring live in
 * `tests/story-close-auto-refresh.test.js` (Story #1415).
 */

/**
 * Numeric guard — accepts finite numbers only. Strings, NaN, Infinity, null,
 * undefined all fail. The evaluator runs against scored rows produced by the
 * MI / CRAP scanners (which always emit numeric scores) and baseline rows
 * loaded from the on-disk JSON (which JSON-parses numeric fields), so a
 * non-finite value here signals upstream corruption — we exclude the row
 * conservatively rather than coercing.
 */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Index `baseline.mi` rows by `path` for O(1) lookup. Bad rows (missing
 * `path`, non-string `path`, non-finite `mi`) are skipped — their absence
 * causes the matching scored row to be treated as "new", which never blocks
 * auto-refresh.
 */
function indexMiBaseline(rows) {
  const byPath = new Map();
  if (!Array.isArray(rows)) return byPath;
  for (const row of rows) {
    if (!row || typeof row.path !== 'string' || row.path.length === 0) continue;
    if (!isFiniteNumber(row.mi)) continue;
    byPath.set(row.path, row);
  }
  return byPath;
}

/**
 * Index `baseline.crap` rows by `${file}::${method}` for O(1) lookup.
 * `startLine` is *not* part of the key — the scored row may have shifted
 * lines vs the baseline (legitimate refactor), and we want the closest match
 * by method name. When the same method appears multiple times in the same
 * file (e.g. nested helpers), we pick the closest startLine at lookup time.
 *
 * Bad rows (missing `file`/`method`, non-finite `crap`) are skipped — their
 * absence causes the matching scored row to be treated as "new".
 */
function indexCrapBaseline(rows) {
  const byMethod = new Map();
  if (!Array.isArray(rows)) return byMethod;
  for (const row of rows) {
    if (!row || typeof row.file !== 'string' || row.file.length === 0) {
      continue;
    }
    if (typeof row.method !== 'string' || row.method.length === 0) continue;
    if (!isFiniteNumber(row.crap)) continue;
    const key = `${row.file}::${row.method}`;
    if (!byMethod.has(key)) byMethod.set(key, []);
    byMethod.get(key).push(row);
  }
  return byMethod;
}

/**
 * Pick the closest baseline candidate by `startLine` distance. When the
 * scored row's `startLine` is missing or all candidates have missing line
 * info, returns the first candidate — matches `baseline-attribution-wiring`'s
 * `diffCrapBaselines` resolution policy.
 */
function pickClosestBaseline(candidates, scoredStartLine) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  const target = isFiniteNumber(scoredStartLine) ? scoredStartLine : 0;
  let best = candidates[0];
  let bestDist = Math.abs((best.startLine ?? 0) - target);
  for (let i = 1; i < candidates.length; i += 1) {
    const c = candidates[i];
    const dist = Math.abs((c?.startLine ?? 0) - target);
    if (dist < bestDist) {
      bestDist = dist;
      best = c;
    }
  }
  return best;
}

/**
 * Evaluate every MI scored row against the MI cap. Returns the over-cap
 * subset; rows under the cap (or new) are simply omitted from the result.
 *
 * MI is higher-is-better, so drift = baseline.mi − scored.mi. A positive
 * drift is a regression; a drift greater than `miDropCap` breaches the cap.
 */
function evaluateMiRows({ scoredRows, baselineIndex, miDropCap }) {
  const overCap = [];
  if (!Array.isArray(scoredRows)) return overCap;
  for (const row of scoredRows) {
    if (!row || typeof row.path !== 'string' || row.path.length === 0) {
      continue;
    }
    if (!isFiniteNumber(row.mi)) continue;
    const baselineRow = baselineIndex.get(row.path);
    if (!baselineRow) continue; // new path — never breaches
    const drop = baselineRow.mi - row.mi;
    if (drop > miDropCap) {
      overCap.push({
        path: row.path,
        baseline: baselineRow.mi,
        scored: row.mi,
        delta: drop,
      });
    }
  }
  return overCap;
}

/**
 * Evaluate every CRAP scored row against the CRAP cap. Returns the over-cap
 * subset; rows under the cap (or new) are simply omitted from the result.
 *
 * CRAP is lower-is-better, so jump = scored.crap − baseline.crap. A positive
 * jump is a regression; a jump greater than `crapJumpCap` breaches the cap.
 */
function evaluateCrapRows({ scoredRows, baselineIndex, crapJumpCap }) {
  const overCap = [];
  if (!Array.isArray(scoredRows)) return overCap;
  for (const row of scoredRows) {
    if (!row || typeof row.file !== 'string' || row.file.length === 0) {
      continue;
    }
    if (typeof row.method !== 'string' || row.method.length === 0) continue;
    if (!isFiniteNumber(row.crap)) continue;
    const candidates = baselineIndex.get(`${row.file}::${row.method}`);
    const baselineRow = pickClosestBaseline(candidates, row.startLine);
    if (!baselineRow) continue; // new method — never breaches
    const jump = row.crap - baselineRow.crap;
    if (jump > crapJumpCap) {
      overCap.push({
        file: row.file,
        method: row.method,
        startLine: row.startLine,
        baseline: baselineRow.crap,
        scored: row.crap,
        delta: jump,
      });
    }
  }
  return overCap;
}

/**
 * Build the human-readable refusal reasons array. Stable formatting so the
 * friction-signal renderer (and unit tests) can pin the strings exactly.
 *
 * Each reason names the kind, the file/path/method, and the absolute delta
 * vs the cap. Numbers are formatted to 3 decimal places to match the
 * baseline JSON's float precision without trailing-zero noise.
 */
function buildRefusalReasons({ miOverCap, crapOverCap, caps }) {
  const reasons = [];
  for (const r of miOverCap) {
    reasons.push(
      `MI drop ${r.delta.toFixed(3)} > cap ${caps.miDropCap} on ${r.path} (baseline ${r.baseline.toFixed(3)} → scored ${r.scored.toFixed(3)})`,
    );
  }
  for (const r of crapOverCap) {
    reasons.push(
      `CRAP jump ${r.delta.toFixed(3)} > cap ${caps.crapJumpCap} on ${r.file}::${r.method} (baseline ${r.baseline.toFixed(3)} → scored ${r.scored.toFixed(3)})`,
    );
  }
  return reasons;
}

/**
 * Pure delta-cap evaluator. Decides whether the regenerated rows can be
 * silently amended into the close commit (under-cap) or whether the close
 * must refuse the amend and surface a `baseline-refresh-regression` friction
 * signal (over-cap).
 *
 * @param {object} input
 * @param {{
 *   mi?: Array<{ path: string, mi: number }>,
 *   crap?: Array<{ file: string, method: string, startLine?: number, crap: number }>,
 * }} input.scoredRows  Just-regenerated rows for the Story diff.
 * @param {{
 *   mi?: Array<{ path: string, mi: number }>,
 *   crap?: Array<{ file: string, method: string, startLine?: number, crap: number }>,
 * }} input.baseline    Previously committed rows.
 * @param {{ miDropCap: number, crapJumpCap: number }} input.caps
 *   Bounded delta caps (defaults: miDropCap=1.5, crapJumpCap=5 — see
 *   `.agents/full-agentrc.json` under `agentSettings.quality.autoRefresh`).
 * @returns {{
 *   canAutoRefresh: boolean,
 *   miOverCap:   Array<{ path: string, baseline: number, scored: number, delta: number }>,
 *   crapOverCap: Array<{ file: string, method: string, startLine?: number, baseline: number, scored: number, delta: number }>,
 *   refusalReasons: string[],
 * }}
 */
export function evaluateAutoRefresh({
  scoredRows = {},
  baseline = {},
  caps,
} = {}) {
  if (
    !caps ||
    !isFiniteNumber(caps.miDropCap) ||
    !isFiniteNumber(caps.crapJumpCap)
  ) {
    throw new TypeError(
      'evaluateAutoRefresh: caps.{miDropCap,crapJumpCap} must be finite numbers',
    );
  }

  const miBaselineIdx = indexMiBaseline(baseline?.mi);
  const crapBaselineIdx = indexCrapBaseline(baseline?.crap);

  const miOverCap = evaluateMiRows({
    scoredRows: scoredRows?.mi,
    baselineIndex: miBaselineIdx,
    miDropCap: caps.miDropCap,
  });
  const crapOverCap = evaluateCrapRows({
    scoredRows: scoredRows?.crap,
    baselineIndex: crapBaselineIdx,
    crapJumpCap: caps.crapJumpCap,
  });

  const canAutoRefresh = miOverCap.length === 0 && crapOverCap.length === 0;
  const refusalReasons = canAutoRefresh
    ? []
    : buildRefusalReasons({ miOverCap, crapOverCap, caps });

  return { canAutoRefresh, miOverCap, crapOverCap, refusalReasons };
}

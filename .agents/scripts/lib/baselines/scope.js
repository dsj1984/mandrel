// .agents/scripts/lib/baselines/scope.js
//
// Story #1962 / Task #1970 — the ScopeResolution helper behind the
// `check-baselines.js` dispatcher: `resolveDispatchScope` in
// `lib/orchestration/check-baselines/phases/compare.js` is its one
// caller. Routing the read side's scope decision through a single pure
// function keeps the precedence rules from being re-implemented per gate.
//
// It is NOT the writers' resolver. `lib/baselines/refresh-service.js`
// defines its own private `resolveScope` (Story #3658) over a different
// input set, and the header here used to claim otherwise — a claim that
// made the read/write pair look coupled when it is not. Corrected in
// Story #4922.
//
// The resolver is intentionally pure — it takes already-extracted
// inputs and returns a frozen ScopeResolution. Env reading and config
// loading happen in the caller; that keeps this module trivially
// testable.
//
// Precedence (highest → lowest):
//
//   1. Environment — `BASELINE_SCOPE` ('full' | 'diff') and
//      `BASELINE_REF` (any git ref). The dispatcher reads these from
//      `process.env` and forwards via `envScope` / `envRef` so the
//      resolver itself never touches process state. CI sets these.
//   2. Default — `mode='diff'` against `ref='main'`. This is the
//      framework-wide fallback when the environment names nothing.
//
// Story #5382 removed the config layer between them: the
// `delivery.quality.gateScoping` block it read was never set by any
// surveyed config and always resolved to the default above.
//
// Story #4922 removed a fourth, highest-precedence layer: a
// `cliFlags.fullScope` / `cliFlags.changedSinceRef` operator override,
// plus the `cliFlags.changedFiles` → `files` plumbing that fed it. No
// production caller ever populated any of the three — only this module's
// own unit tests did — so the layer's only effect was to advertise a
// `--full-scope` / `--changed-since` contract that `check-baselines.js`
// does not implement, and a `files` set that no consumer read. Operators
// who need full scope set `BASELINE_SCOPE=full`, which is what CI does.
// (`mergeRowsByScope` below still takes a `files`-bearing scope — that
// one comes from the refresh service's own resolver, not from here.)
//
// Missing-ref fallback: when the resolved mode is `'diff'` but no ref
// is supplied at any layer, the resolver falls back to `'main'` rather
// than producing a half-resolved scope with `ref=null`. The dispatcher
// would have to invent a default anyway; centralising it here keeps
// every gate aligned.
//
// `kind` (e.g. `'coverage'`, `'crap'`) is currently echoed through to
// the resolution unchanged. The argument exists so future per-kind
// overrides have a place to land without breaking call signatures.
// Today: pass it; ignore it.
//
// Returned shape:
//
//   {
//     kind: string,        // echoed back for caller convenience
//     mode: 'full' | 'diff',
//     ref:  string | null, // null in full mode; ref string in diff mode
//     source: string,      // which layer won (debug / friction signal)
//   }

const VALID_MODES = new Set(['full', 'diff']);
const DEFAULT_DIFF_REF = 'main';

/**
 * Coerce a candidate value to a non-empty string, or `null`.
 *
 * @param {unknown} v
 * @returns {string | null}
 */
function asNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Coerce a candidate scope value to one of the canonical modes, or
 * `null` if it is not a recognised mode. Unknown strings are dropped
 * rather than coerced — the layer "did not specify" rather than
 * "specified an invalid value".
 *
 * @param {unknown} v
 * @returns {'full' | 'diff' | null}
 */
function asMode(v) {
  return typeof v === 'string' && VALID_MODES.has(v) ? v : null;
}

/**
 * Resolve a scope against the layered precedence (env > default). Pure;
 * no I/O.
 *
 * @param {object} input
 * @param {string} input.kind          - Baseline kind (e.g. `'crap'`).
 * @param {string} [input.envScope]    - From `BASELINE_SCOPE`.
 * @param {string} [input.envRef]      - From `BASELINE_REF`.
 * @returns {{
 *   kind: string,
 *   mode: 'full' | 'diff',
 *   ref: string | null,
 *   source: string,
 * }}
 */
export function resolveScope(input = {}) {
  const kind =
    typeof input.kind === 'string' && input.kind.length > 0
      ? input.kind
      : 'unknown';

  // ---- Layer 1: Environment (extracted by the caller) ------------------
  const envMode = asMode(input.envScope);
  if (envMode === 'full') {
    return Object.freeze({
      kind,
      mode: 'full',
      ref: null,
      source: 'env:BASELINE_SCOPE=full',
    });
  }
  const envRef = asNonEmptyString(input.envRef);
  if (envMode === 'diff' || envRef) {
    return Object.freeze({
      kind,
      mode: 'diff',
      ref: envRef ?? DEFAULT_DIFF_REF,
      source: envRef ? 'env:BASELINE_REF' : 'env:BASELINE_SCOPE=diff',
    });
  }

  // ---- Layer 2: Default ------------------------------------------------
  return Object.freeze({
    kind,
    mode: 'diff',
    ref: DEFAULT_DIFF_REF,
    source: 'default',
  });
}

/**
 * Generic scope-aware row merge for s-diff-scoped-writes (Story #1974).
 *
 * Each per-kind module re-exports a thin wrapper that pins `scopeKey` to
 * the field used to identify the file the row belongs to (path / route /
 * bundle). This helper does the actual merge:
 *
 *   - `scope.mode === 'full'` (or `scope` is null/undefined / `scope.files`
 *     is empty): regenerated wins everywhere — returned as-is. This keeps
 *     the legacy "always rewrite" behaviour intact when no scope filter is
 *     applied.
 *   - `scope.mode === 'diff'`: rows whose `scopeKey` value is OUTSIDE
 *     `scope.files` are preserved from `prior` verbatim. Rows whose
 *     `scopeKey` value is INSIDE `scope.files` are taken from
 *     `regenerated` (the regenerated values for in-scope files). Prior
 *     rows for in-scope files are dropped (regen replaces them); regen
 *     rows for out-of-scope files are dropped (the writer should not have
 *     computed them, but we filter defensively).
 *   - Missing `prior` (null / undefined / empty) — regenerated wins
 *     everywhere; behaves like full mode.
 *
 * Identity matching uses the per-kind `identity(row)` function — for
 * coverage / lint / maintainability / mutation / lighthouse / bundle-size
 * the identity is the keyField value; for crap it's a composite
 * `path::method@startLine`. The merge preserves row ordering by
 * concatenating in-scope regen rows then out-of-scope prior rows; the
 * downstream `sortRows` from the per-kind module re-sorts before write.
 *
 * Pure. No I/O.
 *
 * @template TRow
 * @param {object} args
 * @param {Array<TRow>|null|undefined} args.prior
 * @param {Array<TRow>|null|undefined} args.regenerated
 * @param {{mode?: 'full'|'diff', files?: Set<string>|Iterable<string>}|null|undefined} args.scope
 * @param {(row: TRow) => string} args.scopeKey  Per-kind scope-key extractor — returns the
 *        file path / route / bundle name used to match against `scope.files`.
 * @param {(row: TRow) => string} [args.identity] Per-kind identity extractor — defaults to
 *        the same as `scopeKey`. CRAP overrides this with `path::method@startLine`.
 * @returns {Array<TRow>}
 */
export function mergeRowsByScope({
  prior,
  regenerated,
  scope,
  scopeKey,
  identity,
} = {}) {
  const regenRows = Array.isArray(regenerated) ? regenerated : [];
  const priorRows = Array.isArray(prior) ? prior : [];
  if (typeof scopeKey !== 'function') {
    throw new TypeError('mergeRowsByScope: scopeKey must be a function');
  }
  const idFn = typeof identity === 'function' ? identity : scopeKey;

  // No scope filter / full mode / no prior → regen wins everywhere.
  const mode = scope?.mode;
  if (!scope || mode === 'full' || priorRows.length === 0) {
    return regenRows.slice();
  }

  // Coerce scope.files to a Set for O(1) membership tests. An empty Set in
  // diff mode means "no files in scope" — every prior row is preserved
  // and every regen row is dropped (defensive: writer feeds in-scope rows).
  const filesSet =
    scope.files instanceof Set ? scope.files : new Set(scope.files ?? []);

  // In-scope regen rows: keep regen.
  const regenInScope = regenRows.filter((row) => filesSet.has(scopeKey(row)));
  // Out-of-scope prior rows: keep prior, but drop any whose identity
  // collides with an in-scope regen row (defensive — should not happen
  // since identity within a kind is keyField-derived).
  const inScopeIds = new Set(regenInScope.map((row) => idFn(row)));
  const priorOutOfScope = priorRows.filter(
    (row) => !filesSet.has(scopeKey(row)) && !inScopeIds.has(idFn(row)),
  );

  return regenInScope.concat(priorOutOfScope);
}

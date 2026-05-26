// .agents/scripts/lib/baselines/scope.js
//
// Story #1962 / Task #1970 — One ScopeResolution helper that the
// `check-baselines.js` dispatcher and the per-kind regression writers
// (Epic #1943) both consume. Routing every scope decision through this
// single function is what guarantees read/write parity: the dispatcher
// can never decide "diff against epic/1943" while the writer assumes
// "full repo", because both call `resolveScope()` with the same inputs.
//
// The resolver is intentionally pure — it takes already-extracted
// inputs and returns a frozen ScopeResolution. CLI parsing, env
// reading, and config loading happen in the caller; that keeps this
// module trivially testable and prevents the precedence rules from
// being silently re-implemented at every call site.
//
// Precedence (highest → lowest):
//
//   1. CLI flags — `cliFlags.fullScope: true` or `cliFlags.changedSinceRef`.
//      Operator-typed beats anything in env/config. A CLI override of
//      `--full-scope` wins even if the config says `'diff'`.
//   2. Environment — `BASELINE_SCOPE` ('full' | 'diff') and
//      `BASELINE_REF` (any git ref). The dispatcher reads these from
//      `process.env` and forwards via `cliFlags.envScope` /
//      `cliFlags.envRef` so the resolver itself never touches process
//      state. CI usually sets these.
//   3. Config — `configScope` ('full' | 'diff') and `configRef` (any
//      git ref) from `delivery.quality.gateScoping` in `.agentrc.json`.
//   4. Default — `mode='diff'` against `ref='main'`. This is the
//      framework-wide fallback when nothing else is configured.
//
// Missing-ref fallback: when the resolved mode is `'diff'` but no ref
// is supplied at any layer, the resolver falls back to `'main'` rather
// than producing a half-resolved scope with `ref=null`. The dispatcher
// would have to invent a default anyway; centralising it here keeps
// every gate aligned.
//
// `kind` (e.g. `'lint'`, `'coverage'`, `'crap'`) is currently echoed
// through to the resolution unchanged. The argument exists so future
// per-kind overrides (e.g. "lint always runs full") have a place to
// land without breaking call signatures. Today: pass it; ignore it.
//
// Returned shape:
//
//   {
//     kind: string,        // echoed back for caller convenience
//     mode: 'full' | 'diff',
//     ref:  string | null, // null in full mode; ref string in diff mode
//     files: Set<string>,  // empty Set in full mode (sentinel for "all")
//     source: string,      // which layer won (debug / friction signal)
//   }
//
// `files` is intentionally a Set rather than an Array — callers
// repeatedly check membership during per-row filtering, and Set lookup
// is O(1). An empty Set in `'full'` mode means "no filter applies".
// A non-empty Set in `'diff'` mode means "only these paths are in
// scope" (the dispatcher pre-computes them via `git diff --name-only`
// and forwards via `cliFlags.changedFiles`); when omitted, the writer
// is expected to compute the diff itself against `ref`.

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
 * Coerce a candidate set/array of files to a frozen Set. Returns an
 * empty Set when the input is missing or empty.
 *
 * @param {unknown} v
 * @returns {Set<string>}
 */
function asFilesSet(v) {
  if (v instanceof Set) {
    return new Set(
      Array.from(v).filter((f) => typeof f === 'string' && f.length > 0),
    );
  }
  if (Array.isArray(v)) {
    return new Set(v.filter((f) => typeof f === 'string' && f.length > 0));
  }
  return new Set();
}

/**
 * Resolve a scope against the layered precedence (CLI > env > config >
 * default). Pure; no I/O.
 *
 * @param {object} input
 * @param {string} input.kind         - Baseline kind (e.g. `'lint'`).
 * @param {string} [input.configScope] - `'full'` | `'diff'` from agentrc.
 * @param {string} [input.configRef]   - Diff ref from agentrc.
 * @param {object} [input.cliFlags]    - Pre-parsed CLI / env layer.
 * @param {boolean} [input.cliFlags.fullScope]      - `--full-scope`.
 * @param {string}  [input.cliFlags.changedSinceRef] - `--changed-since <ref>`.
 * @param {string}  [input.cliFlags.envScope]        - From `BASELINE_SCOPE`.
 * @param {string}  [input.cliFlags.envRef]          - From `BASELINE_REF`.
 * @param {Iterable<string>} [input.cliFlags.changedFiles]
 *        Pre-computed diff paths (when caller already ran `git diff
 *        --name-only`). Becomes `files`; only meaningful in `'diff'` mode.
 * @returns {{
 *   kind: string,
 *   mode: 'full' | 'diff',
 *   ref: string | null,
 *   files: Set<string>,
 *   source: string,
 * }}
 */
export function resolveScope(input = {}) {
  const kind =
    typeof input.kind === 'string' && input.kind.length > 0
      ? input.kind
      : 'unknown';
  const cli = input.cliFlags ?? {};

  // ---- Layer 1: CLI flags (highest precedence) -------------------------
  if (cli.fullScope === true) {
    return Object.freeze({
      kind,
      mode: 'full',
      ref: null,
      files: new Set(),
      source: 'cli:--full-scope',
    });
  }
  const cliRef = asNonEmptyString(cli.changedSinceRef);
  if (cliRef) {
    return Object.freeze({
      kind,
      mode: 'diff',
      ref: cliRef,
      files: asFilesSet(cli.changedFiles),
      source: 'cli:--changed-since',
    });
  }

  // ---- Layer 2: Environment (extracted by caller into cliFlags.env*) ---
  const envMode = asMode(cli.envScope);
  if (envMode === 'full') {
    return Object.freeze({
      kind,
      mode: 'full',
      ref: null,
      files: new Set(),
      source: 'env:BASELINE_SCOPE=full',
    });
  }
  const envRef = asNonEmptyString(cli.envRef);
  if (envMode === 'diff' || envRef) {
    return Object.freeze({
      kind,
      mode: 'diff',
      ref: envRef ?? DEFAULT_DIFF_REF,
      files: asFilesSet(cli.changedFiles),
      source: envRef ? 'env:BASELINE_REF' : 'env:BASELINE_SCOPE=diff',
    });
  }

  // ---- Layer 3: Config (delivery.quality.gateScoping) -----------------
  const cfgMode = asMode(input.configScope);
  if (cfgMode === 'full') {
    return Object.freeze({
      kind,
      mode: 'full',
      ref: null,
      files: new Set(),
      source: 'config:gateScoping.scope=full',
    });
  }
  const cfgRef = asNonEmptyString(input.configRef);
  if (cfgMode === 'diff' || cfgRef) {
    return Object.freeze({
      kind,
      mode: 'diff',
      ref: cfgRef ?? DEFAULT_DIFF_REF,
      files: asFilesSet(cli.changedFiles),
      source: cfgRef
        ? 'config:gateScoping.diffRef'
        : 'config:gateScoping.scope=diff',
    });
  }

  // ---- Layer 4: Default ------------------------------------------------
  return Object.freeze({
    kind,
    mode: 'diff',
    ref: DEFAULT_DIFF_REF,
    files: asFilesSet(cli.changedFiles),
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

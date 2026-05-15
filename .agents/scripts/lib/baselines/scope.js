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
//      framework-wide fallback when nothing else is configured; it
//      matches the historical default in `gate-cli.js#resolveScopedRef`.
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
      source: cfgRef ? 'config:gateScoping.diffRef' : 'config:gateScoping.scope=diff',
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

// Read-side scope resolution for the `check-baselines` dispatcher (the
// refresh service has its own resolver). Pure: the caller extracts
// `BASELINE_SCOPE` / `BASELINE_REF`; env wins, else diff against `main`.

const VALID_MODES = new Set(['full', 'diff']);
const DEFAULT_DIFF_REF = 'main';

/**
 * @param {unknown} v
 * @returns {string | null}
 */
function asNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * An unknown string means "unspecified", not invalid.
 *
 * @param {unknown} v
 * @returns {'full' | 'diff' | null}
 */
function asMode(v) {
  return typeof v === 'string' && VALID_MODES.has(v) ? v : null;
}

/**
 * `source` names the winning layer; `ref` is null in full mode.
 *
 * @param {object} input
 * @param {string} input.kind          - Echoed back.
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

  return Object.freeze({
    kind,
    mode: 'diff',
    ref: DEFAULT_DIFF_REF,
    source: 'default',
  });
}

/**
 * Scope-aware row merge. Full mode, no scope, or no prior: regenerated wins.
 * Diff mode: in-scope rows come from `regenerated`, out-of-scope rows from
 * `prior` verbatim (regen rows outside scope are dropped). Output is unsorted.
 *
 * @template TRow
 * @param {object} args
 * @param {Array<TRow>|null|undefined} args.prior
 * @param {Array<TRow>|null|undefined} args.regenerated
 * @param {{mode?: 'full'|'diff', files?: Set<string>|Iterable<string>}|null|undefined} args.scope
 * @param {(row: TRow) => string} args.scopeKey  The file key matched against `scope.files`.
 * @param {(row: TRow) => string} [args.identity] Defaults to `scopeKey`.
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

  const mode = scope?.mode;
  if (!scope || mode === 'full' || priorRows.length === 0) {
    return regenRows.slice();
  }

  const filesSet =
    scope.files instanceof Set ? scope.files : new Set(scope.files ?? []);

  const regenInScope = regenRows.filter((row) => filesSet.has(scopeKey(row)));
  const inScopeIds = new Set(regenInScope.map((row) => idFn(row)));
  const priorOutOfScope = priorRows.filter(
    (row) => !filesSet.has(scopeKey(row)) && !inScopeIds.has(idFn(row)),
  );

  return regenInScope.concat(priorOutOfScope);
}

/**
 * Semver-free range comparison for the dependency probes. The engine runs from
 * a consumer's `node_modules`, and the runtime closure stays semver-free on
 * purpose (see `lib/runtime-deps/dep-resolution.js`), so this handles only the
 * shapes it can decide exactly — exact, `^`, `~`, `>=` / `>` / `<=` / `<`
 * comparator sets, x-ranges and `||` unions of those — and answers `null` for
 * anything else (prereleases, aliases, tags, protocols). `null` is "cannot
 * decide", never "no".
 *
 * Each range becomes a list of half-open intervals `[lo, hi)` over
 * `[major, minor, patch]` tuples; `hi` of `null` is unbounded.
 *
 * @module lib/audit-exceptions/range-subset
 */

const VERSION_RE = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?$/;
const COMPARATOR_RE = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/;

/**
 * @param {string} raw
 * @returns {{ parts: number[], wild: number }|null} `wild` = index of the
 *   first wildcard / missing part (3 when fully specified).
 */
function parseVersion(raw) {
  const m = VERSION_RE.exec(raw.trim());
  if (!m) return null;
  const parts = [];
  for (const p of [m[1], m[2], m[3]]) {
    if (p === undefined || /^[xX*]$/.test(p)) break;
    parts.push(Number(p));
  }
  const wild = parts.length;
  while (parts.length < 3) parts.push(0);
  return { parts, wild };
}

const ZERO = Object.freeze([0, 0, 0]);

function cmp(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/** The smallest version strictly above every version sharing `parts[0..idx)`. */
function bump(parts, idx) {
  if (idx === 0) return null;
  const out = parts.slice(0, idx);
  out[idx - 1] += 1;
  while (out.length < 3) out.push(0);
  return out;
}

function nextPatch(parts) {
  return [parts[0], parts[1], parts[2] + 1];
}

function caretHi({ parts, wild }) {
  const firstNonZero = parts.findIndex((n, i) => n !== 0 && i < wild);
  const idx = firstNonZero === -1 ? Math.max(wild, 1) : firstNonZero + 1;
  return bump(parts, Math.min(idx, Math.max(wild, 1)));
}

function tildeHi({ parts, wild }) {
  return bump(parts, Math.min(Math.max(wild, 1), 2));
}

/**
 * @param {string} op
 * @param {{ parts: number[], wild: number }} v
 * @returns {{ lo: number[], hi: number[]|null }}
 */
function comparatorInterval(op, v) {
  const exactHi = v.wild === 3 ? nextPatch(v.parts) : bump(v.parts, v.wild);
  switch (op) {
    case '^':
      return { lo: v.parts, hi: caretHi(v) };
    case '~':
      return { lo: v.parts, hi: tildeHi(v) };
    case '>=':
      return { lo: v.parts, hi: null };
    case '>':
      return { lo: exactHi ?? v.parts, hi: exactHi === null ? ZERO : null };
    case '<':
      return { lo: ZERO, hi: v.parts };
    case '<=':
      return { lo: ZERO, hi: exactHi };
    default:
      return { lo: v.parts, hi: exactHi };
  }
}

function intersect(a, b) {
  const lo = cmp(a.lo, b.lo) >= 0 ? a.lo : b.lo;
  let hi = a.hi ?? b.hi;
  if (a.hi && b.hi) hi = cmp(a.hi, b.hi) <= 0 ? a.hi : b.hi;
  return { lo, hi };
}

/**
 * @param {string} set - a space-separated comparator set (one `||` arm).
 * @returns {{ lo: number[], hi: number[]|null }|null}
 */
function parseSet(set) {
  const tokens = set
    .trim()
    .replace(/([<>=^~])\s+/g, '$1')
    .split(/\s+/);
  let acc = { lo: ZERO, hi: null };
  for (const token of tokens) {
    if (token === '' || token === '*' || /^[xX]$/.test(token)) continue;
    const m = COMPARATOR_RE.exec(token);
    const v = m ? parseVersion(m[2]) : null;
    if (!v) return null;
    acc = intersect(acc, comparatorInterval(m[1] ?? '=', v));
  }
  return acc;
}

/**
 * @param {unknown} range
 * @returns {Array<{ lo: number[], hi: number[]|null }>|null}
 */
function parseRange(range) {
  if (typeof range !== 'string') return null;
  const arms = range.split('||').map((arm) => parseSet(arm));
  return arms.some((arm) => arm === null) ? null : arms;
}

function within(inner, outer) {
  if (cmp(inner.lo, outer.lo) < 0) return false;
  if (outer.hi === null) return true;
  if (inner.hi === null) return false;
  return cmp(inner.hi, outer.hi) <= 0;
}

/**
 * Is every version `inner` admits also admitted by `outer`?
 *
 * @param {string} inner
 * @param {string} outer
 * @returns {boolean|null} `null` when either range is outside the supported shapes,
 *   or when only a union of `outer` arms could cover an `inner` arm.
 */
export function rangeIsSubset(inner, outer) {
  const a = parseRange(inner);
  const b = parseRange(outer);
  if (!a || !b) return null;
  const covered = a.every((arm) => b.some((o) => within(arm, o)));
  if (covered) return true;
  return b.length === 1 ? false : null;
}

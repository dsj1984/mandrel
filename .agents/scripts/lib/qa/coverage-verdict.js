// .agents/scripts/lib/qa/coverage-verdict.js
//
// Deterministic per-tier coverage verdict for a single finding surface.
//
// A "finding surface" is the unit of code a quality finding points at — a
// symbol (function / class / module export) together with the set of tests
// that exercise it. This helper answers one question, purely and without I/O:
// for that surface, which of the three test tiers from
// `.agents/rules/testing-standards.md` (unit / contract / acceptance) are
// PRESENT, and which are ABSENT — and why.
//
// A scenario that is skipped does not exercise anything — a `@skip`
// Gherkin tag (or a runner equivalent such as `it.skip` / `xit` /
// `describe.skip`, or a `skipped: true` descriptor field) means the test is
// inert at run time. This module therefore treats a skipped test as ABSENT
// for its tier: it never bumps a tier into `present`, because a tier whose
// only "coverage" is a skipped scenario is, operationally, uncovered.
//
// The companion process skill is `core/qa-coverage-mapping`, which shows how
// to gather the surface input and act on the verdict. This module is the
// deterministic seam that skill delegates to; it makes no network calls, runs
// no child processes, and reads no environment or files.
//
// Public API:
//
//   coverageVerdict(surface) -> {
//     unit:       { status, note },
//     contract:   { status, note },
//     acceptance: { status, note },
//   }
//
//   status is 'present' when the tier has at least one classified,
//   non-skipped test, or 'absent' otherwise. `note` is a short
//   operator-facing string explaining the verdict (always populated,
//   including for present tiers).
//
//   acceptanceMatrix(criteria) -> {
//     tiers: TIERS,
//     rows: [{ id, label, verdict }, ...],
//   }
//
//   Maps each acceptance criterion to its per-tier `coverageVerdict`, giving
//   the AC × test-tier matrix the markdown report (lib/qa/coverage-report.js)
//   renders.

/** The three test tiers, in pyramid order (base → top). */
export const TIERS = Object.freeze(['unit', 'contract', 'acceptance']);

const PRESENT = 'present';
const ABSENT = 'absent';

/** True when `value` contains a `@skip` Gherkin-style tag. */
function hasSkipTag(value) {
  if (typeof value !== 'string') return false;
  return /(^|[\s,])@skip\b/i.test(value);
}

/** True when `value` contains a runner-level skip/pending marker. */
function hasRunnerSkipMarker(value) {
  if (typeof value !== 'string') return false;
  if (/\b(?:it|test|describe|context)\.(?:skip|todo)\b/i.test(value)) {
    return true;
  }
  return /\bx(?:it|test|describe|context)\b/i.test(value);
}

/**
 * True when a test descriptor is marked skipped/pending and therefore must
 * NOT count toward its tier. Recognizes:
 *   - a `@skip` tag in a `tags` array or whitespace/comma string,
 *   - the same tags embedded in a path or descriptor `name`,
 *   - explicit boolean flags (`skipped`, `pending`),
 *   - runner skip markers in a path/name (`it.skip`, `xit`, `xdescribe`,
 *     `describe.skip`, `test.skip`, `.todo`).
 *
 * @param {string|object} test
 * @returns {boolean}
 */
export function isSkipped(test) {
  if (test == null) return false;

  if (typeof test === 'object') {
    // 1. Explicit boolean flags win.
    if (test.skipped === true || test.pending === true) return true;

    // 2. A `tags` field — array of tag strings or a single string.
    const tags = test.tags;
    if (Array.isArray(tags)) {
      if (tags.some((t) => hasSkipTag(t))) return true;
    } else if (typeof tags === 'string' && hasSkipTag(tags)) {
      return true;
    }
  }

  // 3. Scan a path/name string for an inline skip/pending tag or a runner
  //    skip marker (covers both string inputs and descriptor `path`/`name`).
  const scannable =
    typeof test === 'string'
      ? test
      : typeof test === 'object'
        ? [test.path, test.name].filter((s) => typeof s === 'string').join(' ')
        : '';
  return hasSkipTag(scannable) || hasRunnerSkipMarker(scannable);
}

/**
 * Classify a single test descriptor into one of the three tiers, or `null`
 * when it cannot be placed OR when it is skipped/pending. Tier placement
 * mirrors `.agents/rules/testing-standards.md`:
 *   - unit       — colocated `*.test.*` next to source, or under `__tests__/`.
 *   - contract   — lives under a `tests/contract/**` (or `**\/contract\/**`)
 *                  path.
 *   - acceptance — a Gherkin `.feature` file (e2e / acceptance tier).
 *
 * An explicit `tier` field on the descriptor always wins over path inference,
 * so callers that already know the tier can state it directly.
 *
 * A skipped/pending test (see {@link isSkipped}) is treated as inert and
 * returns `null` so it never counts toward its tier — a tier covered only by
 * a skipped scenario is, operationally, uncovered.
 */
export function classifyTest(test) {
  if (test == null) return null;

  // A skipped/pending test exercises nothing — it cannot place into any tier.
  if (isSkipped(test)) return null;

  // 1. Explicit tier wins.
  const explicit =
    typeof test === 'object' && typeof test.tier === 'string'
      ? test.tier.trim().toLowerCase()
      : null;
  if (explicit && TIERS.includes(explicit)) {
    return explicit;
  }

  // 2. Infer from a path string.
  const rawPath =
    typeof test === 'string'
      ? test
      : typeof test === 'object' && typeof test.path === 'string'
        ? test.path
        : null;
  if (!rawPath) return null;

  const p = rawPath.replace(/\\/g, '/').toLowerCase();

  if (p.endsWith('.feature')) return 'acceptance';
  if (/(^|\/)contract\//.test(p) || /\.contract\.test\.[cm]?[jt]sx?$/.test(p)) {
    return 'contract';
  }
  if (/\.test\.[cm]?[jt]sx?$/.test(p) || /(^|\/)__tests__\//.test(p)) {
    return 'unit';
  }
  return null;
}

const ABSENT_NOTES = Object.freeze({
  unit: 'no colocated unit test exercises this surface',
  contract: 'no contract test asserts this surface’s wire shape or boundary',
  acceptance: 'no acceptance scenario covers a user-visible journey here',
});

const PRESENT_NOTES = Object.freeze({
  unit: (n) => `${n} unit test${n === 1 ? '' : 's'} present`,
  contract: (n) => `${n} contract test${n === 1 ? '' : 's'} present`,
  acceptance: (n) => `${n} acceptance scenario${n === 1 ? '' : 's'} present`,
});

/**
 * Compute the per-tier coverage verdict for one finding surface.
 *
 * @param {object} surface
 * @param {string} [surface.symbol] - The symbol the finding points at; echoed
 *   into notes for operator context. Optional.
 * @param {Array<string|{path?:string,tier?:string,tags?:string|string[],skipped?:boolean,pending?:boolean}>} [surface.tests] -
 *   The tests that exercise the surface. Each entry is either a path string or
 *   a descriptor with `path`, `tier`, and/or skip markers (`tags`, `skipped`,
 *   `pending`). Unclassifiable and skipped/pending entries are ignored.
 * @returns {{unit:{status:string,note:string},
 *            contract:{status:string,note:string},
 *            acceptance:{status:string,note:string}}}
 */
export function coverageVerdict(surface = {}) {
  if (surface === null || typeof surface !== 'object') {
    throw new TypeError('coverageVerdict: surface must be an object');
  }

  const tests = Array.isArray(surface.tests) ? surface.tests : [];
  const symbol =
    typeof surface.symbol === 'string' && surface.symbol.trim() !== ''
      ? surface.symbol.trim()
      : null;

  const counts = { unit: 0, contract: 0, acceptance: 0 };
  for (const test of tests) {
    const tier = classifyTest(test);
    if (tier) counts[tier] += 1;
  }

  const verdict = {};
  for (const tier of TIERS) {
    const n = counts[tier];
    if (n > 0) {
      verdict[tier] = {
        status: PRESENT,
        note: PRESENT_NOTES[tier](n),
      };
    } else {
      const base = ABSENT_NOTES[tier];
      verdict[tier] = {
        status: ABSENT,
        note: symbol ? `${base} (${symbol})` : base,
      };
    }
  }

  return verdict;
}

/**
 * Normalize a single criterion descriptor into `{id, label, surface}`. A
 * descriptor may carry `id`, `label` (falls back to id), and either a nested
 * `surface` or a flat `{symbol, tests}` shape.
 */
function normalizeOne(entry, index) {
  const e = entry && typeof entry === 'object' ? entry : {};
  const id =
    typeof e.id === 'string' && e.id.trim() !== ''
      ? e.id.trim()
      : `AC-${index + 1}`;
  const label =
    typeof e.label === 'string' && e.label.trim() !== '' ? e.label.trim() : id;

  let surface;
  if (e.surface && typeof e.surface === 'object') {
    surface = e.surface;
  } else if (Array.isArray(e.tests) || typeof e.symbol === 'string') {
    surface = { symbol: e.symbol, tests: e.tests };
  } else {
    surface = {};
  }

  return { id, label, surface };
}

/**
 * Normalize the criteria input for {@link acceptanceMatrix}. Accepts either an
 * array of criterion descriptors or a plain object keyed by criterion id whose
 * values are surfaces (or `{surface}` wrappers). Returns a normalized array of
 * `{id, label, surface}`.
 *
 * @param {Array<object>|object} criteria
 * @returns {Array<{id:string,label:string,surface:object}>}
 */
function normalizeCriteria(criteria) {
  if (Array.isArray(criteria)) {
    return criteria.map((entry, index) => normalizeOne(entry, index));
  }
  if (criteria && typeof criteria === 'object') {
    return Object.entries(criteria).map(([id, value], index) =>
      normalizeOne(
        value && typeof value === 'object' && !Array.isArray(value)
          ? { id, ...value }
          : { id, surface: { tests: value } },
        index,
      ),
    );
  }
  throw new TypeError(
    'acceptanceMatrix: criteria must be an array or an object',
  );
}

/**
 * Build the AC × test-tier matrix: for each acceptance criterion, the per-tier
 * {@link coverageVerdict}. This is the structured shape the markdown report
 * (`lib/qa/coverage-report.js`) renders into a table.
 *
 * @param {Array<{id?:string,label?:string,surface?:object,symbol?:string,tests?:Array}>|Record<string,object>} criteria
 *   Acceptance criteria, either as an array of descriptors or an object keyed
 *   by criterion id. Each descriptor names a surface (nested `surface`, or a
 *   flat `{symbol, tests}`).
 * @returns {{tiers: ReadonlyArray<string>,
 *            rows: Array<{id:string,label:string,
 *                         verdict:ReturnType<typeof coverageVerdict>}>}}
 */
export function acceptanceMatrix(criteria) {
  const normalized = normalizeCriteria(criteria);
  const rows = normalized.map(({ id, label, surface }) => ({
    id,
    label,
    verdict: coverageVerdict(surface),
  }));
  return { tiers: TIERS, rows };
}

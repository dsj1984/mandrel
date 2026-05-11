/**
 * Pure failure-class detector for the s4-auto-fix workflow.
 *
 * Reads the same `test-output.txt` artifacts that `triage-ci-failure.js`
 * consumes and classifies the *most prominent* failure into one of:
 *
 *   - `lint`            biome (or eslint shim) lint diagnostic
 *   - `format`          biome format / prettier diff
 *   - `coverage`        c8 / node:test coverage gate failure
 *   - `crap`            CRAP regression from `check-crap.js`
 *   - `maintainability` maintainability regression from `check-maintainability.js`
 *   - `test`            ordinary test assertion / TAP `not ok`
 *   - `unknown`         no recognisable marker
 *
 * The detector is intentionally pure: callers (workflow scripts, tests)
 * pass the artifact text or a pre-collected payload list and receive a
 * structured verdict. No filesystem, no env, no gh shell-outs.
 *
 * ## Auto-fix gating policy
 *
 * The auto-fix workflow only acts on `lint` or `format` verdicts. If *any*
 * leg of the matrix surfaces a non-fixable class (coverage, crap,
 * maintainability, test, unknown), the verdict is the non-fixable one —
 * we never silently fix only the lint half of a mixed lint+coverage run
 * because the operator still owes a real change to close the coverage
 * gap. Priority order, from least to most "blocking":
 *
 *     format  <  lint  <  test  <  coverage  <  crap  <  maintainability  <  unknown
 *
 * `unknown` ranks highest because it surfaces config drift (artifact with
 * no recognised markers) and the bail comment is the only signal the
 * operator gets — auto-fixing through it would mask the drift.
 *
 * The order is locked by the test fixtures under tests/auto-fix/ and
 * should not be re-ordered without updating those.
 */

/**
 * @typedef {'lint'|'format'|'coverage'|'crap'|'maintainability'|'test'|'unknown'} FailureClass
 */

/**
 * Per-class marker regexes, matched against trimmed lines of the
 * `test-output.txt` buffer. The first list entry that matches a given
 * line determines the class contribution for that line; the overall
 * verdict is then the highest-priority class observed across all lines.
 *
 * Each marker is anchored at line start where possible to avoid sloppy
 * substring collisions (a stack-trace mentioning "lint" inside a path
 * should not count).
 */
export const CLASS_MARKERS = Object.freeze({
  // Maintainability regression banner from .agents/scripts/check-maintainability.js.
  // The banner shape is "Maintainability regression in <file>: ..." or
  // "Maintainability ... regression" — we accept either by making the
  // middle "<something>" optional.
  maintainability: [/\bmaintainability\b.*\bregression\b/i],
  // CRAP regression banner from .agents/scripts/check-crap.js. Same
  // shape: "CRAP regression in <file>: ..." (no required middle words).
  crap: [/\bCRAP\b.*\bregression\b/i],
  // c8 / node:test coverage gate
  coverage: [/coverage threshold .* not met/i, /\bcoverage\b.*\bbelow\b/i],
  // node:test TAP-style failures, pretty reporter, and the FAIL banner.
  // We also accept indented `✖` from the pretty reporter — the lint /
  // format markers below are matched first via CLASS_PRIORITY so a
  // `✖ lint` line still routes to lint, not test.
  test: [/^not ok\b/, /^#\s*fail\s+\d+/i, /^✖\s/, /^FAIL\b/],
  // biome lint diagnostics — biome prints `lint/<group>/<rule>` headers,
  // a "Biome check found N errors" summary, or a leading `✖ lint` line.
  lint: [
    /\blint\/[a-z]+\/[A-Za-z0-9]+/, // diagnostic header e.g. lint/correctness/noUnusedVars
    /\bbiome\b.*\bfound\b.*\d+\s*error/i,
    /^\s*✖\s+lint\b/i,
  ],
  // biome formatter / prettier diff. The line shapes we see in practice:
  //   "./foo.js  Formatter would have made changes."
  //   "Found 2 unformatted files."
  //   "biome format reports differences"
  //   "✖ format/..."
  format: [
    /^\s*✖\s+format\b/i,
    /\bFormatter\s+would\s+have\s+made\s+changes/i,
    /\bunformatted\s+files?\b/i,
    /\bbiome\s+format\b/i,
  ],
});

/**
 * Lowest-to-highest priority. Higher index wins when multiple classes
 * fire. `unknown` is never in this list; it's the fallback returned when
 * no marker matches.
 */
export const CLASS_PRIORITY = Object.freeze([
  'format',
  'lint',
  'test',
  'coverage',
  'crap',
  'maintainability',
]);

/**
 * The set of classes the auto-fix workflow will act on. Everything else
 * routes to the bail-comment branch.
 */
export const FIXABLE_CLASSES = Object.freeze(new Set(['lint', 'format']));

/**
 * Classify a single line. Returns `null` if no marker matches. The first
 * matching class wins for that line — class-level priority is applied at
 * the verdict layer, not here.
 *
 * @param {string} line
 * @returns {FailureClass | null}
 */
export function classifyLine(line) {
  if (typeof line !== 'string') return null;
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  for (const cls of CLASS_PRIORITY) {
    for (const re of CLASS_MARKERS[cls]) {
      if (re.test(trimmed)) return cls;
    }
  }
  return null;
}

/**
 * Classify a raw artifact buffer. Walks every line and aggregates the
 * highest-priority class observed.
 *
 * Returns `unknown` when no marker fires across the whole buffer. The
 * caller (`detectFailureClass`) is responsible for collapsing this with
 * the cross-leg verdict.
 *
 * @param {string} raw
 * @returns {{ class: FailureClass, lineCounts: Record<FailureClass, number> }}
 */
export function classifyBuffer(raw) {
  if (typeof raw !== 'string') {
    return { class: 'unknown', lineCounts: emptyCounts() };
  }
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const lineCounts = emptyCounts();
  let best = null;
  let bestRank = -1;
  for (const line of lines) {
    const cls = classifyLine(line);
    if (!cls) continue;
    lineCounts[cls] = (lineCounts[cls] ?? 0) + 1;
    const rank = CLASS_PRIORITY.indexOf(cls);
    if (rank > bestRank) {
      best = cls;
      bestRank = rank;
    }
  }
  return { class: best ?? 'unknown', lineCounts };
}

/**
 * Top-level detector. Accepts an array of `{ os, raw }` payloads (one per
 * matrix leg's test-output.txt) and returns the cross-leg verdict plus a
 * per-leg breakdown for the bail-comment renderer to surface.
 *
 * When any leg is `unknown`, the overall verdict is `unknown` (config
 * drift is louder than any single fixable signal — we'd rather bail and
 * have a human look at it than auto-commit on a fuzzy read).
 *
 * @param {Array<{ os?: string|null, raw: string }>} payloads
 * @returns {{
 *   class: FailureClass,
 *   fixable: boolean,
 *   perLeg: Array<{ os: string|null, class: FailureClass }>
 * }}
 */
export function detectFailureClass(payloads) {
  if (!Array.isArray(payloads) || payloads.length === 0) {
    return { class: 'unknown', fixable: false, perLeg: [] };
  }
  const perLeg = payloads.map((p) => ({
    os: p?.os ?? null,
    class: classifyBuffer(typeof p?.raw === 'string' ? p.raw : '').class,
  }));

  // Unknown wins outright: it signals an artifact we can't read, which
  // should never be silently auto-fixed through.
  if (perLeg.some((l) => l.class === 'unknown')) {
    return { class: 'unknown', fixable: false, perLeg };
  }

  let best = perLeg[0].class;
  let bestRank = CLASS_PRIORITY.indexOf(best);
  for (let i = 1; i < perLeg.length; i++) {
    const r = CLASS_PRIORITY.indexOf(perLeg[i].class);
    if (r > bestRank) {
      best = perLeg[i].class;
      bestRank = r;
    }
  }
  return { class: best, fixable: FIXABLE_CLASSES.has(best), perLeg };
}

function emptyCounts() {
  return {
    format: 0,
    lint: 0,
    test: 0,
    coverage: 0,
    crap: 0,
    maintainability: 0,
  };
}

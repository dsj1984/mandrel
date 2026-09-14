/**
 * Shared projections for the escomplex-kernel parity corpus (Story #5333).
 *
 * The corpus was captured under the **displaced** `typhonjs-escomplex` kernel
 * before that dependency left the tree, and is the sole evidence that the
 * in-repo replacement (`.agents/scripts/lib/escomplex-kernel.js`) reproduces
 * it exactly. The displaced kernel is uninstallable afterwards, so these three
 * helpers must stay byte-stable: change one and the corpus stops meaning what
 * it was captured to mean. A different projection needs a **re-captured**
 * corpus, which is impossible — so it needs a baseline recut instead.
 *
 * - {@link reportHash} is the exactness assertion: the whole report, hashed.
 * - {@link projectMetrics} is the diagnosis surface, naming the dimensions the
 *   Story's acceptance criteria name (maintainability, per-method cyclomatic,
 *   line coordinates) so a divergence reports *what* moved, not just "hash
 *   differs".
 * - {@link syntheticCoverageEntry} synthesises a deterministic istanbul entry
 *   from a report's own method ranges, so the CRAP row join — which is a pure
 *   function of (cyclomatic, coverage) — is exercised end to end without
 *   committing a coverage artifact that would rot.
 */

import crypto from 'node:crypto';

/**
 * Hash a report's canonical JSON. Exactness in one value.
 *
 * @param {object} report An `analyzeModule` report.
 * @returns {string} Hex sha256.
 */
export function reportHash(report) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(report))
    .digest('hex');
}

/**
 * Project the report onto the dimensions a parity failure must be able to
 * name. Deliberately narrow: {@link reportHash} already covers everything.
 *
 * @param {object} report An `analyzeModule` report.
 * @returns {object}
 */
export function projectMetrics(report) {
  return {
    maintainability: report.maintainability,
    lineStart: report.lineStart,
    lineEnd: report.lineEnd,
    aggregate: {
      cyclomatic: report.aggregate?.cyclomatic,
      cyclomaticDensity: report.aggregate?.cyclomaticDensity,
      paramCount: report.aggregate?.paramCount,
      slocLogical: report.aggregate?.sloc?.logical,
      slocPhysical: report.aggregate?.sloc?.physical,
      halsteadVolume: report.aggregate?.halstead?.volume,
      halsteadDifficulty: report.aggregate?.halstead?.difficulty,
    },
    methods: (report.methods ?? []).map((m) => ({
      name: m.name,
      lineStart: m.lineStart,
      lineEnd: m.lineEnd,
      cyclomatic: m.cyclomatic,
      paramCount: m.paramCount,
      slocLogical: m.sloc?.logical,
    })),
  };
}

/**
 * Build a deterministic istanbul-shaped coverage entry from a report.
 *
 * One `fnMap` entry per method spanning that method's own line range, and one
 * statement per line inside it, hit unless `(line + methodIndex) % 3 === 0`.
 * The arithmetic is arbitrary but fixed: what matters is that it yields
 * fractional, per-method-distinct coverage so the CRAP values in the corpus
 * are non-degenerate.
 *
 * A fresh object every call — `coverageForMethodInEntry` memoises its index on
 * the entry via a non-enumerable Symbol.
 *
 * @param {object} report An `analyzeModule` report.
 * @returns {{fnMap: object, statementMap: object, s: object}}
 */
export function syntheticCoverageEntry(report) {
  const fnMap = {};
  const statementMap = {};
  const s = {};
  let stmtId = 0;
  const methods = report?.methods ?? [];
  for (const [i, m] of methods.entries()) {
    if (typeof m?.lineStart !== 'number') continue;
    const start = m.lineStart;
    const end =
      typeof m.lineEnd === 'number' && m.lineEnd >= start ? m.lineEnd : start;
    fnMap[String(i)] = {
      name: `fn${i}`,
      decl: {
        start: { line: start, column: 0 },
        end: { line: start, column: 1 },
      },
      loc: { start: { line: start, column: 0 }, end: { line: end, column: 1 } },
    };
    for (let line = start; line <= end; line += 1) {
      statementMap[String(stmtId)] = {
        start: { line, column: 0 },
        end: { line, column: 1 },
      };
      s[String(stmtId)] = (line + i) % 3 === 0 ? 0 : 1;
      stmtId += 1;
    }
  }
  return { fnMap, statementMap, s };
}

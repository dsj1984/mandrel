/**
 * V8 range folding, captured from a real c8 10.1.3 run on Node: a
 * module-scope arrow callback executed once at import shares its parent's
 * execution count, so V8 folds its range into the module's and the Istanbul
 * `fnMap` carries only the named function. Line 2's arrow has statements but
 * no `fnMap` entry; the blank line 3 keeps it outside the ±1 decl window.
 */

export const FOLDED_ARROW_SOURCE = [
  "const EXTS = ['.js', '.ts'];",
  "export const RE = new RegExp(EXTS.map((e) => e.slice(1)).join('|'));",
  '',
  'export function named(a) {',
  '  if (a) return 1;',
  '  return 2;',
  '}',
  '',
].join('\n');

const STATEMENT_ENDS = [28, 68, 0, 26, 18, 11, 1];
const STATEMENT_HITS = [1, 1, 1, 1, 1, 0, 1];

/**
 * The `coverage-final.json` entry c8 produced for {@link FOLDED_ARROW_SOURCE}.
 *
 * @param {string} absPath The entry's `path` (and map key).
 * @returns {object}
 */
export function foldedArrowCoverageEntry(absPath) {
  const statementMap = {};
  const s = {};
  STATEMENT_ENDS.forEach((endColumn, i) => {
    statementMap[String(i)] = {
      start: { line: i + 1, column: 0 },
      end: { line: i + 1, column: endColumn },
    };
    s[String(i)] = STATEMENT_HITS[i];
  });
  const span = {
    start: { line: 4, column: 7 },
    end: { line: 7, column: 1 },
  };
  return {
    path: absPath,
    fnMap: { 0: { name: 'named', decl: span, loc: span, line: 4 } },
    f: { 0: 1 },
    statementMap,
    s,
    branchMap: {},
    b: {},
  };
}

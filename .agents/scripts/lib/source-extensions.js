/**
 * SSOT for the extensions the CRAP/MI scanners score. The scanner walk, the
 * coverage-freshness check, the refresh scope predicates, the close-time
 * CRAP/MI projections, native review and the duplication scanner's jscpd
 * formats must all agree: a narrower selector makes a gate green while
 * measuring nothing. Not configurable, for the same reason.
 *
 * MUST import only `node:` builtins — it runs on the pre-push path and must
 * not drag the scoring engines in.
 */
import path from 'node:path';

/**
 * What the engines can parse (not `.vue`/`.svelte`/`.astro`), each mapped to
 * the jscpd format that reads it — jscpd's `javascript` alone reads only
 * `.js`/`.mjs`/`.cjs`. Private: select via the exported regex or predicate.
 *
 * @type {Readonly<Record<string, string>>}
 */
const SCORABLE_SOURCES = Object.freeze({
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'jsx',
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.mts': 'typescript',
  '.cts': 'typescript',
});

const SCORABLE_SOURCE_EXTENSIONS = Object.keys(SCORABLE_SOURCES);

/**
 * For paths arriving as raw text (git output lines). Built without a
 * callback: a module-scope arrow gets no per-method coverage, so the CRAP
 * seat could never resolve it.
 *
 * @type {RegExp}
 */
export const SCORABLE_SOURCE_EXT_RE = new RegExp(
  `\\.(?:${SCORABLE_SOURCE_EXTENSIONS.join('|').replaceAll('.', '')})$`,
);

/**
 * @param {string} filePath
 * @returns {boolean}
 */
export function isScorableSourceFile(filePath) {
  return SCORABLE_SOURCE_EXTENSIONS.includes(
    path.extname(String(filePath)).toLowerCase(),
  );
}

/**
 * The jscpd formats covering the scorable list. Derived, never declared: the
 * duplication gate scans exactly the files the other gates score.
 *
 * @returns {string[]}
 */
export function jscpdFormatsFor() {
  return [...new Set(Object.values(SCORABLE_SOURCES))];
}

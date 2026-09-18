/**
 * SSOT for the extensions the CRAP/MI scanners score. The scanner walk, the
 * coverage-freshness check and the CRAP projection filter must all agree: a
 * narrower selector makes a gate green while measuring nothing. Not
 * configurable, for the same reason.
 *
 * MUST import only `node:` builtins — it runs on the pre-push path and must
 * not drag the scoring engines in.
 */
import path from 'node:path';

/**
 * What the engines can parse (not `.vue`/`.svelte`/`.astro`). Private: select
 * via the exported regex or predicate.
 *
 * @type {readonly string[]}
 */
const SCORABLE_SOURCE_EXTENSIONS = Object.freeze([
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
]);

/**
 * For paths arriving as raw text (git output lines).
 *
 * @type {RegExp}
 */
export const SCORABLE_SOURCE_EXT_RE = new RegExp(
  `\\.(?:${SCORABLE_SOURCE_EXTENSIONS.map((ext) => ext.slice(1)).join('|')})$`,
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

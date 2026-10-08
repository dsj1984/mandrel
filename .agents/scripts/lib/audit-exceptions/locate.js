/**
 * Text positions for records: the line an exception lives on, and whether a
 * match sits inside a string literal.
 *
 * @module lib/audit-exceptions/locate
 */

/**
 * 1-based line of `needle` in `text`, searched after each of `anchors` in
 * turn — the section keys that contain it (`"pnpm"`, then `"overrides"`). A
 * pin's package also appears as its `dependencies` entry, so a bare
 * first-occurrence search lands on the wrong line, and that line's blame and
 * diff membership are wrong with it. Returns 1 when the needle does not occur:
 * a record always carries a line a reader can open.
 *
 * @param {string|null} text
 * @param {string} needle
 * @param {string[]} [anchors]
 * @returns {number}
 */
export function lineOf(text, needle, anchors = []) {
  if (!text) return 1;
  let from = 0;
  for (const anchor of anchors) {
    const hit = text.indexOf(anchor, from);
    if (hit !== -1) from = hit + anchor.length;
  }
  const at = text.indexOf(needle, from);
  if (at === -1) return 1;
  return text.slice(0, at).split('\n').length;
}

/**
 * `lineOf` for a package or key name: JSON quotes it, YAML does not, so try
 * the quoted form first.
 *
 * @param {string|null} text
 * @param {string} name
 * @param {string[]} [anchors]
 * @returns {number}
 */
export function lineOfName(text, name, anchors = []) {
  const quoted = lineOf(text, `"${name}"`, anchors);
  return quoted === 1 ? lineOf(text, name, anchors) : quoted;
}

/**
 * True when an odd number of one quote kind precede `index` on `line` — the
 * position sits inside a string literal, so a directive or declaration there
 * is data (a fixture, a message), not code.
 *
 * @param {string} line
 * @param {number} index
 * @returns {boolean}
 */
export function insideString(line, index) {
  const before = line.slice(0, index);
  return ['"', "'", '`'].some((q) => before.split(q).length % 2 === 0);
}

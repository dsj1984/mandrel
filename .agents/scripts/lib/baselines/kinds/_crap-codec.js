/**
 * The CRAP baseline's on-disk layout: `files` maps each canonical path, once,
 * to its `{ "<method key>": <crap> }` entries, so each method sits on its own
 * line and disjoint methods merge textually. A leaf: `codec.js` and the merge
 * driver import it.
 */

/**
 * Path, then method key: the persisted order of both layouts.
 *
 * @param {{path: string, method: string}} a
 * @param {{path: string, method: string}} b
 * @returns {number}
 */
export function compareCrapRows(a, b) {
  if (a.path !== b.path) return a.path.localeCompare(b.path);
  return a.method.localeCompare(b.method);
}

/**
 * Null-prototype objects: a method named `__proto__` stays a plain key.
 *
 * @param {Array<{path: string, method: string, crap: number}>} rows
 * @returns {Record<string, Record<string, number>>}
 */
export function encodeCrapFiles(rows) {
  const files = Object.create(null);
  for (const { path, method, crap } of [...(rows ?? [])].sort(
    compareCrapRows,
  )) {
    files[path] ??= Object.create(null);
    files[path][method] = crap;
  }
  return files;
}

/**
 * @param {Record<string, Record<string, number>>} files
 * @returns {Array<{path: string, method: string, crap: number}>}
 */
export function decodeCrapFiles(files) {
  const rows = [];
  for (const [path, methods] of Object.entries(files ?? {})) {
    if (!methods || typeof methods !== 'object') continue;
    for (const [method, crap] of Object.entries(methods)) {
      rows.push({ path, method, crap });
    }
  }
  return rows;
}

/** A method's line in the grouped layout: `"<method key>": <crap>`. */
function crapLine(row) {
  return `      ${JSON.stringify(row.method)}: ${JSON.stringify(row.crap)}`;
}

/**
 * Git conflict markers around one method's line inside its path's block;
 * every other line stays byte-identical.
 *
 * @param {string[]} lines The serialised envelope, split on `\n`.
 * @param {{ours?: object, theirs?: object}} conflict
 */
function markCrapConflict(lines, conflict) {
  const placed = conflict.ours ?? conflict.theirs;
  if (placed === undefined) return;
  const header = lines.indexOf(`    ${JSON.stringify(placed.path)}: {`);
  if (header < 0) return;
  const needle = crapLine(placed);
  let i = header + 1;
  // Scan to the block's closing brace: an earlier conflict's markers sit
  // unindented inside the block and must not end the search.
  while (i < lines.length && !lines[i].startsWith('    }')) {
    if (lines[i] === needle || lines[i] === `${needle},`) break;
    i += 1;
  }
  if (!lines[i]?.startsWith(needle)) return;
  const suffix = lines[i].endsWith(',') ? ',' : '';
  const side = (row) =>
    row === undefined ? [] : [`${crapLine(row)}${suffix}`];
  lines.splice(
    i,
    1,
    '<<<<<<< ours',
    ...side(conflict.ours),
    '=======',
    ...side(conflict.theirs),
    '>>>>>>> theirs',
  );
}

/**
 * Render every row conflict of a merged grouped-layout CRAP file.
 *
 * @param {string} text
 * @param {Array<{ours?: object, theirs?: object}>} conflicts
 * @returns {string}
 */
export function renderCrapConflicts(text, conflicts) {
  const lines = text.split('\n');
  for (const conflict of conflicts) markCrapConflict(lines, conflict);
  return lines.join('\n');
}

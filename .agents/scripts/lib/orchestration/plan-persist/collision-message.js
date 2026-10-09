/**
 * collision-message.js — the clauses of a same-wave refusal line, naming
 * who declared each colliding path, so a Story that declared
 * nothing is never blamed for a sibling's glob.
 *
 * @module lib/orchestration/plan-persist/collision-message
 */

import { globsOverlap, isGlobPath } from '../../wave-runner/footprint.js';

/**
 * One clause per colliding path, naming who declared it. A glob both sides
 * declare and a concrete path both declare read alike; a one-sided glob says
 * what it covers. A glob the other side's glob already names as an overlap
 * is not restated from the other direction.
 *
 * @param {{ slugs: [string, string], paths: string[], declaredBy?: Record<string, string> }} collision
 * @returns {string[]}
 */
export function declarerClauses({ slugs, paths, declaredBy = {} }) {
  const name = { a: `"${slugs[0]}"`, b: `"${slugs[1]}"` };
  const other = { a: 'b', b: 'a' };
  const globsOf = (side) =>
    paths.filter(
      (p) => isGlobPath(p) && [side, 'both'].includes(declaredBy[p] ?? 'both'),
    );
  const clauses = [];
  for (const path of paths) {
    const side = declaredBy[path] ?? 'both';
    if (side === 'both' || !isGlobPath(path)) {
      clauses.push(`${name.a} + ${name.b} both declare \`${path}\``);
      continue;
    }
    const peer = other[side];
    const overlapping = globsOf(peer).filter((g) => globsOverlap(path, g));
    if (overlapping.length === 0) {
      clauses.push(
        `${name[side]} declares glob \`${path}\`, which covers a path ${name[peer]} declares`,
      );
      continue;
    }
    // A `b` glob overlapping an `a`-only glob is already named by that clause.
    if (side === 'b' && overlapping.some((g) => declaredBy[g] === 'a')) {
      continue;
    }
    const globs = overlapping.map((g) => `\`${g}\``).join(', ');
    clauses.push(
      `${name[side]} declares glob \`${path}\`, which may overlap ${name[peer]}'s glob ${globs}`,
    );
  }
  return clauses;
}

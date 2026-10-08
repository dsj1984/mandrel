/**
 * The shared probe for an exemption expressed as a glob: does it still exempt
 * anything? A glob matching a tracked file is `live`. One matching nothing is
 * `dead` only when its static base path is absent from disk and is not a
 * gitignored location — `dist/**` on a fresh clone matches nothing yet still
 * guards the build output — and `unknown` when the glob has no static base.
 *
 * @module lib/audit-exceptions/globs
 */

import fs from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import { gitSpawn } from '../git-utils.js';

const GLOB_CHAR_RE = /[*?[\]{}()!]/;

/**
 * Leading static directory of a glob (`src/gen/**\/*.ts` → `src/gen`).
 *
 * @param {string} glob
 * @returns {string}
 */
function staticBase(glob) {
  const segments = glob.split('/');
  const out = [];
  for (const seg of segments) {
    if (GLOB_CHAR_RE.test(seg)) break;
    out.push(seg);
  }
  return out.join('/');
}

/**
 * gitignore-style line (`dist`, `/build/`, `*.log`) → globs relative to `dir`.
 *
 * @param {string} line
 * @param {string} [dir]
 * @returns {string[]}
 */
export function ignoreLineGlobs(line, dir = '') {
  const anchored = line.startsWith('/') || line.slice(0, -1).includes('/');
  const body = line.replace(/^\/|\/$/g, '');
  // An unanchored line also matches at the top level, which carries a static base.
  const bases = anchored ? [body] : [body, `**/${body}`];
  return bases
    .flatMap((b) => [b, `${b}/**`])
    .map((g) => (dir ? `${dir}/${g}` : g));
}

/**
 * @param {object} ctx
 * @param {string} glob - repo-relative.
 * @returns {{ verdict: string, basis: string }}
 */
function probeOne(ctx, glob) {
  const clean = glob.replace(/^\.\//, '').replace(/^!/, '');
  const isMatch = picomatch([clean, `${clean.replace(/\/+$/, '')}/**`], {
    dot: true,
  });
  if (ctx.scope.files.some((f) => isMatch(f)))
    return { verdict: 'live', basis: 'matches-tracked' };
  const base = staticBase(clean);
  if (base === '') return { verdict: 'unknown', basis: 'no-static-base' };
  if (fs.existsSync(path.join(ctx.root, base))) {
    return {
      verdict: 'live',
      basis: 'matches-untracked-path',
      permanentHint: 'untracked-path',
    };
  }
  // A child path, so a directory-only pattern (`/temp/`) matches an absent dir.
  if (
    gitSpawn(ctx.root, 'check-ignore', '-q', '--no-index', `${base}/.probe`)
      .status === 0
  ) {
    return {
      verdict: 'live',
      basis: 'gitignored-path',
      permanentHint: 'untracked-path',
    };
  }
  return { verdict: 'dead', basis: 'matches-nothing' };
}

/**
 * Probe several globs that form one exemption: `live` if any is live, `dead`
 * only if every one is dead, otherwise `unknown`.
 *
 * @param {object} ctx
 * @param {string[]} globs
 * @returns {{ verdict: string, basis: string }}
 */
export function globsProbe(ctx, globs) {
  const results = globs.map((g) => probeOne(ctx, g));
  const live = results.find((r) => r.verdict === 'live');
  if (live) return live;
  if (results.length > 0 && results.every((r) => r.verdict === 'dead'))
    return results[0];
  return (
    results.find((r) => r.verdict === 'unknown') ?? {
      verdict: 'unknown',
      basis: 'no-globs',
    }
  );
}

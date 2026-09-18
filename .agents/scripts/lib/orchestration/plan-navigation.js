/**
 * plan-navigation.js — navigability helpers for `plan-reachability.js`.
 */

/**
 * Opt-in: no `planning.navigation.routeGlobs` means a silent no-op.
 *
 * @param {object} config Resolved `.agentrc.json`.
 * @returns {{ routeGlobs: string[], navRegistry: string[] }}
 */
export function resolveNavConfig(config) {
  const nav = config?.planning?.navigation ?? {};
  const toList = (v) =>
    (Array.isArray(v) ? v : v == null ? [] : [v])
      .filter((s) => typeof s === 'string' && s.trim().length > 0)
      .map((s) => s.trim());
  return {
    routeGlobs: toList(nav.routeGlobs),
    navRegistry: toList(nav.navRegistry),
  };
}

/**
 * `**` any depth, `*` any non-separator run, `?` one non-separator char;
 * everything else literal.
 *
 * @param {string} glob
 * @returns {RegExp}
 */
export function globToRegExp(glob) {
  // Collapse `**/**` and `***` to `**`: adjacent `.*` runs backtrack
  // catastrophically on long non-matching paths (ReDoS).
  const normalized = glob
    .replace(/\*\*(?:\/\*\*)+/g, '**')
    .replace(/\*{3,}/g, '**');
  let re = '';
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (ch === '*') {
      if (normalized[i + 1] === '*') {
        re += '.*';
        i++;
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * Paths a Story declares: `"path": "…"` change descriptors plus path-like
 * inline code spans.
 *
 * @param {string} body
 * @returns {string[]}
 */
export function extractStoryPaths(body) {
  if (typeof body !== 'string' || body.length === 0) return [];
  const paths = new Set();
  for (const m of body.matchAll(/"path"\s*:\s*"([^"]+)"/g)) {
    paths.add(m[1]);
  }
  for (const m of body.matchAll(/`([^`]+)`/g)) {
    const token = m[1].trim();
    if (/[/.]/.test(token) && !token.includes(' ')) paths.add(token);
  }
  return [...paths];
}

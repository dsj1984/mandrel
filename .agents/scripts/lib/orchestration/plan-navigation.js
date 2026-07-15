/**
 * plan-navigation.js — shared navigability helpers for the persist-side
 * draft reachability check (`plan-reachability.js`).
 *
 * Extracted from the retired `epic-plan-healthcheck.js` so the live
 * draft-ticket scan owns its own mechanics without pulling in the
 * deleted post-plan healthcheck CLI.
 */

/**
 * Resolve the navigation config that drives the reachability check.
 *
 * The check is opt-in: a consumer that has not configured
 * `planning.navigation.routeGlobs` gets a silent no-op. The nav-registry
 * token list is what a route-adding Story is expected to reference
 * somewhere in its body or `## Acceptance` section.
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
 * Translate a route glob (`pages/**`, `app/**\/route.ts`) into a RegExp that
 * matches a path string. Supports `**` (any depth, including `/`), `*` (any
 * run of non-separator chars), and `?` (single non-separator char). All other
 * characters are matched literally.
 *
 * @param {string} glob
 * @returns {RegExp}
 */
export function globToRegExp(glob) {
  // Collapse adjacent `**` segments before compiling. `**/**` and `***` both
  // mean "any depth", but compiling them literally emits adjacent `.*` runs
  // (`.*/.*` / `.*.*`) that backtrack catastrophically on a long non-matching
  // path. Collapsing to a single `**` preserves semantics and keeps the
  // matcher linear (ReDoS hardening).
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
 * Extract the candidate route-touching paths a Story declares. Reads the
 * `## Changes` block (the decompose-author emits one `{"path":...}` JSON
 * object per bullet) and falls back to any bare `` `path/like/this` ``
 * inline-code spans in the body.
 *
 * @param {string} body
 * @returns {string[]}
 */
export function extractStoryPaths(body) {
  if (typeof body !== 'string' || body.length === 0) return [];
  const paths = new Set();
  // `{"path":"pages/foo.tsx", ...}` change descriptors.
  for (const m of body.matchAll(/"path"\s*:\s*"([^"]+)"/g)) {
    paths.add(m[1]);
  }
  // Inline-code spans that look like a path (contain a slash or a dotted ext).
  for (const m of body.matchAll(/`([^`]+)`/g)) {
    const token = m[1].trim();
    if (/[/.]/.test(token) && !token.includes(' ')) paths.add(token);
  }
  return [...paths];
}

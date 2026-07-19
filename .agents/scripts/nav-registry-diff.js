#!/usr/bin/env node
/**
 * .agents/scripts/nav-registry-diff.js — the deterministic route ↔ nav-registry
 * cross-check the navigability lens (`audit-navigability.md`) runs and triages.
 *
 * The navigability lens asserts two symmetric invariants over a consumer's web
 * surface:
 *
 *   1. **Every route has a persona nav door** — a route registered in the route
 *      tree that no nav-registry entry surfaces for an entitled persona is an
 *      **orphaned route**.
 *   2. **No nav href is dead** — a nav-registry door whose target does not
 *      resolve to a real route is a **dead nav href**.
 *
 * Both invariants are a set-difference over two identifier lists, not a
 * judgement call, so they belong in a script rather than in lens prose that
 * asks the agent to eyeball the two files. The lens enumerates the route tree
 * (from `planning.navigation.routeGlobs`) and the nav registry (from
 * `planning.navigation.navRegistry`), hands both to this tool, and triages the
 * structured diff it prints.
 *
 * The one subtlety a naive set-difference gets wrong is **false orphans**: a
 * dynamic detail route (`/users/:id`) is reachable through its surfaced parent,
 * a system route (`/login`, `/404`) is reachable by construction, and a route
 * reached only by an in-app link is not orphaned either. This tool applies that
 * **orphan-verification exemption taxonomy** so the lens reports only genuine
 * orphans (Story #4630, AC-5).
 *
 * Input is two JSON files (route tree + nav registry); a third optional file
 * lists in-app inbound references. Route and door **identifiers only** are read
 * — never route bodies or persona PII (the navigability lens's logging
 * constraint). The tool prints the diff and exits 0 on a successful run; pass
 * `--strict` to exit non-zero when genuine findings remain (a CI gate posture).
 *
 * This is a one-shot deterministic reporter, not an orchestrator: it takes no
 * ticket, mutates no state, and spawns no process.
 */

import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { runAsCli } from './lib/cli-utils.js';

/**
 * Last-segment tokens (or whole-path tokens) that mark a **system route** —
 * reachable by construction (auth walls, error pages) rather than through a
 * persona nav door, so their absence from the nav registry is never an orphan.
 */
const SYSTEM_ROUTE_TOKENS = Object.freeze([
  'login',
  'logout',
  'signin',
  'sign-in',
  'signout',
  'sign-out',
  'signup',
  'sign-up',
  'register',
  'auth',
  'callback',
  'unauthorized',
  'forbidden',
  'not-found',
  'notfound',
  '404',
  '401',
  '403',
  '500',
  'error',
  'maintenance',
]);

/** The exemption reasons a verified non-orphan can carry, for triage clarity. */
const EXEMPTION_REASONS = Object.freeze({
  EXPLICIT: 'explicit-exempt',
  SYSTEM: 'system-route',
  DYNAMIC_CHILD: 'dynamic-child-of-surfaced-parent',
  INBOUND: 'inbound-in-app-reference',
});

/**
 * Normalize a route or href path for comparison: coerce to string, trim, force
 * a single leading slash, collapse duplicate slashes, and drop a trailing slash
 * (except for the root `/`). Returns `''` for a nullish or empty input so the
 * caller can reject it.
 *
 * @param {unknown} p
 * @returns {string}
 */
export function normalizePath(p) {
  if (typeof p !== 'string') return '';
  const trimmed = p.trim();
  if (trimmed.length === 0) return '';
  const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  const collapsed = withSlash.replace(/\/{2,}/g, '/');
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, '') : collapsed;
}

/**
 * Split a normalized path into its non-empty segments (`'/'` → `[]`).
 *
 * @param {string} normalized
 * @returns {string[]}
 */
function segmentsOf(normalized) {
  return normalized.split('/').filter(Boolean);
}

/**
 * True when a single path segment is a **dynamic** segment: an Express/React
 * Router `:param`, a Next.js `[param]` / `[...catchAll]`, a bare wildcard `*`,
 * or a `{param}` template.
 *
 * @param {string} segment
 * @returns {boolean}
 */
export function isDynamicSegment(segment) {
  return (
    segment.startsWith(':') ||
    segment === '*' ||
    (segment.startsWith('[') && segment.endsWith(']')) ||
    (segment.startsWith('{') && segment.endsWith('}'))
  );
}

/** True when the segment is a catch-all (`[...slug]` / `*`) that eats the rest. */
function isCatchAllSegment(segment) {
  return segment === '*' || segment.startsWith('[...');
}

/**
 * True when a normalized route path contains at least one dynamic segment.
 *
 * @param {string} normalized
 * @returns {boolean}
 */
export function isDynamicPath(normalized) {
  return segmentsOf(normalized).some(isDynamicSegment);
}

/**
 * True when a normalized route path is a system route (its last segment, or the
 * whole path, is a recognized system token).
 *
 * @param {string} normalized
 * @returns {boolean}
 */
export function isSystemRoute(normalized) {
  const segs = segmentsOf(normalized);
  if (segs.length === 0) return false;
  const last = segs[segs.length - 1].toLowerCase();
  return SYSTEM_ROUTE_TOKENS.includes(last);
}

/**
 * The parent of a normalized path — the path with its last segment removed
 * (`/users/:id` → `/users`, `/users` → `/`, `/` → `/`).
 *
 * @param {string} normalized
 * @returns {string}
 */
export function parentPath(normalized) {
  const segs = segmentsOf(normalized);
  if (segs.length <= 1) return '/';
  return `/${segs.slice(0, -1).join('/')}`;
}

/**
 * True when a **route template** (which may contain dynamic segments) matches a
 * concrete **href**. A dynamic segment matches any single href segment; a
 * catch-all matches one-or-more trailing href segments. A template with no
 * dynamic segment matches only an identical href.
 *
 * @param {string} routeNorm normalized route path (the template)
 * @param {string} hrefNorm normalized href (the concrete target)
 * @returns {boolean}
 */
export function routeTemplateMatchesHref(routeNorm, hrefNorm) {
  const routeSegs = segmentsOf(routeNorm);
  const hrefSegs = segmentsOf(hrefNorm);
  for (let i = 0; i < routeSegs.length; i += 1) {
    const rSeg = routeSegs[i];
    if (isCatchAllSegment(rSeg)) {
      // A catch-all consumes every remaining href segment (>= 1).
      return hrefSegs.length >= i + 1;
    }
    if (i >= hrefSegs.length) return false;
    if (isDynamicSegment(rSeg)) continue; // matches any one segment
    if (rSeg !== hrefSegs[i]) return false;
  }
  return routeSegs.length === hrefSegs.length;
}

/**
 * Coerce a route-tree entry (a bare path string or a `{ path, personas, exempt,
 * kind }` object) into the internal route shape. Throws on an entry with no
 * usable path so a malformed fixture fails loudly rather than silently
 * dropping a route.
 *
 * @param {unknown} entry
 * @returns {{ path: string, personas: string[], exempt: boolean }}
 */
export function toRoute(entry) {
  const raw = typeof entry === 'string' ? { path: entry } : (entry ?? {});
  const path = normalizePath(raw.path);
  if (path === '') {
    throw new Error(
      `nav-registry-diff: route entry has no usable "path": ${JSON.stringify(entry)}`,
    );
  }
  const personas = Array.isArray(raw.personas)
    ? raw.personas.filter((x) => typeof x === 'string' && x.trim().length > 0)
    : [];
  return { path, personas, exempt: raw.exempt === true };
}

/**
 * Coerce a nav-registry entry (a bare href string or a `{ href, persona }`
 * object) into the internal door shape. Throws on an entry with no usable href.
 *
 * @param {unknown} entry
 * @returns {{ href: string, persona: string|null }}
 */
export function toDoor(entry) {
  const raw = typeof entry === 'string' ? { href: entry } : (entry ?? {});
  const href = normalizePath(raw.href ?? raw.path);
  if (href === '') {
    throw new Error(
      `nav-registry-diff: nav entry has no usable "href": ${JSON.stringify(entry)}`,
    );
  }
  const persona =
    typeof raw.persona === 'string' && raw.persona.trim().length > 0
      ? raw.persona.trim()
      : null;
  return { href, persona };
}

/**
 * True when a nav door surfaces a route: the door's href resolves to the route
 * (identical path, or the route template matches the concrete href), AND — when
 * both sides name personas — the door renders in a persona entitled to the
 * route. A route with no declared personas is surfaced by any resolving door; a
 * door with no persona surfaces for any entitled persona.
 *
 * @param {{ path: string, personas: string[] }} route
 * @param {{ href: string, persona: string|null }} door
 * @returns {boolean}
 */
function doorSurfacesRoute(route, door) {
  const resolves =
    route.path === door.href || routeTemplateMatchesHref(route.path, door.href);
  if (!resolves) return false;
  if (route.personas.length === 0 || door.persona === null) return true;
  return route.personas.includes(door.persona);
}

/**
 * Resolve why an unsurfaced route is exempt from the orphan report, or `null`
 * when it is a genuine orphan. The taxonomy (Story #4630, AC-5): an explicitly
 * exempt route, a system route, a dynamic-segment child of a surfaced parent,
 * or a route reached by an in-app inbound reference.
 *
 * @param {{ path: string, exempt: boolean }} route
 * @param {Set<string>} surfacedPaths route paths a door surfaces
 * @param {Set<string>} inboundRefs normalized in-app referenced paths
 * @returns {string|null} an {@link EXEMPTION_REASONS} value, or null
 */
function orphanExemption(route, surfacedPaths, inboundRefs) {
  if (route.exempt) return EXEMPTION_REASONS.EXPLICIT;
  if (isSystemRoute(route.path)) return EXEMPTION_REASONS.SYSTEM;
  if (isDynamicPath(route.path) && surfacedPaths.has(parentPath(route.path))) {
    return EXEMPTION_REASONS.DYNAMIC_CHILD;
  }
  if (inboundRefs.has(route.path)) return EXEMPTION_REASONS.INBOUND;
  return null;
}

/**
 * Compute the two-way route ↔ nav-registry diff with orphan verification.
 *
 * @param {{
 *   routes?: unknown[],
 *   nav?: unknown[],
 *   refs?: unknown[],
 * }} params
 * @returns {{
 *   counts: { routes: number, doors: number },
 *   orphanedRoutes: { path: string, personas: string[] }[],
 *   deadHrefs: { href: string, persona: string|null }[],
 *   exemptRoutes: { path: string, reason: string }[],
 * }}
 */
export function computeNavDiff({ routes = [], nav = [], refs = [] } = {}) {
  const routeList = routes.map(toRoute);
  const doorList = nav.map(toDoor);
  const inboundRefs = new Set(refs.map(normalizePath).filter((p) => p !== ''));

  // Which route paths does at least one door surface (persona-aware)?
  const surfacedPaths = new Set();
  for (const route of routeList) {
    if (doorList.some((door) => doorSurfacesRoute(route, door))) {
      surfacedPaths.add(route.path);
    }
  }

  const orphanedRoutes = [];
  const exemptRoutes = [];
  for (const route of routeList) {
    if (surfacedPaths.has(route.path)) continue;
    const reason = orphanExemption(route, surfacedPaths, inboundRefs);
    if (reason === null) {
      orphanedRoutes.push({ path: route.path, personas: route.personas });
    } else {
      exemptRoutes.push({ path: route.path, reason });
    }
  }

  // A door is dead when its href resolves to no route (identical or template).
  const deadHrefs = [];
  for (const door of doorList) {
    const resolves = routeList.some(
      (route) =>
        route.path === door.href ||
        routeTemplateMatchesHref(route.path, door.href),
    );
    if (!resolves) deadHrefs.push({ href: door.href, persona: door.persona });
  }

  return {
    counts: { routes: routeList.length, doors: doorList.length },
    orphanedRoutes,
    deadHrefs,
    exemptRoutes,
  };
}

/**
 * Read and parse a JSON array from a file, throwing a clear error when the file
 * is unreadable, not JSON, or not an array.
 *
 * @param {string} label human-readable role for the error message
 * @param {string} file
 * @returns {unknown[]}
 */
function readJsonArray(label, file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(
      `nav-registry-diff: cannot read ${label} file '${file}': ${err.message}`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `nav-registry-diff: ${label} file '${file}' is not valid JSON: ${err.message}`,
    );
  }
  // Accept either a bare array or a `{ routes: [...] }` / `{ nav: [...] }` wrapper.
  const list = Array.isArray(parsed)
    ? parsed
    : (parsed?.routes ?? parsed?.nav ?? parsed?.entries);
  if (!Array.isArray(list)) {
    throw new Error(
      `nav-registry-diff: ${label} file '${file}' must be a JSON array (or an object with a matching array field)`,
    );
  }
  return list;
}

/**
 * Render the diff as a human-readable, triage-friendly text report.
 *
 * @param {ReturnType<typeof computeNavDiff>} diff
 * @returns {string}
 */
export function formatDiffText(diff) {
  const lines = [
    'Route ↔ nav-registry diff',
    `  routes: ${diff.counts.routes}   nav doors: ${diff.counts.doors}`,
    `  orphaned routes: ${diff.orphanedRoutes.length}`,
  ];
  for (const o of diff.orphanedRoutes) {
    const personas = o.personas.length > 0 ? ` [${o.personas.join(', ')}]` : '';
    lines.push(`    - ${o.path}${personas}`);
  }
  lines.push(`  dead nav hrefs: ${diff.deadHrefs.length}`);
  for (const d of diff.deadHrefs) {
    const persona = d.persona ? ` [${d.persona}]` : '';
    lines.push(`    - ${d.href}${persona}`);
  }
  lines.push(`  exempt (verified, not reported): ${diff.exemptRoutes.length}`);
  for (const e of diff.exemptRoutes) {
    lines.push(`    - ${e.path} — ${e.reason}`);
  }
  return lines.join('\n');
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>} process exit code
 */
async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      routes: { type: 'string' },
      nav: { type: 'string' },
      refs: { type: 'string' },
      json: { type: 'boolean', default: false },
      strict: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  if (!values.routes || !values.nav) {
    throw new Error(
      'nav-registry-diff: both --routes <file> and --nav <file> are required.\n' +
        'Usage: node .agents/scripts/nav-registry-diff.js --routes routes.json --nav nav.json [--refs refs.json] [--json] [--strict]',
    );
  }

  const routes = readJsonArray('routes', values.routes);
  const nav = readJsonArray('nav', values.nav);
  const refs = values.refs ? readJsonArray('refs', values.refs) : [];

  const diff = computeNavDiff({ routes, nav, refs });

  // Written straight to stdout (not the orchestrator Logger) so the output is a
  // clean, machine-parseable report the lens can pipe or `JSON.parse`.
  const rendered = values.json
    ? JSON.stringify(diff, null, 2)
    : formatDiffText(diff);
  process.stdout.write(`${rendered}\n`);

  const hasFindings =
    diff.orphanedRoutes.length > 0 || diff.deadHrefs.length > 0;
  return values.strict && hasFindings ? 1 : 0;
}

export { main };

runAsCli(import.meta.url, main, {
  source: 'nav-registry-diff',
  propagateExitCode: true,
});

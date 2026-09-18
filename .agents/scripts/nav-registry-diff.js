#!/usr/bin/env node
/**
 * nav-registry-diff.js — route ↔ nav-registry cross-check for the
 * navigability lens: reports orphaned routes (no persona nav door) and dead
 * nav hrefs. System routes, dynamic children of a surfaced parent, explicit
 * exemptions, and routes with an in-app inbound link are not orphans. Reads
 * identifiers only, never route bodies or persona PII. `--strict` exits
 * non-zero on findings.
 */

import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { runAsCli } from './lib/cli-utils.js';

/** Last-segment tokens of routes reachable by construction (auth, errors). */
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

const EXEMPTION_REASONS = Object.freeze({
  EXPLICIT: 'explicit-exempt',
  SYSTEM: 'system-route',
  DYNAMIC_CHILD: 'dynamic-child-of-surfaced-parent',
  INBOUND: 'inbound-in-app-reference',
});

/**
 * `''` for a non-string or empty input so the caller can reject it.
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
 * @param {string} normalized
 * @returns {string[]}
 */
function segmentsOf(normalized) {
  return normalized.split('/').filter(Boolean);
}

/**
 * `:param`, `[param]` / `[...catchAll]`, `*`, or `{param}`.
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

function isCatchAllSegment(segment) {
  return segment === '*' || segment.startsWith('[...');
}

/**
 * @param {string} normalized
 * @returns {boolean}
 */
export function isDynamicPath(normalized) {
  return segmentsOf(normalized).some(isDynamicSegment);
}

/**
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
 * @param {string} normalized
 * @returns {string}
 */
export function parentPath(normalized) {
  const segs = segmentsOf(normalized);
  if (segs.length <= 1) return '/';
  return `/${segs.slice(0, -1).join('/')}`;
}

/**
 * A dynamic segment matches one href segment; a catch-all matches one or more.
 *
 * @param {string} routeNorm
 * @param {string} hrefNorm
 * @returns {boolean}
 */
export function routeTemplateMatchesHref(routeNorm, hrefNorm) {
  const routeSegs = segmentsOf(routeNorm);
  const hrefSegs = segmentsOf(hrefNorm);
  for (let i = 0; i < routeSegs.length; i += 1) {
    const rSeg = routeSegs[i];
    if (isCatchAllSegment(rSeg)) {
      return hrefSegs.length >= i + 1;
    }
    if (i >= hrefSegs.length) return false;
    if (isDynamicSegment(rSeg)) continue;
    if (rSeg !== hrefSegs[i]) return false;
  }
  return routeSegs.length === hrefSegs.length;
}

/**
 * Throws on a pathless entry rather than silently dropping a route.
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
 * The door resolves to the route and, when both name personas, the door's
 * persona is entitled to it.
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
 * @param {{ path: string, exempt: boolean }} route
 * @param {Set<string>} surfacedPaths
 * @param {Set<string>} inboundRefs
 * @returns {string|null} an {@link EXEMPTION_REASONS} value, or null for a genuine orphan
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
 * @param {string} label
 * @param {string} file
 * @param {typeof fs} [fsImpl]
 * @returns {unknown[]}
 */
function readJsonArray(label, file, fsImpl = fs) {
  let raw;
  try {
    raw = fsImpl.readFileSync(file, 'utf8');
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
 * @param {string[]} [argv]
 * @param {{ fsImpl?: typeof fs, stdout?: { write: (s: string) => void } }} [deps]
 * @returns {Promise<number>} process exit code
 */
export async function runNavRegistryDiff(
  argv = process.argv.slice(2),
  { fsImpl = fs, stdout = process.stdout } = {},
) {
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

  const routes = readJsonArray('routes', values.routes, fsImpl);
  const nav = readJsonArray('nav', values.nav, fsImpl);
  const refs = values.refs ? readJsonArray('refs', values.refs, fsImpl) : [];

  const diff = computeNavDiff({ routes, nav, refs });

  // Straight to stdout (not Logger) so the report stays machine-parseable.
  const rendered = values.json
    ? JSON.stringify(diff, null, 2)
    : formatDiffText(diff);
  stdout.write(`${rendered}\n`);

  const hasFindings =
    diff.orphanedRoutes.length > 0 || diff.deadHrefs.length > 0;
  return values.strict && hasFindings ? 1 : 0;
}

/**
 * @param {string[]} [argv]
 * @returns {Promise<number>} process exit code
 */
async function main(argv = process.argv.slice(2)) {
  return runNavRegistryDiff(argv);
}

export { main };

runAsCli(import.meta.url, main, {
  source: 'nav-registry-diff',
  propagateExitCode: true,
  usage: {
    invocation:
      'node .agents/scripts/nav-registry-diff.js --routes <file> --nav <file> [--refs <file>] [--json] [--strict]',
    summary:
      'Diff a route inventory against the nav registry: report routes with no nav door and nav hrefs pointing nowhere.',
    flags: [
      ['--routes <file>', 'JSON array of route records (required).'],
      ['--nav <file>', 'JSON array of nav entries (required).'],
      ['--refs <file>', 'JSON array of additional href references.'],
      ['--json', 'Emit the diff as JSON instead of a text report.'],
      ['--strict', 'Exit non-zero on any finding.'],
    ],
  },
});

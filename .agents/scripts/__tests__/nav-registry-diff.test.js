/**
 * .agents/scripts/__tests__/nav-registry-diff.test.js — unit + CLI contract for
 * the deterministic route ↔ nav-registry cross-check (Story #4630, AC-4/AC-5).
 *
 * The script is the mechanical half of the navigability lens: it turns the
 * route-tree ↔ nav-registry set-difference into a runnable diff and applies the
 * orphan-verification exemption taxonomy (dynamic children, system routes,
 * inbound references) so the lens reports only genuine orphans.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  computeNavDiff,
  formatDiffText,
  isDynamicPath,
  isDynamicSegment,
  isSystemRoute,
  normalizePath,
  parentPath,
  routeTemplateMatchesHref,
} from '../nav-registry-diff.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, '..', 'nav-registry-diff.js');

describe('normalizePath', () => {
  it('forces a single leading slash and drops a trailing slash', () => {
    assert.equal(normalizePath('users/'), '/users');
    assert.equal(normalizePath('/users'), '/users');
    assert.equal(normalizePath('users/list/'), '/users/list');
  });

  it('collapses duplicate slashes and preserves root', () => {
    assert.equal(normalizePath('//users//list'), '/users/list');
    assert.equal(normalizePath('/'), '/');
  });

  it('returns empty string for nullish or blank input', () => {
    assert.equal(normalizePath(''), '');
    assert.equal(normalizePath('   '), '');
    assert.equal(normalizePath(null), '');
    assert.equal(normalizePath(undefined), '');
    assert.equal(normalizePath(42), '');
  });
});

describe('dynamic + system segment classification', () => {
  it('recognizes dynamic segment syntaxes', () => {
    assert.equal(isDynamicSegment(':id'), true);
    assert.equal(isDynamicSegment('[id]'), true);
    assert.equal(isDynamicSegment('[...slug]'), true);
    assert.equal(isDynamicSegment('{id}'), true);
    assert.equal(isDynamicSegment('*'), true);
    assert.equal(isDynamicSegment('users'), false);
  });

  it('flags a path with any dynamic segment', () => {
    assert.equal(isDynamicPath('/users/:id'), true);
    assert.equal(isDynamicPath('/blog/[slug]/edit'), true);
    assert.equal(isDynamicPath('/users/list'), false);
  });

  it('flags system routes by their last segment', () => {
    assert.equal(isSystemRoute('/login'), true);
    assert.equal(isSystemRoute('/auth/callback'), true);
    assert.equal(isSystemRoute('/404'), true);
    assert.equal(isSystemRoute('/unauthorized'), true);
    assert.equal(isSystemRoute('/dashboard'), false);
    assert.equal(isSystemRoute('/'), false);
  });
});

describe('parentPath', () => {
  it('strips the last segment, bottoming out at root', () => {
    assert.equal(parentPath('/users/:id'), '/users');
    assert.equal(parentPath('/users'), '/');
    assert.equal(parentPath('/'), '/');
    assert.equal(parentPath('/a/b/c'), '/a/b');
  });
});

describe('routeTemplateMatchesHref', () => {
  it('matches an identical static path', () => {
    assert.equal(routeTemplateMatchesHref('/users', '/users'), true);
    assert.equal(routeTemplateMatchesHref('/users', '/teams'), false);
  });

  it('matches a dynamic segment against any concrete segment', () => {
    assert.equal(routeTemplateMatchesHref('/users/:id', '/users/42'), true);
    assert.equal(routeTemplateMatchesHref('/blog/[slug]', '/blog/hello'), true);
  });

  it('rejects a length mismatch on a non-catch-all template', () => {
    assert.equal(routeTemplateMatchesHref('/users/:id', '/users'), false);
    assert.equal(
      routeTemplateMatchesHref('/users/:id', '/users/42/edit'),
      false,
    );
  });

  it('lets a catch-all consume one or more trailing segments', () => {
    assert.equal(routeTemplateMatchesHref('/docs/[...path]', '/docs/a'), true);
    assert.equal(
      routeTemplateMatchesHref('/docs/[...path]', '/docs/a/b/c'),
      true,
    );
    assert.equal(routeTemplateMatchesHref('/docs/*', '/docs/a/b'), true);
    // A catch-all still needs at least one trailing segment.
    assert.equal(routeTemplateMatchesHref('/docs/[...path]', '/docs'), false);
  });
});

describe('computeNavDiff — the two invariants', () => {
  it('flags an orphaned route with no nav door', () => {
    const diff = computeNavDiff({
      routes: ['/dashboard', '/reports'],
      nav: ['/dashboard'],
    });
    assert.deepEqual(
      diff.orphanedRoutes.map((o) => o.path),
      ['/reports'],
    );
    assert.deepEqual(diff.deadHrefs, []);
    assert.deepEqual(diff.counts, { routes: 2, doors: 1 });
  });

  it('flags a dead nav href pointing at no route', () => {
    const diff = computeNavDiff({
      routes: ['/dashboard'],
      nav: ['/dashboard', '/ghost'],
    });
    assert.deepEqual(
      diff.deadHrefs.map((d) => d.href),
      ['/ghost'],
    );
    assert.deepEqual(diff.orphanedRoutes, []);
  });

  it('treats a door as surfacing a dynamic route via template match', () => {
    const diff = computeNavDiff({
      routes: ['/users/:id'],
      nav: ['/users/42'],
    });
    // The concrete href resolves to the template, so no dead href …
    assert.deepEqual(diff.deadHrefs, []);
    // … and the route is surfaced, so it is not orphaned.
    assert.deepEqual(diff.orphanedRoutes, []);
  });
});

describe('computeNavDiff — orphan-verification exemption taxonomy (AC-5)', () => {
  it('exempts an explicitly-flagged route', () => {
    const diff = computeNavDiff({
      routes: [{ path: '/internal', exempt: true }],
      nav: [],
    });
    assert.deepEqual(diff.orphanedRoutes, []);
    assert.deepEqual(diff.exemptRoutes, [
      { path: '/internal', reason: 'explicit-exempt' },
    ]);
  });

  it('exempts a system route (login / 404)', () => {
    const diff = computeNavDiff({
      routes: ['/login', '/404'],
      nav: [],
    });
    assert.deepEqual(diff.orphanedRoutes, []);
    assert.deepEqual(diff.exemptRoutes.map((e) => e.reason).sort(), [
      'system-route',
      'system-route',
    ]);
  });

  it('exempts a dynamic-segment child of a surfaced parent', () => {
    const diff = computeNavDiff({
      routes: ['/users', '/users/:id'],
      nav: ['/users'],
    });
    assert.deepEqual(diff.orphanedRoutes, []);
    assert.deepEqual(diff.exemptRoutes, [
      { path: '/users/:id', reason: 'dynamic-child-of-surfaced-parent' },
    ]);
  });

  it('does NOT exempt a dynamic child when the parent is itself unsurfaced', () => {
    const diff = computeNavDiff({
      routes: ['/users', '/users/:id'],
      nav: [],
    });
    // Parent /users is orphaned; the dynamic child is a genuine orphan too.
    assert.deepEqual(diff.orphanedRoutes.map((o) => o.path).sort(), [
      '/users',
      '/users/:id',
    ]);
  });

  it('exempts a route reached only by an in-app inbound reference', () => {
    const diff = computeNavDiff({
      routes: ['/settings/advanced'],
      nav: [],
      refs: ['/settings/advanced'],
    });
    assert.deepEqual(diff.orphanedRoutes, []);
    assert.deepEqual(diff.exemptRoutes, [
      { path: '/settings/advanced', reason: 'inbound-in-app-reference' },
    ]);
  });
});

describe('computeNavDiff — persona entitlement', () => {
  it('requires a persona intersection when both sides declare one', () => {
    const diff = computeNavDiff({
      routes: [{ path: '/admin', personas: ['admin'] }],
      nav: [{ href: '/admin', persona: 'member' }],
    });
    // The door renders in the wrong persona shell → the route stays orphaned.
    assert.deepEqual(
      diff.orphanedRoutes.map((o) => o.path),
      ['/admin'],
    );
    // …but the href still resolves to a real route, so it is not dead.
    assert.deepEqual(diff.deadHrefs, []);
  });

  it('surfaces when the door persona is entitled', () => {
    const diff = computeNavDiff({
      routes: [{ path: '/admin', personas: ['admin', 'owner'] }],
      nav: [{ href: '/admin', persona: 'owner' }],
    });
    assert.deepEqual(diff.orphanedRoutes, []);
  });

  it('surfaces for any persona when the door declares none', () => {
    const diff = computeNavDiff({
      routes: [{ path: '/admin', personas: ['admin'] }],
      nav: [{ href: '/admin' }],
    });
    assert.deepEqual(diff.orphanedRoutes, []);
  });
});

describe('input coercion', () => {
  it('accepts bare-string and object entries interchangeably', () => {
    const diff = computeNavDiff({
      routes: ['/a', { path: '/b' }],
      nav: ['/a', { href: '/b' }],
    });
    assert.deepEqual(diff.orphanedRoutes, []);
    assert.deepEqual(diff.deadHrefs, []);
  });

  it('throws on a route entry with no usable path', () => {
    assert.throws(
      () => computeNavDiff({ routes: [{ personas: ['x'] }], nav: [] }),
      /no usable "path"/,
    );
  });

  it('throws on a nav entry with no usable href', () => {
    assert.throws(
      () => computeNavDiff({ routes: [], nav: [{ persona: 'x' }] }),
      /no usable "href"/,
    );
  });
});

describe('formatDiffText', () => {
  it('renders counts, orphans, dead hrefs, and exemptions', () => {
    const text = formatDiffText(
      computeNavDiff({
        routes: ['/dashboard', '/reports', '/login', '/users/:id', '/users'],
        nav: ['/dashboard', '/users', '/ghost'],
      }),
    );
    assert.match(text, /routes: 5 {3}nav doors: 3/);
    assert.match(text, /orphaned routes: 1/);
    assert.match(text, /- \/reports/);
    assert.match(text, /dead nav hrefs: 1/);
    assert.match(text, /- \/ghost/);
    assert.match(text, /exempt \(verified, not reported\): 2/);
  });
});

// ---------------------------------------------------------------------------
// CLI contract (AC-4): the script runs over a fixture route tree + nav registry,
// prints the two-way diff, and exits 0.
// ---------------------------------------------------------------------------

/** Write JSON fixtures into an isolated temp dir; return their paths. */
function writeFixtures({ routes, nav, refs }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'nav-registry-diff-'));
  const routesFile = path.join(dir, 'routes.json');
  const navFile = path.join(dir, 'nav.json');
  writeFileSync(routesFile, JSON.stringify(routes));
  writeFileSync(navFile, JSON.stringify(nav));
  const out = { routesFile, navFile };
  if (refs) {
    out.refsFile = path.join(dir, 'refs.json');
    writeFileSync(out.refsFile, JSON.stringify(refs));
  }
  return out;
}

describe('CLI', () => {
  it('prints the two-way diff and exits 0 over a fixture (AC-4)', () => {
    const { routesFile, navFile } = writeFixtures({
      routes: ['/dashboard', '/reports', '/login', '/users/:id', '/users'],
      nav: ['/dashboard', '/users', '/ghost'],
    });
    // execFileSync throws on a non-zero exit, so reaching the assertions proves
    // exit 0.
    const stdout = execFileSync('node', [
      SCRIPT,
      '--routes',
      routesFile,
      '--nav',
      navFile,
    ]).toString();
    assert.match(stdout, /Route ↔ nav-registry diff/);
    assert.match(stdout, /orphaned routes: 1/);
    assert.match(stdout, /dead nav hrefs: 1/);
  });

  it('emits machine-readable JSON under --json', () => {
    const { routesFile, navFile } = writeFixtures({
      routes: ['/a', '/b'],
      nav: ['/a'],
    });
    const stdout = execFileSync('node', [
      SCRIPT,
      '--routes',
      routesFile,
      '--nav',
      navFile,
      '--json',
    ]).toString();
    const parsed = JSON.parse(stdout);
    assert.deepEqual(
      parsed.orphanedRoutes.map((o) => o.path),
      ['/b'],
    );
  });

  it('exits non-zero under --strict when genuine findings remain', () => {
    const { routesFile, navFile } = writeFixtures({
      routes: ['/a', '/b'],
      nav: ['/a'],
    });
    assert.throws(
      () =>
        execFileSync('node', [
          SCRIPT,
          '--routes',
          routesFile,
          '--nav',
          navFile,
          '--strict',
        ]),
      /Command failed/,
    );
  });

  it('exits 0 under --strict when the diff is clean', () => {
    const { routesFile, navFile } = writeFixtures({
      routes: ['/a'],
      nav: ['/a'],
    });
    const stdout = execFileSync('node', [
      SCRIPT,
      '--routes',
      routesFile,
      '--nav',
      navFile,
      '--strict',
    ]).toString();
    assert.match(stdout, /orphaned routes: 0/);
  });

  it('honours a --refs exemption file', () => {
    const { routesFile, navFile, refsFile } = writeFixtures({
      routes: ['/hidden'],
      nav: [],
      refs: ['/hidden'],
    });
    const stdout = execFileSync('node', [
      SCRIPT,
      '--routes',
      routesFile,
      '--nav',
      navFile,
      '--refs',
      refsFile,
      '--json',
    ]).toString();
    const parsed = JSON.parse(stdout);
    assert.deepEqual(parsed.orphanedRoutes, []);
    assert.equal(parsed.exemptRoutes[0].reason, 'inbound-in-app-reference');
  });

  it('errors when a required flag is missing', () => {
    const { routesFile } = writeFixtures({ routes: ['/a'], nav: [] });
    assert.throws(
      () => execFileSync('node', [SCRIPT, '--routes', routesFile]),
      /Command failed/,
    );
  });
});

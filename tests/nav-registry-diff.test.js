import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  computeNavDiff,
  formatDiffText,
  isDynamicPath,
  isDynamicSegment,
  isSystemRoute,
  normalizePath,
  parentPath,
  routeTemplateMatchesHref,
  runNavRegistryDiff,
  toDoor,
  toRoute,
} from '../.agents/scripts/nav-registry-diff.js';

/**
 * Story #4780 — the navigability cross-check had no test file, leaving
 * `main` (CRAP 72), `orphanExemption` (42), `routeTemplateMatchesHref` (35)
 * and `isDynamicSegment` (30) unreached. These are the rules that decide
 * whether a route is reported as an orphan, so an unverified branch here is
 * a silently wrong lens verdict.
 *
 * `runNavRegistryDiff`'s filesystem and stdout are injected through its
 * optional final `deps` parameter (`docs/contributing/test-seams.md` rules 1, 4
 * and 5) — plain stub objects, no module mocking.
 */

describe('normalizePath', () => {
  it('returns empty string for non-strings and blanks', () => {
    for (const input of [null, undefined, 42, {}, '', '   ']) {
      assert.equal(normalizePath(input), '');
    }
  });

  it('forces a leading slash and trims', () => {
    assert.equal(normalizePath('  users  '), '/users');
  });

  it('collapses duplicate slashes', () => {
    assert.equal(normalizePath('//a///b'), '/a/b');
  });

  it('drops a trailing slash except at the root', () => {
    assert.equal(normalizePath('/a/b/'), '/a/b');
    assert.equal(normalizePath('/'), '/');
    assert.equal(normalizePath('///'), '/');
  });
});

describe('isDynamicSegment / isDynamicPath', () => {
  it('recognises every dynamic syntax', () => {
    assert.equal(isDynamicSegment(':id'), true);
    assert.equal(isDynamicSegment('*'), true);
    assert.equal(isDynamicSegment('[id]'), true);
    assert.equal(isDynamicSegment('[...slug]'), true);
    assert.equal(isDynamicSegment('{id}'), true);
  });

  it('rejects static segments and half-open brackets', () => {
    assert.equal(isDynamicSegment('users'), false);
    assert.equal(isDynamicSegment('[id'), false);
    assert.equal(isDynamicSegment('id]'), false);
    assert.equal(isDynamicSegment('{id'), false);
    assert.equal(isDynamicSegment('id}'), false);
  });

  it('isDynamicPath is true when any segment is dynamic', () => {
    assert.equal(isDynamicPath('/users/:id'), true);
    assert.equal(isDynamicPath('/users'), false);
    assert.equal(isDynamicPath('/'), false);
  });
});

describe('isSystemRoute / parentPath', () => {
  it('treats a recognised last segment as a system route', () => {
    assert.equal(isSystemRoute('/login'), true);
    assert.equal(isSystemRoute('/auth/CALLBACK'), true);
    assert.equal(isSystemRoute('/404'), true);
    assert.equal(isSystemRoute('/dashboard'), false);
    assert.equal(isSystemRoute('/'), false);
  });

  it('parentPath drops the last segment, bottoming out at the root', () => {
    assert.equal(parentPath('/users/:id'), '/users');
    assert.equal(parentPath('/users'), '/');
    assert.equal(parentPath('/'), '/');
    assert.equal(parentPath('/a/b/c'), '/a/b');
  });
});

describe('routeTemplateMatchesHref', () => {
  it('matches an identical static template', () => {
    assert.equal(routeTemplateMatchesHref('/users', '/users'), true);
  });

  it('rejects a static template of a different length', () => {
    assert.equal(routeTemplateMatchesHref('/users', '/users/1'), false);
    assert.equal(routeTemplateMatchesHref('/users/1', '/users'), false);
  });

  it('rejects a differing static segment', () => {
    assert.equal(routeTemplateMatchesHref('/users/new', '/users/edit'), false);
  });

  it('lets a dynamic segment match exactly one href segment', () => {
    assert.equal(routeTemplateMatchesHref('/users/:id', '/users/42'), true);
    assert.equal(
      routeTemplateMatchesHref('/users/:id', '/users/42/edit'),
      false,
    );
  });

  it('lets a catch-all consume one or more trailing segments', () => {
    assert.equal(routeTemplateMatchesHref('/docs/[...slug]', '/docs/a'), true);
    assert.equal(
      routeTemplateMatchesHref('/docs/[...slug]', '/docs/a/b/c'),
      true,
    );
    assert.equal(routeTemplateMatchesHref('/docs/[...slug]', '/docs'), false);
    assert.equal(routeTemplateMatchesHref('/*', '/anything'), true);
  });

  it('rejects an href shorter than the template', () => {
    assert.equal(routeTemplateMatchesHref('/a/b/:c', '/a'), false);
  });

  it('matches the root against the root', () => {
    assert.equal(routeTemplateMatchesHref('/', '/'), true);
  });
});

describe('toRoute / toDoor', () => {
  it('accepts a bare string', () => {
    assert.deepEqual(toRoute('/users'), {
      path: '/users',
      personas: [],
      exempt: false,
    });
    assert.deepEqual(toDoor('/users'), { href: '/users', persona: null });
  });

  it('keeps only non-blank string personas', () => {
    assert.deepEqual(
      toRoute({ path: '/x', personas: ['admin', '', '  ', 7, null] }).personas,
      ['admin'],
    );
    assert.deepEqual(toRoute({ path: '/x', personas: 'admin' }).personas, []);
  });

  it('carries the explicit exempt flag', () => {
    assert.equal(toRoute({ path: '/x', exempt: true }).exempt, true);
    assert.equal(toRoute({ path: '/x', exempt: 'yes' }).exempt, false);
  });

  it('accepts a door declared with path instead of href', () => {
    assert.deepEqual(toDoor({ path: '/x' }), { href: '/x', persona: null });
  });

  it('trims a persona and nulls a blank one', () => {
    assert.equal(toDoor({ href: '/x', persona: '  admin ' }).persona, 'admin');
    assert.equal(toDoor({ href: '/x', persona: '   ' }).persona, null);
    assert.equal(toDoor({ href: '/x', persona: 5 }).persona, null);
  });

  it('throws loudly on an entry with no usable identifier', () => {
    assert.throws(() => toRoute({ personas: ['a'] }), /no usable "path"/);
    assert.throws(() => toRoute(null), /no usable "path"/);
    assert.throws(() => toDoor({ persona: 'a' }), /no usable "href"/);
  });
});

describe('computeNavDiff', () => {
  it('reports nothing for an empty inventory', () => {
    assert.deepEqual(computeNavDiff(), {
      counts: { routes: 0, doors: 0 },
      orphanedRoutes: [],
      deadHrefs: [],
      exemptRoutes: [],
    });
  });

  it('reports a route no door surfaces as an orphan', () => {
    const diff = computeNavDiff({ routes: ['/reports'], nav: ['/home'] });
    assert.deepEqual(diff.orphanedRoutes, [{ path: '/reports', personas: [] }]);
    assert.deepEqual(diff.deadHrefs, [{ href: '/home', persona: null }]);
    assert.deepEqual(diff.counts, { routes: 1, doors: 1 });
  });

  it('treats a door with no persona as surfacing any entitled route', () => {
    const diff = computeNavDiff({
      routes: [{ path: '/admin', personas: ['admin'] }],
      nav: ['/admin'],
    });
    assert.deepEqual(diff.orphanedRoutes, []);
  });

  it('requires an entitled persona when both sides declare one', () => {
    const diff = computeNavDiff({
      routes: [{ path: '/admin', personas: ['admin'] }],
      nav: [{ href: '/admin', persona: 'viewer' }],
    });
    assert.deepEqual(diff.orphanedRoutes, [
      { path: '/admin', personas: ['admin'] },
    ]);
    assert.deepEqual(diff.deadHrefs, []);
  });

  it('exempts an explicitly exempt route', () => {
    const diff = computeNavDiff({
      routes: [{ path: '/internal', exempt: true }],
      nav: [],
    });
    assert.deepEqual(diff.exemptRoutes, [
      { path: '/internal', reason: 'explicit-exempt' },
    ]);
  });

  it('exempts a system route', () => {
    const diff = computeNavDiff({ routes: ['/login'], nav: [] });
    assert.deepEqual(diff.exemptRoutes, [
      { path: '/login', reason: 'system-route' },
    ]);
  });

  it('exempts a dynamic child of a surfaced parent', () => {
    const diff = computeNavDiff({
      routes: ['/users', '/users/:id'],
      nav: ['/users'],
    });
    assert.deepEqual(diff.exemptRoutes, [
      { path: '/users/:id', reason: 'dynamic-child-of-surfaced-parent' },
    ]);
    assert.deepEqual(diff.orphanedRoutes, []);
  });

  it('does NOT exempt a dynamic child whose parent is itself unsurfaced', () => {
    const diff = computeNavDiff({ routes: ['/users/:id'], nav: [] });
    assert.deepEqual(diff.orphanedRoutes, [
      { path: '/users/:id', personas: [] },
    ]);
  });

  it('exempts a route reached only by an in-app inbound reference', () => {
    const diff = computeNavDiff({
      routes: ['/reports'],
      nav: [],
      refs: ['/reports', '', null],
    });
    assert.deepEqual(diff.exemptRoutes, [
      { path: '/reports', reason: 'inbound-in-app-reference' },
    ]);
  });

  it('resolves a door against a template route, so it is not dead', () => {
    const diff = computeNavDiff({ routes: ['/users/:id'], nav: ['/users/7'] });
    assert.deepEqual(diff.deadHrefs, []);
  });
});

describe('formatDiffText', () => {
  it('renders counts, orphans, dead hrefs, and exemptions', () => {
    const text = formatDiffText(
      computeNavDiff({
        routes: ['/reports', { path: '/admin', personas: ['admin'] }, '/login'],
        nav: [{ href: '/nowhere', persona: 'admin' }],
      }),
    );
    assert.match(text, /routes: 3 {3}nav doors: 1/);
    assert.match(text, /- \/admin \[admin\]/);
    assert.match(text, /- \/nowhere \[admin\]/);
    assert.match(text, /- \/login — system-route/);
  });
});

describe('runNavRegistryDiff', () => {
  const fsStub = (files) => ({
    readFileSync: (file) => {
      if (!(file in files)) throw new Error(`ENOENT: ${file}`);
      return files[file];
    },
  });

  const sink = () => {
    const chunks = [];
    return { chunks, write: (s) => chunks.push(s) };
  };

  it('requires both --routes and --nav', async () => {
    await assert.rejects(
      () => runNavRegistryDiff([], { fsImpl: fsStub({}), stdout: sink() }),
      /both --routes <file> and --nav <file> are required/,
    );
    await assert.rejects(
      () =>
        runNavRegistryDiff(['--routes', 'r.json'], {
          fsImpl: fsStub({}),
          stdout: sink(),
        }),
      /both --routes <file> and --nav <file> are required/,
    );
  });

  it('prints the text report and exits 0 when there are findings but no --strict', async () => {
    const out = sink();
    const code = await runNavRegistryDiff(
      ['--routes', 'r.json', '--nav', 'n.json'],
      {
        fsImpl: fsStub({
          'r.json': JSON.stringify(['/reports']),
          'n.json': JSON.stringify([]),
        }),
        stdout: out,
      },
    );
    assert.equal(code, 0);
    assert.match(out.chunks.join(''), /orphaned routes: 1/);
  });

  it('exits 1 under --strict when a finding remains', async () => {
    const code = await runNavRegistryDiff(
      ['--routes', 'r.json', '--nav', 'n.json', '--strict'],
      {
        fsImpl: fsStub({
          'r.json': JSON.stringify(['/reports']),
          'n.json': JSON.stringify([]),
        }),
        stdout: sink(),
      },
    );
    assert.equal(code, 1);
  });

  it('exits 0 under --strict when the inventories agree', async () => {
    const code = await runNavRegistryDiff(
      ['--routes', 'r.json', '--nav', 'n.json', '--strict'],
      {
        fsImpl: fsStub({
          'r.json': JSON.stringify(['/home']),
          'n.json': JSON.stringify(['/home']),
        }),
        stdout: sink(),
      },
    );
    assert.equal(code, 0);
  });

  it('emits JSON under --json and folds in the optional --refs file', async () => {
    const out = sink();
    await runNavRegistryDiff(
      ['--routes', 'r.json', '--nav', 'n.json', '--refs', 'f.json', '--json'],
      {
        fsImpl: fsStub({
          'r.json': JSON.stringify({ routes: ['/reports'] }),
          'n.json': JSON.stringify({ nav: [] }),
          'f.json': JSON.stringify({ entries: ['/reports'] }),
        }),
        stdout: out,
      },
    );
    const parsed = JSON.parse(out.chunks.join(''));
    assert.deepEqual(parsed.orphanedRoutes, []);
    assert.deepEqual(parsed.exemptRoutes, [
      { path: '/reports', reason: 'inbound-in-app-reference' },
    ]);
  });

  it('names the unreadable file, the bad JSON, and the non-array shape', async () => {
    const base = ['--routes', 'r.json', '--nav', 'n.json'];
    await assert.rejects(
      () => runNavRegistryDiff(base, { fsImpl: fsStub({}), stdout: sink() }),
      /cannot read routes file 'r\.json'/,
    );
    await assert.rejects(
      () =>
        runNavRegistryDiff(base, {
          fsImpl: fsStub({ 'r.json': '{ not json' }),
          stdout: sink(),
        }),
      /routes file 'r\.json' is not valid JSON/,
    );
    await assert.rejects(
      () =>
        runNavRegistryDiff(base, {
          fsImpl: fsStub({ 'r.json': '{"unexpected":1}' }),
          stdout: sink(),
        }),
      /routes file 'r\.json' must be a JSON array/,
    );
  });
});

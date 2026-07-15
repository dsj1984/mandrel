import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  extractStoryPaths,
  globToRegExp,
  resolveNavConfig,
} from '../.agents/scripts/lib/orchestration/plan-navigation.js';

describe('globToRegExp', () => {
  it('matches a single-segment wildcard but not across separators', () => {
    const rx = globToRegExp('pages/*.tsx');
    assert.ok(rx.test('pages/dashboard.tsx'));
    assert.ok(!rx.test('pages/admin/users.tsx'));
  });

  it('matches any depth with a double-star', () => {
    const rx = globToRegExp('app/**/route.ts');
    assert.ok(rx.test('app/admin/route.ts'));
    assert.ok(rx.test('app/a/b/c/route.ts'));
    assert.ok(!rx.test('app/route.js'));
  });

  it('escapes regex metacharacters in literal segments', () => {
    const rx = globToRegExp('pages/(group)/*.tsx');
    assert.ok(rx.test('pages/(group)/x.tsx'));
    assert.ok(!rx.test('pages/group/x.tsx'));
  });
});

describe('extractStoryPaths', () => {
  it('pulls paths from `## Changes` JSON path descriptors', () => {
    const body =
      '## Changes\n- {"path":"pages/reports.tsx","assumption":"creates"}';
    assert.deepStrictEqual(extractStoryPaths(body), ['pages/reports.tsx']);
  });

  it('returns an empty array for a body with no paths', () => {
    assert.deepStrictEqual(extractStoryPaths('## Goal\nNo files here.'), []);
  });
});

describe('resolveNavConfig', () => {
  it('normalizes string and array forms', () => {
    assert.deepStrictEqual(
      resolveNavConfig({
        planning: {
          navigation: {
            routeGlobs: 'pages/**',
            navRegistry: ['nav-registry.ts', ''],
          },
        },
      }),
      {
        routeGlobs: ['pages/**'],
        navRegistry: ['nav-registry.ts'],
      },
    );
  });

  it('returns empty lists when navigation is absent', () => {
    assert.deepStrictEqual(resolveNavConfig({}), {
      routeGlobs: [],
      navRegistry: [],
    });
  });
});

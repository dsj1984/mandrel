import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  checkReachability,
  extractStoryPaths,
  globToRegExp,
  runPlanHealthcheck,
} from '../.agents/scripts/epic-plan-healthcheck.js';

/**
 * In-memory provider implementing the `getSubTickets` slice the healthcheck
 * reachability check consumes. `stories` is the child-ticket array returned
 * for any parent id.
 */
class StoryProvider {
  constructor(stories) {
    this.stories = stories;
    this.calls = [];
  }
  async getSubTickets(parentId) {
    this.calls.push(parentId);
    return this.stories;
  }
}

/** A minimal valid resolved config; nav config is layered in per-test. */
function baseConfig(navigation) {
  return {
    project: { baseBranch: 'main' },
    planning: navigation ? { navigation } : {},
  };
}

/** Build a Story ticket record with the given body. */
function story(id, body) {
  return { id, title: `Story ${id}`, labels: ['type::story'], body };
}

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

describe('checkReachability', () => {
  it('flags a route-adding Story with no nav-registry reference', async () => {
    const provider = new StoryProvider([
      story(
        201,
        '## Goal\nAdd a reports page.\n## Changes\n- {"path":"pages/reports.tsx","assumption":"creates"}\n## Acceptance\n- [ ] the reports page renders',
      ),
    ]);
    const result = await checkReachability(
      provider,
      100,
      baseConfig({
        routeGlobs: ['pages/**'],
        navRegistry: ['nav-registry.ts'],
      }),
    );
    assert.strictEqual(result.ok, false);
    assert.match(result.detail, /#201/);
    assert.match(result.detail, /nav-registry\.ts/);
  });

  it('passes a route-adding Story that references the nav registry', async () => {
    const provider = new StoryProvider([
      story(
        202,
        '## Goal\nAdd a reports page and wire it into nav-registry.ts.\n## Changes\n- {"path":"pages/reports.tsx","assumption":"creates"}\n## Acceptance\n- [ ] the reports route appears in the nav registry',
      ),
    ]);
    const result = await checkReachability(
      provider,
      100,
      baseConfig({
        routeGlobs: ['pages/**'],
        navRegistry: ['nav-registry.ts'],
      }),
    );
    assert.strictEqual(result.ok, true);
  });

  it('ignores Stories that touch no route-glob path', async () => {
    const provider = new StoryProvider([
      story(
        203,
        '## Goal\nRefactor a utility.\n## Changes\n- {"path":"lib/util.ts","assumption":"refactors-existing"}',
      ),
    ]);
    const result = await checkReachability(
      provider,
      100,
      baseConfig({
        routeGlobs: ['pages/**'],
        navRegistry: ['nav-registry.ts'],
      }),
    );
    assert.strictEqual(result.ok, true);
  });

  it('is a silent no-op when no route-glob config is present', async () => {
    const provider = new StoryProvider([
      story(204, '## Changes\n- {"path":"pages/reports.tsx"}'),
    ]);
    // No navigation config at all.
    const result = await checkReachability(provider, 100, baseConfig());
    assert.strictEqual(result.ok, true);
    assert.match(result.detail, /skipped/i);
    // The check short-circuits before touching the provider.
    assert.strictEqual(provider.calls.length, 0);
  });

  it('treats an empty routeGlobs array as unconfigured (no-op)', async () => {
    const provider = new StoryProvider([
      story(205, '## Changes\n- {"path":"pages/reports.tsx"}'),
    ]);
    const result = await checkReachability(
      provider,
      100,
      baseConfig({ routeGlobs: [], navRegistry: ['nav-registry.ts'] }),
    );
    assert.strictEqual(result.ok, true);
    assert.strictEqual(provider.calls.length, 0);
  });
});

describe('runPlanHealthcheck --paranoid reachability envelope', () => {
  it('emits a failing reachability check in checks[] for a route-without-nav Story', async () => {
    const provider = new StoryProvider([
      story(
        301,
        '## Goal\nAdd a page.\n## Changes\n- {"path":"pages/x.tsx","assumption":"creates"}\n## Acceptance\n- [ ] the page renders',
      ),
    ]);
    const result = await runPlanHealthcheck({
      epicId: 100,
      paranoid: true,
      injectedProvider: provider,
      injectedConfig: baseConfig({
        routeGlobs: ['pages/**'],
        navRegistry: ['nav-registry.ts'],
      }),
    });
    const reach = result.checks.find((c) => c.name === 'reachability');
    assert.ok(reach, 'reachability check is present in the envelope');
    assert.strictEqual(reach.ok, false);
    assert.match(reach.detail, /#301/);
  });

  it('omits the reachability flag (passes) when unconfigured', async () => {
    const provider = new StoryProvider([
      story(
        302,
        '## Goal\nAdd a page.\n## Changes\n- {"path":"pages/x.tsx","assumption":"creates"}\n## Acceptance\n- [ ] renders',
      ),
    ]);
    const result = await runPlanHealthcheck({
      epicId: 100,
      paranoid: true,
      injectedProvider: provider,
      injectedConfig: baseConfig(),
    });
    const reach = result.checks.find((c) => c.name === 'reachability');
    assert.ok(reach, 'reachability check still runs');
    assert.strictEqual(reach.ok, true);
    assert.match(reach.detail, /skipped/i);
  });
});

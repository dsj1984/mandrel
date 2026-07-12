/**
 * plan-reachability.test.js — orphan-surface detection fixtures for the
 * #4474 PR6 deterministic persist-side reachability check (the demoted
 * 8.4 critic):
 *
 *   - unconfigured `planning.navigation` → silent skip (status 'skipped');
 *   - configured navRegistry × clean route set → ok;
 *   - configured navRegistry × orphaned route set → named orphan list;
 *   - plan-level coverage: appending one nav-owner Story that cites the
 *     orphaned routes + the registry converges the re-run to ok (the
 *     one-targeted-amend recovery contract);
 *   - fallback registry tokens when navRegistry is empty;
 *   - the rendered soft-failure message.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  evaluateDraftReachability,
  renderReachabilityOrphans,
} from '../.agents/scripts/lib/orchestration/plan-reachability.js';

const NAV_CONFIG = {
  planning: {
    navigation: {
      routeGlobs: ['pages/**', 'app/**/route.ts'],
      navRegistry: ['nav-registry.ts'],
    },
  },
};

/** Draft story with a serialized-shape body (`{"path":...}` descriptors). */
function story(slug, { paths = [], extraBody = '' } = {}) {
  const changes = paths
    .map((p) => `- {"path":"${p}","assumption":"creates"}`)
    .join('\n');
  return {
    slug,
    title: `Story ${slug}`,
    body: `## Goal\n${slug}.\n\n## Changes\n${changes}\n${extraBody}`,
    depends_on: [],
  };
}

describe('evaluateDraftReachability — fixtures', () => {
  it('is a silent no-op when planning.navigation is unconfigured', () => {
    const result = evaluateDraftReachability({
      tickets: [story('a', { paths: ['pages/dashboard.tsx'] })],
      config: {},
    });
    assert.equal(result.status, 'skipped');
    assert.match(result.reasons[0], /No planning\.navigation\.routeGlobs/);
    assert.deepEqual(result.orphans, []);
    assert.equal(result.scanned, 0);
  });

  it('passes a clean route set (every route-adding story cites the registry)', () => {
    const result = evaluateDraftReachability({
      tickets: [
        story('adds-page', {
          paths: ['pages/reports.tsx'],
          extraBody: '\nRegister the page in `nav-registry.ts`.',
        }),
        story('no-routes', { paths: ['lib/util.js'] }),
      ],
      config: NAV_CONFIG,
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.scanned, 2);
  });

  it('flags orphan surfaces: route-adding stories with no navigation owner', () => {
    const result = evaluateDraftReachability({
      tickets: [
        story('orphan-a', { paths: ['pages/reports.tsx', 'lib/util.js'] }),
        story('orphan-b', { paths: ['app/billing/route.ts'] }),
        story('clean', { paths: ['lib/other.js'] }),
      ],
      config: NAV_CONFIG,
    });
    assert.equal(result.status, 'orphans');
    assert.deepEqual(result.orphans, [
      { story: 'orphan-a', paths: ['pages/reports.tsx'] },
      { story: 'orphan-b', paths: ['app/billing/route.ts'] },
    ]);
  });

  it('converges after the one-targeted-amend recovery (a nav-owner story covers the routes)', () => {
    const orphaned = [
      story('orphan-a', { paths: ['pages/reports.tsx'] }),
      story('orphan-b', { paths: ['app/billing/route.ts'] }),
    ];
    assert.equal(
      evaluateDraftReachability({ tickets: orphaned, config: NAV_CONFIG })
        .status,
      'orphans',
    );
    // The documented recovery: append ONE reachability Story citing the
    // orphaned routes and the nav registry, then re-run.
    const amended = [
      ...orphaned,
      story('nav-owner', {
        paths: ['pages/reports.tsx', 'app/billing/route.ts'],
        extraBody:
          '\nWire both surfaces into `nav-registry.ts` so each has a nav door.',
      }),
    ];
    const rerun = evaluateDraftReachability({
      tickets: amended,
      config: NAV_CONFIG,
    });
    assert.equal(rerun.status, 'ok');
  });

  it('falls back to generic registry tokens when navRegistry is empty', () => {
    const config = {
      planning: { navigation: { routeGlobs: ['pages/**'] } },
    };
    const flagged = evaluateDraftReachability({
      tickets: [story('a', { paths: ['pages/x.tsx'] })],
      config,
    });
    assert.equal(flagged.status, 'orphans');
    const passing = evaluateDraftReachability({
      tickets: [
        story('a', {
          paths: ['pages/x.tsx'],
          extraBody: '\nAdd the page to the nav registry.',
        }),
      ],
      config,
    });
    assert.equal(passing.status, 'ok');
  });

  it('handles an empty draft set as ok', () => {
    const result = evaluateDraftReachability({
      tickets: [],
      config: NAV_CONFIG,
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.scanned, 0);
  });
});

describe('renderReachabilityOrphans', () => {
  it('renders the named soft failure with the orphan list and the recovery contract', () => {
    const message = renderReachabilityOrphans({
      status: 'orphans',
      reasons: ['1 route-adding draft story(ies) leave orphan surfaces.'],
      orphans: [{ story: 'orphan-a', paths: ['pages/reports.tsx'] }],
      scanned: 1,
    });
    assert.match(message, /SOFT FAILURE — reachability orphans/);
    assert.match(message, /orphan-a: pages\/reports\.tsx/);
    assert.match(message, /Nothing was written to GitHub/);
    assert.match(message, /ONE targeted amend/);
    assert.match(message, /at most one reachability Story per plan/);
  });
});

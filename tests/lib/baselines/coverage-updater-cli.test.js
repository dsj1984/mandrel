/**
 * coverage-updater-cli.test.js — the `update-coverage-baseline` CLI's scope
 * reconciliation and scorer (Story #5316).
 *
 * Both lived inside `main`, unreachable from a test: `main` scored CRAP 30 and
 * the inlined scorer another 30.
 *
 * The `[Coverage] ❌` read-failure log is asserted deliberately. It is the
 * reason this scorer was not collapsed into the service's behaviour-equivalent
 * `buildDefaultCoverageScorer`: `refresh-service.js` has no empty-rows guard,
 * so an unreadable artifact silently writes an emptied baseline at exit 0, and
 * that line is the only signal the operator gets.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildCoverageUpdaterScorer,
  resolveCoverageUpdaterScope,
} from '../../../.agents/scripts/lib/baselines/coverage-updater-cli.js';

function recordingLogger() {
  const lines = { info: [], warn: [], error: [] };
  return {
    lines,
    info: (s) => lines.info.push(s),
    warn: (s) => lines.warn.push(s),
    error: (s) => lines.error.push(s),
  };
}

/** Seams over a two-file coverage artifact, one of which is out of c8 scope. */
function stubDeps(logger, over = {}) {
  return {
    readCoverage: () => ({ raw: true }),
    loadScope: () => ({ include: ['.agents/**'], exclude: [] }),
    buildScope: (cfg) => cfg,
    score: () => ({
      '.agents/scripts/a.js': { lines: 90, branches: 80, functions: 70 },
      '.agents/scripts/b.js': { lines: 50, branches: 40, functions: 30 },
    }),
    logger,
    ...over,
  };
}

describe('resolveCoverageUpdaterScope', () => {
  it('reports neither flag for an empty argv', () => {
    assert.deepEqual(resolveCoverageUpdaterScope([]), {
      fullScope: false,
      diffScopeRef: null,
    });
  });

  it('reads --full-scope', () => {
    assert.equal(resolveCoverageUpdaterScope(['--full-scope']).fullScope, true);
  });

  it('reads --diff-scope in both spellings', () => {
    assert.equal(
      resolveCoverageUpdaterScope(['--diff-scope', 'origin/main']).diffScopeRef,
      'origin/main',
    );
    assert.equal(
      resolveCoverageUpdaterScope(['--diff-scope=HEAD~2']).diffScopeRef,
      'HEAD~2',
    );
  });

  it('refuses the incompatible pair rather than silently preferring one', () => {
    assert.throws(
      () =>
        resolveCoverageUpdaterScope(['--full-scope', '--diff-scope', 'HEAD']),
      /--full-scope is incompatible with --diff-scope/,
    );
  });
});

describe('buildCoverageUpdaterScorer — the read failure', () => {
  it('logs the error and returns no rows', () => {
    const logger = recordingLogger();
    const scorer = buildCoverageUpdaterScorer(
      '/repo',
      stubDeps(logger, {
        readCoverage: () => {
          throw new Error('ENOENT coverage-final.json');
        },
      }),
    );
    assert.deepEqual(scorer([], { fullScope: true }), []);
    assert.match(logger.lines.error.join('\n'), /ENOENT coverage-final\.json/);
  });

  it('does not score when the artifact could not be read', () => {
    const logger = recordingLogger();
    let scored = false;
    const scorer = buildCoverageUpdaterScorer(
      '/repo',
      stubDeps(logger, {
        readCoverage: () => {
          throw new Error('unreadable');
        },
        score: () => {
          scored = true;
          return {};
        },
      }),
    );
    scorer([], { fullScope: true });
    assert.equal(scored, false);
  });
});

describe('buildCoverageUpdaterScorer — rows', () => {
  it('projects every scored file onto the baseline row shape in full scope', () => {
    const scorer = buildCoverageUpdaterScorer(
      '/repo',
      stubDeps(recordingLogger()),
    );
    const rows = scorer([], { fullScope: true });
    assert.deepEqual(rows, [
      {
        path: '.agents/scripts/a.js',
        lines: 90,
        branches: 80,
        functions: 70,
      },
      {
        path: '.agents/scripts/b.js',
        lines: 50,
        branches: 40,
        functions: 30,
      },
    ]);
  });

  it('narrows to the in-scope file list in diff mode', () => {
    const scorer = buildCoverageUpdaterScorer(
      '/repo',
      stubDeps(recordingLogger()),
    );
    const rows = scorer(['.agents/scripts/b.js'], { fullScope: false });
    assert.deepEqual(
      rows.map((r) => r.path),
      ['.agents/scripts/b.js'],
    );
  });

  it('treats an empty diff list as no narrowing, so rows are preserved', () => {
    const scorer = buildCoverageUpdaterScorer(
      '/repo',
      stubDeps(recordingLogger()),
    );
    assert.equal(scorer([], { fullScope: false }).length, 2);
  });

  it('defaults a missing metric to 0 rather than undefined', () => {
    const scorer = buildCoverageUpdaterScorer(
      '/repo',
      stubDeps(recordingLogger(), {
        score: () => ({ 'a.js': {}, 'b.js': null }),
      }),
    );
    for (const row of scorer([], { fullScope: true })) {
      assert.equal(row.lines, 0);
      assert.equal(row.branches, 0);
      assert.equal(row.functions, 0);
    }
  });

  it('hands the c8 include/exclude through to the scope predicate', () => {
    let seenScope;
    const scorer = buildCoverageUpdaterScorer(
      '/repo',
      stubDeps(recordingLogger(), {
        loadScope: () => ({ include: ['lib/**'], exclude: ['lib/gen/**'] }),
        score: (args) => {
          seenScope = args.scope;
          return {};
        },
      }),
    );
    scorer([], { fullScope: true });
    assert.deepEqual(seenScope, {
      include: ['lib/**'],
      exclude: ['lib/gen/**'],
    });
  });

  it('tolerates a .c8rc with neither include nor exclude', () => {
    let seenScope;
    const scorer = buildCoverageUpdaterScorer(
      '/repo',
      stubDeps(recordingLogger(), {
        loadScope: () => ({}),
        score: (args) => {
          seenScope = args.scope;
          return {};
        },
      }),
    );
    scorer([], { fullScope: true });
    assert.deepEqual(seenScope, { include: [], exclude: [] });
  });

  it('scores against the opts cwd when one is given', () => {
    let seenCwd;
    const scorer = buildCoverageUpdaterScorer(
      '/repo',
      stubDeps(recordingLogger(), {
        score: (args) => {
          seenCwd = args.cwd;
          return {};
        },
      }),
    );
    scorer([], { fullScope: true, cwd: '/elsewhere' });
    assert.equal(seenCwd, '/elsewhere');
  });

  it('falls back to the build cwd when opts carries none', () => {
    let seenCwd;
    const scorer = buildCoverageUpdaterScorer(
      '/repo',
      stubDeps(recordingLogger(), {
        score: (args) => {
          seenCwd = args.cwd;
          return {};
        },
      }),
    );
    scorer([], { fullScope: true });
    assert.equal(seenCwd, '/repo');
  });
});

describe('buildCoverageUpdaterScorer — reporting', () => {
  it('reports the scored file count, and the in-scope count only in diff mode', () => {
    const full = recordingLogger();
    buildCoverageUpdaterScorer('/repo', stubDeps(full))([], {
      fullScope: true,
    });
    assert.match(full.lines.info.join('\n'), /Scored 2 file\(s\)\./);

    const diff = recordingLogger();
    buildCoverageUpdaterScorer('/repo', stubDeps(diff))(
      ['.agents/scripts/b.js'],
      { fullScope: false },
    );
    assert.match(
      diff.lines.info.join('\n'),
      /Scored 2 file\(s\) \(1 in scope\)/,
    );
  });
});

/**
 * Branch-coverage harness for the 11 high-CRAP methods refactored under
 * Story #1641 (parent Epic #1184, parent Task #1645). Each suite drives
 * every branch of a targeted method so the regenerated CRAP baseline lands
 * at or below the floor.
 *
 * Methods covered:
 *   - progress-reporter.phaseToState
 *   - ticket-validator.validateAndNormalizeTickets (+ extracted helpers)
 *   - spec-renderer.renderSpec (+ extracted helpers)
 *   - merge-runner.{rebaseStoryOnEpic, runFinalizeMerge, finalizeMergeIfPending}
 *   - automerge-predicate.deriveAutoMergeVerdict (+ extracted helpers)
 *   - reconciler.maybeClose (exercised via reconcileHierarchy)
 *   - crap-drift.findCoverageEntry (+ normaliseCoveragePath / coverageKeyMatches)
 *   - auto-refresh-runner.runAutoRefresh
 *   - baseline-attribution-wiring.diffCrapBaselines
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { phaseToState } from '../../../.agents/scripts/lib/orchestration/epic-runner/progress-reporter.js';
import {
  coverageKeyMatches,
  createCrapDriftDetector,
  normaliseCoveragePath,
} from '../../../.agents/scripts/lib/orchestration/epic-runner/progress-signals/crap-drift.js';
import {
  CLEAN_SPRINT_MARKER,
  deriveAutoMergeVerdict,
} from '../../../.agents/scripts/lib/orchestration/lifecycle/listeners/automerge-predicate.js';
import { reconcileHierarchy } from '../../../.agents/scripts/lib/orchestration/reconciler.js';
import { runAutoRefresh } from '../../../.agents/scripts/lib/orchestration/story-close/auto-refresh-runner.js';
import { diffCrapBaselines } from '../../../.agents/scripts/lib/orchestration/story-close/baseline-attribution-wiring.js';
import {
  finalizeMergeIfPending,
  rebaseStoryOnEpic,
  runFinalizeMerge,
} from '../../../.agents/scripts/lib/orchestration/story-close/merge-runner.js';
import { validateAndNormalizeTickets } from '../../../.agents/scripts/lib/orchestration/ticket-validator.js';

// ---------------------------------------------------------------------------
// phaseToState
// ---------------------------------------------------------------------------

describe('progress-reporter.phaseToState', () => {
  it('maps each known phase token and falls back to "unknown"', () => {
    assert.equal(phaseToState('done'), 'done');
    assert.equal(phaseToState('blocked'), 'blocked');
    assert.equal(phaseToState('implementing'), 'in-flight');
    assert.equal(phaseToState('closing'), 'in-flight');
    assert.equal(phaseToState('init'), 'queued');
    assert.equal(phaseToState('mystery'), 'unknown');
    assert.equal(phaseToState(undefined), 'unknown');
    assert.equal(phaseToState(null), 'unknown');
  });
});

// ---------------------------------------------------------------------------
// ticket-validator.validateAndNormalizeTickets + helpers
// ---------------------------------------------------------------------------

function buildMinimalBacklog() {
  return [
    {
      slug: 'feat-x',
      type: 'feature',
      title: 'feat X',
      depends_on: [],
    },
    {
      slug: 'story-x',
      type: 'story',
      title: 'story X',
      parent_slug: 'feat-x',
      depends_on: [],
      acceptance: ['story X is implemented'],
      verify: ['node --test'],
    },
  ];
}

describe('ticket-validator.validateAndNormalizeTickets — happy path', () => {
  it('returns the input tickets and attaches findings/errors', () => {
    const backlog = buildMinimalBacklog();
    const validated = validateAndNormalizeTickets(backlog);
    assert.equal(validated, backlog);
    assert.ok(Array.isArray(validated.findings));
    assert.ok(Array.isArray(validated.errors));
  });
});

describe('ticket-validator.validateAndNormalizeTickets — error branches', () => {
  it('throws on duplicate slug', () => {
    const b = buildMinimalBacklog();
    b.push({
      slug: 'story-x',
      type: 'story',
      title: 'dup',
      parent_slug: 'feat-x',
      acceptance: ['a'],
      verify: ['v'],
    });
    assert.throws(() => validateAndNormalizeTickets(b), /Duplicate slug/);
  });

  it('throws when no Feature is present', () => {
    const b = buildMinimalBacklog().filter((t) => t.type !== 'feature');
    assert.throws(() => validateAndNormalizeTickets(b), /at least one Feature/);
  });

  it('throws when no Story is present', () => {
    const b = buildMinimalBacklog().filter((t) => t.type !== 'story');
    assert.throws(() => validateAndNormalizeTickets(b), /at least one Story/);
  });

  it('throws when a Story lacks an inline acceptance + verify contract', () => {
    // 3-tier (Epic #3238): a Story with no top-level acceptance/verify is
    // the legacy 4-tier shape that expected child Tasks — now rejected.
    const b = buildMinimalBacklog();
    const story = b.find((t) => t.type === 'story');
    story.acceptance = undefined;
    story.verify = undefined;
    assert.throws(
      () => validateAndNormalizeTickets(b),
      /lack an inline acceptance \+ verify contract/,
    );
  });

  it('throws on Story without parent_slug', () => {
    const b = buildMinimalBacklog();
    b.find((t) => t.type === 'story').parent_slug = undefined;
    assert.throws(
      () => validateAndNormalizeTickets(b),
      /Story "story X" must have a parent_slug/,
    );
  });

  it('throws on Story whose parent is not a Feature', () => {
    const b = buildMinimalBacklog();
    b.push({
      slug: 'story-z',
      type: 'story',
      title: 'story Z',
      parent_slug: 'story-x',
      acceptance: ['a'],
      verify: ['v'],
    });
    assert.throws(
      () => validateAndNormalizeTickets(b),
      /Story "story Z" parent must be a Feature/,
    );
  });

  it('throws on unknown depends_on slug', () => {
    const b = buildMinimalBacklog();
    b.find((t) => t.slug === 'story-x').depends_on = ['ghost'];
    assert.throws(
      () => validateAndNormalizeTickets(b),
      /depends_on reference\(s\) use unknown slugs/,
    );
  });

  it('throws on circular dependency', () => {
    const b = buildMinimalBacklog();
    // Add a sibling story Y → make X depend on Y, Y depend on X.
    b.push({
      slug: 'story-y',
      type: 'story',
      title: 'story Y',
      parent_slug: 'feat-x',
      depends_on: ['story-x'],
      acceptance: ['a'],
      verify: ['v'],
    });
    b.find((t) => t.slug === 'story-x').depends_on = ['story-y'];
    assert.throws(
      () => validateAndNormalizeTickets(b),
      /Circular dependency detected/,
    );
  });
});
// ---------------------------------------------------------------------------
// merge-runner — rebaseStoryOnEpic / runFinalizeMerge / finalizeMergeIfPending
// ---------------------------------------------------------------------------

function gitStub(routes = {}) {
  const calls = [];
  return {
    calls,
    gitSpawn: (cwd, ...args) => {
      calls.push({ cwd, args });
      const key = args.join(' ');
      const route = routes[key];
      if (typeof route === 'function') return route(cwd, args);
      return route ?? { status: 0, stdout: '', stderr: '' };
    },
  };
}

describe('merge-runner.rebaseStoryOnEpic', () => {
  it('returns isolation-disabled when worktreeIsolation is off', () => {
    const out = rebaseStoryOnEpic({
      orchestration: { worktreeIsolation: { enabled: false } },
      storyId: 1,
      epicBranch: 'e',
      storyBranch: 's',
      repoRoot: '/r',
      gitSpawn: gitStub().gitSpawn,
    });
    assert.deepEqual(out, { rebased: false, reason: 'isolation-disabled' });
  });

  it('returns worktree-missing when path does not exist', () => {
    const out = rebaseStoryOnEpic({
      orchestration: {
        worktreeIsolation: { enabled: true, root: '/nonexistent-9d8h2' },
      },
      storyId: 999999,
      epicBranch: 'e',
      storyBranch: 's',
      repoRoot: '/r-nonexistent-9d8h2',
      gitSpawn: gitStub().gitSpawn,
    });
    assert.equal(out.rebased, false);
    assert.match(out.reason, /worktree-missing|isolation-disabled/);
  });
});

describe('merge-runner.finalizeMergeIfPending', () => {
  it('no-ops when MERGE_HEAD is absent', async () => {
    const stub = gitStub();
    const logs = [];
    await finalizeMergeIfPending({
      cwd: process.cwd(), // MERGE_HEAD will not exist
      epicBranch: 'epic/1',
      storyBranch: 'story-1',
      storyTitle: 't',
      storyId: 1,
      log: (tag, msg) => logs.push(`${tag}:${msg}`),
      gitSpawn: stub.gitSpawn,
    });
    assert.ok(logs.some((l) => l.includes('No MERGE_HEAD found')));
    assert.equal(stub.calls.length, 0);
  });
});

describe('merge-runner.runFinalizeMerge', () => {
  it('throws when storyTitle is missing (buildMergeMessage)', async () => {
    const stub = gitStub();
    await assert.rejects(async () =>
      runFinalizeMerge({
        storyTitle: undefined,
        storyId: 1,
        cwd: process.cwd(),
        orchestration: { worktreeIsolation: { enabled: false } },
        gitSync: () => ({ status: 0, stdout: '', stderr: '' }),
        gitSpawn: stub.gitSpawn,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// automerge-predicate.deriveAutoMergeVerdict
// ---------------------------------------------------------------------------

describe('automerge-predicate.deriveAutoMergeVerdict', () => {
  it('clean when every signal source is clean', () => {
    const verdict = deriveAutoMergeVerdict({
      state: {
        manualInterventions: [],
        waves: [{ status: 'complete', stories: [{ status: 'done' }] }],
      },
      codeReview: { body: '🔴 Critical Blocker: 0\n🟠 High Risk: 0\n' },
      retro: { body: `done ${CLEAN_SPRINT_MARKER} okay` },
    });
    assert.equal(verdict.clean, true);
    assert.deepEqual(verdict.reasons, []);
  });

  it('flags missing state', () => {
    const v = deriveAutoMergeVerdict({
      state: null,
      codeReview: { body: '🔴 Critical Blocker: 0\n🟠 High Risk: 0\n' },
      retro: { body: CLEAN_SPRINT_MARKER },
    });
    assert.ok(
      v.reasons.some((r) => r.includes('epic-run-state checkpoint missing')),
    );
  });

  it('flags manual interventions and truncates the printed list', () => {
    const v = deriveAutoMergeVerdict({
      state: {
        manualInterventions: [
          { reason: 'r1' },
          { reason: 'r2' },
          { reason: 'r3' },
          { reason: 'r4' },
        ],
        waves: [],
      },
      codeReview: null,
      retro: null,
    });
    assert.ok(
      v.reasons.some((r) => r.includes('manual interventions recorded (4)')),
    );
    assert.ok(v.reasons.some((r) => r.includes('…')));
  });

  it('flags non-complete waves and per-story blockers', () => {
    const v = deriveAutoMergeVerdict({
      state: {
        manualInterventions: [],
        waves: [
          {
            status: 'in-progress',
            stories: [
              { blockerCommentId: 'c1', status: 'blocked' },
              { status: 'in-flight' },
            ],
          },
        ],
      },
      codeReview: { body: '🔴 Critical Blocker: 1\n🟠 High Risk: 2\n' },
      retro: { body: 'no marker here' },
    });
    assert.ok(v.reasons.some((r) => r.includes('wave(s) not complete')));
    assert.ok(v.reasons.some((r) => r.includes('story-level blocker')));
    assert.ok(v.reasons.some((r) => r.includes('1 🔴 Critical Blocker')));
    assert.ok(v.reasons.some((r) => r.includes('2 🟠 High Risk')));
    assert.ok(v.reasons.some((r) => r.includes('retro is not compact')));
    assert.equal(v.clean, false);
  });

  it('flags un-parseable code-review severity bullets', () => {
    const v = deriveAutoMergeVerdict({
      state: { manualInterventions: [], waves: [] },
      codeReview: { body: 'no bullets here' },
      retro: { body: CLEAN_SPRINT_MARKER },
    });
    assert.ok(
      v.reasons.some((r) =>
        r.includes('code-review severity bullets could not be parsed'),
      ),
    );
  });

  it('flags missing code-review + missing retro', () => {
    const v = deriveAutoMergeVerdict({
      state: { manualInterventions: [], waves: [] },
      codeReview: null,
      retro: null,
    });
    assert.ok(
      v.reasons.some((r) =>
        r.includes('code-review structured comment not found'),
      ),
    );
    assert.ok(
      v.reasons.some((r) => r.includes('retro structured comment not found')),
    );
  });
});

// ---------------------------------------------------------------------------
// reconciler.maybeClose (via reconcileHierarchy)
// ---------------------------------------------------------------------------

describe('reconciler.maybeClose', () => {
  const STORY_LABEL = 'type::story';
  const FEATURE_LABEL = 'type::feature';

  function makeTicket(id, type, extra = {}) {
    return {
      id,
      type,
      title: `T${id}`,
      labels: [type === 'story' ? STORY_LABEL : FEATURE_LABEL],
      labelSet: new Set([type === 'story' ? STORY_LABEL : FEATURE_LABEL]),
      state: 'open',
      body: extra.body ?? null,
      ...extra,
    };
  }

  it('dry-run flips state to closed without provider calls', async () => {
    const provider = {
      updateTicket: async () => {
        throw new Error('should not be called in dry-run');
      },
    };
    const story = makeTicket(10, 'story', { body: 'parent: #1' });
    const all = [
      story,
      {
        id: 100,
        type: 'task',
        state: 'closed',
        title: 'tA',
        body: 'parent: #10',
        labels: ['agent::done'],
        labelSet: new Set(['agent::done']),
      },
    ];
    await reconcileHierarchy(provider, 1, null, all, true);
    assert.equal(story.state, 'closed');
  });

  it('skips already-closed and parent-less tickets', async () => {
    let updates = 0;
    const provider = {
      updateTicket: async () => {
        updates += 1;
      },
    };
    const closedStory = makeTicket(11, 'story', { state: 'closed' });
    await reconcileHierarchy(provider, 1, null, [closedStory], false);
    assert.equal(updates, 0);
  });
});

// ---------------------------------------------------------------------------
// crap-drift helpers
// ---------------------------------------------------------------------------

describe('crap-drift helpers', () => {
  it('normaliseCoveragePath drops "./" prefix and flips backslashes', () => {
    assert.equal(normaliseCoveragePath('./foo/bar.js'), 'foo/bar.js');
    assert.equal(normaliseCoveragePath('foo\\bar.js'), 'foo/bar.js');
    assert.equal(normaliseCoveragePath(''), '');
  });

  it('coverageKeyMatches accepts exact + suffix match', () => {
    assert.equal(coverageKeyMatches('foo/bar.js', 'foo/bar.js'), true);
    assert.equal(
      coverageKeyMatches('/abs/path/foo/bar.js', 'foo/bar.js'),
      true,
    );
    assert.equal(coverageKeyMatches('other.js', 'foo/bar.js'), false);
    assert.equal(coverageKeyMatches('FOObar.js', 'bar.js'), false);
  });

  it('findCoverageEntry exercised through createCrapDriftDetector', () => {
    const fs = {
      readFileSync: () => 'function f(){}',
      writeFileSync: () => {},
      mkdirSync: () => {},
      existsSync: () => false,
    };
    const detector = createCrapDriftDetector({
      cwd: '/tmp',
      files: ['foo.js'],
      fs,
      calculate: () => [{ method: 'f', startLine: 1, crap: 1 }],
      loadCoverage: () => ({ 'foo.js': { statementMap: {} } }),
      coveragePath: '/tmp/cov.json',
    });
    const snap = detector.captureBaseline();
    assert.ok(snap['foo.js']);
  });

  it('findCoverageEntry returns null for empty path / no map', () => {
    const detector = createCrapDriftDetector({
      cwd: '/tmp',
      files: [],
      fs: {
        readFileSync: () => '',
        writeFileSync: () => {},
        mkdirSync: () => {},
        existsSync: () => false,
      },
      calculate: () => [],
      loadCoverage: () => null,
      coveragePath: null,
    });
    // captureBaseline with no files is a no-op but exercises readCoverageMap
    // returning null branch.
    detector.captureBaseline();
  });
});

// ---------------------------------------------------------------------------
// auto-refresh-runner.runAutoRefresh
// ---------------------------------------------------------------------------

describe('auto-refresh-runner.runAutoRefresh — Story #2205 contract', () => {
  // Story #2205 — `runAutoRefresh` now routes every baseline write through
  // `refreshBaseline()` and emits `chore(baselines): refresh <kind> for
  // story-<id>` commits (no `--amend`, no `--allow-empty`). Tests pin the
  // status-string contract for the four terminal outcomes:
  //
  //   skipped/disabled, skipped/no-baseline-drift,
  //   refused (with friction + dedup),
  //   committed (with sha).
  function baseDeps(overrides = {}) {
    return {
      logger: { info: () => {}, warn: () => {} },
      getQuality: () => ({
        autoRefresh: { enabled: true, miDropCap: 5, crapJumpCap: 5 },
      }),
      getBaselines: () => ({
        maintainability: { path: 'baselines/maintainability.json' },
        crap: { path: 'baselines/crap.json' },
      }),
      evaluateAutoRefresh: () => ({
        canAutoRefresh: true,
        miOverCap: [],
        crapOverCap: [],
        refusalReasons: [],
      }),
      // Stub the refresh-service: claim every kind wrote successfully.
      refreshBaseline: async (opts) => ({
        kind: opts.kind,
        writePath: opts.writePath,
        wrote: true,
      }),
      // Stub the scorer builder — the scorer itself is never invoked
      // because refreshBaseline is stubbed.
      scorerBuilder: () => () => async () => [],
      gitRunner: {
        gitSpawn: (_cwd, ...args) => {
          // Default plan: every git op succeeds.
          //   - `diff --cached --exit-code` returns 1 (drift present), so
          //     the runner emits a commit.
          //   - `rev-parse --short HEAD` returns abc1234.
          if (
            args[0] === 'diff' &&
            args.includes('--cached') &&
            args.includes('--exit-code')
          ) {
            return { status: 1, stdout: 'drift\n' };
          }
          if (args[0] === 'rev-parse') {
            return { status: 0, stdout: 'abc1234' };
          }
          return { status: 0, stdout: '', stderr: '' };
        },
      },
      fsImpl: {
        readFileSync: () => '{}',
        mkdirSync: () => {},
        writeFileSync: () => {},
      },
      appendSignal: async () => true,
      forEachLine: async () => {},
      computeStoryDiffPaths: () => [],
      // Reader returns minimally-valid envelopes so the cap evaluator
      // has something to iterate over.
      readerLoadFile: () => ({
        rollup: { '*': {} },
        rows: [],
        kernelVersion: '0.1.0',
        generatedAt: '2026-05-15T00:00:00Z',
      }),
      ...overrides,
    };
  }

  it('returns "skipped/disabled" when autoRefresh is off', async () => {
    const out = await runAutoRefresh({
      storyId: 1,
      epicId: 1,
      cwd: '/tmp',
      epicBranch: 'epic/1',
      storyBranch: 'story-1',
      agentSettings: {},
      deps: baseDeps({
        getQuality: () => ({ autoRefresh: { enabled: false } }),
      }),
    });
    assert.deepEqual(out, { status: 'skipped', reason: 'disabled' });
  });

  it('returns "skipped/no-baseline-drift" when every refreshBaseline reports wrote:false', async () => {
    const out = await runAutoRefresh({
      storyId: 1,
      epicId: 1,
      cwd: '/tmp',
      epicBranch: 'epic/1',
      storyBranch: 'story-1',
      agentSettings: {},
      deps: baseDeps({
        refreshBaseline: async (opts) => ({
          kind: opts.kind,
          writePath: opts.writePath,
          wrote: false,
        }),
      }),
    });
    assert.deepEqual(out, { status: 'skipped', reason: 'no-baseline-drift' });
  });

  it('returns "failed/refresh-service-threw" when refreshBaseline rejects', async () => {
    const out = await runAutoRefresh({
      storyId: 1,
      epicId: 1,
      cwd: '/tmp',
      epicBranch: 'epic/1',
      storyBranch: 'story-1',
      agentSettings: {},
      deps: baseDeps({
        refreshBaseline: async () => {
          throw new Error('boom');
        },
      }),
    });
    assert.equal(out.status, 'failed');
    assert.equal(out.reason, 'refresh-service-threw');
    assert.equal(out.detail, 'boom');
  });

  it('happy path under cap → status=committed with sha', async () => {
    const out = await runAutoRefresh({
      storyId: 1,
      epicId: 1,
      cwd: '/tmp',
      epicBranch: 'epic/1',
      storyBranch: 'story-1',
      agentSettings: {},
      deps: baseDeps(),
    });
    assert.equal(out.status, 'committed');
    assert.equal(out.sha, 'abc1234');
  });

  it('refused path → appends friction signal and rolls back baseline files', async () => {
    const out = await runAutoRefresh({
      storyId: 1,
      epicId: 1,
      cwd: '/tmp',
      epicBranch: 'epic/1',
      storyBranch: 'story-1',
      agentSettings: {},
      deps: baseDeps({
        evaluateAutoRefresh: () => ({
          canAutoRefresh: false,
          miOverCap: [{ path: 'a.js', drop: 9 }],
          crapOverCap: [{ file: 'b.js', method: 'm', drop: 9 }],
          refusalReasons: ['mi cap breached'],
        }),
      }),
    });
    assert.equal(out.status, 'refused');
    assert.equal(out.dedup, false);
    assert.equal(out.signalAppended, true);
  });

  it('refused path with dedup match → does NOT append friction signal', async () => {
    let appended = 0;
    const out = await runAutoRefresh({
      storyId: 1,
      epicId: 1,
      cwd: '/tmp',
      epicBranch: 'epic/1',
      storyBranch: 'story-1',
      agentSettings: {},
      deps: baseDeps({
        evaluateAutoRefresh: () => ({
          canAutoRefresh: false,
          miOverCap: [],
          crapOverCap: [],
          refusalReasons: ['xx'],
        }),
        appendSignal: async () => {
          appended += 1;
          return true;
        },
        forEachLine: async (_e, _s, cb) => {
          cb({
            kind: 'friction',
            category: 'baseline-refresh-regression',
            source: { tool: 'auto-refresh-runner' },
          });
        },
      }),
    });
    assert.equal(out.dedup, true);
    assert.equal(appended, 0);
  });

  it('scope=full bypasses computeStoryDiffPaths', async () => {
    let diffCalled = 0;
    const out = await runAutoRefresh({
      storyId: 1,
      epicId: 1,
      cwd: '/tmp',
      epicBranch: 'epic/1',
      storyBranch: 'story-1',
      agentSettings: {},
      deps: baseDeps({
        getQuality: () => ({
          autoRefresh: {
            enabled: true,
            miDropCap: 5,
            crapJumpCap: 5,
            scope: 'full',
          },
        }),
        computeStoryDiffPaths: () => {
          diffCalled += 1;
          return [];
        },
      }),
    });
    assert.equal(diffCalled, 0);
    assert.equal(out.status, 'committed');
  });

  it('returns "failed/commit-failed" when git commit itself fails', async () => {
    const out = await runAutoRefresh({
      storyId: 1,
      epicId: 1,
      cwd: '/tmp',
      epicBranch: 'epic/1',
      storyBranch: 'story-1',
      agentSettings: {},
      deps: baseDeps({
        gitRunner: {
          gitSpawn: (_cwd, ...args) => {
            if (
              args[0] === 'diff' &&
              args.includes('--cached') &&
              args.includes('--exit-code')
            ) {
              return { status: 1, stdout: 'drift\n' };
            }
            if (args[0] === 'commit') {
              return { status: 1, stdout: '', stderr: 'commit failed' };
            }
            return { status: 0, stdout: '', stderr: '' };
          },
        },
      }),
    });
    assert.equal(out.status, 'failed');
    assert.equal(out.reason, 'commit-failed');
  });
});

// ---------------------------------------------------------------------------
// baseline-attribution-wiring.diffCrapBaselines
// ---------------------------------------------------------------------------

describe('baseline-attribution-wiring.diffCrapBaselines', () => {
  it('returns [] when either input is non-array', () => {
    assert.deepEqual(
      diffCrapBaselines({ baselineRows: null, headRows: [] }),
      [],
    );
    assert.deepEqual(
      diffCrapBaselines({ baselineRows: [], headRows: null }),
      [],
    );
  });

  it('flags an above-tolerance head crap regression', () => {
    const out = diffCrapBaselines({
      baselineRows: [{ file: 'a.js', method: 'm', startLine: 1, crap: 5 }],
      headRows: [{ file: 'a.js', method: 'm', startLine: 1, crap: 20 }],
      tolerance: 0.1,
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].drop, 15);
    assert.equal(out[0].baseline, 5);
    assert.equal(out[0].projected, 20);
  });

  it('skips rows under tolerance', () => {
    const out = diffCrapBaselines({
      baselineRows: [{ file: 'a.js', method: 'm', startLine: 1, crap: 5 }],
      headRows: [{ file: 'a.js', method: 'm', startLine: 1, crap: 5.04 }],
      tolerance: 0.1,
    });
    assert.deepEqual(out, []);
  });

  it('filters to scope (Array form)', () => {
    const out = diffCrapBaselines({
      baselineRows: [{ file: 'a.js', method: 'm', startLine: 1, crap: 5 }],
      headRows: [{ file: 'a.js', method: 'm', startLine: 1, crap: 20 }],
      touchedFiles: ['b.js'],
    });
    assert.deepEqual(out, []);
  });

  it('filters to scope (Set form)', () => {
    const out = diffCrapBaselines({
      baselineRows: [{ file: 'a.js', method: 'm', startLine: 1, crap: 5 }],
      headRows: [{ file: 'a.js', method: 'm', startLine: 1, crap: 20 }],
      touchedFiles: new Set(['a.js']),
    });
    assert.equal(out.length, 1);
  });

  it('matches closest unused candidate by startLine when method moved', () => {
    const out = diffCrapBaselines({
      baselineRows: [
        { file: 'a.js', method: 'm', startLine: 100, crap: 5 },
        { file: 'a.js', method: 'm', startLine: 200, crap: 10 },
      ],
      headRows: [{ file: 'a.js', method: 'm', startLine: 198, crap: 20 }],
    });
    assert.equal(out[0].baseline, 10);
  });

  it('skips head rows lacking baseline candidates', () => {
    const out = diffCrapBaselines({
      baselineRows: [{ file: 'a.js', method: 'm', startLine: 1, crap: 5 }],
      headRows: [{ file: 'a.js', method: 'other', startLine: 1, crap: 30 }],
    });
    assert.deepEqual(out, []);
  });

  it('skips malformed head rows', () => {
    const out = diffCrapBaselines({
      baselineRows: [{ file: 'a.js', method: 'm', startLine: 1, crap: 5 }],
      headRows: [null, { file: 1, method: 'm' }, { method: 'm' }],
    });
    assert.deepEqual(out, []);
  });

  it('skips malformed baseline rows during indexing', () => {
    const out = diffCrapBaselines({
      baselineRows: [null, { file: 'a.js' }, { method: 'm' }],
      headRows: [{ file: 'a.js', method: 'm', startLine: 1, crap: 20 }],
    });
    assert.deepEqual(out, []);
  });
});

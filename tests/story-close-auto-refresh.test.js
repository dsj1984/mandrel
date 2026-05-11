import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  amendBaselinesIntoHead,
  buildRefusalSignal,
  FRICTION_CATEGORY,
  filterToStoryDiff,
  priorRefusalSignalExists,
  RUNNER_SOURCE_TOOL,
  readBaselineRows,
  runAutoRefresh,
} from '../.agents/scripts/lib/orchestration/story-close/auto-refresh-runner.js';

// Compute a platform-absolute test repo root so path.resolve(REPO, 'baselines/x.json')
// produces the same absolute string the runner derives via path.resolve(cwd, ...).
// On POSIX this is `/tmp/repo-1398`; on Windows it is `C:\tmp\repo-1398`.
const REPO = path.resolve('/tmp/repo-1398');
const MI_PATH = path.resolve(REPO, 'baselines/maintainability.json');
const CRAP_PATH = path.resolve(REPO, 'baselines/crap.json');

/**
 * Story #1398 (Epic #1386). Wiring tests for the bounded baseline
 * auto-refresh at story-close. Covers the four AC paths:
 *
 *   - under-cap amend         → status 'amended' + baseline files staged + amend SHA
 *   - over-cap refusal (MI)   → status 'refused' + friction signal appended
 *   - mixed-file refusal      → no amend; refusal names every offending row
 *   - idempotent re-run       → second over-cap refusal does NOT duplicate the signal
 */

const CAPS = Object.freeze({ miDropCap: 1.5, crapJumpCap: 5 });

const AGENT_SETTINGS_FIXTURE = {
  paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
  quality: {
    autoRefresh: {
      enabled: true,
      miDropCap: CAPS.miDropCap,
      crapJumpCap: CAPS.crapJumpCap,
      scope: 'diff',
    },
    baselines: {
      maintainability: { path: 'baselines/maintainability.json' },
      crap: { path: 'baselines/crap.json' },
    },
  },
};

function makeFsShim(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    readFileSync(p) {
      if (!store.has(p)) {
        const err = new Error(`ENOENT: ${p}`);
        err.code = 'ENOENT';
        throw err;
      }
      return store.get(p);
    },
    writeFileSync(p, bytes) {
      store.set(p, bytes);
    },
    existsSync(p) {
      return store.has(p);
    },
    mkdirSync() {},
  };
}

function makeRecordingGit(plan = {}) {
  const calls = [];
  const gitSpawn = (_cwd, ...args) => {
    calls.push(args.join(' '));
    const key = args.join(' ');
    if (Object.hasOwn(plan, key)) {
      const v = plan[key];
      return typeof v === 'function' ? v(calls) : v;
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  return { gitRunner: { gitSpawn }, calls };
}

function silentLogger() {
  const sink = [];
  return {
    sink,
    info: (m) => sink.push(['info', m]),
    warn: (m) => sink.push(['warn', m]),
  };
}

// Convenience: make every getQuality / getBaselines stub return the resolved
// shape the runner expects, without re-running the actual resolver.
function stubAccessors() {
  return {
    getQuality: () => ({
      autoRefresh: { ...AGENT_SETTINGS_FIXTURE.quality.autoRefresh },
    }),
    getBaselines: () => ({
      maintainability: { path: 'baselines/maintainability.json' },
      crap: { path: 'baselines/crap.json' },
    }),
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('readBaselineRows', () => {
  it('parses the MI baseline shape ({ "<path>": <mi> }) into rows', () => {
    const fsImpl = makeFsShim({
      'baselines/maintainability.json': JSON.stringify({
        $schema: 'x',
        'a.js': 90,
        'b.js': 80,
      }),
    });
    const rows = readBaselineRows({
      kind: 'mi',
      baselinePath: 'baselines/maintainability.json',
      fsImpl,
    });
    assert.deepEqual(
      rows.sort((x, y) => x.path.localeCompare(y.path)),
      [
        { path: 'a.js', mi: 90 },
        { path: 'b.js', mi: 80 },
      ],
    );
  });

  it('parses the CRAP baseline shape ({ rows: [...] }) into rows', () => {
    const fsImpl = makeFsShim({
      'baselines/crap.json': JSON.stringify({
        rows: [{ file: 'foo.js', method: 'fn', startLine: 1, crap: 7 }],
      }),
    });
    const rows = readBaselineRows({
      kind: 'crap',
      baselinePath: 'baselines/crap.json',
      fsImpl,
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].file, 'foo.js');
  });

  it('returns null for missing baseline file', () => {
    const fsImpl = makeFsShim({});
    const rows = readBaselineRows({
      kind: 'mi',
      baselinePath: 'baselines/missing.json',
      fsImpl,
    });
    assert.equal(rows, null);
  });

  it('returns null for malformed JSON', () => {
    const fsImpl = makeFsShim({ 'baselines/x.json': '{bad' });
    const rows = readBaselineRows({
      kind: 'mi',
      baselinePath: 'baselines/x.json',
      fsImpl,
    });
    assert.equal(rows, null);
  });
});

describe('filterToStoryDiff', () => {
  it('passes through both kinds when storyDiffPaths is empty', () => {
    const out = filterToStoryDiff({
      miRows: [{ path: 'a.js', mi: 90 }],
      crapRows: [{ file: 'b.js', method: 'fn', crap: 5 }],
      storyDiffPaths: [],
    });
    assert.equal(out.mi.length, 1);
    assert.equal(out.crap.length, 1);
  });

  it('keeps only rows whose path/file is in the diff set', () => {
    const out = filterToStoryDiff({
      miRows: [
        { path: 'a.js', mi: 90 },
        { path: 'other.js', mi: 80 },
      ],
      crapRows: [
        { file: 'a.js', method: 'fn', crap: 1 },
        { file: 'other.js', method: 'fn', crap: 1 },
      ],
      storyDiffPaths: ['a.js'],
    });
    assert.equal(out.mi.length, 1);
    assert.equal(out.mi[0].path, 'a.js');
    assert.equal(out.crap.length, 1);
    assert.equal(out.crap[0].file, 'a.js');
  });
});

describe('amendBaselinesIntoHead', () => {
  it('git-adds each baseline file then amends with --no-edit', () => {
    const { gitRunner, calls } = makeRecordingGit({
      'rev-parse --short HEAD': { status: 0, stdout: 'abc1234\n', stderr: '' },
    });
    const result = amendBaselinesIntoHead({
      cwd: REPO,
      baselineFiles: [MI_PATH, CRAP_PATH],
      gitRunner,
    });
    assert.equal(result.ok, true);
    assert.equal(result.sha, 'abc1234');
    assert.deepEqual(calls, [
      'add baselines/maintainability.json',
      'add baselines/crap.json',
      'commit --amend --no-edit --allow-empty',
      'rev-parse --short HEAD',
    ]);
  });

  it('returns ok:false when the amend itself fails', () => {
    const { gitRunner } = makeRecordingGit({
      'commit --amend --no-edit --allow-empty': {
        status: 1,
        stdout: '',
        stderr: 'nothing to commit',
      },
    });
    const result = amendBaselinesIntoHead({
      cwd: REPO,
      baselineFiles: [path.resolve(REPO, 'baselines/x.json')],
      gitRunner,
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /amend failed/);
  });
});

describe('priorRefusalSignalExists', () => {
  it('detects an existing baseline-refresh-regression signal from the runner', async () => {
    const records = [
      { kind: 'friction', category: 'unrelated', source: { tool: 'x' } },
      {
        kind: 'friction',
        category: FRICTION_CATEGORY,
        source: { tool: RUNNER_SOURCE_TOOL },
      },
    ];
    const forEachLine = async (_eid, _sid, cb) => {
      for (const r of records) await cb(r);
      return {
        linesRead: records.length,
        linesParsed: records.length,
        missing: false,
      };
    };
    const found = await priorRefusalSignalExists({
      epicId: 1,
      storyId: 2,
      forEachLine,
    });
    assert.equal(found, true);
  });

  it('returns false when the only matching category came from another tool', async () => {
    const forEachLine = async (_eid, _sid, cb) => {
      // Same category but different source.tool — must NOT count (e.g. the
      // existing check-maintainability emitter from Story #1124).
      await cb({
        kind: 'friction',
        category: FRICTION_CATEGORY,
        source: { tool: 'check-maintainability.js' },
      });
      return { linesRead: 1, linesParsed: 1, missing: false };
    };
    const found = await priorRefusalSignalExists({
      epicId: 1,
      storyId: 2,
      forEachLine,
    });
    assert.equal(found, false);
  });
});

describe('buildRefusalSignal', () => {
  it('renders the canonical friction-signal shape', () => {
    const sig = buildRefusalSignal({
      epicId: 1386,
      storyId: 1398,
      miOverCap: [{ path: 'big.js', baseline: 90, scored: 80, delta: 10 }],
      crapOverCap: [],
      refusalReasons: ['MI drop 10.000 > cap 1.5 on big.js (...)'],
      caps: CAPS,
    });
    assert.equal(sig.kind, 'friction');
    assert.equal(sig.category, FRICTION_CATEGORY);
    assert.equal(sig.source.tool, RUNNER_SOURCE_TOOL);
    assert.equal(sig.epicId, 1386);
    assert.equal(sig.storyId, 1398);
    assert.equal(sig.miOverCap.length, 1);
    assert.deepEqual(sig.caps, CAPS);
    assert.match(sig.details, /Auto-refresh refused: 1 row/);
  });
});

// ---------------------------------------------------------------------------
// Top-level: runAutoRefresh — AC paths
// ---------------------------------------------------------------------------

describe('runAutoRefresh — AC1 under-cap amend path', () => {
  it('amends regenerated rows into HEAD and produces no separate baseline-refresh: commit', async () => {
    // Seed: previous baseline says a.js has MI 90; regen produces MI 89.5
    // (drop 0.5 — under cap 1.5). The regen helper writes the new value
    // to disk; the runner then reads it back, evaluates, and amends.
    const fsImpl = makeFsShim({});
    const baselineMiPath = MI_PATH;
    const baselineCrapPath = CRAP_PATH;
    // Pre-regen: previous baseline rows
    let miBytes = JSON.stringify({ 'a.js': 90 });
    const crapBytes = JSON.stringify({ rows: [] });
    fsImpl.writeFileSync(baselineMiPath, miBytes);
    fsImpl.writeFileSync(baselineCrapPath, crapBytes);

    const regenerateMainFromTree = async () => {
      // Simulate the regen helper writing the new (under-cap) values.
      miBytes = JSON.stringify({ 'a.js': 89.5 });
      fsImpl.writeFileSync(baselineMiPath, miBytes);
      return {
        didChange: true,
        files: [
          { kind: 'maintainability', path: baselineMiPath, didChange: true },
        ],
      };
    };

    const { gitRunner, calls } = makeRecordingGit({
      // Story diff vs origin/epic/<id> — a.js is in scope.
      'diff --name-only origin/epic/1386...story-1398': {
        status: 0,
        stdout: 'a.js\n',
        stderr: '',
      },
      'rev-parse --short HEAD': { status: 0, stdout: 'feed1234\n', stderr: '' },
    });

    const result = await runAutoRefresh({
      storyId: 1398,
      epicId: 1386,
      cwd: REPO,
      epicBranch: 'epic/1386',
      storyBranch: 'story-1398',
      agentSettings: AGENT_SETTINGS_FIXTURE,
      deps: {
        ...stubAccessors(),
        regenerateMainFromTree,
        gitRunner,
        fsImpl,
        appendSignal: async () => true,
        forEachLine: async () => ({
          linesRead: 0,
          linesParsed: 0,
          missing: true,
        }),
        logger: silentLogger(),
      },
    });
    assert.equal(result.status, 'amended');
    assert.equal(result.sha, 'feed1234');
    // git ops: diff (story-diff), add (mi), add (crap), commit --amend, rev-parse.
    // Order matters — the amend MUST come after the adds.
    assert.ok(calls.includes('add baselines/maintainability.json'));
    assert.ok(calls.includes('add baselines/crap.json'));
    assert.ok(calls.includes('commit --amend --no-edit --allow-empty'));
    // No `commit -m baseline-refresh:` invocation anywhere.
    assert.equal(
      calls.some((c) => c.startsWith('commit -m baseline-refresh:')),
      false,
    );
  });
});

describe('runAutoRefresh — AC2 over-cap refusal path', () => {
  it('refuses to amend, leaves HEAD untouched, and appends baseline-refresh-regression friction', async () => {
    const fsImpl = makeFsShim({});
    const miPath = MI_PATH;
    const crapPath = CRAP_PATH;
    fsImpl.writeFileSync(miPath, JSON.stringify({ 'big.js': 90 }));
    fsImpl.writeFileSync(crapPath, JSON.stringify({ rows: [] }));

    const regenerateMainFromTree = async () => {
      // Simulate regen writing a 10-point MI drop — well over cap 1.5.
      fsImpl.writeFileSync(miPath, JSON.stringify({ 'big.js': 80 }));
      return {
        didChange: true,
        files: [{ kind: 'maintainability', path: miPath, didChange: true }],
      };
    };

    const { gitRunner, calls } = makeRecordingGit({
      'diff --name-only origin/epic/1386...story-1398': {
        status: 0,
        stdout: 'big.js\n',
        stderr: '',
      },
    });

    const appendedSignals = [];
    const appendSignal = async ({ signal }) => {
      appendedSignals.push(signal);
      return true;
    };

    const result = await runAutoRefresh({
      storyId: 1398,
      epicId: 1386,
      cwd: REPO,
      epicBranch: 'epic/1386',
      storyBranch: 'story-1398',
      agentSettings: AGENT_SETTINGS_FIXTURE,
      deps: {
        ...stubAccessors(),
        regenerateMainFromTree,
        gitRunner,
        fsImpl,
        appendSignal,
        forEachLine: async () => ({
          linesRead: 0,
          linesParsed: 0,
          missing: true,
        }),
        logger: silentLogger(),
      },
    });

    assert.equal(result.status, 'refused');
    assert.equal(result.signalAppended, true);
    assert.equal(result.dedup, false);
    assert.equal(result.miOverCap.length, 1);
    assert.equal(result.miOverCap[0].path, 'big.js');
    assert.equal(appendedSignals.length, 1);
    assert.equal(appendedSignals[0].category, FRICTION_CATEGORY);
    assert.equal(appendedSignals[0].source.tool, RUNNER_SOURCE_TOOL);
    // HEAD untouched: no commit / amend issued.
    assert.equal(
      calls.some((c) => c.startsWith('commit')),
      false,
    );
    // Did issue checkout HEAD -- to roll back the on-disk baseline write.
    assert.ok(
      calls.some((c) => c.startsWith('checkout HEAD --')),
      'expected checkout HEAD -- to roll back baseline writes',
    );
  });

  it('mixed-file refusal — names every offending row across MI and CRAP', async () => {
    const fsImpl = makeFsShim({});
    const miPath = MI_PATH;
    const crapPath = CRAP_PATH;
    fsImpl.writeFileSync(miPath, JSON.stringify({ 'a.js': 90, 'b.js': 80 }));
    fsImpl.writeFileSync(
      crapPath,
      JSON.stringify({
        rows: [
          { file: 'a.js', method: 'fn', startLine: 1, crap: 5 },
          { file: 'c.js', method: 'churn', startLine: 1, crap: 8 },
        ],
      }),
    );

    const regenerateMainFromTree = async () => {
      // Both files breach: a.js MI drop 10, c.js CRAP jump 12.
      fsImpl.writeFileSync(miPath, JSON.stringify({ 'a.js': 80, 'b.js': 80 }));
      fsImpl.writeFileSync(
        crapPath,
        JSON.stringify({
          rows: [
            { file: 'a.js', method: 'fn', startLine: 1, crap: 5 },
            { file: 'c.js', method: 'churn', startLine: 1, crap: 20 },
          ],
        }),
      );
      return { didChange: true, files: [] };
    };

    const { gitRunner } = makeRecordingGit({
      'diff --name-only origin/epic/1386...story-1398': {
        status: 0,
        stdout: 'a.js\nc.js\n',
        stderr: '',
      },
    });

    const appendedSignals = [];
    const appendSignal = async ({ signal }) => {
      appendedSignals.push(signal);
      return true;
    };

    const result = await runAutoRefresh({
      storyId: 1398,
      epicId: 1386,
      cwd: REPO,
      epicBranch: 'epic/1386',
      storyBranch: 'story-1398',
      agentSettings: AGENT_SETTINGS_FIXTURE,
      deps: {
        ...stubAccessors(),
        regenerateMainFromTree,
        gitRunner,
        fsImpl,
        appendSignal,
        forEachLine: async () => ({
          linesRead: 0,
          linesParsed: 0,
          missing: true,
        }),
        logger: silentLogger(),
      },
    });

    assert.equal(result.status, 'refused');
    assert.equal(result.miOverCap.length, 1);
    assert.equal(result.miOverCap[0].path, 'a.js');
    assert.equal(result.crapOverCap.length, 1);
    assert.equal(result.crapOverCap[0].file, 'c.js');
    assert.equal(result.refusalReasons.length, 2);
    assert.equal(appendedSignals.length, 1);
    assert.equal(appendedSignals[0].refusalReasons.length, 2);
  });
});

describe('runAutoRefresh — AC3 idempotent re-run', () => {
  it('does NOT duplicate the friction signal on a second over-cap run', async () => {
    const fsImpl = makeFsShim({});
    const miPath = MI_PATH;
    const crapPath = CRAP_PATH;
    fsImpl.writeFileSync(miPath, JSON.stringify({ 'big.js': 90 }));
    fsImpl.writeFileSync(crapPath, JSON.stringify({ rows: [] }));

    const regenerateMainFromTree = async () => {
      fsImpl.writeFileSync(miPath, JSON.stringify({ 'big.js': 80 }));
      return { didChange: true, files: [] };
    };

    const { gitRunner } = makeRecordingGit({
      'diff --name-only origin/epic/1386...story-1398': {
        status: 0,
        stdout: 'big.js\n',
        stderr: '',
      },
    });

    // forEachLine reports a prior runner-tagged refusal signal already on disk.
    const forEachLine = async (_eid, _sid, cb) => {
      await cb({
        kind: 'friction',
        category: FRICTION_CATEGORY,
        source: { tool: RUNNER_SOURCE_TOOL },
      });
      return { linesRead: 1, linesParsed: 1, missing: false };
    };

    const appendCalls = [];
    const appendSignal = async (args) => {
      appendCalls.push(args);
      return true;
    };

    const result = await runAutoRefresh({
      storyId: 1398,
      epicId: 1386,
      cwd: REPO,
      epicBranch: 'epic/1386',
      storyBranch: 'story-1398',
      agentSettings: AGENT_SETTINGS_FIXTURE,
      deps: {
        ...stubAccessors(),
        regenerateMainFromTree,
        gitRunner,
        fsImpl,
        appendSignal,
        forEachLine,
        logger: silentLogger(),
      },
    });

    assert.equal(result.status, 'refused');
    assert.equal(result.dedup, true);
    assert.equal(result.signalAppended, false);
    assert.equal(appendCalls.length, 0, 'no new signal append on dedup');
  });
});

describe('runAutoRefresh — skip paths', () => {
  it("returns status 'skipped' with reason 'disabled' when autoRefresh.enabled is false", async () => {
    const result = await runAutoRefresh({
      storyId: 1398,
      epicId: 1386,
      cwd: REPO,
      epicBranch: 'epic/1386',
      storyBranch: 'story-1398',
      agentSettings: AGENT_SETTINGS_FIXTURE,
      deps: {
        getQuality: () => ({
          autoRefresh: { enabled: false, miDropCap: 1.5, crapJumpCap: 5 },
        }),
        getBaselines: () => ({}),
        regenerateMainFromTree: async () => {
          throw new Error('should not be called when disabled');
        },
        appendSignal: async () => true,
        forEachLine: async () => ({
          linesRead: 0,
          linesParsed: 0,
          missing: true,
        }),
        logger: silentLogger(),
      },
    });
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'disabled');
  });

  it("returns status 'skipped' with reason 'no-baseline-drift' when regen reports didChange:false", async () => {
    const result = await runAutoRefresh({
      storyId: 1398,
      epicId: 1386,
      cwd: REPO,
      epicBranch: 'epic/1386',
      storyBranch: 'story-1398',
      agentSettings: AGENT_SETTINGS_FIXTURE,
      deps: {
        ...stubAccessors(),
        regenerateMainFromTree: async () => ({ didChange: false, files: [] }),
        fsImpl: makeFsShim({}),
        appendSignal: async () => true,
        forEachLine: async () => ({
          linesRead: 0,
          linesParsed: 0,
          missing: true,
        }),
        logger: silentLogger(),
      },
    });
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'no-baseline-drift');
  });

  it("returns status 'failed' when regen throws", async () => {
    const result = await runAutoRefresh({
      storyId: 1398,
      epicId: 1386,
      cwd: REPO,
      epicBranch: 'epic/1386',
      storyBranch: 'story-1398',
      agentSettings: AGENT_SETTINGS_FIXTURE,
      deps: {
        ...stubAccessors(),
        regenerateMainFromTree: async () => {
          throw new Error('boom');
        },
        fsImpl: makeFsShim({}),
        appendSignal: async () => true,
        forEachLine: async () => ({
          linesRead: 0,
          linesParsed: 0,
          missing: true,
        }),
        logger: silentLogger(),
      },
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'regen-threw');
    assert.match(result.detail, /boom/);
  });
});

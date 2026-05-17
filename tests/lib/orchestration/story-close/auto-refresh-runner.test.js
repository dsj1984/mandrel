/**
 * auto-refresh-runner.test.js — Story #2205 / Task #2218.
 *
 * Pins the routing contract: `runAutoRefresh` MUST hand every baseline
 * write to `refreshBaseline()` from `lib/baselines/refresh-service.js`. No
 * direct call to `regenerateMainFromTree` or per-kind regen helpers
 * remains in the runner.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { runAutoRefresh } from '../../../../.agents/scripts/lib/orchestration/story-close/auto-refresh-runner.js';

const REPO = path.resolve('/tmp/repo-2205');
const MI_PATH = path.resolve(REPO, 'baselines/maintainability.json');
const CRAP_PATH = path.resolve(REPO, 'baselines/crap.json');

const AGENT_SETTINGS_FIXTURE = {
  paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
  quality: {
    autoRefresh: {
      enabled: true,
      miDropCap: 1.5,
      crapJumpCap: 5,
      scope: 'diff',
    },
    baselines: {
      maintainability: { path: 'baselines/maintainability.json' },
      crap: { path: 'baselines/crap.json' },
    },
  },
};

function stubAccessors() {
  return {
    getQuality: () => ({
      ...AGENT_SETTINGS_FIXTURE.quality,
      autoRefresh: { ...AGENT_SETTINGS_FIXTURE.quality.autoRefresh },
    }),
    getBaselines: () => ({
      maintainability: { path: 'baselines/maintainability.json' },
      crap: { path: 'baselines/crap.json' },
    }),
  };
}

function makeFsShim() {
  const store = new Map();
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
    renameSync(from, to) {
      if (!store.has(from)) return;
      store.set(to, store.get(from));
      store.delete(from);
    },
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
  return { info: () => {}, warn: () => {}, error: () => {} };
}

// Stub `readerLoadFile` to parse whatever the fs shim currently holds.
function makeReaderForFs(fsImpl) {
  return (absPath, _opts) => {
    const bytes = fsImpl.store.get(absPath);
    if (!bytes) {
      throw new Error(`reader stub: missing ${absPath}`);
    }
    const parsed = JSON.parse(bytes);
    return {
      rollup: parsed.rollup ?? { '*': {} },
      rows: parsed.rows ?? [],
      kernelVersion: parsed.kernelVersion ?? '0.0.0',
      generatedAt: parsed.generatedAt ?? '2026-05-15T00:00:00Z',
    };
  };
}

// Stub refreshBaseline — emulates the service writing a new envelope to
// the fs shim. Records every call so tests can pin routing.
function makeRefreshBaselineStub(fsImpl, scenarios) {
  const calls = [];
  const refreshBaseline = async (opts) => {
    calls.push({ ...opts });
    const scenario = scenarios?.[opts.kind];
    if (scenario?.write) {
      fsImpl.writeFileSync(opts.writePath, JSON.stringify(scenario.envelope));
      return { kind: opts.kind, writePath: opts.writePath, wrote: true };
    }
    return { kind: opts.kind, writePath: opts.writePath, wrote: false };
  };
  return { refreshBaseline, calls };
}

function fakeScorerBuilder() {
  // The scorer is forwarded to refreshBaseline; the stub never invokes
  // it because the stub fakes the persisted envelope directly.
  return () => async () => [];
}

function miEnvelope(entries) {
  return {
    $schema: '.agents/schemas/baselines/maintainability.schema.json',
    kernelVersion: '0.1.0',
    generatedAt: '2026-04-01T00:00:00Z',
    rollup: { '*': {} },
    rows: entries.map(([p, mi]) => ({ path: p, mi })),
  };
}

function crapEnvelope(rows) {
  return {
    $schema: '.agents/schemas/baselines/crap.schema.json',
    kernelVersion: '1.1.0',
    generatedAt: '2026-04-01T00:00:00Z',
    rollup: { '*': {} },
    rows: rows.map((r) => ({ ...r })),
  };
}

describe('runAutoRefresh — Story #2205 routing through refreshBaseline()', () => {
  it('dispatches refreshBaseline() once per configured kind (mi + crap)', async () => {
    const fsImpl = makeFsShim();
    fsImpl.writeFileSync(MI_PATH, JSON.stringify(miEnvelope([['a.js', 90]])));
    fsImpl.writeFileSync(CRAP_PATH, JSON.stringify(crapEnvelope([])));

    const { refreshBaseline, calls } = makeRefreshBaselineStub(fsImpl, {
      maintainability: {
        write: true,
        envelope: miEnvelope([['a.js', 89.5]]),
      },
      crap: { write: false, envelope: crapEnvelope([]) },
    });

    const { gitRunner } = makeRecordingGit({
      'diff --name-only origin/epic/2173...story-2205': {
        status: 0,
        stdout: 'a.js\n',
      },
      'add baselines/maintainability.json': { status: 0 },
      'diff --cached --exit-code -- baselines/maintainability.json': {
        status: 1,
        stdout: 'M baselines/maintainability.json\n',
      },
      'commit -m chore(baselines): refresh maintainability for story-2205': {
        status: 0,
      },
      'rev-parse --short HEAD': { status: 0, stdout: 'feed4242' },
    });

    const result = await runAutoRefresh({
      storyId: 2205,
      epicId: 2173,
      cwd: REPO,
      epicBranch: 'epic/2173',
      storyBranch: 'story-2205',
      agentSettings: AGENT_SETTINGS_FIXTURE,
      deps: {
        ...stubAccessors(),
        refreshBaseline,
        scorerBuilder: fakeScorerBuilder(),
        gitRunner,
        fsImpl,
        appendSignal: async () => true,
        forEachLine: async () => ({ linesRead: 0, missing: true }),
        logger: silentLogger(),
        readerLoadFile: makeReaderForFs(fsImpl),
      },
    });

    assert.equal(result.status, 'committed');
    assert.equal(result.sha, 'feed4242');

    // AC: refreshBaseline() invoked once per configured kind.
    const kindsRouted = calls.map((c) => c.kind).sort();
    assert.deepEqual(kindsRouted, ['crap', 'maintainability']);

    // AC: each call passed fullScope:false + a scorer + the write path.
    for (const call of calls) {
      assert.equal(call.fullScope, false);
      assert.equal(typeof call.scorer, 'function');
      assert.equal(typeof call.writePath, 'string');
      assert.equal(call.baseRef, 'origin/epic/2173');
      assert.equal(call.headRef, 'story-2205');
    }

    // AC: only the kind that actually drifted produces a commit. The
    // crap kind reported `wrote:false` so the runner never staged it.
    const committedKinds = result.committed.map((c) => c.kind);
    assert.deepEqual(committedKinds, ['maintainability']);
  });

  it('returns status=skipped when no kind wrote (every refreshBaseline returns wrote:false)', async () => {
    const fsImpl = makeFsShim();
    fsImpl.writeFileSync(MI_PATH, JSON.stringify(miEnvelope([['a.js', 90]])));
    fsImpl.writeFileSync(CRAP_PATH, JSON.stringify(crapEnvelope([])));

    const { refreshBaseline, calls } = makeRefreshBaselineStub(fsImpl, {
      maintainability: { write: false, envelope: miEnvelope([['a.js', 90]]) },
      crap: { write: false, envelope: crapEnvelope([]) },
    });

    const { gitRunner } = makeRecordingGit();

    const result = await runAutoRefresh({
      storyId: 2205,
      epicId: 2173,
      cwd: REPO,
      epicBranch: 'epic/2173',
      storyBranch: 'story-2205',
      agentSettings: AGENT_SETTINGS_FIXTURE,
      deps: {
        ...stubAccessors(),
        refreshBaseline,
        scorerBuilder: fakeScorerBuilder(),
        gitRunner,
        fsImpl,
        appendSignal: async () => true,
        forEachLine: async () => ({ linesRead: 0, missing: true }),
        logger: silentLogger(),
        readerLoadFile: makeReaderForFs(fsImpl),
      },
    });

    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'no-baseline-drift');
    // refreshBaseline() was still called (the service decides whether to
    // persist); the runner short-circuits when no kind wrote.
    assert.equal(calls.length, 2);
  });

  it('returns status=skipped when autoRefresh.enabled is false', async () => {
    const result = await runAutoRefresh({
      storyId: 2205,
      epicId: 2173,
      cwd: REPO,
      epicBranch: 'epic/2173',
      storyBranch: 'story-2205',
      agentSettings: {
        ...AGENT_SETTINGS_FIXTURE,
        quality: {
          ...AGENT_SETTINGS_FIXTURE.quality,
          autoRefresh: { enabled: false },
        },
      },
      deps: {
        getQuality: () => ({ autoRefresh: { enabled: false } }),
        getBaselines: () => ({}),
        refreshBaseline: async () => {
          throw new Error('refreshBaseline must not be invoked when disabled');
        },
        scorerBuilder: fakeScorerBuilder(),
        gitRunner: { gitSpawn: () => ({ status: 0 }) },
        fsImpl: makeFsShim(),
        appendSignal: async () => true,
        forEachLine: async () => ({ linesRead: 0, missing: true }),
        logger: silentLogger(),
        readerLoadFile: () => null,
      },
    });
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'disabled');
  });

  it('routes refusal through the friction-signal path when caps trip', async () => {
    const fsImpl = makeFsShim();
    fsImpl.writeFileSync(MI_PATH, JSON.stringify(miEnvelope([['a.js', 90]])));
    fsImpl.writeFileSync(CRAP_PATH, JSON.stringify(crapEnvelope([])));

    const { refreshBaseline } = makeRefreshBaselineStub(fsImpl, {
      // MI drops from 90 → 50 (drop = 40, far above the cap of 1.5).
      maintainability: { write: true, envelope: miEnvelope([['a.js', 50]]) },
      crap: { write: false, envelope: crapEnvelope([]) },
    });

    const appendCalls = [];
    const { gitRunner } = makeRecordingGit({
      'diff --name-only origin/epic/2173...story-2205': {
        status: 0,
        stdout: 'a.js\n',
      },
    });

    const result = await runAutoRefresh({
      storyId: 2205,
      epicId: 2173,
      cwd: REPO,
      epicBranch: 'epic/2173',
      storyBranch: 'story-2205',
      agentSettings: AGENT_SETTINGS_FIXTURE,
      deps: {
        ...stubAccessors(),
        refreshBaseline,
        scorerBuilder: fakeScorerBuilder(),
        gitRunner,
        fsImpl,
        appendSignal: async ({ signal }) => {
          appendCalls.push(signal);
          return true;
        },
        forEachLine: async () => ({ linesRead: 0, missing: true }),
        logger: silentLogger(),
        readerLoadFile: makeReaderForFs(fsImpl),
      },
    });

    assert.equal(result.status, 'refused');
    assert.ok(result.refusalReasons.length >= 1);
    assert.equal(appendCalls.length, 1);
    assert.equal(appendCalls[0].source.tool, 'auto-refresh-runner');
    assert.equal(appendCalls[0].category, 'baseline-refresh-regression');
  });
});

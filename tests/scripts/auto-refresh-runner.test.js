/**
 * tests/scripts/auto-refresh-runner.test.js — Story #4017.
 *
 * `runAutoRefresh` delegates the per-kind refresh → stage → commit
 * mechanics to the single `runRefreshCommit` funnel
 * (`baseline-attribution/phases/refresh-commit.js`) and owns only the
 * config gating, the prior-envelope snapshot, the cap-check closure, and
 * the refusal publication. These tests pin:
 *
 *   - the four terminal statuses (committed / refused / skipped / failed)
 *     through the real funnel with injected git + fs + refresh-service;
 *   - the Story #4017 each-kind-once contract: a kind already present in
 *     the shared `cycleState.refreshedKinds` is never re-scored or
 *     re-committed by the post-gates auto-refresh.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { runAutoRefresh } from '../../.agents/scripts/lib/orchestration/story-close/auto-refresh-runner.js';

const REPO = path.resolve('/tmp/repo-2460');
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

function makeReaderForFs(fsImpl) {
  return (absPath) => {
    const bytes = fsImpl.store.get(absPath);
    if (!bytes) throw new Error(`reader stub: missing ${absPath}`);
    const parsed = JSON.parse(bytes);
    return {
      rollup: parsed.rollup ?? { '*': {} },
      rows: parsed.rows ?? [],
      kernelVersion: parsed.kernelVersion ?? '0.0.0',
      generatedAt: parsed.generatedAt ?? '2026-05-18T00:00:00Z',
    };
  };
}

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
  return () => async () => [];
}

const stubAccessors = () => ({
  getQuality: () => ({
    ...AGENT_SETTINGS_FIXTURE.quality,
    autoRefresh: { ...AGENT_SETTINGS_FIXTURE.quality.autoRefresh },
  }),
  getBaselines: () => ({
    maintainability: { path: 'baselines/maintainability.json' },
    crap: { path: 'baselines/crap.json' },
  }),
});

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

function baseArgs({ fsImpl, refreshBaseline, gitRunner, overrides = {} }) {
  return {
    storyId: 2460,
    epicId: 2453,
    cwd: REPO,
    epicBranch: 'epic/2453',
    storyBranch: 'story-2460',
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
      ...overrides,
    },
  };
}

describe('runAutoRefresh — single-funnel integration (Story #4017)', () => {
  it('happy path: under-cap drift commits via the funnel and returns status=committed', async () => {
    const fsImpl = makeFsShim();
    fsImpl.writeFileSync(MI_PATH, JSON.stringify(miEnvelope([['a.js', 90]])));
    fsImpl.writeFileSync(CRAP_PATH, JSON.stringify(crapEnvelope([])));

    const { refreshBaseline } = makeRefreshBaselineStub(fsImpl, {
      maintainability: { write: true, envelope: miEnvelope([['a.js', 89.6]]) },
      crap: { write: false, envelope: crapEnvelope([]) },
    });

    const { gitRunner, calls } = makeRecordingGit({
      'diff --name-only origin/epic/2453...story-2460': {
        status: 0,
        stdout: 'a.js\n',
      },
      'add baselines/maintainability.json': { status: 0 },
      'diff --cached --exit-code -- baselines/maintainability.json': {
        status: 1,
        stdout: 'M baselines/maintainability.json\n',
      },
      'commit -m chore(baselines): refresh maintainability for story-2460': {
        status: 0,
      },
      'rev-parse --short HEAD': { status: 0, stdout: 'cafe' },
    });

    const result = await runAutoRefresh(
      baseArgs({ fsImpl, refreshBaseline, gitRunner }),
    );

    assert.equal(result.status, 'committed');
    assert.equal(result.sha, 'cafe');
    assert.deepEqual(result.committed, [
      { kind: 'maintainability', sha: 'cafe' },
    ]);
    // Exactly one canonical commit subject per refreshed kind.
    const commits = calls.filter((c) => c.startsWith('commit -m '));
    assert.deepEqual(commits, [
      'commit -m chore(baselines): refresh maintainability for story-2460',
    ]);
  });

  it('over-cap drift rolls back the file, appends one friction signal, returns status=refused', async () => {
    const fsImpl = makeFsShim();
    fsImpl.writeFileSync(MI_PATH, JSON.stringify(miEnvelope([['a.js', 90]])));
    fsImpl.writeFileSync(CRAP_PATH, JSON.stringify(crapEnvelope([])));

    // MI drops 90 → 80 (drop 10 > cap 1.5) → refusal.
    const { refreshBaseline } = makeRefreshBaselineStub(fsImpl, {
      maintainability: { write: true, envelope: miEnvelope([['a.js', 80]]) },
      crap: { write: false, envelope: crapEnvelope([]) },
    });

    const { gitRunner, calls } = makeRecordingGit({
      'diff --name-only origin/epic/2453...story-2460': {
        status: 0,
        stdout: 'a.js\n',
      },
      'diff --cached --exit-code -- baselines/maintainability.json': {
        status: 1,
        stdout: 'M baselines/maintainability.json\n',
      },
    });

    const signals = [];
    const result = await runAutoRefresh(
      baseArgs({
        fsImpl,
        refreshBaseline,
        gitRunner,
        overrides: {
          appendSignal: async ({ signal }) => {
            signals.push(signal);
            return true;
          },
        },
      }),
    );

    assert.equal(result.status, 'refused');
    assert.equal(result.dedup, false);
    assert.equal(result.signalAppended, true);
    assert.equal(result.miOverCap.length, 1);
    assert.equal(signals.length, 1);
    assert.equal(signals[0].category, 'baseline-refresh-regression');
    // The funnel rolled the staged refresh back; no commit landed.
    assert.ok(
      calls.includes('checkout HEAD -- baselines/maintainability.json'),
      `expected rollback checkout; calls=${JSON.stringify(calls)}`,
    );
    assert.equal(
      calls.filter((c) => c.startsWith('commit -m ')).length,
      0,
      'no commit may land on a refusal',
    );
  });

  it('each-kind-once: a kind already in cycleState.refreshedKinds is not re-scored or re-committed', async () => {
    const fsImpl = makeFsShim();
    fsImpl.writeFileSync(MI_PATH, JSON.stringify(miEnvelope([['a.js', 90]])));
    fsImpl.writeFileSync(CRAP_PATH, JSON.stringify(crapEnvelope([])));

    const { refreshBaseline, calls: refreshCalls } = makeRefreshBaselineStub(
      fsImpl,
      {
        maintainability: {
          write: true,
          envelope: miEnvelope([['a.js', 89.9]]),
        },
        crap: { write: false, envelope: crapEnvelope([]) },
      },
    );
    const { gitRunner, calls } = makeRecordingGit();

    // Simulate the gate-failure attribution retry having already refreshed
    // both kinds this close cycle.
    const cycleState = {
      refreshedKinds: new Set(['maintainability', 'crap']),
      lastRefreshSha: 'beef',
    };

    const result = await runAutoRefresh({
      ...baseArgs({ fsImpl, refreshBaseline, gitRunner }),
      cycleState,
    });

    // Funnel short-circuits on the idempotency token: no scoring, no
    // staging, no commit — the runner reports no drift of its own.
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'no-baseline-drift');
    assert.equal(refreshCalls.length, 0, 'refreshBaseline must not re-run');
    assert.equal(
      calls.filter((c) => c.startsWith('commit -m ')).length,
      0,
      'no duplicate chore(baselines) commit may land',
    );
  });

  it('refresh-service throw collapses to status=failed / reason=refresh-service-threw', async () => {
    const fsImpl = makeFsShim();
    fsImpl.writeFileSync(MI_PATH, JSON.stringify(miEnvelope([['a.js', 90]])));
    fsImpl.writeFileSync(CRAP_PATH, JSON.stringify(crapEnvelope([])));
    const refreshBaseline = async () => {
      throw new Error('boom-at-stage-1');
    };
    const result = await runAutoRefresh(
      baseArgs({
        fsImpl,
        refreshBaseline,
        gitRunner: { gitSpawn: () => ({ status: 0 }) },
      }),
    );
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'refresh-service-threw');
    assert.match(result.detail, /boom-at-stage-1/);
  });

  it('disabled autoRefresh short-circuits to skipped/disabled', async () => {
    const fsImpl = makeFsShim();
    const result = await runAutoRefresh(
      baseArgs({
        fsImpl,
        refreshBaseline: async () => {
          throw new Error('must not be called');
        },
        gitRunner: { gitSpawn: () => ({ status: 0 }) },
        overrides: {
          getQuality: () => ({ autoRefresh: { enabled: false } }),
        },
      }),
    );
    assert.deepEqual(result, { status: 'skipped', reason: 'disabled' });
  });
});

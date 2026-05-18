/**
 * tests/scripts/auto-refresh-runner.test.js — Task #2469 (Story #2460,
 * Epic #2453). Pins the four-step pipeline decomposition of
 * `runAutoRefresh`:
 *
 *   stageRefreshArtifacts  → validateRefreshAccepted →
 *     (accepted) commitRefresh   → { status: 'committed' | 'skipped' | 'failed' }
 *     (refused)  pushRefresh     → { status: 'refused' }
 *
 * Each helper gets a direct sibling unit test that exercises its
 * declarative contract in isolation; one final integration test pins
 * the wiring at the top of `runAutoRefresh` so a future inline-removal
 * of any helper fails fast here.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  commitRefresh,
  pushRefresh,
  runAutoRefresh,
  stageRefreshArtifacts,
  validateRefreshAccepted,
} from '../../.agents/scripts/lib/orchestration/story-close/auto-refresh-runner.js';

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

describe('stageRefreshArtifacts — Task #2469 (step 1 of pipeline)', () => {
  it('returns ok=true plus refresh records for each configured kind', async () => {
    const fsImpl = makeFsShim();
    fsImpl.writeFileSync(MI_PATH, JSON.stringify(miEnvelope([['a.js', 90]])));
    fsImpl.writeFileSync(CRAP_PATH, JSON.stringify(crapEnvelope([])));
    const { refreshBaseline, calls } = makeRefreshBaselineStub(fsImpl, {
      maintainability: { write: true, envelope: miEnvelope([['a.js', 89.6]]) },
      crap: { write: false, envelope: crapEnvelope([]) },
    });

    const stage = await stageRefreshArtifacts({
      cwd: REPO,
      epicBranch: 'epic/2453',
      storyBranch: 'story-2460',
      agentSettings: AGENT_SETTINGS_FIXTURE,
      config: { agentSettings: AGENT_SETTINGS_FIXTURE },
      ...stubAccessors(),
      refreshBaseline,
      scorerBuilder: fakeScorerBuilder(),
      fsImpl,
      readerLoadFile: makeReaderForFs(fsImpl),
    });

    assert.equal(stage.ok, true);
    assert.equal(stage.miAbs, MI_PATH);
    assert.equal(stage.crapAbs, CRAP_PATH);
    assert.equal(stage.miRefreshed.wrote, true);
    assert.equal(stage.crapRefreshed.wrote, false);
    // Snapshot was taken — the prior envelope is captured under priorMiEnv.
    assert.ok(stage.priorMiEnv?.rows?.length === 1);
    assert.deepEqual(calls.map((c) => c.kind).sort(), [
      'crap',
      'maintainability',
    ]);
  });

  it('returns ok=false with reason=refresh-service-threw when refreshBaseline throws', async () => {
    const fsImpl = makeFsShim();
    fsImpl.writeFileSync(MI_PATH, JSON.stringify(miEnvelope([['a.js', 90]])));
    fsImpl.writeFileSync(CRAP_PATH, JSON.stringify(crapEnvelope([])));
    const refreshBaseline = async () => {
      throw new Error('service boom');
    };

    const stage = await stageRefreshArtifacts({
      cwd: REPO,
      epicBranch: 'epic/2453',
      storyBranch: 'story-2460',
      agentSettings: AGENT_SETTINGS_FIXTURE,
      config: { agentSettings: AGENT_SETTINGS_FIXTURE },
      ...stubAccessors(),
      refreshBaseline,
      scorerBuilder: fakeScorerBuilder(),
      fsImpl,
      readerLoadFile: makeReaderForFs(fsImpl),
    });

    assert.equal(stage.ok, false);
    assert.equal(stage.status, 'failed');
    assert.equal(stage.reason, 'refresh-service-threw');
    assert.match(stage.detail, /service boom/);
  });
});

describe('validateRefreshAccepted — Task #2469 (step 2 of pipeline)', () => {
  it('returns noDrift:true when no kind wrote', () => {
    const result = validateRefreshAccepted({
      stage: {
        miAbs: MI_PATH,
        crapAbs: CRAP_PATH,
        priorMiEnv: null,
        priorCrapEnv: null,
        miRefreshed: { wrote: false },
        crapRefreshed: { wrote: false },
      },
      autoRefresh: { scope: 'diff' },
      caps: { miDropCap: 1.5, crapJumpCap: 5 },
      cwd: REPO,
      epicBranch: 'epic/2453',
      storyBranch: 'story-2460',
      evaluateAutoRefresh: () => {
        throw new Error('verdict must not run when noDrift');
      },
      gitRunner: { gitSpawn: () => ({ status: 0 }) },
      computeDiffPaths: () => [],
      readerLoadFile: () => null,
    });
    assert.equal(result.noDrift, true);
  });

  it('returns accepted:true when verdict.canAutoRefresh is true', () => {
    const fsImpl = makeFsShim();
    fsImpl.writeFileSync(MI_PATH, JSON.stringify(miEnvelope([['a.js', 89.5]])));
    fsImpl.writeFileSync(CRAP_PATH, JSON.stringify(crapEnvelope([])));

    const result = validateRefreshAccepted({
      stage: {
        miAbs: MI_PATH,
        crapAbs: CRAP_PATH,
        priorMiEnv: miEnvelope([['a.js', 90]]),
        priorCrapEnv: crapEnvelope([]),
        miRefreshed: { wrote: true },
        crapRefreshed: { wrote: false },
      },
      autoRefresh: { scope: 'diff' },
      caps: { miDropCap: 1.5, crapJumpCap: 5 },
      cwd: REPO,
      epicBranch: 'epic/2453',
      storyBranch: 'story-2460',
      evaluateAutoRefresh: () => ({
        canAutoRefresh: true,
        refusalReasons: [],
        miOverCap: [],
        crapOverCap: [],
      }),
      gitRunner: { gitSpawn: () => ({ status: 0, stdout: 'a.js\n' }) },
      computeDiffPaths: () => ['a.js'],
      readerLoadFile: makeReaderForFs(fsImpl),
    });
    assert.equal(result.noDrift, false);
    assert.equal(result.accepted, true);
    assert.deepEqual(result.baselineFiles, [MI_PATH, CRAP_PATH]);
  });

  it('returns accepted:false when verdict.canAutoRefresh is false', () => {
    const fsImpl = makeFsShim();
    fsImpl.writeFileSync(MI_PATH, JSON.stringify(miEnvelope([['a.js', 80]])));
    fsImpl.writeFileSync(CRAP_PATH, JSON.stringify(crapEnvelope([])));

    const result = validateRefreshAccepted({
      stage: {
        miAbs: MI_PATH,
        crapAbs: CRAP_PATH,
        priorMiEnv: miEnvelope([['a.js', 90]]),
        priorCrapEnv: crapEnvelope([]),
        miRefreshed: { wrote: true },
        crapRefreshed: { wrote: false },
      },
      autoRefresh: { scope: 'diff' },
      caps: { miDropCap: 1.5, crapJumpCap: 5 },
      cwd: REPO,
      epicBranch: 'epic/2453',
      storyBranch: 'story-2460',
      evaluateAutoRefresh: () => ({
        canAutoRefresh: false,
        refusalReasons: ['mi-drop-cap'],
        miOverCap: [{ path: 'a.js', delta: -10 }],
        crapOverCap: [],
      }),
      gitRunner: { gitSpawn: () => ({ status: 0, stdout: 'a.js\n' }) },
      computeDiffPaths: () => ['a.js'],
      readerLoadFile: makeReaderForFs(fsImpl),
    });
    assert.equal(result.accepted, false);
    assert.equal(result.verdict.refusalReasons[0], 'mi-drop-cap');
  });
});

describe('commitRefresh — Task #2469 (step 3a, accepted path)', () => {
  it('emits one chore(baselines): commit per kind that drifted', () => {
    const { gitRunner, calls } = makeRecordingGit({
      'add baselines/maintainability.json': { status: 0 },
      'diff --cached --exit-code -- baselines/maintainability.json': {
        status: 1,
        stdout: 'M baselines/maintainability.json\n',
      },
      'commit -m chore(baselines): refresh maintainability for story-2460': {
        status: 0,
      },
      'rev-parse --short HEAD': { status: 0, stdout: 'abc1234' },
    });
    const result = commitRefresh({
      stage: {
        miAbs: MI_PATH,
        crapAbs: CRAP_PATH,
        miRefreshed: { wrote: true },
        crapRefreshed: { wrote: false },
      },
      cwd: REPO,
      storyId: 2460,
      gitRunner,
      logger: silentLogger(),
    });
    assert.equal(result.status, 'committed');
    assert.equal(result.sha, 'abc1234');
    assert.deepEqual(
      result.committed.map((c) => c.kind),
      ['maintainability'],
    );
    // No `--amend`, no `--allow-empty` — pin the AC-8 commit hygiene at this
    // layer too so a future regression here surfaces in the helper test.
    assert.ok(!calls.some((c) => c.includes('--amend')));
    assert.ok(!calls.some((c) => c.includes('--allow-empty')));
  });

  it('returns skipped when every staged diff is empty', () => {
    const { gitRunner } = makeRecordingGit({
      'diff --cached --exit-code -- baselines/maintainability.json': {
        status: 0,
        stdout: '',
      },
    });
    const result = commitRefresh({
      stage: {
        miAbs: MI_PATH,
        crapAbs: null,
        miRefreshed: { wrote: true },
        crapRefreshed: { wrote: false },
      },
      cwd: REPO,
      storyId: 2460,
      gitRunner,
      logger: silentLogger(),
    });
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'no-baseline-drift');
  });
});

describe('pushRefresh — Task #2469 (step 3b, refused path)', () => {
  it('rolls back baseline files and appends a single friction signal', async () => {
    const checkoutCalls = [];
    const gitRunner = {
      gitSpawn(_cwd, ...args) {
        const joined = args.join(' ');
        if (joined.startsWith('checkout HEAD --')) checkoutCalls.push(joined);
        return { status: 0, stdout: '', stderr: '' };
      },
    };
    const appended = [];
    const appendSignal = async ({ signal }) => {
      appended.push(signal);
      return true;
    };
    const forEachLine = async () => ({ linesRead: 0, missing: true });

    const result = await pushRefresh({
      validation: {
        verdict: {
          canAutoRefresh: false,
          refusalReasons: ['mi-drop-cap'],
          miOverCap: [{ path: 'a.js', delta: -10 }],
          crapOverCap: [],
        },
        baselineFiles: [MI_PATH, CRAP_PATH],
      },
      caps: { miDropCap: 1.5, crapJumpCap: 5 },
      epicId: 2453,
      storyId: 2460,
      cwd: REPO,
      gitRunner,
      appendSignal,
      forEachLine,
      config: { agentSettings: AGENT_SETTINGS_FIXTURE },
      logger: silentLogger(),
    });

    assert.equal(result.status, 'refused');
    assert.equal(result.signalAppended, true);
    assert.equal(appended.length, 1);
    // Both baseline files must be rolled back to HEAD.
    assert.equal(checkoutCalls.length, 2);
  });
});

describe('runAutoRefresh — integration: pipeline wires the four helpers', () => {
  it('happy path: stage → validate(accepted) → commit returns status=committed', async () => {
    const fsImpl = makeFsShim();
    fsImpl.writeFileSync(MI_PATH, JSON.stringify(miEnvelope([['a.js', 90]])));
    fsImpl.writeFileSync(CRAP_PATH, JSON.stringify(crapEnvelope([])));

    const { refreshBaseline } = makeRefreshBaselineStub(fsImpl, {
      maintainability: { write: true, envelope: miEnvelope([['a.js', 89.6]]) },
      crap: { write: false, envelope: crapEnvelope([]) },
    });

    const { gitRunner } = makeRecordingGit({
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

    const result = await runAutoRefresh({
      storyId: 2460,
      epicId: 2453,
      cwd: REPO,
      epicBranch: 'epic/2453',
      storyBranch: 'story-2460',
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
    assert.equal(result.sha, 'cafe');
  });

  it('refresh-service-threw at stage 1 collapses to status=failed', async () => {
    const fsImpl = makeFsShim();
    fsImpl.writeFileSync(MI_PATH, JSON.stringify(miEnvelope([['a.js', 90]])));
    fsImpl.writeFileSync(CRAP_PATH, JSON.stringify(crapEnvelope([])));
    const refreshBaseline = async () => {
      throw new Error('boom-at-stage-1');
    };
    const result = await runAutoRefresh({
      storyId: 2460,
      epicId: 2453,
      cwd: REPO,
      epicBranch: 'epic/2453',
      storyBranch: 'story-2460',
      agentSettings: AGENT_SETTINGS_FIXTURE,
      deps: {
        ...stubAccessors(),
        refreshBaseline,
        scorerBuilder: fakeScorerBuilder(),
        gitRunner: { gitSpawn: () => ({ status: 0 }) },
        fsImpl,
        appendSignal: async () => true,
        forEachLine: async () => ({ linesRead: 0, missing: true }),
        logger: silentLogger(),
        readerLoadFile: makeReaderForFs(fsImpl),
      },
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'refresh-service-threw');
    assert.match(result.detail, /boom-at-stage-1/);
  });
});

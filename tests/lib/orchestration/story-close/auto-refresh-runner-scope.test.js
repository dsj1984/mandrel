/**
 * auto-refresh-runner-scope.test.js — Story #1974 / Task #1983, Epic #1943.
 *
 * `auto-refresh-runner.js` is the only in-PR baseline-write path. With the
 * new scope-aware merge it MUST never persist rows for files outside the
 * Story's diff scope. Two simulated concurrent Stories on disjoint files
 * therefore produce non-overlapping baseline diffs — the moral equivalent
 * of `git merge --no-ff` with zero baseline-JSON conflicts.
 *
 * AC coverage:
 *   - auto-refresh-runner never writes rows for files outside the Story's
 *     diff scope (out-of-scope prior rows are preserved verbatim).
 *   - Two simulated concurrent Story branches produce baseline JSON whose
 *     drifted-row sets are disjoint — no row identity overlap.
 *   - Scope=full preserves the legacy "rewrite everything" behaviour.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  rewriteBaselinesWithScopeMerge,
  runAutoRefresh,
} from '../../../../.agents/scripts/lib/orchestration/story-close/auto-refresh-runner.js';

const REPO = path.resolve('/tmp/repo-1974');
const MI_PATH = path.resolve(REPO, 'baselines/maintainability.json');
const CRAP_PATH = path.resolve(REPO, 'baselines/crap.json');

const AGENT_SETTINGS = {
  paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
  quality: {
    autoRefresh: {
      enabled: true,
      miDropCap: 100, // wide caps — we are testing scope, not refusal
      crapJumpCap: 100,
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
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function stubAccessors() {
  return {
    getQuality: () => ({ ...AGENT_SETTINGS.quality }),
    getBaselines: () => ({ ...AGENT_SETTINGS.quality.baselines }),
    getBaselineEpsilon: (kind) => {
      // Use small epsilons so the test's intentional row drift is not
      // absorbed by the stabilizer.
      if (kind === 'maintainability') return 0.001;
      if (kind === 'crap') return 0.001;
      return 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Pure helper — rewriteBaselinesWithScopeMerge (covers the unit boundary)
// ---------------------------------------------------------------------------

describe('rewriteBaselinesWithScopeMerge — pure', () => {
  it('preserves out-of-scope prior MI rows verbatim', () => {
    const fsImpl = makeFsShim({});
    rewriteBaselinesWithScopeMerge({
      miAbs: MI_PATH,
      crapAbs: null,
      priorMi: [
        { path: 'a.js', mi: 70 },
        { path: 'b.js', mi: 80 },
      ],
      priorCrap: null,
      regenMi: [
        { path: 'a.js', mi: 90 },
        { path: 'b.js', mi: 10 },
      ],
      regenCrap: null,
      scope: { mode: 'diff', files: new Set(['a.js']) },
      miEpsilon: 0,
      crapEpsilon: 0,
      fsImpl,
    });
    const written = JSON.parse(fsImpl.store.get(MI_PATH));
    assert.equal(written['a.js'], 90, 'in-scope row uses regenerated value');
    assert.equal(written['b.js'], 80, 'out-of-scope row preserved from prior');
  });

  it('preserves out-of-scope prior CRAP rows verbatim (legacy `file` field)', () => {
    const fsImpl = makeFsShim({
      [CRAP_PATH]: JSON.stringify({
        $schema: '.agents/schemas/crap-baseline.schema.json',
        kernelVersion: '1.1.0',
        rows: [
          { file: 'a.js', method: 'fn', startLine: 1, crap: 5 },
          { file: 'b.js', method: 'gn', startLine: 1, crap: 8 },
        ],
      }),
    });
    rewriteBaselinesWithScopeMerge({
      miAbs: null,
      crapAbs: CRAP_PATH,
      priorMi: null,
      priorCrap: [
        { file: 'a.js', method: 'fn', startLine: 1, crap: 5 },
        { file: 'b.js', method: 'gn', startLine: 1, crap: 8 },
      ],
      regenMi: null,
      regenCrap: [
        { file: 'a.js', method: 'fn', startLine: 1, crap: 12 },
        { file: 'b.js', method: 'gn', startLine: 1, crap: 99 },
      ],
      scope: { mode: 'diff', files: new Set(['a.js']) },
      miEpsilon: 0,
      crapEpsilon: 0,
      fsImpl,
    });
    const written = JSON.parse(fsImpl.store.get(CRAP_PATH));
    assert.ok(
      Array.isArray(written.rows),
      'envelope rows[] must be present',
    );
    const byFile = Object.fromEntries(written.rows.map((r) => [r.file, r.crap]));
    assert.equal(byFile['a.js'], 12, 'in-scope crap row uses regen value');
    assert.equal(byFile['b.js'], 8, 'out-of-scope crap row preserved from prior');
    // Envelope `$schema` / `kernelVersion` survived the rewrite.
    assert.equal(
      written.$schema,
      '.agents/schemas/crap-baseline.schema.json',
      'envelope metadata preserved',
    );
    assert.equal(written.kernelVersion, '1.1.0');
  });

  it('full mode: regen wins everywhere (no scope-merge applied)', () => {
    const fsImpl = makeFsShim({});
    rewriteBaselinesWithScopeMerge({
      miAbs: MI_PATH,
      crapAbs: null,
      priorMi: [
        { path: 'a.js', mi: 70 },
        { path: 'b.js', mi: 80 },
      ],
      priorCrap: null,
      regenMi: [
        { path: 'a.js', mi: 90 },
        { path: 'b.js', mi: 10 },
      ],
      regenCrap: null,
      scope: { mode: 'full', files: new Set() },
      miEpsilon: 0,
      crapEpsilon: 0,
      fsImpl,
    });
    const written = JSON.parse(fsImpl.store.get(MI_PATH));
    assert.equal(written['a.js'], 90);
    assert.equal(written['b.js'], 10);
  });
});

// ---------------------------------------------------------------------------
// Two concurrent stories on disjoint files — non-overlapping baseline diffs
// ---------------------------------------------------------------------------

describe('runAutoRefresh — concurrent stories on disjoint files', () => {
  // Shared starting baseline that both Stories see.
  const PRIOR_MI = { 'a.js': 70, 'b.js': 80, 'c.js': 65 };
  const PRIOR_CRAP_ROWS = [
    { file: 'a.js', method: 'fn', startLine: 1, crap: 5 },
    { file: 'b.js', method: 'gn', startLine: 1, crap: 6 },
    { file: 'c.js', method: 'hn', startLine: 1, crap: 7 },
  ];

  function setUpStoryFs() {
    const fsImpl = makeFsShim({});
    fsImpl.writeFileSync(MI_PATH, JSON.stringify(PRIOR_MI));
    fsImpl.writeFileSync(
      CRAP_PATH,
      JSON.stringify({
        $schema: '.agents/schemas/crap-baseline.schema.json',
        kernelVersion: '1.1.0',
        rows: PRIOR_CRAP_ROWS,
      }),
    );
    return fsImpl;
  }

  it('Story A (touches a.js) and Story B (touches b.js) produce disjoint baseline drift', async () => {
    // ── Story A ────────────────────────────────────────────────────────────
    const fsA = setUpStoryFs();
    const regenA = async () => {
      // Full regen rewrites the whole baseline (not scope-aware on its own).
      // a.js drifts; b.js / c.js drift but should be reverted by the merge.
      fsA.writeFileSync(
        MI_PATH,
        JSON.stringify({ 'a.js': 90, 'b.js': 100, 'c.js': 100 }),
      );
      fsA.writeFileSync(
        CRAP_PATH,
        JSON.stringify({
          $schema: '.agents/schemas/crap-baseline.schema.json',
          kernelVersion: '1.1.0',
          rows: [
            { file: 'a.js', method: 'fn', startLine: 1, crap: 9 },
            { file: 'b.js', method: 'gn', startLine: 1, crap: 99 },
            { file: 'c.js', method: 'hn', startLine: 1, crap: 99 },
          ],
        }),
      );
      return { didChange: true, files: [] };
    };
    const { gitRunner: gitA } = makeRecordingGit({
      'diff --name-only origin/epic/1943...story-A': {
        status: 0,
        stdout: 'a.js\n',
        stderr: '',
      },
      'rev-parse --short HEAD': {
        status: 0,
        stdout: 'shaA\n',
        stderr: '',
      },
    });

    const resultA = await runAutoRefresh({
      storyId: 'A',
      epicId: 1943,
      cwd: REPO,
      epicBranch: 'epic/1943',
      storyBranch: 'story-A',
      agentSettings: AGENT_SETTINGS,
      deps: {
        ...stubAccessors(),
        regenerateMainFromTree: regenA,
        gitRunner: gitA,
        fsImpl: fsA,
        appendSignal: async () => true,
        forEachLine: async () => ({ linesRead: 0, missing: true }),
        logger: silentLogger(),
      },
    });
    assert.equal(resultA.status, 'amended', 'Story A should amend under-cap');
    const persistedA = JSON.parse(fsA.store.get(MI_PATH));
    const persistedACrap = JSON.parse(fsA.store.get(CRAP_PATH));

    // ── Story B ────────────────────────────────────────────────────────────
    const fsB = setUpStoryFs();
    const regenB = async () => {
      fsB.writeFileSync(
        MI_PATH,
        JSON.stringify({ 'a.js': 100, 'b.js': 95, 'c.js': 100 }),
      );
      fsB.writeFileSync(
        CRAP_PATH,
        JSON.stringify({
          $schema: '.agents/schemas/crap-baseline.schema.json',
          kernelVersion: '1.1.0',
          rows: [
            { file: 'a.js', method: 'fn', startLine: 1, crap: 99 },
            { file: 'b.js', method: 'gn', startLine: 1, crap: 8 },
            { file: 'c.js', method: 'hn', startLine: 1, crap: 99 },
          ],
        }),
      );
      return { didChange: true, files: [] };
    };
    const { gitRunner: gitB } = makeRecordingGit({
      'diff --name-only origin/epic/1943...story-B': {
        status: 0,
        stdout: 'b.js\n',
        stderr: '',
      },
      'rev-parse --short HEAD': {
        status: 0,
        stdout: 'shaB\n',
        stderr: '',
      },
    });
    const resultB = await runAutoRefresh({
      storyId: 'B',
      epicId: 1943,
      cwd: REPO,
      epicBranch: 'epic/1943',
      storyBranch: 'story-B',
      agentSettings: AGENT_SETTINGS,
      deps: {
        ...stubAccessors(),
        regenerateMainFromTree: regenB,
        gitRunner: gitB,
        fsImpl: fsB,
        appendSignal: async () => true,
        forEachLine: async () => ({ linesRead: 0, missing: true }),
        logger: silentLogger(),
      },
    });
    assert.equal(resultB.status, 'amended', 'Story B should amend under-cap');
    const persistedB = JSON.parse(fsB.store.get(MI_PATH));
    const persistedBCrap = JSON.parse(fsB.store.get(CRAP_PATH));

    // ── AC: Story A drifts only a.js; Story B drifts only b.js ────────────
    assert.equal(persistedA['a.js'], 90, 'Story A: a.js drifts to regen value');
    assert.equal(persistedA['b.js'], 80, 'Story A: b.js preserved from prior');
    assert.equal(persistedA['c.js'], 65, 'Story A: c.js preserved from prior');

    assert.equal(persistedB['a.js'], 70, 'Story B: a.js preserved from prior');
    assert.equal(persistedB['b.js'], 95, 'Story B: b.js drifts to regen value');
    assert.equal(persistedB['c.js'], 65, 'Story B: c.js preserved from prior');

    // ── AC: drifted row sets are disjoint (zero merge conflicts) ──────────
    const driftedA = Object.entries(persistedA)
      .filter(([k, v]) => PRIOR_MI[k] !== v)
      .map(([k]) => k);
    const driftedB = Object.entries(persistedB)
      .filter(([k, v]) => PRIOR_MI[k] !== v)
      .map(([k]) => k);
    assert.deepEqual(driftedA, ['a.js']);
    assert.deepEqual(driftedB, ['b.js']);
    assert.deepEqual(
      driftedA.filter((p) => driftedB.includes(p)),
      [],
      'baseline-row drift sets must be disjoint',
    );

    // CRAP: same shape — Story A drifts a.js's row, Story B drifts b.js's.
    const aCrapByFile = Object.fromEntries(
      persistedACrap.rows.map((r) => [r.file, r.crap]),
    );
    const bCrapByFile = Object.fromEntries(
      persistedBCrap.rows.map((r) => [r.file, r.crap]),
    );
    assert.equal(aCrapByFile['a.js'], 9);
    assert.equal(aCrapByFile['b.js'], 6);
    assert.equal(aCrapByFile['c.js'], 7);
    assert.equal(bCrapByFile['a.js'], 5);
    assert.equal(bCrapByFile['b.js'], 8);
    assert.equal(bCrapByFile['c.js'], 7);
  });
});

/**
 * auto-refresh-runner-scope.test.js — Story #1974 / Task #1983, Epic #1943.
 * Migrated to V2 envelopes + writer funnel for Story #2135 / Task #2147.
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
  adaptCrapRowsForEvaluator,
  runAutoRefresh,
  writeScopeMergedBaseline,
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

function stubAccessors() {
  return {
    getQuality: () => ({ ...AGENT_SETTINGS.quality }),
    getBaselines: () => ({ ...AGENT_SETTINGS.quality.baselines }),
    getBaselineEpsilon: (kind) => {
      if (kind === 'maintainability') return 0.001;
      if (kind === 'crap') return 0.001;
      return 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('adaptCrapRowsForEvaluator (Story #2135 / Task #2147)', () => {
  it('renames `path` → `file` so legacy evaluator can index by file', () => {
    const out = adaptCrapRowsForEvaluator([
      { path: 'a.js', method: 'fn', startLine: 1, crap: 5 },
    ]);
    assert.deepEqual(out, [
      { file: 'a.js', method: 'fn', startLine: 1, crap: 5 },
    ]);
  });

  it('returns rows unchanged when no path field is present', () => {
    const out = adaptCrapRowsForEvaluator([
      { file: 'a.js', method: 'fn', startLine: 1, crap: 5 },
    ]);
    assert.deepEqual(out, [
      { file: 'a.js', method: 'fn', startLine: 1, crap: 5 },
    ]);
  });

  it('handles null/undefined input', () => {
    assert.deepEqual(adaptCrapRowsForEvaluator(null), []);
    assert.deepEqual(adaptCrapRowsForEvaluator(undefined), []);
  });
});

describe('writeScopeMergedBaseline — writer funnel', () => {
  it('returns null when absPath is null (kind not configured)', () => {
    const result = writeScopeMergedBaseline({
      kind: 'maintainability',
      absPath: null,
      prior: { rows: [] },
      regen: { rows: [] },
      scope: { mode: 'diff', files: new Set() },
      epsilon: 0,
      writeFn: () => {
        throw new Error('writeFn should not be invoked when absPath is null');
      },
      writeFileFn: () => {
        throw new Error(
          'writeFileFn should not be invoked when absPath is null',
        );
      },
      fsImpl: makeFsShim(),
    });
    assert.equal(result, null);
  });

  it('delegates assembly to writeFn and persistence to writeFileFn', () => {
    const writeCalls = [];
    const writeFileCalls = [];
    const fakeEnvelope = {
      $schema: '.agents/schemas/baselines/maintainability.schema.json',
      kernelVersion: '0.1.0',
      generatedAt: '2026-05-15T00:00:00Z',
      rollup: { '*': {} },
      rows: [{ path: 'a.js', mi: 90 }],
    };
    const result = writeScopeMergedBaseline({
      kind: 'maintainability',
      absPath: MI_PATH,
      prior: { rows: [{ path: 'a.js', mi: 70 }] },
      regen: { rows: [{ path: 'a.js', mi: 90 }] },
      scope: { mode: 'diff', files: new Set(['a.js']) },
      epsilon: 0,
      writeFn: (args) => {
        writeCalls.push(args);
        return fakeEnvelope;
      },
      writeFileFn: (absPath, env, opts) => {
        writeFileCalls.push({ absPath, env, opts });
      },
      fsImpl: makeFsShim(),
    });
    assert.equal(result, fakeEnvelope);
    assert.equal(writeCalls.length, 1);
    assert.equal(writeCalls[0].kind, 'maintainability');
    assert.deepEqual(writeCalls[0].rows, [{ path: 'a.js', mi: 90 }]);
    assert.deepEqual(writeCalls[0].prior, [{ path: 'a.js', mi: 70 }]);
    assert.equal(writeCalls[0].scope.mode, 'diff');
    assert.equal(writeCalls[0].epsilon, 0);
    assert.equal(writeFileCalls.length, 1);
    assert.equal(writeFileCalls[0].absPath, MI_PATH);
    assert.equal(writeFileCalls[0].env, fakeEnvelope);
  });
});

// ---------------------------------------------------------------------------
// Two concurrent stories on disjoint files — non-overlapping baseline diffs
// ---------------------------------------------------------------------------

describe('runAutoRefresh — concurrent stories on disjoint files (V2 funnel)', () => {
  // Shared starting baseline that both Stories see (V2 envelope shape).
  const PRIOR_MI_ENV = {
    $schema: '.agents/schemas/baselines/maintainability.schema.json',
    kernelVersion: '0.1.0',
    generatedAt: '2026-04-01T00:00:00Z',
    rollup: { '*': {} },
    rows: [
      { path: 'a.js', mi: 70 },
      { path: 'b.js', mi: 80 },
      { path: 'c.js', mi: 65 },
    ],
  };
  const PRIOR_CRAP_ENV = {
    $schema: '.agents/schemas/baselines/crap.schema.json',
    kernelVersion: '1.1.0',
    generatedAt: '2026-04-01T00:00:00Z',
    rollup: { '*': {} },
    rows: [
      { path: 'a.js', method: 'fn', startLine: 1, crap: 5 },
      { path: 'b.js', method: 'gn', startLine: 1, crap: 6 },
      { path: 'c.js', method: 'hn', startLine: 1, crap: 7 },
    ],
  };

  // Stub readerLoadFile to return whatever envelope the in-memory shim
  // last persisted (or the prior on the very first read). The shim
  // stores the raw JSON; the reader stub parses it directly.
  function makeReaderForFs(fsImpl) {
    return (absPath, _opts) => {
      const bytes = fsImpl.store.get(absPath);
      if (!bytes) return null;
      const parsed = JSON.parse(bytes);
      return {
        rollup: parsed.rollup ?? { '*': {} },
        rows: parsed.rows ?? [],
        kernelVersion: parsed.kernelVersion,
        generatedAt: parsed.generatedAt,
      };
    };
  }

  // Stub the writer: when scope filters rows, emulate the production
  // per-kind mergeRows behaviour at test scope. The test does not need
  // to exercise the real writer — that's covered in
  // tests/baselines/writer.test.js — but it does need to honour the
  // scope contract so the disjoint-drift assertions pass.
  function makeWriterStub() {
    return ({ kind, rows, prior, scope }) => {
      const priorRows = Array.isArray(prior) ? prior : [];
      const regenRows = Array.isArray(rows) ? rows : [];
      // CRAP rows here arrive keyed by `path` from the writer's projection.
      // The test fixtures pre-key by `path` to mirror the real per-kind
      // module output.
      const scopeFiles = scope?.files instanceof Set ? scope.files : new Set();
      let mergedRows;
      if (scope?.mode === 'diff') {
        const regenInScope = regenRows.filter((row) =>
          scopeFiles.has(row.path),
        );
        const priorOutOfScope = priorRows.filter(
          (row) => !scopeFiles.has(row.path),
        );
        mergedRows = regenInScope.concat(priorOutOfScope);
      } else {
        mergedRows = regenRows;
      }
      // Sort by path so disjoint-drift assertions are order-stable.
      mergedRows.sort((a, b) => a.path.localeCompare(b.path));
      return {
        $schema: `.agents/schemas/baselines/${kind}.schema.json`,
        kernelVersion: '0.1.0',
        generatedAt: '2026-05-15T00:00:00Z',
        rollup: { '*': {} },
        rows: mergedRows,
      };
    };
  }

  function makeWriteFileStub() {
    return (absPath, envelope, opts) => {
      opts.fsImpl.writeFileSync(absPath, JSON.stringify(envelope));
    };
  }

  function setUpStoryFs() {
    const fsImpl = makeFsShim({});
    fsImpl.writeFileSync(MI_PATH, JSON.stringify(PRIOR_MI_ENV));
    fsImpl.writeFileSync(CRAP_PATH, JSON.stringify(PRIOR_CRAP_ENV));
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
        JSON.stringify({
          ...PRIOR_MI_ENV,
          rows: [
            { path: 'a.js', mi: 90 },
            { path: 'b.js', mi: 100 },
            { path: 'c.js', mi: 100 },
          ],
        }),
      );
      fsA.writeFileSync(
        CRAP_PATH,
        JSON.stringify({
          ...PRIOR_CRAP_ENV,
          rows: [
            { path: 'a.js', method: 'fn', startLine: 1, crap: 9 },
            { path: 'b.js', method: 'gn', startLine: 1, crap: 99 },
            { path: 'c.js', method: 'hn', startLine: 1, crap: 99 },
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
        writeFn: makeWriterStub(),
        writeFileFn: makeWriteFileStub(),
        readerLoadFile: makeReaderForFs(fsA),
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
        JSON.stringify({
          ...PRIOR_MI_ENV,
          rows: [
            { path: 'a.js', mi: 100 },
            { path: 'b.js', mi: 95 },
            { path: 'c.js', mi: 100 },
          ],
        }),
      );
      fsB.writeFileSync(
        CRAP_PATH,
        JSON.stringify({
          ...PRIOR_CRAP_ENV,
          rows: [
            { path: 'a.js', method: 'fn', startLine: 1, crap: 99 },
            { path: 'b.js', method: 'gn', startLine: 1, crap: 8 },
            { path: 'c.js', method: 'hn', startLine: 1, crap: 99 },
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
        writeFn: makeWriterStub(),
        writeFileFn: makeWriteFileStub(),
        readerLoadFile: makeReaderForFs(fsB),
      },
    });
    assert.equal(resultB.status, 'amended', 'Story B should amend under-cap');
    const persistedB = JSON.parse(fsB.store.get(MI_PATH));
    const persistedBCrap = JSON.parse(fsB.store.get(CRAP_PATH));

    // ── AC: Story A drifts only a.js; Story B drifts only b.js ────────────
    const aMiByPath = Object.fromEntries(
      persistedA.rows.map((r) => [r.path, r.mi]),
    );
    const bMiByPath = Object.fromEntries(
      persistedB.rows.map((r) => [r.path, r.mi]),
    );
    assert.equal(aMiByPath['a.js'], 90, 'Story A: a.js drifts to regen value');
    assert.equal(aMiByPath['b.js'], 80, 'Story A: b.js preserved from prior');
    assert.equal(aMiByPath['c.js'], 65, 'Story A: c.js preserved from prior');

    assert.equal(bMiByPath['a.js'], 70, 'Story B: a.js preserved from prior');
    assert.equal(bMiByPath['b.js'], 95, 'Story B: b.js drifts to regen value');
    assert.equal(bMiByPath['c.js'], 65, 'Story B: c.js preserved from prior');

    // ── AC: drifted row sets are disjoint (zero merge conflicts) ──────────
    const PRIOR_MI = Object.fromEntries(
      PRIOR_MI_ENV.rows.map((r) => [r.path, r.mi]),
    );
    const driftedA = Object.entries(aMiByPath)
      .filter(([k, v]) => PRIOR_MI[k] !== v)
      .map(([k]) => k);
    const driftedB = Object.entries(bMiByPath)
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
    const aCrapByPath = Object.fromEntries(
      persistedACrap.rows.map((r) => [r.path, r.crap]),
    );
    const bCrapByPath = Object.fromEntries(
      persistedBCrap.rows.map((r) => [r.path, r.crap]),
    );
    assert.equal(aCrapByPath['a.js'], 9);
    assert.equal(aCrapByPath['b.js'], 6);
    assert.equal(aCrapByPath['c.js'], 7);
    assert.equal(bCrapByPath['a.js'], 5);
    assert.equal(bCrapByPath['b.js'], 8);
    assert.equal(bCrapByPath['c.js'], 7);
  });
});

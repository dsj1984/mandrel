import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  createCrapDriftDetector,
  detectComponentRegressions,
} from '../../.agents/scripts/lib/orchestration/epic-runner/progress-signals/crap-drift.js';

const CWD = path.join(path.sep, 'repo');
const BASELINE_PATH = path.join(CWD, '.agents/state/wave-crap-snapshot.json');

/**
 * Build a fake fs whose `readFileSync` returns canned content for either the
 * baseline JSON path (via `baseline`) or repo-relative source paths (via
 * `files`). `writeFileSync` captures every write for assertions.
 */
function fakeFs({ baseline = null, files = {}, failOn = [] } = {}) {
  const writes = [];
  return {
    writes,
    readFileSync(p) {
      if (failOn.includes(p)) {
        const err = new Error(`EACCES: ${p}`);
        err.code = 'EACCES';
        throw err;
      }
      if (baseline && p === BASELINE_PATH) return baseline;
      for (const [rel, contents] of Object.entries(files)) {
        if (p === path.join(CWD, rel)) return contents;
      }
      const err = new Error(`ENOENT: ${p}`);
      err.code = 'ENOENT';
      throw err;
    },
    writeFileSync(p, body) {
      writes.push({ path: p, body });
    },
    mkdirSync() {},
  };
}

/**
 * Build a scripted `calculate` stub. The stub returns rows from `rowsFor`
 * keyed by source text — callers stage snapshot vs. tick by using different
 * source strings (e.g. 'pre' / 'post') and mapping each to the method rows
 * that should be reported for that phase.
 */
function scriptedCalculate(rowsFor) {
  return (source) => rowsFor[source] ?? [];
}

describe('crap-drift detector', () => {
  it('emits the expected bullet when a 45-CRAP method appears between snapshot and tick (crosses ceiling)', async () => {
    // A stateful source so a single detector sees "pre" at snapshot and
    // "post" at tick without rebuilding the fake fs.
    const sourceState = { value: 'pre' };
    const fs = {
      writes: [],
      readFileSync(p) {
        if (p === BASELINE_PATH) {
          const w = this.writes[this.writes.length - 1];
          if (w) return w.body;
          const err = new Error(`ENOENT: ${p}`);
          err.code = 'ENOENT';
          throw err;
        }
        if (p === path.join(CWD, 'src/a.js')) return sourceState.value;
        const err = new Error(`ENOENT: ${p}`);
        err.code = 'ENOENT';
        throw err;
      },
      writeFileSync(p, body) {
        this.writes.push({ path: p, body });
      },
      mkdirSync() {},
    };

    const detector = createCrapDriftDetector({
      cwd: CWD,
      files: ['src/a.js'],
      fs,
      calculate: scriptedCalculate({
        pre: [{ method: 'foo', startLine: 10, crap: 12 }],
        post: [
          { method: 'foo', startLine: 10, crap: 12 },
          { method: 'bar', startLine: 40, crap: 45 },
        ],
      }),
      ceiling: 30,
      threshold: 5,
    });

    detector.captureBaseline();
    sourceState.value = 'post';
    const bullets = await detector.detect();
    assert.deepEqual(bullets, [
      '🧨 CRAP drift: src/a.js::bar 45.00 (ceiling 30)',
    ]);
  });

  it('rose-by-threshold path fires for a below-ceiling method whose CRAP rose ≥ threshold', async () => {
    const detector = createCrapDriftDetector({
      cwd: CWD,
      files: ['src/a.js'],
      fs: fakeFs({
        baseline: JSON.stringify({
          ceiling: 30,
          threshold: 5,
          scores: { 'src/a.js': { 'foo@10': 10 } },
        }),
        files: { 'src/a.js': 'post' },
      }),
      calculate: scriptedCalculate({
        post: [{ method: 'foo', startLine: 10, crap: 18 }],
      }),
      ceiling: 30,
      threshold: 5,
    });
    detector.loadBaseline();
    const bullets = await detector.detect();
    assert.deepEqual(bullets, [
      '🧨 CRAP drift: src/a.js::foo 18.00 (ceiling 30)',
    ]);
  });

  it('does not fire when baseline already above ceiling and current rise < threshold', async () => {
    const detector = createCrapDriftDetector({
      cwd: CWD,
      files: ['src/a.js'],
      fs: fakeFs({
        baseline: JSON.stringify({
          ceiling: 30,
          threshold: 5,
          scores: { 'src/a.js': { 'foo@10': 40 } },
        }),
        files: { 'src/a.js': 'post' },
      }),
      calculate: scriptedCalculate({
        post: [{ method: 'foo', startLine: 10, crap: 42 }],
      }),
      ceiling: 30,
      threshold: 5,
    });
    detector.loadBaseline();
    const bullets = await detector.detect();
    assert.deepEqual(bullets, []);
  });

  it('loadBaseline survives mid-wave restart — a fresh detector reads the persisted snapshot', async () => {
    // Phase 1: capture baseline through a detector whose `writeFileSync`
    // captures the persisted JSON.
    const captureFs = fakeFs({ files: { 'src/a.js': 'pre' } });
    const capture = createCrapDriftDetector({
      cwd: CWD,
      files: ['src/a.js'],
      fs: captureFs,
      calculate: scriptedCalculate({
        pre: [{ method: 'foo', startLine: 10, crap: 12 }],
      }),
      ceiling: 30,
      threshold: 5,
    });
    capture.captureBaseline();
    const persisted = captureFs.writes[0];
    assert.equal(persisted.path, BASELINE_PATH);

    // Phase 2: a brand-new detector (simulating a mid-wave process restart)
    // loads the snapshot from disk and still detects the same drift.
    const resume = createCrapDriftDetector({
      cwd: CWD,
      files: ['src/a.js'],
      fs: fakeFs({
        baseline: persisted.body,
        files: { 'src/a.js': 'post' },
      }),
      calculate: scriptedCalculate({
        post: [
          { method: 'foo', startLine: 10, crap: 12 },
          { method: 'bar', startLine: 40, crap: 45 },
        ],
      }),
      ceiling: 30,
      threshold: 5,
    });
    resume.loadBaseline();
    const bullets = await resume.detect();
    assert.deepEqual(bullets, [
      '🧨 CRAP drift: src/a.js::bar 45.00 (ceiling 30)',
    ]);
  });

  it('per-file read error is logged but does not propagate or poison other files', async () => {
    const warnings = [];
    const detector = createCrapDriftDetector({
      cwd: CWD,
      files: ['src/bad.js', 'src/good.js'],
      fs: fakeFs({
        baseline: JSON.stringify({
          ceiling: 30,
          threshold: 5,
          scores: {
            'src/bad.js': { 'wrecked@1': 5 },
            'src/good.js': { 'ok@1': 5 },
          },
        }),
        files: { 'src/good.js': 'good' },
        failOn: [path.join(CWD, 'src/bad.js')],
      }),
      calculate: scriptedCalculate({
        good: [{ method: 'ok', startLine: 1, crap: 45 }],
      }),
      ceiling: 30,
      threshold: 5,
      logger: {
        warn(msg) {
          warnings.push(msg);
        },
      },
    });
    detector.loadBaseline();
    const bullets = await detector.detect();
    assert.deepEqual(bullets, [
      '🧨 CRAP drift: src/good.js::ok 45.00 (ceiling 30)',
    ]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /crap-drift/);
    assert.match(warnings[0], /src[\\/]bad\.js/);
  });

  it('returns no bullets before a baseline is captured or loaded', async () => {
    const detector = createCrapDriftDetector({
      cwd: CWD,
      files: ['src/a.js'],
      fs: fakeFs({ files: { 'src/a.js': 'post' } }),
      calculate: scriptedCalculate({
        post: [{ method: 'foo', startLine: 10, crap: 45 }],
      }),
      ceiling: 30,
      threshold: 5,
    });
    const bullets = await detector.detect();
    assert.deepEqual(bullets, []);
  });
});

describe('crap detectComponentRegressions (Task #1919)', () => {
  it('emits per-component bullets that name the failing component', () => {
    const bullets = detectComponentRegressions({
      rollup: {
        '*': { p95: 5, max: 8 },
        api: { p95: 9.2, max: 12 },
      },
      gateConfig: {
        components: { api: ['src/api/**'] },
        floors: { '*': { p95: 6 }, api: { p95: 8 } },
      },
    });
    assert.deepEqual(bullets, ['🧨 crap: api p95 9.20 > floor 8']);
  });

  it('does not report `*` when only a component-scoped floor was breached', () => {
    const bullets = detectComponentRegressions({
      rollup: {
        '*': { p95: 5 },
        api: { p95: 9 },
      },
      gateConfig: {
        components: { api: ['src/api/**'] },
        floors: { '*': { p95: 10 }, api: { p95: 8 } },
      },
    });
    assert.deepEqual(bullets, ['🧨 crap: api p95 9 > floor 8']);
  });

  it('returns no bullets when every component passes its floor', () => {
    const bullets = detectComponentRegressions({
      rollup: { '*': { p95: 5 }, api: { p95: 7 } },
      gateConfig: { floors: { '*': { p95: 10 }, api: { p95: 8 } } },
    });
    assert.deepEqual(bullets, []);
  });

  it('tolerates missing rollup / floors gracefully', () => {
    assert.deepEqual(detectComponentRegressions({}), []);
    assert.deepEqual(
      detectComponentRegressions({ rollup: {}, gateConfig: {} }),
      [],
    );
  });
});

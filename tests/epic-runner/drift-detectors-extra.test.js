/**
 * Tail branches for the wave-start drift detectors:
 *
 *   - crap-drift.js — persistence-failure swallow path; loadBaseline
 *     missing/parse-error path; readCoverageMap throw / null path.
 *   - maintainability-drift.js — same persistence + loadBaseline
 *     branches; baselinePath getter exposure.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { createCrapDriftDetector } from '../../.agents/scripts/lib/orchestration/epic-runner/progress-signals/crap-drift.js';
import { createMaintainabilityDriftDetector } from '../../.agents/scripts/lib/orchestration/epic-runner/progress-signals/maintainability-drift.js';

const CWD = path.join(path.sep, 'repo');

function fakeFs({
  files = {},
  failOn = [],
  failWriteOn = [],
  failMkdirOn = [],
} = {}) {
  return {
    readFileSync(p) {
      if (failOn.includes(p)) {
        const e = new Error(`mocked read failure: ${p}`);
        e.code = 'EIO';
        throw e;
      }
      const rel = p
        .replace(/\\/g, '/')
        .replace(`${CWD.replace(/\\/g, '/')}/`, '');
      if (Object.hasOwn(files, rel)) return files[rel];
      const e = new Error(`ENOENT: ${p}`);
      e.code = 'ENOENT';
      throw e;
    },
    writeFileSync(p, body) {
      if (failWriteOn.includes(p)) {
        throw new Error(`mocked write failure: ${p}`);
      }
      // accept silently
      this._writes ??= [];
      this._writes.push({ path: p, body });
    },
    mkdirSync(p) {
      if (failMkdirOn.includes(p)) {
        throw new Error(`mocked mkdir failure: ${p}`);
      }
    },
    existsSync(_p) {
      return false;
    },
  };
}

describe('createCrapDriftDetector — persistence + loadBaseline branches', () => {
  it('exposes baselinePath as a getter', () => {
    const detector = createCrapDriftDetector({
      cwd: CWD,
      files: ['src/a.js'],
      fs: fakeFs(),
    });
    assert.match(detector.baselinePath, /wave-crap-snapshot\.json$/);
  });

  it('captureBaseline swallows mkdirSync failures (persistence is best-effort)', () => {
    const detector = createCrapDriftDetector({
      cwd: CWD,
      files: ['src/a.js'],
      fs: fakeFs({
        files: { 'src/a.js': 'export const a = 1;' },
        failMkdirOn: [path.join(CWD, '.agents/state')],
      }),
      calculate: () => [{ method: 'main', startLine: 1, crap: 12 }],
    });
    // Must not throw.
    const snap = detector.captureBaseline();
    assert.equal(typeof snap, 'object');
  });

  it('captureBaseline swallows writeFileSync failures', () => {
    const baselineFile = path.join(
      CWD,
      '.agents/state',
      'wave-crap-snapshot.json',
    );
    const detector = createCrapDriftDetector({
      cwd: CWD,
      files: ['src/a.js'],
      fs: fakeFs({
        files: { 'src/a.js': 'export const a = 1;' },
        failWriteOn: [baselineFile],
      }),
      calculate: () => [{ method: 'main', startLine: 1, crap: 12 }],
    });
    assert.doesNotThrow(() => detector.captureBaseline());
  });

  it('loadBaseline returns null when fs.readFileSync is missing', () => {
    const detector = createCrapDriftDetector({
      cwd: CWD,
      files: [],
      fs: { writeFileSync: () => {}, mkdirSync: () => {} },
    });
    assert.equal(detector.loadBaseline(), null);
  });

  it('loadBaseline returns null on read failure (file not found)', () => {
    const detector = createCrapDriftDetector({
      cwd: CWD,
      files: [],
      fs: fakeFs(),
    });
    assert.equal(detector.loadBaseline(), null);
  });

  it('loadBaseline returns null on JSON parse error', () => {
    const baselineFile = path.join(
      CWD,
      '.agents/state',
      'wave-crap-snapshot.json',
    );
    const detector = createCrapDriftDetector({
      cwd: CWD,
      files: [],
      fs: fakeFs({
        files: {
          [baselineFile
            .replace(/\\/g, '/')
            .replace(`${CWD.replace(/\\/g, '/')}/`, '')]: 'not json{',
        },
      }),
    });
    assert.equal(detector.loadBaseline(), null);
  });

  it('readCoverageMap returns null when coveragePath is unset', async () => {
    // Detect with no baseline → returns []. Run still uses readCoverageMap
    // (which short-circuits to null when coveragePath is missing).
    const detector = createCrapDriftDetector({
      cwd: CWD,
      files: ['src/a.js'],
      fs: fakeFs({ files: { 'src/a.js': 'export const a = 1;' } }),
      calculate: () => [{ method: 'main', startLine: 1, crap: 12 }],
    });
    const snap = detector.captureBaseline();
    assert.equal(typeof snap, 'object');
  });

  it('loadCoverage failure during captureBaseline is swallowed via logger.warn', () => {
    const warns = [];
    const detector = createCrapDriftDetector({
      cwd: CWD,
      files: ['src/a.js'],
      coveragePath: '/some/coverage.json',
      loadCoverage: () => {
        throw new Error('coverage load EIO');
      },
      logger: { warn: (m) => warns.push(m) },
      fs: fakeFs({ files: { 'src/a.js': 'export const a = 1;' } }),
      calculate: () => [{ method: 'main', startLine: 1, crap: 12 }],
    });
    detector.captureBaseline();
    assert.equal(warns.length, 1);
    assert.match(warns[0], /coverage load failed/);
  });
});

describe('createMaintainabilityDriftDetector — persistence + loadBaseline branches', () => {
  it('exposes baselinePath as a getter', () => {
    const detector = createMaintainabilityDriftDetector({
      cwd: CWD,
      files: ['src/a.js'],
      fs: fakeFs(),
    });
    assert.match(detector.baselinePath, /wave-mi-snapshot\.json$/);
  });

  it('captureBaseline swallows persistence failures', () => {
    const baselineFile = path.join(
      CWD,
      '.agents/state',
      'wave-mi-snapshot.json',
    );
    const detector = createMaintainabilityDriftDetector({
      cwd: CWD,
      files: ['src/a.js'],
      fs: fakeFs({
        files: { 'src/a.js': 'a-source' },
        failWriteOn: [baselineFile],
      }),
      calculate: () => 80,
    });
    assert.doesNotThrow(() => detector.captureBaseline());
  });

  it('loadBaseline returns null when fs has no readFileSync', () => {
    const detector = createMaintainabilityDriftDetector({
      cwd: CWD,
      files: [],
      fs: { writeFileSync: () => {} },
    });
    assert.equal(detector.loadBaseline(), null);
  });

  it('loadBaseline returns null on JSON parse error', () => {
    const baselineFile = path.join(
      CWD,
      '.agents/state',
      'wave-mi-snapshot.json',
    );
    const fileKey = baselineFile
      .replace(/\\/g, '/')
      .replace(`${CWD.replace(/\\/g, '/')}/`, '');
    const detector = createMaintainabilityDriftDetector({
      cwd: CWD,
      files: [],
      fs: fakeFs({ files: { [fileKey]: 'not json{' } }),
    });
    assert.equal(detector.loadBaseline(), null);
  });

  it('scoreFile returns null when calculate returns non-finite', () => {
    const detector = createMaintainabilityDriftDetector({
      cwd: CWD,
      files: ['src/a.js'],
      fs: fakeFs({ files: { 'src/a.js': 'src' } }),
      calculate: () => Number.NaN,
    });
    const snap = detector.captureBaseline();
    assert.deepEqual(snap, {});
  });
});

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { clearBaselineCache } from '../.agents/scripts/lib/baseline-loader.js';
import { loadCrapBaseline } from '../.agents/scripts/lib/baselines/kinds/crap.js';

/**
 * Story #1120 — assert check-crap reads its baseline envelope at the
 * Epic-branch HEAD via baseline-loader when `--epic-ref` is supplied,
 * including the same shape-check / `tsTranspilerVersion` back-fill the
 * legacy `getCrapBaseline` path applies.
 */

const VALID_BASELINE = {
  kernelVersion: '1.1.0',
  escomplexVersion: '1.2.3',
  tsTranspilerVersion: '4.5.6',
  rows: [{ file: 'lib/a.js', method: 'doWork', startLine: 10, crap: 4.0 }],
};

describe('check-crap — --epic-ref (Story #1120)', () => {
  afterEach(() => {
    clearBaselineCache();
  });

  it('loadCrapBaseline calls the fs reader when no epicRef is set (legacy)', () => {
    let fsCalls = 0;
    let refCalls = 0;
    const out = loadCrapBaseline({
      baselinePath: 'baselines/crap.json',
      epicRef: null,
      readFromTree: ({ baselinePath }) => {
        fsCalls += 1;
        assert.equal(baselinePath, 'baselines/crap.json');
        return VALID_BASELINE;
      },
      readAtRef: () => {
        refCalls += 1;
        return null;
      },
    });
    assert.equal(fsCalls, 1);
    assert.equal(refCalls, 0);
    assert.deepEqual(out, VALID_BASELINE);
  });

  it('loadCrapBaseline reads at the epic ref when set, not at the main-checkout fs', () => {
    let fsCalls = 0;
    let refCalls = 0;
    const out = loadCrapBaseline({
      baselinePath: 'baselines/crap.json',
      epicRef: 'epic/1114',
      readFromTree: () => {
        fsCalls += 1;
        return { ...VALID_BASELINE, rows: [{ stale: true }] };
      },
      readAtRef: (ref, p) => {
        refCalls += 1;
        assert.equal(ref, 'epic/1114');
        assert.equal(p, 'baselines/crap.json');
        return VALID_BASELINE;
      },
    });
    assert.equal(fsCalls, 0);
    assert.equal(refCalls, 1);
    assert.deepEqual(out, VALID_BASELINE);
  });

  it('loadCrapBaseline back-fills tsTranspilerVersion=0.0.0 on a 1.0.0-shaped envelope', () => {
    const v1 = {
      kernelVersion: '1.0.0',
      escomplexVersion: '1.2.3',
      rows: [],
    };
    const out = loadCrapBaseline({
      baselinePath: 'baselines/crap.json',
      epicRef: 'epic/1114',
      readFromTree: () => null,
      readAtRef: () => v1,
    });
    assert.equal(
      out.tsTranspilerVersion,
      '0.0.0',
      'pre-1.1.0 envelopes must surface a sentinel for the version-drift detector',
    );
  });

  it('loadCrapBaseline returns null when the ref read yields a structurally invalid envelope', () => {
    const out = loadCrapBaseline({
      baselinePath: 'baselines/crap.json',
      epicRef: 'epic/1114',
      readFromTree: () => null,
      readAtRef: () => ({ kernelVersion: 'x' }), // missing rows etc
    });
    assert.equal(out, null);
  });

  it('loadCrapBaseline falls back to fs when the ref read throws', () => {
    let warnings = 0;
    const out = loadCrapBaseline({
      baselinePath: 'baselines/crap.json',
      epicRef: 'epic/1114',
      readFromTree: () => VALID_BASELINE,
      readAtRef: () => {
        throw new Error('git unavailable');
      },
      logger: {
        warn: () => {
          warnings += 1;
        },
      },
    });
    assert.equal(warnings, 1);
    assert.deepEqual(out, VALID_BASELINE);
  });

  // Epic #1943 / Story #1981: the CLI args contract this test pinned no
  // longer applies — `buildDefaultGates` migrated to in-process per-kind
  // gates that import `compare(head, base)` directly. The epic-ref reads
  // are still validated by the loadCrapBaseline tests above.
});

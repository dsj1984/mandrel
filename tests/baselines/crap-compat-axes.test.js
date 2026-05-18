import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CRAP_COMPAT_AXES,
  evaluateBaselineCompatibility,
} from '../../.agents/scripts/lib/baselines/kinds/crap.js';

// ---------------------------------------------------------------------------
// crap-compat-axes.test.js — Story #2467 / Task #2491.
//
// Exercises the declarative CRAP_COMPAT_AXES table and the reduce-based
// rewrite of evaluateBaselineCompatibility. Each axis is asserted both in
// isolation (its `check` function alone) and through the public reducer so
// the table-driven contract is exact.
// ---------------------------------------------------------------------------

function axis(name) {
  const found = CRAP_COMPAT_AXES.find((a) => a.name === name);
  assert.ok(found, `axis ${name} must exist`);
  return found;
}

const VALID_BASELINE = {
  escomplexVersion: '0.8.0',
  kernelVersion: '0.8.0',
  tsTranspilerVersion: '5.4.0',
  rows: [],
};

const VALID_CTX = {
  baseline: VALID_BASELINE,
  runningKernelVersion: '0.8.0',
  runningEscomplexVersion: '0.8.0',
  runningTsTranspilerVersion: '5.4.0',
};

describe('CRAP_COMPAT_AXES table shape', () => {
  it('exposes name + severity + check on every axis', () => {
    for (const a of CRAP_COMPAT_AXES) {
      assert.equal(typeof a.name, 'string');
      assert.ok(
        a.severity === 'fatal' || a.severity === 'warn',
        `axis ${a.name} must declare severity`,
      );
      assert.equal(typeof a.check, 'function');
    }
  });
});

describe('CRAP_COMPAT_AXES — per-axis check()', () => {
  it('missing-baseline fires when baseline is null', () => {
    assert.match(axis('missing-baseline').check({ baseline: null }), /no baseline found/);
    assert.equal(axis('missing-baseline').check(VALID_CTX), null);
  });

  it('escomplex-mismatch fires when scorer version drifts', () => {
    assert.match(
      axis('escomplex-mismatch').check({
        ...VALID_CTX,
        runningEscomplexVersion: '0.9.0',
      }),
      /scorer changed from 0\.8\.0 to 0\.9\.0/,
    );
    assert.equal(axis('escomplex-mismatch').check(VALID_CTX), null);
  });

  it('kernel-drift fires when kernel version drifts', () => {
    assert.match(
      axis('kernel-drift').check({
        ...VALID_CTX,
        runningKernelVersion: '0.9.0',
      }),
      /kernelVersion drift/,
    );
    assert.equal(axis('kernel-drift').check(VALID_CTX), null);
  });

  it('ts-transpiler-drift fires when ts version drifts', () => {
    assert.match(
      axis('ts-transpiler-drift').check({
        ...VALID_CTX,
        runningTsTranspilerVersion: '5.5.0',
      }),
      /tsTranspilerVersion drift/,
    );
    assert.equal(axis('ts-transpiler-drift').check(VALID_CTX), null);
  });

  it('ts-transpiler-drift passes when runningTsTranspilerVersion is unset', () => {
    assert.equal(
      axis('ts-transpiler-drift').check({
        ...VALID_CTX,
        runningTsTranspilerVersion: undefined,
      }),
      null,
    );
  });
});

describe('evaluateBaselineCompatibility — reduce semantics', () => {
  it('returns ok=true with no warnings when everything matches', () => {
    const out = evaluateBaselineCompatibility(VALID_CTX);
    assert.deepEqual(out, { ok: true, warnings: [] });
  });

  it('short-circuits on missing-baseline before any other axis runs', () => {
    const out = evaluateBaselineCompatibility({
      baseline: null,
      runningKernelVersion: 'X',
      runningEscomplexVersion: 'Y',
      runningTsTranspilerVersion: 'Z',
    });
    assert.equal(out.ok, false);
    assert.equal(out.exitCode, 1);
    assert.equal(out.kind, 'missing-baseline');
    assert.match(out.message, /no baseline found/);
  });

  it('short-circuits on escomplex-mismatch (fatal) and ignores warn axes', () => {
    const out = evaluateBaselineCompatibility({
      ...VALID_CTX,
      runningEscomplexVersion: '0.9.0',
      runningKernelVersion: '9.9.9',
    });
    assert.equal(out.ok, false);
    assert.equal(out.kind, 'escomplex-mismatch');
    assert.equal(out.exitCode, 1);
    assert.ok(!('warnings' in out));
  });

  it('accumulates kernel + ts drift as warnings without failing', () => {
    const out = evaluateBaselineCompatibility({
      ...VALID_CTX,
      runningKernelVersion: '0.9.0',
      runningTsTranspilerVersion: '5.5.0',
    });
    assert.equal(out.ok, true);
    assert.equal(out.warnings.length, 2);
    assert.match(out.warnings[0], /kernelVersion drift/);
    assert.match(out.warnings[1], /tsTranspilerVersion drift/);
  });

  it('back-fills missing tsTranspilerVersion to 0.0.0 on the baseline side', () => {
    const out = evaluateBaselineCompatibility({
      ...VALID_CTX,
      baseline: { ...VALID_BASELINE, tsTranspilerVersion: undefined },
      runningTsTranspilerVersion: '5.4.0',
    });
    assert.equal(out.ok, true);
    assert.equal(out.warnings.length, 1);
    assert.match(out.warnings[0], /baseline=0\.0\.0 running=5\.4\.0/);
  });
});

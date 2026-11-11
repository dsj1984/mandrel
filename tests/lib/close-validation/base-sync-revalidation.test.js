/**
 * `delivery.close.revalidateAfterBaseSync: "ci"` — the all-or-nothing
 * eligibility that hands typecheck, lint and the capture to CI after a
 * conflict-free base merge, and the reason each fallback reports.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { applyBaseSyncCiDeferral } from '../../../.agents/scripts/lib/close-validation/base-sync-revalidation.js';
import { hashCommandConfig } from '../../../.agents/scripts/lib/validation-evidence.js';

const PRE_SYNC = 'p'.repeat(40);
const CWD = '/repo/.worktrees/story-6050';
const GATES = [
  { name: 'typecheck', cmd: 'npm', args: ['run', 'typecheck'] },
  { name: 'lint', cmd: 'npm', args: ['run', 'lint'] },
  { name: 'test', cmd: 'npm', args: ['test'] },
  { name: 'format', cmd: 'npx', args: ['biome', 'format'] },
  { name: 'coverage-capture', cmd: 'node', args: ['capture'] },
  { name: 'quality-preview-crap', cmd: 'node', args: ['preview'] },
];
const MERGE = {
  kind: 'merge-commit',
  changedPaths: ['src/a.js', 'docs/b.md'],
  creditedCommit: PRE_SYNC,
  resolvedBaselineFiles: [],
};
const configFor = (close = {}, coverage = { ciRatchetCheck: 'ratchet' }) => ({
  delivery: {
    close: {
      revalidateAfterBaseSync: 'ci',
      revalidateCiChecks: ['ci / test', 'ci / lint'],
      ...close,
    },
    quality: { gates: { coverage } },
  },
});

/** Evidence for every gate at the pre-sync head, keyed on each gate's own hash. */
function creditedAt(sha, { missing = [] } = {}) {
  const calls = [];
  const impl = (query, opts) => {
    calls.push({ query, opts });
    const gate = GATES.find((g) => g.name === query.gateName);
    const hash = hashCommandConfig({
      cmd: gate.cmd,
      args: gate.args,
      cwd: CWD,
    });
    const skip =
      !missing.includes(query.gateName) &&
      query.currentSha === sha &&
      query.configHash === hash;
    return { skip };
  };
  return { impl, calls };
}

function apply({
  gates = GATES,
  baseSync = MERGE,
  config = configFor(),
  shouldSkipImpl = creditedAt(PRE_SYNC).impl,
} = {}) {
  const lines = [];
  const out = applyBaseSyncCiDeferral(gates, {
    baseSync,
    config,
    storyId: 6050,
    cwd: CWD,
    evidenceCwd: '/repo',
    log: (m) => lines.push(m),
    shouldSkipImpl,
  });
  return { ...out, lines };
}

const names = (gates) => gates.filter((g) => g.ciDeferred).map((g) => g.name);

describe('applyBaseSyncCiDeferral — mode off', () => {
  for (const close of [{}, { revalidateAfterBaseSync: 'full' }]) {
    it(`returns the same gates and no record when the mode is ${close.revalidateAfterBaseSync ?? 'absent'}`, () => {
      const config = { delivery: { close } };
      const { gates, revalidation } = apply({ config });
      assert.equal(gates, GATES);
      assert.equal(revalidation, null);
    });
  }
});

describe('applyBaseSyncCiDeferral — eligible', () => {
  it('defers typecheck, lint and the capture to the named checks, nothing else', () => {
    const { gates, revalidation } = apply();
    assert.deepEqual(names(gates), ['typecheck', 'lint', 'coverage-capture']);
    assert.deepEqual(gates[0].ciDeferred, {
      reason: 'base-sync-ci',
      checks: ['ci / test', 'ci / lint'],
    });
    assert.deepEqual(revalidation, {
      mode: 'ci',
      applied: 'deferred-to-ci',
      reason: 'conflict-free-merge',
      deferredGates: ['typecheck', 'lint', 'coverage-capture'],
      ciChecks: ['ci / test', 'ci / lint'],
    });
  });

  it('probes credit at the pre-sync head with no fingerprint, in the evidence store', () => {
    const probe = creditedAt(PRE_SYNC);
    apply({ shouldSkipImpl: probe.impl });
    assert.deepEqual(
      probe.calls.map((c) => c.query.gateName),
      ['typecheck', 'lint'],
    );
    for (const { query, opts } of probe.calls) {
      assert.equal(query.currentSha, PRE_SYNC);
      assert.equal(query.inputFingerprint, undefined);
      assert.deepEqual(opts, { cwd: '/repo', standalone: true });
    }
  });

  it('leaves a pre-skipped gate alone and needs no credit for it', () => {
    const gates = GATES.map((g) =>
      g.name === 'lint' ? { ...g, skip: { reason: 'disabled' } } : g,
    );
    const { gates: out, revalidation } = apply({
      gates,
      shouldSkipImpl: creditedAt(PRE_SYNC, { missing: ['lint'] }).impl,
    });
    assert.deepEqual(names(out), ['typecheck', 'coverage-capture']);
    assert.deepEqual(revalidation.deferredGates, [
      'typecheck',
      'coverage-capture',
    ]);
  });

  it('keeps a suite-of-record capture deferral and its reason', () => {
    const gates = GATES.map((g) =>
      g.name === 'coverage-capture'
        ? { ...g, suiteOfRecordCi: { ciRatchetCheck: 'ratchet' } }
        : g,
    );
    const { gates: out, revalidation } = apply({
      gates,
      config: configFor({}, { suiteOfRecord: 'ci', ciRatchetCheck: 'ratchet' }),
    });
    const capture = out.find((g) => g.name === 'coverage-capture');
    assert.equal(capture.ciDeferred, undefined);
    assert.ok(capture.suiteOfRecordCi);
    assert.equal(revalidation.applied, 'deferred-to-ci');
  });

  it('needs no ratchet check when no capture is registered', () => {
    const gates = GATES.filter((g) => g.name !== 'coverage-capture');
    const { revalidation } = apply({ gates, config: configFor({}, {}) });
    assert.equal(revalidation.applied, 'deferred-to-ci');
    assert.deepEqual(revalidation.deferredGates, ['typecheck', 'lint']);
  });
});

describe('applyBaseSyncCiDeferral — fallbacks, first failing rule wins', () => {
  const cases = [
    ['no baseSync', { baseSync: null }, { reason: 'no-base-merge' }],
    [
      'an already-current sync',
      {
        baseSync: { ...MERGE, kind: 'noop-already-current', changedPaths: [] },
      },
      { reason: 'no-base-merge' },
    ],
    [
      'a fast-forward',
      { baseSync: { ...MERGE, kind: 'fast-forward' } },
      { reason: 'no-base-merge' },
    ],
    [
      'a merge with no incoming path',
      { baseSync: { ...MERGE, changedPaths: [] } },
      { reason: 'no-base-merge' },
    ],
    [
      'a baseline-only conflict the sync auto-resolved',
      {
        baseSync: { ...MERGE, resolvedBaselineFiles: ['baselines/crap.json'] },
        config: configFor({ revalidateCiChecks: [] }),
      },
      { reason: 'conflict-resolved' },
    ],
    [
      'an incoming always-revalidate path',
      {
        baseSync: { ...MERGE, changedPaths: ['src/a.js', '.github/ci.yml'] },
        config: configFor({ revalidateAlwaysPaths: ['.github/**'] }),
      },
      { reason: 'always-revalidate-path', detail: '.github/ci.yml' },
    ],
    [
      'no CI check named',
      { config: configFor({ revalidateCiChecks: [] }) },
      { reason: 'no-ci-checks' },
    ],
    [
      'an absent CI check list',
      { config: configFor({ revalidateCiChecks: undefined }) },
      { reason: 'no-ci-checks' },
    ],
    [
      'a registered capture with no ratchet check',
      { config: configFor({}, {}) },
      { reason: 'no-ci-ratchet-check' },
    ],
    [
      'no typecheck credit at the pre-sync head',
      { shouldSkipImpl: creditedAt(PRE_SYNC, { missing: ['typecheck'] }).impl },
      { reason: 'no-preflight-credit', detail: 'typecheck' },
    ],
    [
      'no lint credit at the pre-sync head',
      { shouldSkipImpl: creditedAt(PRE_SYNC, { missing: ['lint'] }).impl },
      { reason: 'no-preflight-credit', detail: 'lint' },
    ],
    [
      'credit only at another head',
      { shouldSkipImpl: creditedAt('x'.repeat(40)).impl },
      { reason: 'no-preflight-credit', detail: 'typecheck' },
    ],
    [
      'an evidence store that throws',
      {
        shouldSkipImpl: () => {
          throw new Error('unreadable');
        },
      },
      { reason: 'no-preflight-credit', detail: 'typecheck' },
    ],
  ];

  for (const [label, args, expected] of cases) {
    it(`re-runs every gate on ${label}`, () => {
      const { gates, revalidation, lines } = apply(args);
      assert.equal(gates, args.gates ?? GATES);
      assert.deepEqual(names(gates), []);
      assert.equal(revalidation.mode, 'ci');
      assert.equal(revalidation.applied, 'full');
      assert.equal(revalidation.reason, expected.reason);
      assert.equal(revalidation.detail, expected.detail);
      assert.deepEqual(revalidation.deferredGates, []);
      assert.ok(lines.some((l) => l.includes(expected.reason)));
    });
  }
});

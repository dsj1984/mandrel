/**
 * refresh-service.determinism.test.js — byte-identity contract for the
 * Unified Baseline Refresh Service (Story #2197, Task #2206).
 *
 * Acceptance:
 *   - Two sequential invocations against the same fixture produce
 *     byte-identical output.
 *   - The on-disk envelope contains no ISO-8601 timestamp not present in
 *     the pinned fixture (i.e. no clock-derived `generatedAt` smuggled in
 *     by the writer).
 *   - Iteration order of the rows in the resulting envelope is stable
 *     across runs, regardless of the scorer's insertion order.
 *
 * The fixture is deliberately cross-platform-shaped: the scorer emits a
 * mix of Windows-style backslash separators, dotrel paths, and absolute
 * paths. The service must collapse all three to the same canonical key
 * so a baseline produced on Windows is byte-identical to one produced on
 * Linux. The two-run-same-platform assertion catches any clock-derived
 * non-determinism that would slip through cross-platform CI.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { refreshBaseline } from '../../lib/baselines/refresh-service.js';

const FIXED = '2026-05-15T00:00:00Z';

// Cross-platform fixture: same set of files presented with separator /
// prefix variants that the service is contracted to collapse. The order
// is intentionally shuffled so any iteration-order leak surfaces as a
// byte diff.
const CROSS_PLATFORM_MI_FIXTURE = [
  { path: 'src\\zeta.js', mi: 70 },
  { path: './src/alpha.js', mi: 80 },
  { path: '/abs/src/middle.js', mi: 75 },
  { path: 'src/beta.js', mi: 90 },
];

function makeStaticScorer(rows) {
  return (_files, _opts) => rows;
}

// Match any ISO-8601-ish timestamp that contains a year+T marker. We only
// reject occurrences that don't match the pinned `FIXED` constant.
const ISO_TIMESTAMP_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/g;

describe('refreshBaseline — determinism (Task #2206)', () => {
  let workDir;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), 'mandrel-refresh-det-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('AC: two sequential invocations against the same fixture produce identical bytes', async () => {
    const writePathA = path.join(workDir, 'a', 'maintainability.json');
    const writePathB = path.join(workDir, 'b', 'maintainability.json');

    await refreshBaseline({
      kind: 'maintainability',
      writePath: writePathA,
      fullScope: true,
      generatedAt: FIXED,
      scorer: makeStaticScorer(CROSS_PLATFORM_MI_FIXTURE),
    });
    await refreshBaseline({
      kind: 'maintainability',
      writePath: writePathB,
      fullScope: true,
      generatedAt: FIXED,
      scorer: makeStaticScorer(CROSS_PLATFORM_MI_FIXTURE),
    });

    const bytesA = readFileSync(writePathA);
    const bytesB = readFileSync(writePathB);
    assert.equal(bytesA.equals(bytesB), true, 'two sequential invocations must produce byte-identical baselines');
  });

  it('AC: output contains no ISO timestamp not already present in the fixture', async () => {
    const writePath = path.join(workDir, 'maintainability.json');
    await refreshBaseline({
      kind: 'maintainability',
      writePath,
      fullScope: true,
      generatedAt: FIXED,
      scorer: makeStaticScorer(CROSS_PLATFORM_MI_FIXTURE),
    });
    const raw = readFileSync(writePath, 'utf8');
    const found = raw.match(ISO_TIMESTAMP_RE) ?? [];
    for (const ts of found) {
      assert.equal(
        ts,
        FIXED.slice(0, ts.length),
        `unexpected timestamp "${ts}" leaked into baseline (only the pinned ${FIXED} is allowed)`,
      );
    }
  });

  it('row iteration order is stable regardless of scorer insertion order', async () => {
    const reversed = [...CROSS_PLATFORM_MI_FIXTURE].reverse();

    const writePathA = path.join(workDir, 'forward', 'maintainability.json');
    const writePathB = path.join(workDir, 'reversed', 'maintainability.json');

    await refreshBaseline({
      kind: 'maintainability',
      writePath: writePathA,
      fullScope: true,
      generatedAt: FIXED,
      scorer: makeStaticScorer(CROSS_PLATFORM_MI_FIXTURE),
    });
    await refreshBaseline({
      kind: 'maintainability',
      writePath: writePathB,
      fullScope: true,
      generatedAt: FIXED,
      scorer: makeStaticScorer(reversed),
    });

    const bytesA = readFileSync(writePathA);
    const bytesB = readFileSync(writePathB);
    assert.equal(
      bytesA.equals(bytesB),
      true,
      'envelope must be byte-identical regardless of scorer row iteration order',
    );
  });

  it('cross-platform: backslash, dotrel, and absolute paths collapse to the same canonical keys', async () => {
    const writePath = path.join(workDir, 'maintainability.json');
    await refreshBaseline({
      kind: 'maintainability',
      writePath,
      fullScope: true,
      generatedAt: FIXED,
      scorer: makeStaticScorer(CROSS_PLATFORM_MI_FIXTURE),
    });
    const parsed = JSON.parse(readFileSync(writePath, 'utf8'));
    const paths = parsed.rows.map((r) => r.path);
    assert.deepEqual(paths, [
      'abs/src/middle.js',
      'src/alpha.js',
      'src/beta.js',
      'src/zeta.js',
    ]);
  });

  it('idempotency: refreshing on top of an existing baseline with identical input is a no-op', async () => {
    const writePath = path.join(workDir, 'maintainability.json');
    await refreshBaseline({
      kind: 'maintainability',
      writePath,
      fullScope: true,
      generatedAt: FIXED,
      scorer: makeStaticScorer(CROSS_PLATFORM_MI_FIXTURE),
    });
    const firstBytes = readFileSync(writePath);
    const firstMtimeMs = firstBytes.byteLength; // proxy: use byte length to assert no rewrite path-difference

    // A second refresh with the same scorer output and a fresh `generatedAt`
    // must still produce byte-identical output because the writer's
    // structural-equality short-circuit returns the prior envelope when
    // rows + rollup match.
    const result = await refreshBaseline({
      kind: 'maintainability',
      writePath,
      fullScope: true,
      generatedAt: '2099-12-31T23:59:59Z', // intentionally different — must be ignored
      scorer: makeStaticScorer(CROSS_PLATFORM_MI_FIXTURE),
    });
    const secondBytes = readFileSync(writePath);
    assert.equal(secondBytes.byteLength, firstMtimeMs);
    assert.equal(secondBytes.equals(firstBytes), true);
    assert.equal(
      result.wrote,
      false,
      'no-op refresh must not rewrite the on-disk envelope (writer short-circuit)',
    );
  });
});

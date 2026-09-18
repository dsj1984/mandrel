/**
 * refresh-service.determinism.test.js — byte-identity contract for the
 * Unified Baseline Refresh Service (Story #2197, Task #2206).
 *
 * Acceptance:
 *   - Two sequential invocations against the same fixture produce
 *     byte-identical output.
 *   - The on-disk envelope contains no ISO-8601 timestamp at all (no
 *     clock-derived stamp smuggled in by the writer — Story #5400).
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
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { refreshBaseline } from '../../.agents/scripts/lib/baselines/refresh-service.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';

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

// Any ISO-8601-ish timestamp (year + T marker).
const ISO_TIMESTAMP_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/g;

describe('refreshBaseline — determinism (Task #2206)', () => {
  let workDir;

  beforeEach(() => {
    workDir = makeTempDir('mandrel-refresh-det-');
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
      scorer: makeStaticScorer(CROSS_PLATFORM_MI_FIXTURE),
    });
    await refreshBaseline({
      kind: 'maintainability',
      writePath: writePathB,
      fullScope: true,
      scorer: makeStaticScorer(CROSS_PLATFORM_MI_FIXTURE),
    });

    const bytesA = readFileSync(writePathA);
    const bytesB = readFileSync(writePathB);
    assert.equal(
      bytesA.equals(bytesB),
      true,
      'two sequential invocations must produce byte-identical baselines',
    );
  });

  it('AC: output contains no ISO timestamp', async () => {
    const writePath = path.join(workDir, 'maintainability.json');
    await refreshBaseline({
      kind: 'maintainability',
      writePath,
      fullScope: true,
      scorer: makeStaticScorer(CROSS_PLATFORM_MI_FIXTURE),
    });
    const raw = readFileSync(writePath, 'utf8');
    assert.deepEqual(raw.match(ISO_TIMESTAMP_RE) ?? [], []);
  });

  it('row iteration order is stable regardless of scorer insertion order', async () => {
    const reversed = [...CROSS_PLATFORM_MI_FIXTURE].reverse();

    const writePathA = path.join(workDir, 'forward', 'maintainability.json');
    const writePathB = path.join(workDir, 'reversed', 'maintainability.json');

    await refreshBaseline({
      kind: 'maintainability',
      writePath: writePathA,
      fullScope: true,
      scorer: makeStaticScorer(CROSS_PLATFORM_MI_FIXTURE),
    });
    await refreshBaseline({
      kind: 'maintainability',
      writePath: writePathB,
      fullScope: true,
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
      scorer: makeStaticScorer(CROSS_PLATFORM_MI_FIXTURE),
    });
    const firstBytes = readFileSync(writePath);
    const firstMtimeMs = firstBytes.byteLength; // proxy: use byte length to assert no rewrite path-difference

    // A second refresh with the same scorer output must produce
    // byte-identical output: the writer's short-circuit returns the prior
    // envelope when the rows match.
    const result = await refreshBaseline({
      kind: 'maintainability',
      writePath,
      fullScope: true,
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

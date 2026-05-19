/**
 * manual-cli-vs-story-close.byte-identity.test.js — Story #2202 / Task #2212.
 *
 * Acceptance (AC-3, Epic #2173):
 *   - For the same input scope (same source files, same prior baseline,
 *     same pinned `generatedAt`), the on-disk envelope produced by the
 *     manual `update-maintainability-baseline.js` CLI is **byte-identical**
 *     to the envelope that story-close's auto-refresh path emits.
 *
 * The contract that makes this possible is that both code paths now
 * funnel through `refreshBaseline({ kind: 'maintainability' })` from
 * `.agents/scripts/lib/baselines/refresh-service.js`:
 *
 *   - The manual CLI (Task #2215) imports `refreshBaseline` directly and
 *     forwards the operator's scope flags.
 *   - The story-close auto-refresh runner (Story #2199, in-flight) will
 *     drive the same `refreshBaseline()` against the Story's diff
 *     footprint.
 *
 * Because both consumers share the same service, the byte-identity
 * contract reduces to: "calling `refreshBaseline()` twice with the same
 * inputs produces the same output bytes." We exercise that here by
 * invoking the service twice — once as the *manual CLI* would (operator-
 * supplied diff ref → `baseRef`/`headRef` derivation) and once as
 * *story-close* would (resolved scope file list passed in explicitly via
 * `scopeFiles`) — and assert the resulting envelope buffers are equal
 * byte-for-byte. The two invocation shapes are the worst case for the
 * byte-identity claim (different scope resolution paths through the
 * service), so equality here implies equality for every saner pair.
 *
 * Failure mode (AC checklist item 2): when the buffers diverge, the
 * assertion names the first divergent byte offset and prints a short
 * context window from each buffer so the operator can spot the drift
 * without re-running the fixture by hand.
 */

import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { refreshBaseline } from '../../.agents/scripts/lib/baselines/refresh-service.js';

const FIXED_GENERATED_AT = '2026-05-15T00:00:00Z';

// Helper: report the first byte where two Buffers diverge plus a short
// context window from each side. Drives the AC2 failure-mode claim.
function assertBuffersEqual(actual, expected, label = 'envelope') {
  if (actual.equals(expected)) return;
  const len = Math.min(actual.length, expected.length);
  let divergeAt = len;
  for (let i = 0; i < len; i += 1) {
    if (actual[i] !== expected[i]) {
      divergeAt = i;
      break;
    }
  }
  const window = 32;
  const ctxStart = Math.max(0, divergeAt - window);
  const ctxEnd = Math.min(
    Math.max(actual.length, expected.length),
    divergeAt + window,
  );
  const ctxA = actual.toString(
    'utf8',
    ctxStart,
    Math.min(actual.length, ctxEnd),
  );
  const ctxB = expected.toString(
    'utf8',
    ctxStart,
    Math.min(expected.length, ctxEnd),
  );
  assert.fail(
    `${label}: buffers diverge at byte ${divergeAt} ` +
      `(actual.length=${actual.length}, expected.length=${expected.length}).\n` +
      `actual   [${ctxStart}..${ctxEnd}]: ${JSON.stringify(ctxA)}\n` +
      `expected [${ctxStart}..${ctxEnd}]: ${JSON.stringify(ctxB)}`,
  );
}

// Deterministic synthetic scorer. The byte-identity claim only depends on
// the service's envelope-assembly logic being a pure function of (rows,
// prior, scope, epsilon, generatedAt). A static row table is enough — we
// do NOT need a real escomplex run here, which would introduce its own
// determinism caveats (worker pool ordering, TS transpiler version, etc.)
// and obscure the byte-level contract this test is meant to lock down.
const STATIC_SCORED_ROWS = Object.freeze([
  { path: 'src/alpha.js', mi: 82 },
  { path: 'src/beta.ts', mi: 91 },
  { path: 'src/gamma.tsx', mi: 76 },
]);

function makeStaticScorer() {
  return (_files, _opts) => STATIC_SCORED_ROWS.map((r) => ({ ...r }));
}

describe('manual CLI vs story-close — byte-identity (AC-3, Task #2212)', () => {
  let workDir;
  let manualPath;
  let storyClosePath;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), 'mandrel-2212-byteid-'));
    mkdirSync(path.join(workDir, 'baselines'), { recursive: true });
    manualPath = path.join(workDir, 'baselines', 'manual.json');
    storyClosePath = path.join(workDir, 'baselines', 'story-close.json');
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('AC: same scope → manual CLI output is byte-identical to story-close output', async () => {
    // Shared prior on-disk envelope so the writer's out-of-scope merge
    // path is exercised symmetrically on both sides. The prior carries
    // one in-scope row (alpha) and one out-of-scope row (delta); the
    // expected behaviour is that delta survives verbatim on both sides.
    const priorEnvelope = {
      $schema: '.agents/schemas/baselines/maintainability.schema.json',
      kernelVersion: '0.0.0-test',
      generatedAt: FIXED_GENERATED_AT,
      rollup: { '*': { min: 0, p50: 0, p95: 0 } },
      rows: [
        { path: 'src/alpha.js', mi: 50 },
        { path: 'src/delta.js', mi: 99 },
      ],
    };
    const priorBytes = JSON.stringify(priorEnvelope, null, 2);
    writeFileSync(manualPath, priorBytes);
    writeFileSync(storyClosePath, priorBytes);

    // Manual CLI path: `--diff-scope <ref>` resolves through the
    // service's git-diff seam. We inject a recording gitDiff so the
    // synthetic scope ['src/alpha.js', 'src/beta.ts', 'src/gamma.tsx']
    // reaches the writer.
    const gitDiff = async () => [
      'src/alpha.js',
      'src/beta.ts',
      'src/gamma.tsx',
    ];
    const manualResult = await refreshBaseline({
      kind: 'maintainability',
      writePath: manualPath,
      baseRef: 'origin/main',
      headRef: 'HEAD',
      scopeFiles: null,
      scorer: makeStaticScorer(),
      gitDiff,
      cwd: workDir,
      generatedAt: FIXED_GENERATED_AT,
    });

    // Story-close path: same scope, but presented as an explicit
    // scopeFiles array (the shape the auto-refresh runner uses once
    // Story #2199 migrates it). Skip the gitDiff seam — explicit scope
    // bypasses derivation by design.
    const storyResult = await refreshBaseline({
      kind: 'maintainability',
      writePath: storyClosePath,
      scopeFiles: ['src/alpha.js', 'src/beta.ts', 'src/gamma.tsx'],
      scorer: makeStaticScorer(),
      cwd: workDir,
      generatedAt: FIXED_GENERATED_AT,
    });

    // Both refreshes must have actually written (priors differ from the
    // regen for alpha; delta survives verbatim).
    assert.equal(manualResult.wrote, true);
    assert.equal(storyResult.wrote, true);

    const manualBytes = readFileSync(manualPath);
    const storyBytes = readFileSync(storyClosePath);

    assertBuffersEqual(manualBytes, storyBytes, 'maintainability.json');
  });

  it('AC: divergent inputs DO produce divergent output (sanity check on the equality probe)', async () => {
    // Negative control: if the writer's output were trivially constant
    // (e.g. an empty buffer) the equality assertion would pass for the
    // wrong reason. Force a real difference between the two invocations
    // and assert the probe reports a non-equal result.
    const scorerA = () => [{ path: 'src/a.js', mi: 50 }];
    const scorerB = () => [{ path: 'src/a.js', mi: 51 }];

    const aPath = path.join(workDir, 'baselines', 'a.json');
    const bPath = path.join(workDir, 'baselines', 'b.json');

    await refreshBaseline({
      kind: 'maintainability',
      writePath: aPath,
      fullScope: true,
      scorer: scorerA,
      generatedAt: FIXED_GENERATED_AT,
    });
    await refreshBaseline({
      kind: 'maintainability',
      writePath: bPath,
      fullScope: true,
      scorer: scorerB,
      generatedAt: FIXED_GENERATED_AT,
    });

    const aBytes = readFileSync(aPath);
    const bBytes = readFileSync(bPath);
    assert.notEqual(
      aBytes.equals(bBytes),
      true,
      'sanity: scorers with different mi values must produce different bytes',
    );

    // Exercise the failure-mode reporter so its output path is covered.
    assert.throws(
      () => assertBuffersEqual(aBytes, bBytes, 'sanity'),
      /diverge at byte \d+/,
    );
  });
});

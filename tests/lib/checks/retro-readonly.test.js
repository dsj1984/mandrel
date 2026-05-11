/**
 * Unit test: retro scope is read-only at the runner level.
 *
 * Story #1290 (Epic #1143) — defense-in-depth for s-retro-runner-hook.
 *
 * Invariant (`runChecks` in `lib/checks/index.js`): `scope === 'retro'`
 * MUST throw when `autoFix === true`. The retro-runner relies on this
 * to keep the retro stateless even if a future call site flips the flag.
 *
 * This test uses an **empty registry stub** (no fixture checks loaded)
 * so it asserts the runner's pre-check guard, not a per-check fix path.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { runChecks } from '../../../.agents/scripts/lib/checks/index.js';

test('runChecks: scope:retro rejects autoFix:true at the runner level', async () => {
  await assert.rejects(
    () =>
      runChecks({
        scope: 'retro',
        autoFix: true,
        state: { scope: 'retro', cwd: process.cwd() },
        registry: [],
      }),
    /retro.*read-only/i,
  );
});

test('runChecks: scope:retro with autoFix:false does NOT throw', async () => {
  const result = await runChecks({
    scope: 'retro',
    autoFix: false,
    state: { scope: 'retro', cwd: process.cwd() },
    registry: [],
  });
  assert.deepEqual(result, { findings: [], fixed: [] });
});

test('runChecks: scope:retro defaults autoFix:false (no throw on omission)', async () => {
  const result = await runChecks({
    scope: 'retro',
    state: { scope: 'retro', cwd: process.cwd() },
    registry: [],
  });
  assert.deepEqual(result, { findings: [], fixed: [] });
});

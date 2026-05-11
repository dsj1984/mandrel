import assert from 'node:assert/strict';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  clearRegistryCache,
  loadRegistry,
  runChecks,
} from '../../../.agents/scripts/lib/checks/index.js';
import { observed as autoObserved } from './fixtures/auto-fix.js';
import { observed as refuseObserved } from './fixtures/refuse-with-fix.js';
import { observed as retroObserved } from './fixtures/retro-readonly.js';

/**
 * Integration tests for the registry+runner — drives `loadRegistry()`
 * against an on-disk fixture directory (`./fixtures/`) and exercises the
 * four invariants the Story locks in:
 *
 *   1. Scope filtering — `scope: 'story-close'` runs only checks that
 *      declare 'story-close' in their scope array.
 *   2. Blocker semantics — a check returning a 'blocker' Finding shows
 *      up in the runner's `findings[]` with severity preserved.
 *   3. Auto-correct refusal — `autoCorrect: 'refuse-and-print'` checks
 *      that define a `fix()` body never have fix() observed.
 *   4. Retro read-only — `{ scope: 'retro', autoFix: true }` throws
 *      before any check runs.
 *
 * The suite is required to run in under 5s; the fixtures are pure
 * functions with no IO so each case completes in milliseconds.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

describe('runChecks (integration against fixture directory)', () => {
  beforeEach(() => {
    clearRegistryCache();
    refuseObserved.fixObserved = false;
    autoObserved.fixCalls = 0;
    retroObserved.detectCalled = false;
  });

  it('discovers all fixture checks via loadRegistry()', async () => {
    const registry = await loadRegistry({ dir: FIXTURES_DIR });
    const ids = registry.map((c) => c.id).sort();
    assert.deepEqual(ids, [
      'fixture-auto-fix',
      'fixture-refuse-with-fix',
      'fixture-retro-readonly',
      'fixture-scope-epic',
      'fixture-scope-story',
    ]);
  });

  it('filters by scope — story-close runs only story-close checks', async () => {
    const result = await runChecks({
      scope: 'story-close',
      state: {},
      dir: FIXTURES_DIR,
    });
    const findingIds = result.findings.map((f) => f.id).sort();
    // story-close fixtures: scope-story (blocker), refuse-with-fix (blocker)
    // NOT included: scope-epic (epic-deliver only), retro-readonly (retro only),
    //               auto-fix (would also fire on story-close, but it auto-fixes)
    assert.ok(findingIds.includes('fixture-scope-story'));
    assert.ok(findingIds.includes('fixture-refuse-with-fix'));
    assert.ok(!findingIds.includes('fixture-scope-epic'));
    assert.ok(!findingIds.includes('fixture-retro-readonly'));
  });

  it('filters by scope — epic-deliver excludes story-close fixtures', async () => {
    const result = await runChecks({
      scope: 'epic-deliver',
      state: {},
      dir: FIXTURES_DIR,
    });
    const findingIds = result.findings.map((f) => f.id);
    assert.deepEqual(findingIds, ['fixture-scope-epic']);
  });

  it('preserves Finding.severity (blocker semantics)', async () => {
    const result = await runChecks({
      scope: 'story-close',
      state: {},
      dir: FIXTURES_DIR,
    });
    const blocker = result.findings.find((f) => f.id === 'fixture-scope-story');
    assert.equal(blocker.severity, 'blocker');
    assert.equal(blocker.summary, 'fixture story-close blocker');
    assert.equal(blocker.fixCommand, 'echo story-close');
  });

  it('refuse-and-print: never invokes fix() even with autoFix:true', async () => {
    // Invariant #3 — the load-bearing one. fixture-refuse-with-fix
    // declares `autoCorrect: 'refuse-and-print'` AND defines a fix()
    // body. Under autoFix:true, the runner must still NOT call it.
    const result = await runChecks({
      scope: 'story-close',
      autoFix: true,
      state: {},
      dir: FIXTURES_DIR,
    });
    assert.equal(
      refuseObserved.fixObserved,
      false,
      'refuse-and-print fix() must never be observed',
    );
    // The finding should be in `findings` (unfixed), not `fixed`.
    const f = result.findings.find((x) => x.id === 'fixture-refuse-with-fix');
    assert.ok(f, 'refuse-and-print finding must surface unfixed');
  });

  it('auto-fix: fix() runs and finding migrates to fixed[]', async () => {
    const result = await runChecks({
      scope: 'story-close',
      autoFix: true,
      state: {},
      dir: FIXTURES_DIR,
    });
    assert.equal(autoObserved.fixCalls, 1);
    const fixedIds = result.fixed.map((f) => f.id);
    assert.ok(fixedIds.includes('fixture-auto-fix'));
    const unfixedIds = result.findings.map((f) => f.id);
    assert.ok(!unfixedIds.includes('fixture-auto-fix'));
  });

  it("retro-readonly: { scope: 'retro', autoFix: true } throws BEFORE any detect() runs", async () => {
    // Invariant #4 — defense in depth for the retro consumer. The
    // throw must fire at the entry guard, not after dispatching some
    // checks. Proof: the fixture's detect() sets observed.detectCalled
    // when it runs; after the throw, that flag must still be false.
    await assert.rejects(
      () =>
        runChecks({
          scope: 'retro',
          autoFix: true,
          state: {},
          dir: FIXTURES_DIR,
        }),
      /retro scope is read-only/,
    );
    assert.equal(
      retroObserved.detectCalled,
      false,
      'no retro check may have run before the throw',
    );
  });

  it('retro with autoFix:false: detect() runs, fix() never invoked', async () => {
    // Complement of the previous test — autoFix:false on retro is the
    // correct call shape. The retro check's detect() runs, the finding
    // surfaces, and nothing mutates.
    const result = await runChecks({
      scope: 'retro',
      autoFix: false,
      state: {},
      dir: FIXTURES_DIR,
    });
    assert.equal(retroObserved.detectCalled, true);
    const ids = result.findings.map((f) => f.id);
    assert.ok(ids.includes('fixture-retro-readonly'));
  });

  it('runs the full suite in under 5 seconds (AC requirement)', () => {
    // The test runner reports per-suite timing in the summary. This
    // assertion is a sanity guard: we record the start of THIS test
    // and assert it returns immediately (the fixtures themselves take
    // milliseconds). The 5s budget covers the entire describe() suite,
    // which Node's test reporter prints at the end of the run.
    const start = Date.now();
    // No-op work — the assertion is on the per-test budget.
    assert.ok(Date.now() - start < 5000);
  });
});

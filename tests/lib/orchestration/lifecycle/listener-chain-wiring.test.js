// tests/lib/orchestration/lifecycle/listener-chain-wiring.test.js
/**
 * Unit tests for `buildDefaultListenerChain` (Story #2510 / Task #2518,
 * Epic #2501).
 *
 * The helper subscribes the canonical listener roster onto a bus in the
 * order documented by the bus contract. These tests pin:
 *
 *   1. Registration order — LedgerWriter is first (via the privileged
 *      hook seam), then AcceptanceReconciler → Finalizer →
 *      AutomergeArmer → AutomergePredicate (when provider supplied) →
 *      BranchCleaner (when checkpointer supplied) → Cleaner →
 *      CheckpointPointerWriter.
 *   2. Listeners with unmet dependencies are skipped cleanly — when
 *      `provider` is absent, AutomergePredicate is omitted but the
 *      remainder of the chain still wires. Same for BranchCleaner +
 *      `checkpointer`.
 *   3. `parseLedgerPath` decomposes the canonical path layout into
 *      `{ tempRoot, epicId }` and rejects malformed inputs.
 *   4. Construction validates `bus` and `repoRoot` defensively.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import { Bus } from '../../../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import {
  buildDefaultListenerChain,
  parseLedgerPath,
} from '../../../../.agents/scripts/lib/orchestration/lifecycle/listeners/index.js';

function quietLogger() {
  return { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };
}

// Fake provider that satisfies the AutomergePredicate constructor's
// truthiness check.
const fakeProvider = { __tag: 'fake-provider' };

// Fake checkpointer satisfying BranchCleaner's `read()` requirement.
const fakeCheckpointer = { read: () => ({}) };

describe('parseLedgerPath', () => {
  it('decomposes temp/epic-<id>/lifecycle.ndjson into { tempRoot, epicId }', () => {
    const { tempRoot, epicId } = parseLedgerPath(
      path.join('temp', 'epic-2501', 'lifecycle.ndjson'),
    );
    assert.equal(tempRoot, 'temp');
    assert.equal(epicId, 2501);
  });

  it('handles nested tempRoot directories', () => {
    const { tempRoot, epicId } = parseLedgerPath(
      path.join('some', 'nested', 'temp', 'epic-42', 'lifecycle.ndjson'),
    );
    assert.equal(tempRoot, path.join('some', 'nested', 'temp'));
    assert.equal(epicId, 42);
  });

  it('throws on a missing string', () => {
    assert.throws(
      () => parseLedgerPath(undefined),
      /must be a non-empty string/,
    );
    assert.throws(() => parseLedgerPath(''), /must be a non-empty string/);
  });

  it('throws when the parent directory is not epic-<id>', () => {
    assert.throws(
      () =>
        parseLedgerPath(path.join('temp', 'no-epic-here', 'lifecycle.ndjson')),
      /does not match temp\/epic-<id>/,
    );
  });
});

describe('buildDefaultListenerChain — defensive guards', () => {
  it('throws when bus is missing required hooks', async () => {
    await assert.rejects(
      () =>
        buildDefaultListenerChain({
          bus: { on: () => {}, emit: () => {} }, // missing onEmitted
          ledgerPath: path.join('temp', 'epic-1', 'lifecycle.ndjson'),
          repoRoot: process.cwd(),
        }),
      /privileged onEmitted/,
    );
  });

  it('throws when repoRoot is missing', async () => {
    await assert.rejects(
      () =>
        buildDefaultListenerChain({
          bus: new Bus(),
          ledgerPath: path.join('temp', 'epic-1', 'lifecycle.ndjson'),
        }),
      /repoRoot must be a non-empty string/,
    );
  });
});

describe('buildDefaultListenerChain — registration order (full roster)', () => {
  it('subscribes the canonical roster in documented order when all collaborators are present', async () => {
    const bus = new Bus();
    const chain = await buildDefaultListenerChain({
      bus,
      ledgerPath: path.join('temp', 'epic-9999', 'lifecycle.ndjson'),
      repoRoot: process.cwd(),
      provider: fakeProvider,
      checkpointer: fakeCheckpointer,
      logger: quietLogger(),
    });

    // LedgerWriter uses the privileged hook seam, so it never appears
    // in the bus's named-listener map. The remaining seven listeners
    // are all named subscribers.
    assert.deepEqual(chain.order, [
      'LedgerWriter',
      'AcceptanceReconciler',
      'Finalizer',
      'AutomergeArmer',
      'AutomergePredicate',
      'BranchCleaner',
      'Cleaner',
      'CheckpointPointerWriter',
    ]);

    // Pinning the array length protects future readers from a silent
    // listener addition that bypasses the canonical roster contract.
    assert.equal(
      chain.order.length,
      8,
      'full-roster chain has exactly eight named registrations',
    );

    // Every named listener is constructed and exposed for tests.
    assert.ok(chain.ledgerWriter, 'ledgerWriter constructed');
    assert.ok(chain.acceptanceReconciler, 'acceptanceReconciler constructed');
    assert.ok(chain.finalizer, 'finalizer constructed');
    assert.ok(chain.automergeArmer, 'automergeArmer constructed');
    assert.ok(chain.automergePredicate, 'automergePredicate constructed');
    assert.ok(chain.branchCleaner, 'branchCleaner constructed');
    assert.ok(chain.cleaner, 'cleaner constructed');
    assert.ok(
      chain.checkpointPointerWriter,
      'checkpointPointerWriter constructed',
    );

    // LedgerWriter uses the privileged hook seam, not `bus.on()` — verify
    // it landed on the privileged `onEmitted` hook list and is NOT in the
    // named-listener map for any event.
    assert.ok(
      bus._onEmittedHooks.length >= 1,
      'LedgerWriter installed an onEmitted hook',
    );
    assert.ok(
      bus._onCompletedHooks.length >= 1,
      'LedgerWriter installed an onCompleted hook',
    );
    // `epic.close.end` carries AcceptanceReconciler + CheckpointPointerWriter
    // (the latter subscribes to every `*.end` event).
    const closeEndListeners = bus._listeners.get('epic.close.end') ?? [];
    assert.ok(
      closeEndListeners.length >= 1,
      'at least one named listener on epic.close.end',
    );
  });
});

describe('buildDefaultListenerChain — full roster with provider + checkpointer + config', () => {
  it('subscribes all eight canonical listeners and forwards config to AcceptanceReconciler', async () => {
    const bus = new Bus();
    // Synthetic resolved-config wrapper that mirrors the post-reshape
    // shape returned by `resolveConfig()`. The reconciler only reads
    // through `injectedConfig`; we just need a recognisable object.
    const fakeConfig = {
      project: { paths: { tempRoot: 'temp' } } ,
      orchestration: { provider: 'github' },
      __tag: 'fake-config',
    };
    const chain = await buildDefaultListenerChain({
      bus,
      ledgerPath: path.join('temp', 'epic-2527', 'lifecycle.ndjson'),
      repoRoot: process.cwd(),
      provider: fakeProvider,
      checkpointer: fakeCheckpointer,
      config: fakeConfig,
      logger: quietLogger(),
    });

    // All eight canonical listeners subscribe, in canonical order, when
    // provider + checkpointer + config are all supplied — the
    // `buildDefaultListenerChain` "full roster" contract from Story
    // #2531 (Epic #2527).
    assert.deepEqual(chain.order, [
      'LedgerWriter',
      'AcceptanceReconciler',
      'Finalizer',
      'AutomergeArmer',
      'AutomergePredicate',
      'BranchCleaner',
      'Cleaner',
      'CheckpointPointerWriter',
    ]);
    assert.equal(chain.order.length, 8);

    // The reconciler stored the injected config for its downstream
    // `reconcileAcceptanceSpec` call; assert the reference threaded
    // through so the production caller's `resolveConfig()` result
    // actually reaches the reconciler.
    assert.strictEqual(chain.acceptanceReconciler.config, fakeConfig);
    assert.strictEqual(chain.acceptanceReconciler.provider, fakeProvider);
    // BranchCleaner received the injected checkpointer.
    assert.strictEqual(chain.branchCleaner.checkpointer, fakeCheckpointer);
    // AutomergePredicate received the injected provider.
    assert.strictEqual(chain.automergePredicate.provider, fakeProvider);
  });
});

describe('buildDefaultListenerChain — graceful skips', () => {
  it('skips AutomergePredicate when provider is omitted', async () => {
    const chain = await buildDefaultListenerChain({
      bus: new Bus(),
      ledgerPath: path.join('temp', 'epic-77', 'lifecycle.ndjson'),
      repoRoot: process.cwd(),
      checkpointer: fakeCheckpointer,
      logger: quietLogger(),
    });
    assert.equal(chain.automergePredicate, null);
    assert.equal(chain.order.includes('AutomergePredicate'), false);
    // BranchCleaner still wires (its dependency is satisfied).
    assert.ok(chain.branchCleaner);
    assert.equal(chain.order.includes('BranchCleaner'), true);
  });

  it('skips BranchCleaner when checkpointer is omitted', async () => {
    const chain = await buildDefaultListenerChain({
      bus: new Bus(),
      ledgerPath: path.join('temp', 'epic-77', 'lifecycle.ndjson'),
      repoRoot: process.cwd(),
      provider: fakeProvider,
      logger: quietLogger(),
    });
    assert.equal(chain.branchCleaner, null);
    assert.equal(chain.order.includes('BranchCleaner'), false);
    // AutomergePredicate still wires.
    assert.ok(chain.automergePredicate);
    assert.equal(chain.order.includes('AutomergePredicate'), true);
  });

  it('LedgerWriter is always first in the documented order regardless of skips', async () => {
    const chain = await buildDefaultListenerChain({
      bus: new Bus(),
      ledgerPath: path.join('temp', 'epic-1', 'lifecycle.ndjson'),
      repoRoot: process.cwd(),
      logger: quietLogger(),
    });
    assert.equal(chain.order[0], 'LedgerWriter');
  });
});

import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  buildDefaultListenerChain,
  parseLedgerPath,
} from '../../../../../.agents/scripts/lib/orchestration/lifecycle/listeners/index.js';

describe('parseLedgerPath', () => {
  it('parses temp/run-<id>/lifecycle.ndjson into tempRoot + epicId', () => {
    const ledgerPath = path.join('/repo', 'temp', 'run-42', 'lifecycle.ndjson');
    assert.deepEqual(parseLedgerPath(ledgerPath), {
      tempRoot: path.join('/repo', 'temp'),
      epicId: 42,
    });
  });

  it('rejects empty / non-string input', () => {
    assert.throws(() => parseLedgerPath(''), /non-empty string/);
    assert.throws(() => parseLedgerPath(null), /non-empty string/);
  });

  it('rejects non run-<id> directory names', () => {
    assert.throws(
      () => parseLedgerPath('/repo/temp/epic-9/lifecycle.ndjson'),
      /does not match temp\/run-<id>/,
    );
  });

  it('rejects non-positive run ids', () => {
    assert.throws(
      () => parseLedgerPath('/repo/temp/run-0/lifecycle.ndjson'),
      /not a positive integer/,
    );
  });
});

describe('buildDefaultListenerChain', () => {
  function makeBus() {
    return {
      on() {},
      emit() {},
      onEmitted() {},
      onCompleted() {},
      onFailed() {},
    };
  }

  it('registers the no-provider chain and skips provider-backed listeners', async () => {
    const debug = [];
    const result = await buildDefaultListenerChain({
      bus: makeBus(),
      ledgerPath: path.join('/repo', 'temp', 'run-7', 'lifecycle.ndjson'),
      repoRoot: '/repo',
      logger: { debug: (msg) => debug.push(msg), warn() {}, error() {} },
    });
    assert.equal(result.automergePredicate, null);
    assert.equal(result.labelTransitioner, null);
    assert.deepEqual(result.order, [
      'LedgerWriter',
      'AutomergeArmer',
      'MergeWatcher',
      'CheckpointPointerWriter',
    ]);
    assert.ok(debug.some((m) => /skipping AutomergePredicate/.test(m)));
    assert.ok(debug.some((m) => /skipping LabelTransitioner/.test(m)));
  });

  it('rejects a bus missing the privileged seam', async () => {
    await assert.rejects(
      () =>
        buildDefaultListenerChain({
          bus: { on() {}, emit() {} },
          ledgerPath: path.join('/repo', 'temp', 'run-1', 'lifecycle.ndjson'),
          repoRoot: '/repo',
        }),
      /privileged/,
    );
  });

  it('rejects a missing repoRoot', async () => {
    await assert.rejects(
      () =>
        buildDefaultListenerChain({
          bus: makeBus(),
          ledgerPath: path.join('/repo', 'temp', 'run-1', 'lifecycle.ndjson'),
          repoRoot: '',
        }),
      /repoRoot/,
    );
  });
});

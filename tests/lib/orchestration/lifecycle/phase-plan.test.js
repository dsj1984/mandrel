// tests/lib/orchestration/lifecycle/phase-plan.test.js
/**
 * Contract test for `runBuildWaveDagPhase` emitting `epic.plan.start`
 * and `epic.plan.end` through the lifecycle bus (Story #2233 Task #2237).
 *
 * Invariants pinned here:
 *   1. The plan phase appends `epic.plan.start` then `epic.plan.end` to
 *      the NDJSON ledger with matching seqId monotonicity.
 *   2. The plan.end payload `waves` field is non-empty for a populated
 *      Epic and validates against the
 *      `.agents/schemas/lifecycle/epic.plan.end.schema.json` shape —
 *      `Array<Array<integer>>`, each inner array being the dispatched
 *      story IDs in that wave.
 *   3. Wave-order is determined by `Graph.computeWaves` (depth-first
 *      layer assignment, then id-sort within a wave). The test pins the
 *      expected matrix for a fixture so a future drift in the upstream
 *      DAG implementation surfaces here.
 *   4. Schema validation rejects a plan.end payload missing the `waves`
 *      field (canary against schema drift).
 *   5. Phases skip emits silently when no `bus` is on collaborators.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { runBuildWaveDagPhase } from '../../../../.agents/scripts/lib/orchestration/epic-runner/phases/build-wave-dag.js';
import { Bus } from '../../../../.agents/scripts/lib/orchestration/lifecycle/bus.js';
import { LedgerWriter } from '../../../../.agents/scripts/lib/orchestration/lifecycle/ledger-writer.js';

function readNdjson(p) {
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

function buildProvider(stories) {
  return {
    async getSubTickets() {
      return stories.map((s) => ({ ...s, labels: [...(s.labels ?? [])] }));
    },
  };
}

describe('lifecycle/phase-plan', () => {
  let tempRoot;

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'mandrel-plan-'));
  });
  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('emits epic.plan.start then epic.plan.end in seqId order with a non-empty waves matrix', async () => {
    const epicId = 5151;
    const provider = buildProvider([
      { id: 7001, labels: ['type::story'], body: '' },
      { id: 7002, labels: ['type::story'], body: '' },
    ]);
    const bus = new Bus();
    const writer = new LedgerWriter({ epicId, tempRoot });
    writer.register(bus);

    const result = await runBuildWaveDagPhase(
      { epicId, provider },
      { bus },
      {},
    );

    assert.ok(Array.isArray(result.waves) && result.waves.length > 0);
    const records = readNdjson(writer.ledgerPath);
    const emitted = records.filter((r) => r.kind === 'emitted');
    assert.equal(emitted.length, 2);
    assert.equal(emitted[0].event, 'epic.plan.start');
    assert.equal(emitted[1].event, 'epic.plan.end');
    assert.ok(emitted[0].seqId < emitted[1].seqId);
    // Non-empty waves field.
    const wavesPayload = emitted[1].payload.waves;
    assert.ok(Array.isArray(wavesPayload));
    assert.ok(wavesPayload.length > 0, 'waves matrix must be non-empty');
    // Every inner entry is an array of integers.
    for (const wave of wavesPayload) {
      assert.ok(Array.isArray(wave));
      for (const id of wave) {
        assert.ok(Number.isInteger(id) && id > 0);
      }
    }
    // No failed records on a clean run.
    assert.equal(records.filter((r) => r.kind === 'failed').length, 0);
  });

  it('serializes waves as Array<Array<integer>> matching computeWaves output for a fixture with a dependency edge', async () => {
    const epicId = 5152;
    // 7003 blocked by 7002 → 7002 in wave 1, 7003 in wave 2.
    const provider = buildProvider([
      { id: 7001, labels: ['type::story'], body: '' },
      { id: 7002, labels: ['type::story'], body: '' },
      { id: 7003, labels: ['type::story'], body: 'blocked by #7002' },
    ]);
    const bus = new Bus();
    const writer = new LedgerWriter({ epicId, tempRoot });
    writer.register(bus);

    await runBuildWaveDagPhase({ epicId, provider }, { bus }, {});

    const records = readNdjson(writer.ledgerPath);
    const endRecord = records.find(
      (r) => r.kind === 'emitted' && r.event === 'epic.plan.end',
    );
    assert.ok(endRecord);
    // Wave 1: ids without unblocked deps (7001, 7002); Wave 2: (7003).
    assert.deepEqual(endRecord.payload.waves, [[7001, 7002], [7003]]);
  });

  it('schema validation rejects a plan.end payload missing the waves field (canary)', async () => {
    const bus = new Bus();
    await assert.rejects(
      () => bus.emit('epic.plan.end', {}),
      (err) => {
        assert.equal(err.code, 'BUS_SCHEMA_VALIDATION');
        assert.equal(err.event, 'epic.plan.end');
        return true;
      },
    );
  });

  it('skips emits silently when collaborators bag carries no bus (backward compat)', async () => {
    const epicId = 5153;
    const provider = buildProvider([
      { id: 7100, labels: ['type::story'], body: '' },
    ]);
    const result = await runBuildWaveDagPhase({ epicId, provider }, {}, {});
    assert.ok(Array.isArray(result.waves));
    // No throw, no ledger to inspect (no bus → no writer wired here).
  });

  it('discovers Stories nested under Features (v5 three-level hierarchy)', async () => {
    // Reproduces Story #2980: Epic → Feature → Story. getSubTickets(epic)
    // returns Features + closed reverse-ref Story; getSubTickets(feature)
    // returns the real open Stories. Plan must include all open Stories
    // and exclude the closed reverse-ref.
    const epicId = 775;
    const childrenByParent = new Map([
      [
        775,
        [
          { id: 781, labels: ['context::prd'], body: '', state: 'open' },
          { id: 784, labels: ['type::feature'], body: '', state: 'open' },
          { id: 785, labels: ['type::feature'], body: '', state: 'open' },
          // closed reverse-referenced Story — must be filtered out.
          { id: 774, labels: ['type::story'], body: 'Epic: #775', state: 'closed' },
        ],
      ],
      [
        784,
        [
          { id: 787, labels: ['type::story'], body: '', state: 'open' },
          { id: 791, labels: ['type::story'], body: '', state: 'open' },
        ],
      ],
      [
        785,
        [
          { id: 799, labels: ['type::story'], body: '', state: 'open' },
        ],
      ],
    ]);
    const provider = {
      async getSubTickets(parentId) {
        return (childrenByParent.get(parentId) ?? []).map((s) => ({
          ...s,
          labels: [...(s.labels ?? [])],
        }));
      },
    };
    const bus = new Bus();
    const writer = new LedgerWriter({ epicId, tempRoot });
    writer.register(bus);

    const result = await runBuildWaveDagPhase(
      { epicId, provider },
      { bus },
      {},
    );

    const ids = result.stories.map((s) => s.id).sort((a, b) => a - b);
    assert.deepEqual(ids, [787, 791, 799]);
    // Closed reverse-ref #774 excluded.
    assert.equal(result.stories.find((s) => s.id === 774), undefined);

    const records = readNdjson(writer.ledgerPath);
    const endRecord = records.find(
      (r) => r.kind === 'emitted' && r.event === 'epic.plan.end',
    );
    assert.ok(endRecord);
    const flat = endRecord.payload.waves.flat().sort((a, b) => a - b);
    assert.deepEqual(flat, [787, 791, 799]);
  });

  it('throws when every reverse-referenced Story is closed (no open Stories)', async () => {
    const epicId = 5160;
    const childrenByParent = new Map([
      [
        5160,
        [
          { id: 9001, labels: ['type::story'], body: '', state: 'closed' },
          { id: 9002, labels: ['type::story'], body: '', state: 'closed' },
        ],
      ],
    ]);
    const provider = {
      async getSubTickets(parentId) {
        return childrenByParent.get(parentId) ?? [];
      },
    };
    await assert.rejects(
      () => runBuildWaveDagPhase({ epicId, provider }, {}, {}),
      /has no child stories to dispatch/,
    );
  });
});

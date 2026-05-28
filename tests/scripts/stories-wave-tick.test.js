/**
 * stories-wave-tick.test.js — Story #3233
 *
 * Unit tests for the DAG/wave engine in stories-wave-tick.js.
 *
 * Exercises:
 *   - parseDag: validates the DAG input format
 *   - buildAdjacency: builds the adjacency map from parsed nodes
 *   - computeStoriesWavePlan: produces ordered waves via Graph.js
 *   - runStoriesWaveTick: end-to-end helper (no subprocess)
 *   - CLI via spawnSync: smoke-tests --help, --dag, --dag-file, cycle detection
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildAdjacency,
  computeStoriesWavePlan,
  parseDag,
  runStoriesWaveTick,
} from '../../.agents/scripts/stories-wave-tick.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO_ROOT, '.agents', 'scripts', 'stories-wave-tick.js');

// ---------------------------------------------------------------------------
// parseDag
// ---------------------------------------------------------------------------

describe('parseDag', () => {
  it('accepts a valid DAG array', () => {
    const { nodes, error } = parseDag([
      { id: 101, dependsOn: [] },
      { id: 102, dependsOn: [101] },
    ]);
    assert.strictEqual(error, null);
    assert.strictEqual(nodes.length, 2);
    assert.strictEqual(nodes[0].id, 101);
    assert.deepEqual(nodes[1].dependsOn, [101]);
  });

  it('accepts an empty array', () => {
    const { nodes, error } = parseDag([]);
    assert.strictEqual(error, null);
    assert.deepEqual(nodes, []);
  });

  it('rejects non-array input', () => {
    const { nodes, error } = parseDag({ id: 1, dependsOn: [] });
    assert.ok(error);
    assert.strictEqual(nodes, null);
  });

  it('rejects entry missing id', () => {
    const { nodes, error } = parseDag([{ dependsOn: [] }]);
    assert.ok(error);
    assert.strictEqual(nodes, null);
  });

  it('rejects entry with non-integer id', () => {
    const { nodes, error } = parseDag([{ id: 'abc', dependsOn: [] }]);
    assert.ok(error);
    assert.strictEqual(nodes, null);
  });

  it('rejects entry with negative id', () => {
    const { nodes, error } = parseDag([{ id: -1, dependsOn: [] }]);
    assert.ok(error);
    assert.strictEqual(nodes, null);
  });

  it('rejects entry missing dependsOn', () => {
    const { nodes, error } = parseDag([{ id: 101 }]);
    assert.ok(error);
    assert.strictEqual(nodes, null);
  });

  it('rejects entry with non-array dependsOn', () => {
    const { nodes, error } = parseDag([{ id: 101, dependsOn: 102 }]);
    assert.ok(error);
    assert.strictEqual(nodes, null);
  });

  it('rejects entry with non-integer in dependsOn', () => {
    const { nodes, error } = parseDag([
      { id: 101, dependsOn: ['not-a-number'] },
    ]);
    assert.ok(error);
    assert.strictEqual(nodes, null);
  });

  it('rejects entry with zero in dependsOn', () => {
    const { nodes, error } = parseDag([{ id: 101, dependsOn: [0] }]);
    assert.ok(error);
    assert.strictEqual(nodes, null);
  });
});

// ---------------------------------------------------------------------------
// buildAdjacency
// ---------------------------------------------------------------------------

describe('buildAdjacency', () => {
  it('builds a Map from parsed nodes', () => {
    const nodes = [
      { id: 10, dependsOn: [] },
      { id: 20, dependsOn: [10] },
    ];
    const adj = buildAdjacency(nodes);
    assert.ok(adj instanceof Map);
    assert.deepEqual(adj.get(10), []);
    assert.deepEqual(adj.get(20), [10]);
  });

  it('isolates the dependsOn arrays (defensive copy)', () => {
    const orig = [10];
    const nodes = [{ id: 20, dependsOn: orig }];
    const adj = buildAdjacency(nodes);
    orig.push(99);
    assert.deepEqual(adj.get(20), [10]); // not affected by mutation
  });
});

// ---------------------------------------------------------------------------
// computeStoriesWavePlan
// ---------------------------------------------------------------------------

describe('computeStoriesWavePlan', () => {
  it('returns empty waves for empty adjacency', () => {
    const plan = computeStoriesWavePlan(new Map());
    assert.strictEqual(plan.kind, 'stories-wave-plan');
    assert.deepEqual(plan.waves, []);
    assert.strictEqual(plan.totalStories, 0);
    assert.strictEqual(plan.cycleError, null);
  });

  it('single story with no dependencies → wave 0', () => {
    const adj = new Map([[101, []]]);
    const plan = computeStoriesWavePlan(adj);
    assert.strictEqual(plan.cycleError, null);
    assert.strictEqual(plan.totalStories, 1);
    assert.strictEqual(plan.waves.length, 1);
    assert.strictEqual(plan.waves[0].waveIndex, 0);
    assert.deepEqual(plan.waves[0].stories, [101]);
  });

  it('linear chain A→B→C produces three sequential waves', () => {
    // 103 depends on 102, 102 depends on 101 → waves [101], [102], [103]
    const adj = new Map([
      [101, []],
      [102, [101]],
      [103, [102]],
    ]);
    const plan = computeStoriesWavePlan(adj);
    assert.strictEqual(plan.cycleError, null);
    assert.strictEqual(plan.waves.length, 3);
    assert.deepEqual(plan.waves[0].stories, [101]);
    assert.deepEqual(plan.waves[1].stories, [102]);
    assert.deepEqual(plan.waves[2].stories, [103]);
  });

  it('diamond DAG: A → [B,C] → D produces three waves', () => {
    // 104 depends on 102 and 103; 102 and 103 both depend on 101
    const adj = new Map([
      [101, []],
      [102, [101]],
      [103, [101]],
      [104, [102, 103]],
    ]);
    const plan = computeStoriesWavePlan(adj);
    assert.strictEqual(plan.cycleError, null);
    assert.strictEqual(plan.waves.length, 3);
    // Wave 0: root
    assert.deepEqual(plan.waves[0].stories, [101]);
    // Wave 1: two independent stories sorted by id
    assert.deepEqual(plan.waves[1].stories, [102, 103]);
    // Wave 2: dependent leaf
    assert.deepEqual(plan.waves[2].stories, [104]);
  });

  it('fully independent stories all land in wave 0', () => {
    const adj = new Map([
      [10, []],
      [20, []],
      [30, []],
    ]);
    const plan = computeStoriesWavePlan(adj);
    assert.strictEqual(plan.cycleError, null);
    assert.strictEqual(plan.waves.length, 1);
    assert.deepEqual(plan.waves[0].stories, [10, 20, 30]);
  });

  it('stories within the same wave are sorted by id (ascending)', () => {
    const adj = new Map([
      [300, []],
      [100, []],
      [200, []],
    ]);
    const plan = computeStoriesWavePlan(adj);
    assert.deepEqual(plan.waves[0].stories, [100, 200, 300]);
  });

  it('detects a cycle and returns cycleError', () => {
    // 101 → 102 → 103 → 101 (cycle)
    const adj = new Map([
      [101, [103]],
      [102, [101]],
      [103, [102]],
    ]);
    const plan = computeStoriesWavePlan(adj);
    assert.ok(plan.cycleError, 'expected cycleError to be set');
    assert.ok(
      plan.cycleError.includes('Dependency cycle detected'),
      `unexpected cycleError: ${plan.cycleError}`,
    );
    assert.deepEqual(plan.waves, []);
  });

  it('totalStories matches adjacency size', () => {
    const adj = new Map([
      [1, []],
      [2, [1]],
      [3, [2]],
    ]);
    const plan = computeStoriesWavePlan(adj);
    assert.strictEqual(plan.totalStories, 3);
  });
});

// ---------------------------------------------------------------------------
// runStoriesWaveTick (end-to-end helper)
// ---------------------------------------------------------------------------

describe('runStoriesWaveTick', () => {
  it('returns exitCode 0 and valid envelope for a simple DAG', () => {
    const dagJson = JSON.stringify([
      { id: 1, dependsOn: [] },
      { id: 2, dependsOn: [1] },
    ]);
    const { envelope, exitCode } = runStoriesWaveTick({ dagJson });
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(envelope.kind, 'stories-wave-plan');
    assert.strictEqual(envelope.cycleError, null);
    assert.strictEqual(envelope.waves.length, 2);
  });

  it('returns exitCode 1 for invalid JSON input', () => {
    const { envelope, exitCode } = runStoriesWaveTick({
      dagJson: 'not-json{{{',
    });
    assert.strictEqual(exitCode, 1);
    assert.ok(envelope.inputError);
  });

  it('returns exitCode 1 when neither dagJson nor dagFile is provided', () => {
    const { envelope, exitCode } = runStoriesWaveTick({});
    assert.strictEqual(exitCode, 1);
    assert.ok(envelope.inputError);
  });

  it('returns exitCode 2 for a cyclic DAG', () => {
    const dagJson = JSON.stringify([
      { id: 1, dependsOn: [2] },
      { id: 2, dependsOn: [1] },
    ]);
    const { envelope, exitCode } = runStoriesWaveTick({ dagJson });
    assert.strictEqual(exitCode, 2);
    assert.ok(envelope.cycleError);
  });

  it('reads DAG from a file when dagFile is provided', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'stories-wave-tick-'));
    const dagPath = path.join(tmp, 'dag.json');
    writeFileSync(
      dagPath,
      JSON.stringify([
        { id: 5, dependsOn: [] },
        { id: 6, dependsOn: [5] },
      ]),
      'utf8',
    );
    const { envelope, exitCode } = runStoriesWaveTick({ dagFile: dagPath });
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(envelope.waves.length, 2);
  });

  it('returns exitCode 1 when dagFile does not exist', () => {
    const { envelope, exitCode } = runStoriesWaveTick({
      dagFile: '/nonexistent/path/dag.json',
    });
    assert.strictEqual(exitCode, 1);
    assert.ok(envelope.inputError);
  });

  it('returns exitCode 1 for validation error in DAG entries', () => {
    const dagJson = JSON.stringify([{ id: 0, dependsOn: [] }]); // id=0 is invalid
    const { envelope, exitCode } = runStoriesWaveTick({ dagJson });
    assert.strictEqual(exitCode, 1);
    assert.ok(envelope.inputError);
  });
});

// ---------------------------------------------------------------------------
// CLI smoke tests (spawnSync)
// ---------------------------------------------------------------------------

describe('CLI', () => {
  it('--help exits 0 and prints usage', () => {
    const result = spawnSync(process.execPath, [CLI, '--help'], {
      encoding: 'utf8',
    });
    assert.strictEqual(result.status, 0);
    assert.ok(result.stdout.includes('stories-wave-tick'));
  });

  it('--dag with valid input exits 0 and emits JSON envelope', () => {
    const dag = JSON.stringify([
      { id: 101, dependsOn: [] },
      { id: 102, dependsOn: [101] },
    ]);
    const result = spawnSync(process.execPath, [CLI, '--dag', dag], {
      encoding: 'utf8',
    });
    assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const envelope = JSON.parse(result.stdout);
    assert.strictEqual(envelope.kind, 'stories-wave-plan');
    assert.strictEqual(envelope.cycleError, null);
    assert.strictEqual(envelope.waves.length, 2);
  });

  it('--dag with cyclic DAG exits 2', () => {
    const dag = JSON.stringify([
      { id: 1, dependsOn: [2] },
      { id: 2, dependsOn: [1] },
    ]);
    const result = spawnSync(process.execPath, [CLI, '--dag', dag], {
      encoding: 'utf8',
    });
    assert.strictEqual(result.status, 2, `stderr: ${result.stderr}`);
    const envelope = JSON.parse(result.stdout);
    assert.ok(envelope.cycleError);
  });

  it('missing --dag or --dag-file exits 1', () => {
    const result = spawnSync(process.execPath, [CLI], { encoding: 'utf8' });
    assert.strictEqual(result.status, 1);
  });

  it('--dag-file with a valid JSON file exits 0', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'stories-wave-tick-cli-'));
    const dagPath = path.join(tmp, 'dag.json');
    writeFileSync(dagPath, JSON.stringify([{ id: 50, dependsOn: [] }]), 'utf8');
    const result = spawnSync(process.execPath, [CLI, '--dag-file', dagPath], {
      encoding: 'utf8',
    });
    assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const envelope = JSON.parse(result.stdout);
    assert.strictEqual(envelope.waves.length, 1);
    assert.deepEqual(envelope.waves[0].stories, [50]);
  });
});

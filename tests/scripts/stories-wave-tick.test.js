/**
 * stories-wave-tick.test.js — Story #4156
 *
 * Unit tests for the continuous ready-set adapter in stories-wave-tick.js.
 *
 * The file is now a thin adapter over the path-agnostic scheduling core
 * (`lib/wave-runner/ready-set.js#selectReadySet`): it no longer batches
 * Stories into fully-draining waves (the static wave-batch plan built via
 * `Graph.js#assignLayers` is gone). It parses the operator DAG + the live
 * run progress (`--done` / `--in-flight`) and emits the set of Stories safe
 * to dispatch on this beat under the same global cap and file-overlap guard
 * the Epic path uses.
 *
 * Exercises:
 *   - parseDag: validates the DAG input format
 *   - parseDoneIds / parseInFlight: validate the live-progress flags
 *   - parseConcurrencyOverride / resolveConcurrencyCap: cap resolution
 *   - buildReadySetEnvelope: continuous selection through selectReadySet
 *   - runStoriesWaveTick: end-to-end helper (no subprocess)
 *   - CLI via spawnSync: smoke-tests --help, --dag, --dag-file, --done,
 *     cycle detection
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildReadySetEnvelope,
  detectWedge,
  parseConcurrencyOverride,
  parseDag,
  parseDoneIds,
  parseInFlight,
  resolveConcurrencyCap,
  runStoriesWaveTick,
  WEDGED_EXIT_CODE,
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
// parseDoneIds
// ---------------------------------------------------------------------------

describe('parseDoneIds', () => {
  it('returns an empty set for absent / empty input', () => {
    assert.deepEqual([...parseDoneIds(undefined).ids], []);
    assert.deepEqual([...parseDoneIds('').ids], []);
  });

  it('parses a comma-separated list, deduped', () => {
    const { ids, error } = parseDoneIds('101, 103,101');
    assert.strictEqual(error, null);
    assert.deepEqual(
      [...ids].sort((a, b) => a - b),
      [101, 103],
    );
  });

  it('skips empty tokens (trailing comma / whitespace)', () => {
    const { ids, error } = parseDoneIds('5, ,6,');
    assert.strictEqual(error, null);
    assert.deepEqual(
      [...ids].sort((a, b) => a - b),
      [5, 6],
    );
  });

  it('rejects a non-positive token', () => {
    const { ids, error } = parseDoneIds('5,0');
    assert.strictEqual(ids, null);
    assert.ok(error);
    assert.ok(error.includes('--done'));
  });

  it('rejects a non-numeric token', () => {
    const { ids, error } = parseDoneIds('5,abc');
    assert.strictEqual(ids, null);
    assert.ok(error);
  });
});

// ---------------------------------------------------------------------------
// parseInFlight
// ---------------------------------------------------------------------------

describe('parseInFlight', () => {
  it('defaults to 0 for absent input', () => {
    const { value, error } = parseInFlight(undefined);
    assert.strictEqual(value, 0);
    assert.strictEqual(error, null);
  });

  it('accepts 0 (a full run with all slots free is valid)', () => {
    const { value, error } = parseInFlight('0');
    assert.strictEqual(value, 0);
    assert.strictEqual(error, null);
  });

  it('accepts a positive integer', () => {
    const { value, error } = parseInFlight('2');
    assert.strictEqual(value, 2);
    assert.strictEqual(error, null);
  });

  it('rejects a negative value', () => {
    const { value, error } = parseInFlight('-1');
    assert.strictEqual(value, null);
    assert.ok(error);
  });

  it('rejects a fractional value', () => {
    const { value, error } = parseInFlight('1.5');
    assert.strictEqual(value, null);
    assert.ok(error);
  });

  it('rejects a non-numeric value', () => {
    const { value, error } = parseInFlight('abc');
    assert.strictEqual(value, null);
    assert.ok(error);
  });
});

// ---------------------------------------------------------------------------
// buildReadySetEnvelope (continuous selection through the shared core)
// ---------------------------------------------------------------------------

describe('buildReadySetEnvelope', () => {
  it('returns an empty ready set for an empty DAG', () => {
    const { envelope, exitCode } = buildReadySetEnvelope([], {
      concurrencyCap: 3,
    });
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(envelope.kind, 'stories-ready-set');
    assert.deepEqual(envelope.ready, []);
    assert.strictEqual(envelope.totalStories, 0);
    assert.strictEqual(envelope.concurrencyCap, 3);
    assert.strictEqual(envelope.inFlight, 0);
    assert.strictEqual(envelope.cycleError, null);
  });

  it('a single root Story with no deps is ready', () => {
    const { envelope, exitCode } = buildReadySetEnvelope(
      [{ id: 101, dependsOn: [] }],
      { concurrencyCap: 3 },
    );
    assert.strictEqual(exitCode, 0);
    assert.deepEqual(envelope.ready, [101]);
    assert.strictEqual(envelope.totalStories, 1);
  });

  it('only roots are ready on the first beat; dependents are withheld', () => {
    // 101 → 102 → 103: on beat 0 (nothing done) only 101 is dispatchable.
    const nodes = [
      { id: 101, dependsOn: [] },
      { id: 102, dependsOn: [101] },
      { id: 103, dependsOn: [102] },
    ];
    const { envelope } = buildReadySetEnvelope(nodes, { concurrencyCap: 3 });
    assert.deepEqual(envelope.ready, [101]);
    assert.strictEqual(envelope.totalStories, 3);
  });

  it('a Story is dispatched the instant its OWN deps are done (no wave barrier)', () => {
    // 101 → 103; 102 is an unrelated still-pending root. With 101 done, 103
    // is eligible even though 102 has not been dispatched yet — the
    // continuous, no-false-barrier property the wave-batch lacked: under a
    // batch model 103 would sit in a later wave gated behind 102's wave
    // fully draining. Here both unblocked Stories surface on the same beat.
    const nodes = [
      { id: 101, dependsOn: [] },
      { id: 102, dependsOn: [] },
      { id: 103, dependsOn: [101] },
    ];
    const { envelope } = buildReadySetEnvelope(nodes, {
      concurrencyCap: 3,
      doneIds: new Set([101]),
      inFlight: 0,
    });
    assert.deepEqual(envelope.ready, [102, 103]);
  });

  it('a done Story is never re-dispatched and satisfies its dependents', () => {
    const nodes = [
      { id: 101, dependsOn: [] },
      { id: 102, dependsOn: [101] },
    ];
    const { envelope } = buildReadySetEnvelope(nodes, {
      concurrencyCap: 3,
      doneIds: new Set([101]),
    });
    // 101 done → excluded; 102 now eligible.
    assert.deepEqual(envelope.ready, [102]);
  });

  it('the dispatch set is capped at globalCap − inFlight', () => {
    const nodes = [
      { id: 1, dependsOn: [] },
      { id: 2, dependsOn: [] },
      { id: 3, dependsOn: [] },
      { id: 4, dependsOn: [] },
    ];
    const { envelope } = buildReadySetEnvelope(nodes, {
      concurrencyCap: 3,
      inFlight: 2,
    });
    // 3 − 2 = 1 free slot → exactly one Story (ascending id) selected.
    assert.deepEqual(envelope.ready, [1]);
    assert.strictEqual(envelope.inFlight, 2);
  });

  it('emits an empty ready set when no capacity remains', () => {
    const nodes = [
      { id: 1, dependsOn: [] },
      { id: 2, dependsOn: [] },
    ];
    const { envelope } = buildReadySetEnvelope(nodes, {
      concurrencyCap: 2,
      inFlight: 2,
    });
    assert.deepEqual(envelope.ready, []);
  });

  it('detects a cycle and short-circuits with exitCode 2', () => {
    const nodes = [
      { id: 101, dependsOn: [103] },
      { id: 102, dependsOn: [101] },
      { id: 103, dependsOn: [102] },
    ];
    const { envelope, exitCode } = buildReadySetEnvelope(nodes, {
      concurrencyCap: 3,
    });
    assert.strictEqual(exitCode, 2);
    assert.ok(envelope.cycleError);
    assert.ok(envelope.cycleError.includes('Dependency cycle detected'));
    assert.deepEqual(envelope.ready, []);
  });

  it('honors the file-overlap guard the Epic path uses (co-dispatch withhold)', () => {
    // Two unblocked roots that declare the same file footprint MUST NOT both
    // dispatch on one beat — selectReadySet withholds one. The DAG-node
    // builder forwards `files` through unchanged.
    const nodes = [
      { id: 1, dependsOn: [], files: ['lib/shared.js'] },
      { id: 2, dependsOn: [], files: ['lib/shared.js'] },
    ];
    const { envelope } = buildReadySetEnvelope(nodes, { concurrencyCap: 3 });
    assert.deepEqual(envelope.ready, [1]); // 2 withheld this beat
  });
});

// ---------------------------------------------------------------------------
// runStoriesWaveTick (end-to-end helper)
// ---------------------------------------------------------------------------

describe('runStoriesWaveTick', () => {
  it('returns exitCode 0 and a valid envelope for a simple DAG', () => {
    const dagJson = JSON.stringify([
      { id: 1, dependsOn: [] },
      { id: 2, dependsOn: [1] },
    ]);
    const { envelope, exitCode } = runStoriesWaveTick({ dagJson, config: {} });
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(envelope.kind, 'stories-ready-set');
    assert.strictEqual(envelope.cycleError, null);
    // Only the root is ready on the first beat.
    assert.deepEqual(envelope.ready, [1]);
  });

  it('threads --done through to the selection', () => {
    const dagJson = JSON.stringify([
      { id: 1, dependsOn: [] },
      { id: 2, dependsOn: [1] },
    ]);
    const { envelope, exitCode } = runStoriesWaveTick({
      dagJson,
      config: {},
      done: '1',
    });
    assert.strictEqual(exitCode, 0);
    assert.deepEqual(envelope.ready, [2]);
  });

  it('threads --in-flight through to the capacity calculation', () => {
    const dagJson = JSON.stringify([
      { id: 1, dependsOn: [] },
      { id: 2, dependsOn: [] },
    ]);
    const { envelope, exitCode } = runStoriesWaveTick({
      dagJson,
      config: { delivery: { deliverRunner: { concurrencyCap: 2 } } },
      inFlight: '2',
    });
    assert.strictEqual(exitCode, 0);
    assert.deepEqual(envelope.ready, []);
    assert.strictEqual(envelope.inFlight, 2);
  });

  it('returns exitCode 1 for invalid JSON input', () => {
    const { envelope, exitCode } = runStoriesWaveTick({
      dagJson: 'not-json{{{',
      config: {},
    });
    assert.strictEqual(exitCode, 1);
    assert.ok(envelope.inputError);
  });

  it('returns exitCode 1 when neither dagJson nor dagFile is provided', () => {
    const { envelope, exitCode } = runStoriesWaveTick({ config: {} });
    assert.strictEqual(exitCode, 1);
    assert.ok(envelope.inputError);
  });

  it('returns exitCode 2 for a cyclic DAG', () => {
    const dagJson = JSON.stringify([
      { id: 1, dependsOn: [2] },
      { id: 2, dependsOn: [1] },
    ]);
    const { envelope, exitCode } = runStoriesWaveTick({ dagJson, config: {} });
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
    const { envelope, exitCode } = runStoriesWaveTick({
      dagFile: dagPath,
      config: {},
    });
    assert.strictEqual(exitCode, 0);
    assert.deepEqual(envelope.ready, [5]);
  });

  it('returns exitCode 1 when dagFile does not exist', () => {
    const { envelope, exitCode } = runStoriesWaveTick({
      dagFile: '/nonexistent/path/dag.json',
      config: {},
    });
    assert.strictEqual(exitCode, 1);
    assert.ok(envelope.inputError);
  });

  it('returns exitCode 1 for a validation error in DAG entries', () => {
    const dagJson = JSON.stringify([{ id: 0, dependsOn: [] }]); // id=0 invalid
    const { envelope, exitCode } = runStoriesWaveTick({ dagJson, config: {} });
    assert.strictEqual(exitCode, 1);
    assert.ok(envelope.inputError);
  });

  // -------------------------------------------------------------------------
  // concurrencyCap resolution
  // -------------------------------------------------------------------------

  it('(a) default config (no override) → concurrencyCap 3 in the envelope', () => {
    const dagJson = JSON.stringify([{ id: 1, dependsOn: [] }]);
    // Inject an empty config so getRunners falls back to the default of 3 —
    // never depends on a real .agentrc on disk.
    const { envelope, exitCode } = runStoriesWaveTick({ dagJson, config: {} });
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(envelope.concurrencyCap, 3);
  });

  it('(b) a delivery.deliverRunner.concurrencyCap config override is reflected', () => {
    const dagJson = JSON.stringify([{ id: 1, dependsOn: [] }]);
    const config = { delivery: { deliverRunner: { concurrencyCap: 7 } } };
    const { envelope, exitCode } = runStoriesWaveTick({ dagJson, config });
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(envelope.concurrencyCap, 7);
  });

  it('(c) --concurrency CLI flag takes precedence over config', () => {
    const dagJson = JSON.stringify([{ id: 1, dependsOn: [] }]);
    const config = { delivery: { deliverRunner: { concurrencyCap: 7 } } };
    const { envelope, exitCode } = runStoriesWaveTick({
      dagJson,
      config,
      concurrency: '2',
    });
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(envelope.concurrencyCap, 2);
  });

  it('rejects a non-positive --concurrency with exitCode 1 and a clear message', () => {
    const dagJson = JSON.stringify([{ id: 1, dependsOn: [] }]);
    const { envelope, exitCode } = runStoriesWaveTick({
      dagJson,
      config: {},
      concurrency: '0',
    });
    assert.strictEqual(exitCode, 1);
    assert.ok(envelope.inputError);
    assert.ok(envelope.inputError.includes('--concurrency'));
  });

  it('rejects a non-numeric --concurrency with exitCode 1', () => {
    const dagJson = JSON.stringify([{ id: 1, dependsOn: [] }]);
    const { envelope, exitCode } = runStoriesWaveTick({
      dagJson,
      config: {},
      concurrency: 'abc',
    });
    assert.strictEqual(exitCode, 1);
    assert.ok(envelope.inputError);
  });

  it('rejects a negative --in-flight with exitCode 1', () => {
    const dagJson = JSON.stringify([{ id: 1, dependsOn: [] }]);
    const { envelope, exitCode } = runStoriesWaveTick({
      dagJson,
      config: {},
      inFlight: '-1',
    });
    assert.strictEqual(exitCode, 1);
    assert.ok(envelope.inputError);
    assert.ok(envelope.inputError.includes('--in-flight'));
  });

  it('rejects an invalid --done token with exitCode 1', () => {
    const dagJson = JSON.stringify([{ id: 1, dependsOn: [] }]);
    const { envelope, exitCode } = runStoriesWaveTick({
      dagJson,
      config: {},
      done: '1,bogus',
    });
    assert.strictEqual(exitCode, 1);
    assert.ok(envelope.inputError);
    assert.ok(envelope.inputError.includes('--done'));
  });

  it('carries concurrencyCap through a cyclic-DAG envelope (exitCode 2)', () => {
    const dagJson = JSON.stringify([
      { id: 1, dependsOn: [2] },
      { id: 2, dependsOn: [1] },
    ]);
    const { envelope, exitCode } = runStoriesWaveTick({ dagJson, config: {} });
    assert.strictEqual(exitCode, 2);
    assert.strictEqual(envelope.concurrencyCap, 3);
    assert.ok(envelope.cycleError);
  });
});

// ---------------------------------------------------------------------------
// resolveConcurrencyCap
// ---------------------------------------------------------------------------

describe('resolveConcurrencyCap', () => {
  it('falls back to the default of 3 for an empty config', () => {
    assert.strictEqual(resolveConcurrencyCap({ config: {} }), 3);
  });

  it('reads delivery.deliverRunner.concurrencyCap from config', () => {
    const config = { delivery: { deliverRunner: { concurrencyCap: 9 } } };
    assert.strictEqual(resolveConcurrencyCap({ config }), 9);
  });

  it('an override wins over config', () => {
    const config = { delivery: { deliverRunner: { concurrencyCap: 9 } } };
    assert.strictEqual(resolveConcurrencyCap({ config, override: 4 }), 4);
  });
});

// ---------------------------------------------------------------------------
// parseConcurrencyOverride
// ---------------------------------------------------------------------------

describe('parseConcurrencyOverride', () => {
  it('returns null/null for an absent value', () => {
    const { value, error } = parseConcurrencyOverride(undefined);
    assert.strictEqual(value, null);
    assert.strictEqual(error, null);
  });

  it('accepts a positive integer string', () => {
    const { value, error } = parseConcurrencyOverride('5');
    assert.strictEqual(value, 5);
    assert.strictEqual(error, null);
  });

  it('accepts a positive integer number', () => {
    const { value, error } = parseConcurrencyOverride(5);
    assert.strictEqual(value, 5);
    assert.strictEqual(error, null);
  });

  it('rejects zero', () => {
    const { value, error } = parseConcurrencyOverride('0');
    assert.strictEqual(value, null);
    assert.ok(error);
  });

  it('rejects a negative value', () => {
    const { value, error } = parseConcurrencyOverride('-3');
    assert.strictEqual(value, null);
    assert.ok(error);
  });

  it('rejects a fractional value', () => {
    const { value, error } = parseConcurrencyOverride('2.5');
    assert.strictEqual(value, null);
    assert.ok(error);
  });

  it('rejects a non-numeric value', () => {
    const { value, error } = parseConcurrencyOverride('abc');
    assert.strictEqual(value, null);
    assert.ok(error);
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

  it('--dag with valid input exits 0 and emits the ready-set envelope', () => {
    const dag = JSON.stringify([
      { id: 101, dependsOn: [] },
      { id: 102, dependsOn: [101] },
    ]);
    const result = spawnSync(process.execPath, [CLI, '--dag', dag], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
    });
    assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const envelope = JSON.parse(result.stdout);
    assert.strictEqual(envelope.kind, 'stories-ready-set');
    assert.strictEqual(envelope.cycleError, null);
    // Only the root dispatches on the first beat.
    assert.deepEqual(envelope.ready, [101]);
  });

  it('--dag with --done advances the ready set', () => {
    const dag = JSON.stringify([
      { id: 101, dependsOn: [] },
      { id: 102, dependsOn: [101] },
    ]);
    const result = spawnSync(
      process.execPath,
      [CLI, '--dag', dag, '--done', '101'],
      { encoding: 'utf8', cwd: REPO_ROOT },
    );
    assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const envelope = JSON.parse(result.stdout);
    assert.deepEqual(envelope.ready, [102]);
  });

  it('--dag with a cyclic DAG exits 2', () => {
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
      cwd: REPO_ROOT,
    });
    assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const envelope = JSON.parse(result.stdout);
    assert.deepEqual(envelope.ready, [50]);
  });

  it('--dag emits a numeric concurrencyCap in the envelope', () => {
    const dag = JSON.stringify([{ id: 101, dependsOn: [] }]);
    const result = spawnSync(process.execPath, [CLI, '--dag', dag], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
    });
    assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const envelope = JSON.parse(result.stdout);
    assert.strictEqual(typeof envelope.concurrencyCap, 'number');
    assert.ok(envelope.concurrencyCap >= 1);
  });

  it('--concurrency overrides the resolved cap', () => {
    const dag = JSON.stringify([{ id: 101, dependsOn: [] }]);
    const result = spawnSync(
      process.execPath,
      [CLI, '--dag', dag, '--concurrency', '8'],
      { encoding: 'utf8', cwd: REPO_ROOT },
    );
    assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const envelope = JSON.parse(result.stdout);
    assert.strictEqual(envelope.concurrencyCap, 8);
  });

  it('an invalid --concurrency exits 1', () => {
    const dag = JSON.stringify([{ id: 101, dependsOn: [] }]);
    const result = spawnSync(
      process.execPath,
      [CLI, '--dag', dag, '--concurrency', '0'],
      { encoding: 'utf8', cwd: REPO_ROOT },
    );
    assert.strictEqual(result.status, 1, `stderr: ${result.stderr}`);
    const envelope = JSON.parse(result.stdout);
    assert.ok(envelope.inputError);
  });

  it('--dag forwards a declared file footprint so the overlap guard fires end-to-end', () => {
    // Two unblocked roots touching the same file: parseDag must preserve the
    // footprint and the core must withhold one on this beat.
    const dag = JSON.stringify([
      { id: 1, dependsOn: [], files: ['lib/shared.js'] },
      { id: 2, dependsOn: [], files: ['lib/shared.js'] },
    ]);
    const result = spawnSync(process.execPath, [CLI, '--dag', dag], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
    });
    assert.strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const envelope = JSON.parse(result.stdout);
    assert.deepEqual(envelope.ready, [1]);
  });

  it('--dag rejects a malformed files footprint with exit 1', () => {
    const dag = JSON.stringify([{ id: 1, dependsOn: [], files: [42] }]);
    const result = spawnSync(process.execPath, [CLI, '--dag', dag], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
    });
    assert.strictEqual(result.status, 1, `stderr: ${result.stderr}`);
    const envelope = JSON.parse(result.stdout);
    assert.ok(envelope.inputError);
    assert.ok(envelope.inputError.includes('files'));
  });
});

describe('wedge detection (Story #4540)', () => {
  const dag = (nodes) => JSON.stringify(nodes);

  it('an empty ready set with work IN FLIGHT is not a wedge — it is waiting', () => {
    // The distinction that makes the verdict useful: `ready: []` is the
    // normal steady state while a Story is being delivered.
    const { envelope, exitCode } = runStoriesWaveTick({
      dagJson: dag([
        { id: 1, dependsOn: [] },
        { id: 2, dependsOn: [1] },
      ]),
      done: '',
      inFlight: 1,
      concurrency: 1,
    });
    assert.deepEqual(envelope.ready, []);
    assert.equal(envelope.wedged, null);
    assert.equal(exitCode, 0);
  });

  it('a completed run is not a wedge', () => {
    const { envelope, exitCode } = runStoriesWaveTick({
      dagJson: dag([{ id: 1, dependsOn: [] }]),
      done: '1',
      inFlight: 0,
      concurrency: 3,
    });
    assert.equal(envelope.wedged, null);
    assert.equal(exitCode, 0);
  });

  it('reports a wedge, its ids, and its unmet blockers when nothing can ever progress', () => {
    // A foreign blocker (#4530) that has not landed. Before this, the loop
    // returned ready:[] + exit 0 forever — indistinguishable from waiting.
    const { envelope, exitCode } = runStoriesWaveTick({
      dagJson: dag([{ id: 4534, dependsOn: [4530] }]),
      done: '',
      inFlight: 0,
      concurrency: 3,
    });
    assert.equal(exitCode, WEDGED_EXIT_CODE);
    assert.deepEqual(envelope.ready, []);
    assert.deepEqual(envelope.wedged.stories, [
      { id: 4534, unmetBlockers: [4530] },
    ]);
    assert.match(envelope.wedged.reason, /#4534 ← #4530/);
  });

  it('the wedge exit code is distinct from the cycle exit code', () => {
    const cycle = runStoriesWaveTick({
      dagJson: dag([
        { id: 1, dependsOn: [2] },
        { id: 2, dependsOn: [1] },
      ]),
      done: '',
      inFlight: 0,
      concurrency: 3,
    });
    assert.equal(cycle.exitCode, 2, 'a cycle stays exit 2');
    assert.ok(cycle.envelope.cycleError);
    assert.notEqual(
      WEDGED_EXIT_CODE,
      2,
      'a wedge must not be mistaken for a self-referential DAG',
    );
  });

  it('clears once the blocker lands — the cross-run case', () => {
    const { envelope, exitCode } = runStoriesWaveTick({
      dagJson: dag([{ id: 4534, dependsOn: [4530] }]),
      done: '4530',
      inFlight: 0,
      concurrency: 3,
    });
    assert.equal(exitCode, 0);
    assert.equal(envelope.wedged, null);
    assert.deepEqual(envelope.ready, [4534]);
  });

  it('detectWedge does not fire when undone work has no unmet blockers', () => {
    // Then the cap or in-flight accounting explains the empty ready set.
    assert.equal(
      detectWedge({
        nodes: [{ id: 1, dependsOn: [] }],
        doneIds: new Set(),
        ready: [],
        inFlight: 0,
      }),
      null,
    );
  });
});

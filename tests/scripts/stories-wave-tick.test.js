/**
 * stories-wave-tick.test.js — Story #4156
 *
 * Unit tests for the continuous ready-set adapter in stories-wave-tick.js.
 *
 * The file is now a thin adapter over the path-agnostic scheduling core
 * (`lib/wave-runner/ready-set.js#planReadySet`): it no longer batches
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
 *   - buildReadySetEnvelope: continuous selection through planReadySet
 *   - runStoriesWaveTick: end-to-end helper (no subprocess)
 *   - CLI: two real spawns (the --help contract and one end-to-end smoke),
 *     with every other CLI case driving runStoriesWaveTick in-process
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  fingerprintFooter,
  semanticKeyFooter,
  semanticKeyFor,
} from '../../.agents/scripts/lib/findings/route-finding.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';
import {
  buildReadySetEnvelope,
  detectWedge,
  parseConcurrencyOverride,
  parseDag,
  parseDoneIds,
  parseInFlight,
  resolveCapPrecedence,
  resolveConcurrencyCap,
  resolveFootprintGuardSettings,
  runProbedStoriesWaveTick,
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

  it('expands a dash range, so a ranged run reports back in the same shape', () => {
    const { ids, error } = parseDoneIds('101,103-105');
    assert.strictEqual(error, null);
    assert.deepEqual(
      [...ids].sort((a, b) => a - b),
      [101, 103, 104, 105],
    );
  });

  it('rejects a backwards range', () => {
    const { ids, error } = parseDoneIds('105-103');
    assert.strictEqual(ids, null);
    assert.match(error, /--done/);
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
    // dispatch on one beat — planReadySet withholds one. The DAG-node
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
    const tmp = makeTempDir('stories-wave-tick-');
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

/**
 * The CLI's observable contract, in-process (Story #5111).
 *
 * `main` in `stories-wave-tick.js` parses argv, hands the values to the
 * exported `runStoriesWaveTick`, and prints the envelope. Only the first and
 * last of those need a real process, and the two spawns retained below prove
 * them. Every other case here asserts on the envelope and the exit code —
 * which is what the CLI's callers actually consume — without paying a `node`
 * cold start per assertion.
 *
 * @param {{ dag?: unknown, dagFile?: string, concurrency?: string,
 *   done?: string, inFlight?: string }} [opts]
 * @returns {{ status: number, envelope: object }}
 */
function runCli({ dag, dagFile, concurrency, done, inFlight } = {}) {
  const { envelope, exitCode } = runStoriesWaveTick({
    dagJson:
      typeof dag === 'string' || dag === undefined ? dag : JSON.stringify(dag),
    dagFile,
    concurrency,
    done,
    inFlight,
  });
  return { status: exitCode, envelope };
}

describe('CLI', () => {
  it('--help exits 0 and prints usage', () => {
    const result = spawnSync(process.execPath, [CLI, '--help'], {
      encoding: 'utf8',
    });
    assert.strictEqual(result.status, 0);
    assert.ok(result.stdout.includes('stories-wave-tick'));
  });

  // The one real-spawn smoke case: proves argv reaches runStoriesWaveTick,
  // its envelope reaches stdout, and its exit code reaches the shell.
  it('--dag with valid input exits 0 and emits the ready-set envelope (real spawn)', () => {
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
    const { status, envelope } = runCli({
      dag: [
        { id: 101, dependsOn: [] },
        { id: 102, dependsOn: [101] },
      ],
      done: '101',
    });
    assert.strictEqual(status, 0);
    assert.deepEqual(envelope.ready, [102]);
  });

  it('--dag with a cyclic DAG exits 2', () => {
    const { status, envelope } = runCli({
      dag: [
        { id: 1, dependsOn: [2] },
        { id: 2, dependsOn: [1] },
      ],
    });
    assert.strictEqual(status, 2);
    assert.ok(envelope.cycleError);
  });

  it('missing --dag or --dag-file exits 1', () => {
    assert.strictEqual(runCli().status, 1);
  });

  it('--dag-file with a valid JSON file exits 0', () => {
    const tmp = makeTempDir('stories-wave-tick-cli-');
    const dagPath = path.join(tmp, 'dag.json');
    writeFileSync(dagPath, JSON.stringify([{ id: 50, dependsOn: [] }]), 'utf8');
    const { status, envelope } = runCli({ dagFile: dagPath });
    assert.strictEqual(status, 0);
    assert.deepEqual(envelope.ready, [50]);
  });

  it('--dag emits a numeric concurrencyCap in the envelope', () => {
    const { status, envelope } = runCli({ dag: [{ id: 101, dependsOn: [] }] });
    assert.strictEqual(status, 0);
    assert.strictEqual(typeof envelope.concurrencyCap, 'number');
    assert.ok(envelope.concurrencyCap >= 1);
  });

  it('--concurrency overrides the resolved cap', () => {
    const { status, envelope } = runCli({
      dag: [{ id: 101, dependsOn: [] }],
      concurrency: '8',
    });
    assert.strictEqual(status, 0);
    assert.strictEqual(envelope.concurrencyCap, 8);
  });

  it('an invalid --concurrency exits 1', () => {
    const { status, envelope } = runCli({
      dag: [{ id: 101, dependsOn: [] }],
      concurrency: '0',
    });
    assert.strictEqual(status, 1);
    assert.ok(envelope.inputError);
  });

  it('--dag forwards a declared file footprint so the overlap guard fires end-to-end', () => {
    // Two unblocked roots touching the same file: parseDag must preserve the
    // footprint and the core must withhold one on this beat.
    const { status, envelope } = runCli({
      dag: [
        { id: 1, dependsOn: [], files: ['lib/shared.js'] },
        { id: 2, dependsOn: [], files: ['lib/shared.js'] },
      ],
    });
    assert.strictEqual(status, 0);
    assert.deepEqual(envelope.ready, [1]);
  });

  it('--dag rejects a malformed files footprint with exit 1', () => {
    const { status, envelope } = runCli({
      dag: [{ id: 1, dependsOn: [], files: [42] }],
    });
    assert.strictEqual(status, 1);
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

// ---------------------------------------------------------------------------
// Story #4875 — the --concurrency override is reconciled, never silent
// ---------------------------------------------------------------------------

describe('resolveCapPrecedence — the flag wins, and says that it won (AC-6)', () => {
  const CONFIG = { delivery: { deliverRunner: { concurrencyCap: 3 } } };

  it('names config as the source when no flag was given', () => {
    const p = resolveCapPrecedence({ config: CONFIG });
    assert.strictEqual(p.cap, 3);
    assert.strictEqual(p.source, 'config');
    assert.strictEqual(p.configuredCap, 3);
    assert.strictEqual(p.requestedCap, null);
    assert.strictEqual(p.exceedsConfigured, false);
    assert.match(p.note, /concurrencyCap/);
  });

  it('names the flag as the source, and carries the configured value it outranked', () => {
    const p = resolveCapPrecedence({ config: CONFIG, override: 2 });
    assert.strictEqual(p.cap, 2);
    assert.strictEqual(p.source, 'flag');
    assert.strictEqual(p.configuredCap, 3);
    assert.strictEqual(p.requestedCap, 2);
    assert.strictEqual(p.exceedsConfigured, false);
    assert.match(p.note, /overrides the configured/);
  });

  it('flags a request that EXCEEDS the configured cap rather than applying it silently', () => {
    const p = resolveCapPrecedence({ config: CONFIG, override: 8 });
    assert.strictEqual(p.cap, 8, 'a deliberate operator escalation still runs');
    assert.strictEqual(p.exceedsConfigured, true);
    assert.match(p.note, /EXCEEDS/);
    assert.match(p.note, /3/);
  });

  it('resolveConcurrencyCap stays the cap-only view of the same decision', () => {
    for (const override of [undefined, 2, 8]) {
      assert.strictEqual(
        resolveConcurrencyCap({ config: CONFIG, override }),
        resolveCapPrecedence({ config: CONFIG, override }).cap,
      );
    }
  });
});

describe('the beat envelope reports the cap precedence (AC-6)', () => {
  const DAG = JSON.stringify([{ id: 101, dependsOn: [] }]);
  const CONFIG = { delivery: { deliverRunner: { concurrencyCap: 3 } } };

  it('carries a config-sourced precedence record when no flag was given', () => {
    const { envelope } = runStoriesWaveTick({ dagJson: DAG, config: CONFIG });
    assert.strictEqual(envelope.concurrencyCap, 3);
    assert.strictEqual(envelope.capPrecedence.source, 'config');
    assert.strictEqual(envelope.capPrecedence.exceedsConfigured, false);
  });

  it('an override above the configured cap is visible in the envelope', () => {
    const { envelope } = runStoriesWaveTick({
      dagJson: DAG,
      config: CONFIG,
      concurrency: '8',
    });
    assert.strictEqual(envelope.concurrencyCap, 8);
    assert.strictEqual(envelope.capPrecedence.source, 'flag');
    assert.strictEqual(envelope.capPrecedence.configuredCap, 3);
    assert.strictEqual(envelope.capPrecedence.requestedCap, 8);
    assert.strictEqual(envelope.capPrecedence.exceedsConfigured, true);
  });

  it('the CLI reports the precedence record alongside the cap', () => {
    const { status, envelope } = runCli({
      dag: [{ id: 101, dependsOn: [] }],
      concurrency: '8',
    });
    assert.strictEqual(status, 0);
    assert.strictEqual(envelope.concurrencyCap, 8);
    assert.strictEqual(envelope.capPrecedence.source, 'flag');
    assert.strictEqual(typeof envelope.capPrecedence.note, 'string');
  });
});

// ---------------------------------------------------------------------------
// Story #4950 — the tick reports the in-flight footprint reservation
// ---------------------------------------------------------------------------

describe('buildReadySetEnvelope — inFlightReservation (Story #4950)', () => {
  const held = (id, files) => ({
    id,
    dependsOn: [],
    files,
    labels: ['agent::executing'],
  });

  it('withholds a candidate racing an in-flight Story and names the blocker (AC-4)', () => {
    const { envelope } = buildReadySetEnvelope(
      [
        { id: 1, dependsOn: [], files: ['lib/shared.js'] },
        { id: 2, dependsOn: [], files: ['lib/other.js'] },
      ],
      {
        concurrencyCap: 3,
        inFlight: 1,
        inFlightRecords: [held(9, ['lib/shared.js'])],
      },
    );

    assert.deepEqual(envelope.ready, [2]);
    assert.strictEqual(envelope.inFlightReservation.available, true);
    assert.deepEqual(envelope.inFlightReservation.withheld, [
      {
        id: 1,
        blockedBy: 9,
        reason: 'in-flight-earlier-beat',
        // Both sides declared lib/shared.js in changes[], so this is the
        // guard serializing an intended collision, not an artifact of the
        // evidence widening (Story #5044).
        source: 'declared-overlap',
        paths: ['lib/shared.js'],
      },
    ]);
    // The note must name both sides — an unfilled slot with no explanation is
    // exactly what this report exists to remove.
    assert.match(envelope.inFlightReservation.note, /#1/);
    assert.match(envelope.inFlightReservation.note, /#9/);
    assert.match(envelope.inFlightReservation.note, /in flight/i);
  });

  it('reports available with no withholdings when nothing collides', () => {
    const { envelope } = buildReadySetEnvelope(
      [{ id: 1, dependsOn: [], files: ['lib/a.js'] }],
      {
        concurrencyCap: 3,
        inFlight: 1,
        inFlightRecords: [held(9, ['lib/held.js'])],
      },
    );
    assert.deepEqual(envelope.ready, [1]);
    assert.deepEqual(envelope.inFlightReservation, {
      available: true,
      withheld: [],
      note: null,
    });
  });

  it('says reservation is UNAVAILABLE in flag mode, and leaves selection unchanged (AC-2)', () => {
    // Flag mode supplies a graph and an --in-flight count; no node carries a
    // label, so nothing can classify in-flight and there is no footprint to
    // reserve against. Reporting that explicitly is the point: a silently
    // absent guard reads exactly like a guard that found nothing.
    const nodes = [
      { id: 1, dependsOn: [], files: ['lib/shared.js'] },
      { id: 2, dependsOn: [], files: ['lib/other.js'] },
    ];
    const { envelope } = buildReadySetEnvelope(nodes, {
      concurrencyCap: 3,
      inFlight: 1,
    });

    assert.deepEqual(envelope.ready, [1, 2], 'selection is unchanged');
    assert.strictEqual(envelope.inFlightReservation.available, false);
    assert.deepEqual(envelope.inFlightReservation.withheld, []);
    assert.match(envelope.inFlightReservation.note, /UNAVAILABLE/);
    assert.match(envelope.inFlightReservation.note, /--probe-live/);
  });

  it('reports the reservation on the empty-DAG and cycle short-circuits too', () => {
    const { envelope: empty } = buildReadySetEnvelope([], {
      concurrencyCap: 3,
      inFlightRecords: [],
    });
    assert.deepEqual(empty.inFlightReservation, {
      available: true,
      withheld: [],
      note: null,
    });

    const { envelope: cyclic, exitCode } = buildReadySetEnvelope(
      [
        { id: 1, dependsOn: [2] },
        { id: 2, dependsOn: [1] },
      ],
      { concurrencyCap: 3 },
    );
    assert.strictEqual(exitCode, 2);
    assert.strictEqual(cyclic.inFlightReservation.available, false);
  });

  it('keeps a same-beat withholding out of the reservation report', () => {
    // Two peers racing each other is the pre-existing guard, not a
    // reservation — conflating them would misreport why the slot went unused.
    const { envelope } = buildReadySetEnvelope(
      [
        { id: 1, dependsOn: [], files: ['lib/shared.js'] },
        { id: 2, dependsOn: [], files: ['lib/shared.js'] },
      ],
      { concurrencyCap: 3, inFlightRecords: [] },
    );
    assert.deepEqual(envelope.ready, [1]);
    assert.deepEqual(envelope.inFlightReservation.withheld, []);
  });
});

describe('runProbedStoriesWaveTick — threads the probed in-flight records (AC-2)', () => {
  const CONFIG = { delivery: { deliverRunner: { concurrencyCap: 3 } } };

  /** Run a probe-mode tick against an injected probe result. */
  const tick = (probed) =>
    runProbedStoriesWaveTick({
      stories: '1,2,9',
      config: CONFIG,
      context: () => ({ provider: {}, owner: 'o', repo: 'r', self: null }),
      probe: async () => probed,
    });

  it('reserves the footprints live-probe already fetched', async () => {
    const inFlightRecord = {
      id: 9,
      dependsOn: [],
      files: ['lib/shared.js'],
      body: '',
      labels: ['agent::executing'],
    };
    const { envelope, exitCode } = await tick({
      nodes: [
        {
          id: 1,
          dependsOn: [],
          files: ['lib/shared.js'],
          body: '',
          labels: [],
        },
        { id: 2, dependsOn: [], files: ['lib/other.js'], body: '', labels: [] },
        inFlightRecord,
      ],
      inFlightRecords: [inFlightRecord],
      doneIds: new Set(),
      inFlight: 1,
      blockedIds: [],
      foreignHeld: [],
    });

    assert.strictEqual(exitCode, 0);
    assert.deepEqual(envelope.ready, [2], '#1 races the in-flight #9');
    assert.deepEqual(envelope.inFlightReservation.withheld, [
      {
        id: 1,
        blockedBy: 9,
        reason: 'in-flight-earlier-beat',
        source: 'declared-overlap',
        paths: ['lib/shared.js'],
      },
    ]);
  });

  it('stays available (and empty) when the probe reports nothing in flight', async () => {
    const { envelope } = await tick({
      nodes: [
        { id: 1, dependsOn: [], files: ['lib/a.js'], body: '', labels: [] },
      ],
      inFlightRecords: [],
      doneIds: new Set(),
      inFlight: 0,
      blockedIds: [],
      foreignHeld: [],
    });
    assert.deepEqual(envelope.ready, [1]);
    assert.strictEqual(envelope.inFlightReservation.available, true);
    assert.deepEqual(envelope.inFlightReservation.withheld, []);
  });
});

// ---------------------------------------------------------------------------
// Story #5044 — every withhold is explained, and the guard has a knob
// ---------------------------------------------------------------------------

describe('buildReadySetEnvelope — footprintGuard reports the beat-local half (AC-4)', () => {
  it('names the beat-local skip, its blocker, and the colliding paths', () => {
    // Before #5044 this Story simply vanished from ready[]: the same-beat skip
    // was a bare `continue` and no envelope field mentioned it, so an unfilled
    // slot was indistinguishable from a cap that was never reached.
    const { envelope } = buildReadySetEnvelope(
      [
        { id: 1, dependsOn: [], files: ['lib/shared.js'] },
        { id: 2, dependsOn: [], files: ['lib/shared.js'] },
        { id: 3, dependsOn: [], files: ['lib/other.js'] },
      ],
      { concurrencyCap: 5 },
    );

    assert.deepEqual(envelope.ready, [1, 3]);
    assert.equal(envelope.footprintGuard.mode, 'enforce');
    assert.deepEqual(envelope.footprintGuard.withheld, [
      {
        id: 2,
        blockedBy: 1,
        scope: 'beat',
        source: 'declared-overlap',
        paths: ['lib/shared.js'],
      },
    ]);
    assert.deepEqual(envelope.footprintGuard.advisory, []);
    assert.match(envelope.footprintGuard.note, /#2 ← #1/);
    assert.match(envelope.footprintGuard.note, /lib\/shared\.js/);
  });

  it('AC-7: a prose-only overlap is not a collision and no envelope carries scraped-overlap', () => {
    const { envelope } = buildReadySetEnvelope(
      [
        { id: 1, dependsOn: [], files: ['lib/a.js'] },
        {
          id: 2,
          dependsOn: [],
          files: ['lib/b.js'],
          body: 'the caller in lib/a.js changes shape',
        },
      ],
      { concurrencyCap: 5 },
    );
    assert.deepEqual(envelope.ready, [1, 2]);
    assert.deepEqual(envelope.footprintGuard.withheld, []);
    assert.doesNotMatch(JSON.stringify(envelope), /scraped-overlap/);
  });

  it('reports an empty guard rather than omitting it, on every short-circuit', () => {
    const quiet = { mode: 'enforce', withheld: [], advisory: [], note: null };
    assert.deepEqual(
      buildReadySetEnvelope([], { concurrencyCap: 3 }).envelope.footprintGuard,
      quiet,
    );
    assert.deepEqual(
      buildReadySetEnvelope([{ id: 1, dependsOn: [], files: ['lib/a.js'] }], {
        concurrencyCap: 3,
      }).envelope.footprintGuard,
      quiet,
    );
    // A cycle short-circuits before selection; an absent report would read
    // exactly like a guard that found nothing.
    const { envelope: cyclic } = buildReadySetEnvelope(
      [
        { id: 1, dependsOn: [2] },
        { id: 2, dependsOn: [1] },
      ],
      { concurrencyCap: 3 },
    );
    assert.deepEqual(cyclic.footprintGuard, quiet);
  });

  it('does not manufacture a collision from audit provenance footers (#4875 × #4877)', () => {
    // The composition pin the two Stories never got: #4875 widened the
    // footprint from body text, #4877 made the audit filers stamp provenance
    // footers into that same body text, and nothing tested them together. A
    // semantic key is `area␟primaryFile`, so the path half scraped as evidence
    // and every sibling of an audit-derived plan collided (issue #5040).
    const footers = [
      fingerprintFooter(['b'.repeat(40)]),
      semanticKeyFooter([
        semanticKeyFor({
          area: 'clean-code',
          primaryFile: '.agents/scripts/lib/wave-runner/ready-set.js',
        }),
      ]),
    ].join('\n');
    const contextLink =
      'Opened by `/audit-to-stories` from [audit-clean-code-results.md](temp/audits/audit-clean-code-results.md)';
    const body = (goal) => `${goal}\n\n${contextLink}\n\n${footers}`;

    const { envelope } = buildReadySetEnvelope(
      [
        { id: 1, dependsOn: [], files: ['lib/a.js'], body: body('Fix A') },
        { id: 2, dependsOn: [], files: ['lib/b.js'], body: body('Fix B') },
        { id: 3, dependsOn: [], files: ['lib/c.js'], body: body('Fix C') },
      ],
      { concurrencyCap: 5 },
    );

    assert.deepEqual(
      envelope.ready,
      [1, 2, 3],
      'the whole cohort co-dispatches',
    );
    assert.deepEqual(envelope.footprintGuard.withheld, []);
  });
});

describe('buildReadySetEnvelope — footprintGuard: advisory (AC-5)', () => {
  const colliding = () => [
    { id: 1, dependsOn: [], files: ['lib/a.js'] },
    { id: 2, dependsOn: [], files: ['lib/a.js', 'lib/b.js'] },
  ];

  it('admits the declared-overlap pair and logs the would-be withhold', () => {
    const { envelope } = buildReadySetEnvelope(colliding(), {
      concurrencyCap: 5,
      footprintGuard: 'advisory',
    });

    assert.deepEqual(envelope.ready, [1, 2]);
    assert.equal(envelope.footprintGuard.mode, 'advisory');
    assert.deepEqual(envelope.footprintGuard.withheld, [], 'nothing withheld');
    assert.deepEqual(envelope.footprintGuard.advisory, [
      {
        id: 2,
        blockedBy: 1,
        scope: 'beat',
        source: 'declared-overlap',
        paths: ['lib/a.js'],
      },
    ]);
    assert.match(envelope.footprintGuard.note, /advisory/);
    assert.match(envelope.footprintGuard.note, /lib\/a\.js/);
  });

  it('keeps enforce as the default with today’s behaviour', () => {
    const { envelope } = buildReadySetEnvelope(colliding(), {
      concurrencyCap: 5,
    });
    assert.deepEqual(envelope.ready, [1]);
    assert.equal(envelope.footprintGuard.mode, 'enforce');
    assert.equal(envelope.footprintGuard.advisory.length, 0);
  });
});

describe('resolveFootprintGuardSettings — config seam', () => {
  it('defaults to enforce and the default temp root', () => {
    assert.deepEqual(resolveFootprintGuardSettings({ config: {} }), {
      footprintGuard: 'enforce',
      tempRoot: 'temp',
    });
  });

  it('reads the configured mode and temp root', () => {
    assert.deepEqual(
      resolveFootprintGuardSettings({
        config: {
          project: { paths: { tempRoot: '.scratch' } },
          delivery: { deliverRunner: { footprintGuard: 'advisory' } },
        },
      }),
      { footprintGuard: 'advisory', tempRoot: '.scratch' },
    );
  });

  it('is threaded end to end by runStoriesWaveTick', () => {
    const dag = JSON.stringify([
      { id: 1, dependsOn: [], files: ['lib/a.js'] },
      { id: 2, dependsOn: [], files: ['lib/a.js'] },
    ]);
    const enforced = runStoriesWaveTick({
      dagJson: dag,
      config: { delivery: { deliverRunner: { concurrencyCap: 5 } } },
    });
    assert.deepEqual(enforced.envelope.ready, [1]);

    const advisory = runStoriesWaveTick({
      dagJson: dag,
      config: {
        delivery: {
          deliverRunner: { concurrencyCap: 5, footprintGuard: 'advisory' },
        },
      },
    });
    assert.deepEqual(advisory.envelope.ready, [1, 2]);
    assert.equal(advisory.envelope.footprintGuard.mode, 'advisory');
    assert.equal(advisory.envelope.footprintGuard.advisory.length, 1);
  });
});

describe('the withheld entry names declared paths only (Story #5313)', () => {
  it('two Stories that merely run the same gate in ## Verify co-dispatch', () => {
    const { envelope } = buildReadySetEnvelope(
      [
        {
          id: 5266,
          dependsOn: [],
          files: ['lib/one.js'],
          body: '## Verify\n- node .agents/scripts/check-baselines.js (validate)',
        },
        {
          id: 5267,
          dependsOn: [],
          files: ['lib/two.js'],
          body: '## Verify\n- node .agents/scripts/check-baselines.js (validate)',
        },
      ],
      { concurrencyCap: 5 },
    );
    assert.deepEqual(envelope.ready, [5266, 5267]);
    assert.deepEqual(envelope.footprintGuard.withheld, []);
  });

  it('a declared collision renders the declared-overlap tag and no scrape clause', () => {
    const { envelope } = buildReadySetEnvelope(
      [
        { id: 1, dependsOn: [], files: ['baselines/crap.json'] },
        { id: 2, dependsOn: [], files: ['baselines/crap.json'] },
      ],
      { concurrencyCap: 5 },
    );
    assert.match(envelope.footprintGuard.note, /declared-overlap\)/);
    assert.doesNotMatch(envelope.footprintGuard.note, /scraped/);
    assert.equal('attribution' in envelope.footprintGuard.withheld[0], false);
  });
});

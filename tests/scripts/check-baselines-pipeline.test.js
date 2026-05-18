// tests/scripts/check-baselines-pipeline.test.js
//
// Story #2466 / Task #2493 — byte-identical CLI surface for the thinned
// check-baselines pipeline.
//
// After Story #2466 extracted the per-phase modules under
// `lib/orchestration/check-baselines/phases/`, this fixture-diff test
// pins the public CLI output across the three classes of run the
// operator-facing surface must preserve:
//
//   1. clean PASS  — every gate green, exit code 0.
//   2. FAIL (floor breach) — non-zero exit code, breach surfaced in
//      output, and the structured `report.gates[].breaches` row carries
//      the offending {axis, value, floor, direction} tuple.
//   3. --help — canned `--help` text + exit 0, regardless of config.
//
// The assertions are structural / textual rather than full snapshot
// files: the post-refactor implementation MUST produce the same shape
// the legacy in-line dispatcher produced. Anything sensitive to the
// thinning shuffle (re-exports, phase boundaries, log-line ordering)
// is asserted explicitly.
//
// Run: node --test tests/scripts/check-baselines-pipeline.test.js

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  applyFloors,
  assertFloorAxesExist,
  compareToFloor,
  formatReport,
  parseArgs,
  runCheckBaselines,
  selectEnabledGates,
} from '../../.agents/scripts/check-baselines.js';
import { currentKernelVersion } from '../../.agents/scripts/lib/baselines/kernel.js';

function writeJson(p, value) {
  writeFileSync(p, JSON.stringify(value, null, 2));
}

function coverageEnvelope({ rollup, rows } = {}) {
  return {
    $schema: 'coverage.schema.json',
    kernelVersion: currentKernelVersion('coverage'),
    generatedAt: '2026-01-01T00:00:00.000Z',
    rollup: rollup ?? { '*': { lines: 95, branches: 92, functions: 95 } },
    rows: rows ?? [],
  };
}

function setupTmpRepo({ coverageRollup } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'check-baselines-pipeline-'));
  mkdirSync(path.join(root, 'baselines'), { recursive: true });
  const agentrc = {
    project: {
      baseBranch: 'main',
      paths: { agentRoot: '.agents', docsRoot: 'docs', tempRoot: 'temp' },
      docsContextFiles: [],
      commands: { lintBaseline: 'echo', test: 'echo', typecheck: 'echo' },
    },
    github: { owner: 'x', repo: 'y' },
    delivery: {
      quality: {
        gates: {
          coverage: {
            enabled: true,
            baselinePath: 'baselines/coverage.json',
            tolerance: { kind: 'absolute', value: 0 },
            floors: { '*': { lines: 90, branches: 85, functions: 90 } },
          },
        },
      },
    },
  };
  writeJson(path.join(root, '.agentrc.json'), agentrc);
  writeJson(
    path.join(root, 'baselines', 'coverage.json'),
    coverageEnvelope({ rollup: coverageRollup }),
  );
  return root;
}

describe('check-baselines-pipeline — byte-identical surface (Story #2466)', () => {
  let root;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('clean PASS fixture: exit code 0, single gate, no breaches', async () => {
    root = setupTmpRepo();
    const res = await runCheckBaselines({
      argv: ['--no-friction'],
      cwd: root,
    });
    assert.equal(res.exitCode, 0);
    assert.equal(res.report.gates.length, 1);
    assert.equal(res.report.gates[0].kind, 'coverage');
    assert.equal(res.report.gates[0].breachCount, 0);
    assert.equal(res.report.totalBreaches, 0);
    assert.equal(res.report.schemaErrors.length, 0);
    assert.equal(res.frictionEvents.length, 0);
  });

  it('FAIL (floor breach) fixture: exit code 1, breach surfaced with full tuple', async () => {
    root = setupTmpRepo({
      coverageRollup: { '*': { lines: 80, branches: 75, functions: 80 } },
    });
    const res = await runCheckBaselines({
      argv: ['--no-friction'],
      cwd: root,
    });
    assert.equal(res.exitCode, 1);
    assert.equal(res.report.totalBreaches, 3);
    const gate = res.report.gates[0];
    assert.equal(gate.breachCount, 3);
    // Per-axis breach shape: { axis, value, floor, direction, component }.
    const axes = gate.breaches.map((b) => b.axis).sort();
    assert.deepEqual(axes, ['branches', 'functions', 'lines']);
    for (const b of gate.breaches) {
      assert.equal(b.direction, 'gte');
      assert.equal(b.component, '*');
      assert.equal(typeof b.value, 'number');
      assert.equal(typeof b.floor, 'number');
      assert.ok(b.value < b.floor, 'breach must have value < floor');
    }
  });

  it('--help fixture: exit 0, canned text, knownKinds advertised', async () => {
    root = setupTmpRepo();
    const res = await runCheckBaselines({ argv: ['--help'], cwd: root });
    assert.equal(res.exitCode, 0);
    assert.equal(res.report.help, true);
    assert.ok(Array.isArray(res.report.knownKinds));
    assert.ok(res.report.knownKinds.includes('coverage'));
    assert.ok(res.report.knownKinds.includes('lint'));
    assert.match(res.output, /Usage: check-baselines\.js/);
    assert.match(res.output, /Exit codes:/);
  });

  it('JSON output is the formatted report by default', async () => {
    root = setupTmpRepo();
    const res = await runCheckBaselines({
      argv: ['--no-friction'],
      cwd: root,
    });
    // Default format is `json`; the output must round-trip back into the
    // structured report verbatim (byte-identical contract for CI parsers).
    const reparsed = JSON.parse(res.output);
    assert.equal(reparsed.schemaVersion, '1');
    assert.equal(reparsed.gates.length, 1);
    assert.equal(reparsed.totalBreaches, 0);
  });

  it('text format emits the legacy header + per-gate lines', async () => {
    root = setupTmpRepo();
    const res = await runCheckBaselines({
      argv: ['--no-friction', '--format', 'text'],
      cwd: root,
    });
    const lines = res.output.split('\n');
    assert.match(lines[0], /^\[check-baselines\] 1 gate\(s\) — /);
    assert.match(lines[0], /breaches=0, regressions=0/);
    assert.ok(
      lines.some((l) => l.startsWith('  - coverage: PASS')),
      'text output must list per-gate status lines',
    );
  });
});

describe('check-baselines-pipeline — public exports (Story #2466)', () => {
  it('re-exports the named surface the legacy module published', () => {
    // Pin: removing any of these breaks downstream tests + scripts.
    assert.equal(typeof runCheckBaselines, 'function');
    assert.equal(typeof parseArgs, 'function');
    assert.equal(typeof selectEnabledGates, 'function');
    assert.equal(typeof formatReport, 'function');
    assert.equal(typeof applyFloors, 'function');
    assert.equal(typeof compareToFloor, 'function');
    assert.equal(typeof assertFloorAxesExist, 'function');
  });

  it('parseArgs round-trips every supported flag', () => {
    const parsed = parseArgs([
      '--config',
      '/tmp/x.json',
      '--gate',
      'coverage,lint',
      '--format',
      'text',
      '--no-friction',
      '--story',
      '42',
      '--epic',
      '99',
    ]);
    assert.equal(parsed.configPath, '/tmp/x.json');
    assert.deepEqual(parsed.gates, ['coverage', 'lint']);
    assert.equal(parsed.format, 'text');
    assert.equal(parsed.friction, false);
    assert.equal(parsed.storyId, '42');
    assert.equal(parsed.epicId, '99');
  });

  it('parseArgs rejects unknown flags with a descriptive message', () => {
    assert.throws(() => parseArgs(['--bogus']), /unknown flag "--bogus"/);
  });
});

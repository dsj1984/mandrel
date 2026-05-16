// tests/scripts/check-baselines.test.js
//
// Story #1912 / Task #1915 — contract tests for the thin unified runtime
// gate at `.agents/scripts/check-baselines.js`. Cover the pass / floor-
// breach / schema-error / config-error exit paths plus the small set of
// pure helpers (`parseArgs`, `selectEnabledGates`, `compareToFloor`,
// `applyFloors`, `formatReport`).

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  applyFloors,
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

function coverageEnvelope({ rollup, kernelVersion } = {}) {
  return {
    $schema: 'coverage.schema.json',
    kernelVersion: kernelVersion ?? currentKernelVersion('coverage'),
    generatedAt: '2026-01-01T00:00:00.000Z',
    rollup: rollup ?? { '*': { lines: 95, branches: 92, functions: 95 } },
    rows: [],
  };
}

function setupTmpRepo(extraConfig = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'check-baselines-test-'));
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
          ...(extraConfig.gates ?? {}),
        },
      },
    },
  };
  if (extraConfig.coverageGate) {
    agentrc.delivery.quality.gates.coverage = extraConfig.coverageGate;
  }
  writeJson(path.join(root, '.agentrc.json'), agentrc);
  return root;
}

describe('check-baselines — parseArgs', () => {
  it('defaults to JSON format with friction enabled', () => {
    const a = parseArgs([]);
    assert.equal(a.format, 'json');
    assert.equal(a.friction, true);
    assert.equal(a.configPath, null);
    assert.equal(a.gates, null);
  });

  it('accepts --gate as a comma-separated list and repeated flag', () => {
    const a = parseArgs(['--gate', 'coverage,crap', '--gate', 'lint']);
    assert.deepEqual(a.gates, ['coverage', 'crap', 'lint']);
  });

  it('--no-friction suppresses friction emission', () => {
    const a = parseArgs(['--no-friction']);
    assert.equal(a.friction, false);
  });

  it('rejects unknown --format values', () => {
    assert.throws(
      () => parseArgs(['--format', 'xml']),
      /expects "json" or "text"/,
    );
  });

  it('rejects unknown flags', () => {
    assert.throws(() => parseArgs(['--mystery']), /unknown flag/);
  });
});

describe('check-baselines — selectEnabledGates', () => {
  it('returns kinds in canonical order, skipping disabled', () => {
    const quality = {
      gates: {
        coverage: { enabled: true, floors: {} },
        crap: { enabled: false, floors: {} },
        lint: { enabled: true, floors: {} },
        maintainability: { enabled: true, floors: {} },
      },
    };
    assert.deepEqual(selectEnabledGates(quality), [
      'lint',
      'coverage',
      'maintainability',
    ]);
  });

  it('treats missing gates block as empty', () => {
    assert.deepEqual(selectEnabledGates({}), []);
  });
});

describe('check-baselines — compareToFloor', () => {
  it('coverage axes use >= direction', () => {
    const v = compareToFloor(
      'coverage',
      { lines: 80, branches: 90, functions: 95 },
      { lines: 90, branches: 85, functions: 90 },
    );
    const axes = v.map((x) => x.axis).sort();
    assert.deepEqual(axes, ['lines']);
  });

  it('lint axes use <= direction', () => {
    const v = compareToFloor(
      'lint',
      { errorCount: 3, warningCount: 0 },
      { errorCount: 0, warningCount: 0 },
    );
    assert.equal(v.length, 1);
    assert.equal(v[0].axis, 'errorCount');
    assert.equal(v[0].direction, 'lte');
  });

  it('mutation survived uses <= and score uses >=', () => {
    const v = compareToFloor(
      'mutation',
      { score: 60, survived: 50, killed: 30, noCoverage: 0 },
      { score: 80, survived: 30 },
    );
    const failing = v.map((x) => x.axis).sort();
    assert.deepEqual(failing, ['score', 'survived']);
  });

  it('crap max uses <= direction', () => {
    const v = compareToFloor('crap', { max: 35 }, { max: 30 });
    assert.equal(v.length, 1);
    assert.equal(v[0].direction, 'lte');
  });

  it('missing floor entry yields no violations', () => {
    const v = compareToFloor('coverage', { lines: 50 }, {});
    assert.equal(v.length, 0);
  });
});

describe('check-baselines — applyFloors', () => {
  it("emits '*' first followed by alpha-sorted components", () => {
    const findings = applyFloors(
      'coverage',
      {
        '*': { lines: 90, branches: 85, functions: 90 },
        scripts: { lines: 92, branches: 88, functions: 92 },
        tests: { lines: 80, branches: 80, functions: 95 },
      },
      { '*': { lines: 85, branches: 80, functions: 85 } },
    );
    assert.equal(findings[0].component, '*');
    assert.equal(findings[1].component, 'scripts');
    assert.equal(findings[2].component, 'tests');
  });

  it('floors fall back to the * entry when a component-specific floor is absent', () => {
    const findings = applyFloors(
      'coverage',
      { '*': { lines: 80 }, scripts: { lines: 70 } },
      { '*': { lines: 75 } },
    );
    const scripts = findings.find((f) => f.component === 'scripts');
    assert.equal(scripts.violations.length, 1);
  });
});

describe('check-baselines — integration (pass / floor-breach / schema-error / config-error)', () => {
  let root;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('exits 0 when every gate passes', async () => {
    root = setupTmpRepo();
    writeJson(
      path.join(root, 'baselines', 'coverage.json'),
      coverageEnvelope(),
    );
    const res = await runCheckBaselines({
      argv: ['--no-friction'],
      cwd: root,
    });
    assert.equal(res.exitCode, 0);
    assert.equal(res.report.totalBreaches, 0);
    assert.equal(res.report.schemaErrors.length, 0);
    assert.equal(res.report.gates[0].kind, 'coverage');
  });

  it('exits 1 on any floor breach', async () => {
    root = setupTmpRepo();
    writeJson(
      path.join(root, 'baselines', 'coverage.json'),
      coverageEnvelope({
        rollup: { '*': { lines: 50, branches: 50, functions: 50 } },
      }),
    );
    const res = await runCheckBaselines({
      argv: ['--no-friction'],
      cwd: root,
    });
    assert.equal(res.exitCode, 1);
    assert.ok(res.report.totalBreaches > 0);
  });

  it('Story #2125: framework-default floors apply when consumer omits floors block', async () => {
    // Consumer .agentrc.json carries an empty floors bag — the unified
    // gate must still enforce the framework default (lines:90, branches:85,
    // functions:90) by virtue of the resolver-side defaults injection.
    root = setupTmpRepo({
      coverageGate: {
        enabled: true,
        baselinePath: 'baselines/coverage.json',
        tolerance: { kind: 'absolute', value: 0 },
        floors: {},
      },
    });
    writeJson(
      path.join(root, 'baselines', 'coverage.json'),
      coverageEnvelope({
        rollup: { '*': { lines: 50, branches: 50, functions: 50 } },
      }),
    );
    const res = await runCheckBaselines({
      argv: ['--no-friction'],
      cwd: root,
    });
    assert.equal(res.exitCode, 1);
    assert.ok(res.report.totalBreaches > 0);
  });

  it('Story #2125: framework defaults pass when rollup clears them', async () => {
    // Same setup but rollup is comfortably above the framework default.
    root = setupTmpRepo({
      coverageGate: {
        enabled: true,
        baselinePath: 'baselines/coverage.json',
        tolerance: { kind: 'absolute', value: 0 },
        floors: {},
      },
    });
    writeJson(
      path.join(root, 'baselines', 'coverage.json'),
      coverageEnvelope({
        rollup: { '*': { lines: 95, branches: 92, functions: 95 } },
      }),
    );
    const res = await runCheckBaselines({
      argv: ['--no-friction'],
      cwd: root,
    });
    assert.equal(res.exitCode, 0);
    assert.equal(res.report.totalBreaches, 0);
  });

  it('exits 2 on schema validation error', async () => {
    root = setupTmpRepo();
    // Missing required fields → schema rejection.
    writeJson(path.join(root, 'baselines', 'coverage.json'), {
      $schema: 'coverage.schema.json',
      rows: 'not-an-array',
    });
    const res = await runCheckBaselines({
      argv: ['--no-friction'],
      cwd: root,
    });
    assert.equal(res.exitCode, 2);
    assert.equal(res.report.schemaErrors.length, 1);
    assert.equal(res.report.schemaErrors[0].kind, 'coverage');
  });

  it('exits 3 (via thrown error) when the config file is malformed', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'check-baselines-badconfig-'));
    try {
      // Write a syntactically-invalid JSON document so `resolveConfig`
      // throws — the CLI shell maps a throw out of `runCheckBaselines`
      // to exit code 3.
      writeFileSync(path.join(tmp, '.agentrc.json'), '{ not: valid');
      await assert.rejects(() =>
        runCheckBaselines({ argv: ['--no-friction'], cwd: tmp }),
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('check-baselines — kernel mismatch', () => {
  let root;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('flags kernel drift without changing the exit code', async () => {
    root = setupTmpRepo();
    writeJson(
      path.join(root, 'baselines', 'coverage.json'),
      coverageEnvelope({ kernelVersion: '9.9.9' }),
    );
    const res = await runCheckBaselines({
      argv: ['--no-friction'],
      cwd: root,
    });
    assert.equal(res.exitCode, 0);
    assert.equal(res.report.kernelDriftCount, 1);
    assert.equal(res.report.gates[0].kernelMatch, false);
  });
});

describe('check-baselines — formatReport', () => {
  it('JSON output round-trips through JSON.parse', () => {
    const report = {
      schemaVersion: '1',
      cwd: '/tmp/x',
      gates: [
        {
          kind: 'coverage',
          enabled: true,
          kernelMatch: true,
          kernelCurrent: '1.0.0',
          kernelBaseline: '1.0.0',
          tolerance: { kind: 'absolute', value: 0 },
          floors: { '*': { lines: 90 } },
          components: [{ component: '*', violations: [] }],
          breachCount: 0,
          generatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      totalBreaches: 0,
      kernelDriftCount: 0,
      schemaErrors: [],
    };
    const out = formatReport(report, 'json');
    const parsed = JSON.parse(out);
    assert.equal(parsed.gates[0].kind, 'coverage');
  });

  it('text output is a single newline-joined block (no JSON markup)', () => {
    const report = {
      schemaVersion: '1',
      cwd: '/tmp/x',
      gates: [
        {
          kind: 'coverage',
          enabled: true,
          kernelMatch: true,
          kernelCurrent: '1.0.0',
          kernelBaseline: '1.0.0',
          tolerance: null,
          floors: {},
          components: [{ component: '*', violations: [] }],
          breachCount: 0,
        },
      ],
      totalBreaches: 0,
      kernelDriftCount: 0,
      schemaErrors: [],
    };
    const out = formatReport(report, 'text');
    assert.ok(out.includes('coverage: PASS'));
    assert.ok(!out.startsWith('{'));
  });
});

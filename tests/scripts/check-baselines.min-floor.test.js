// tests/scripts/check-baselines.min-floor.test.js
//
// Story #2193 / Task #2200 — AC-5: the unified `check-baselines.js`
// dispatcher MUST fail closed when `rollup['*'].min` drops below the
// configured maintainability floor.
//
// Pre-#2193 the framework default was `{ '*': { maintainability: 70 } }`,
// which silently no-oped because the maintainability rollup exposes
// `min` / `p50` / `p95` axes, not `maintainability`. Task #2198 corrected
// the default to `{ '*': { min: 70 } }`; this test pins the integration
// contract end-to-end: a rollup `min` of 65 trips the gate, 75 passes,
// and the breach payload names the `min` axis and the observed value.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { runCheckBaselines } from '../../.agents/scripts/check-baselines.js';
import { currentKernelVersion } from '../../.agents/scripts/lib/baselines/kernel.js';

function writeJson(p, value) {
  writeFileSync(p, JSON.stringify(value, null, 2));
}

function maintainabilityEnvelope({ min }) {
  return {
    $schema: 'maintainability.schema.json',
    kernelVersion: currentKernelVersion('maintainability'),
    generatedAt: '2026-01-01T00:00:00.000Z',
    // Rollup must satisfy the schema's required min/p50/p95 trio. Only
    // `min` is load-bearing for the floor assertion under test.
    rollup: { '*': { min, p50: 88, p95: 95 } },
    rows: [{ path: 'src/example.js', mi: min }],
  };
}

function setupRepo({ floors } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'check-baselines-mi-min-'));
  mkdirSync(path.join(root, 'baselines'), { recursive: true });
  const gate = {
    enabled: true,
    baselinePath: 'baselines/maintainability.json',
    tolerance: { kind: 'absolute', value: 0.5 },
  };
  // When `floors` is omitted, the consumer is opting into framework
  // defaults — the resolver injects `{ '*': { min: 70 } }` (Story #2125 +
  // #2193) so the gate enforces the 70-MI floor with no consumer override.
  if (floors !== undefined) gate.floors = floors;
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
          maintainability: gate,
        },
      },
    },
  };
  writeJson(path.join(root, '.agentrc.json'), agentrc);
  return root;
}

describe('check-baselines — maintainability min floor (Story #2193 AC-5)', () => {
  let root;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('fails closed when rollup["*"].min drops below the default 70 floor', async () => {
    root = setupRepo({ floors: {} }); // empty → resolver injects defaults
    writeJson(
      path.join(root, 'baselines', 'maintainability.json'),
      maintainabilityEnvelope({ min: 65 }),
    );
    const res = await runCheckBaselines({
      argv: ['--no-friction', '--gate', 'maintainability'],
      cwd: root,
    });
    assert.equal(res.exitCode, 1, 'EXIT_FLOOR (1) on min < default floor');
    assert.equal(res.report.totalBreaches, 1);
    const gate = res.report.gates[0];
    assert.equal(gate.kind, 'maintainability');
    const breach = gate.breaches[0];
    assert.equal(breach.axis, 'min', 'breach names the `min` axis');
    assert.equal(breach.value, 65, 'breach carries the observed value');
    assert.equal(breach.floor, 70, 'breach carries the configured floor');
    assert.equal(breach.direction, 'gte');
    assert.equal(breach.component, '*');
  });

  it('passes when rollup["*"].min clears the default 70 floor', async () => {
    root = setupRepo({ floors: {} });
    writeJson(
      path.join(root, 'baselines', 'maintainability.json'),
      maintainabilityEnvelope({ min: 75 }),
    );
    const res = await runCheckBaselines({
      argv: ['--no-friction', '--gate', 'maintainability'],
      cwd: root,
    });
    assert.equal(res.exitCode, 0);
    assert.equal(res.report.totalBreaches, 0);
  });

  it('text output names the breached axis and observed value', async () => {
    root = setupRepo({ floors: {} });
    writeJson(
      path.join(root, 'baselines', 'maintainability.json'),
      maintainabilityEnvelope({ min: 65 }),
    );
    const res = await runCheckBaselines({
      argv: ['--no-friction', '--gate', 'maintainability', '--format', 'text'],
      cwd: root,
    });
    assert.equal(res.exitCode, 1);
    assert.match(
      res.output,
      /\*\.min: 65 < floor 70/,
      'text output line names the `*` component, `min` axis, observed 65 and floor 70',
    );
  });

  it('honours an explicit consumer-supplied min floor', async () => {
    // Set a stricter custom floor and prove the gate enforces it.
    root = setupRepo({ floors: { '*': { min: 80 } } });
    writeJson(
      path.join(root, 'baselines', 'maintainability.json'),
      maintainabilityEnvelope({ min: 75 }),
    );
    const res = await runCheckBaselines({
      argv: ['--no-friction', '--gate', 'maintainability'],
      cwd: root,
    });
    assert.equal(res.exitCode, 1);
    assert.equal(res.report.gates[0].breaches[0].floor, 80);
    assert.equal(res.report.gates[0].breaches[0].value, 75);
  });
});

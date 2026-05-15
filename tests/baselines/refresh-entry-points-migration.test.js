import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { assertEnvelope } from '../../.agents/scripts/lib/baselines/envelope.js';
import { writeBaseline } from '../../.agents/scripts/lib/coverage-baseline.js';

// ---------------------------------------------------------------------------
// refresh-entry-points-migration.test.js — Task #1901 contract tests.
//
// Acceptance:
//   - No call site under .agents/scripts writes a baseline JSON file via
//     fs.writeFileSync anymore (grep returns zero hits outside the writer
//     module + a small allowlist of unrelated baseline-store / snapshot
//     helpers).
//   - Each migrated refresh entry point preserves its prior CLI surface
//     (no new required flags).
//   - Refresh scripts run end-to-end against a synthetic fixture without
//     throwing, producing envelope-shape JSON that passes assertEnvelope.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

describe('coverage-baseline.writeBaseline — envelope migration', () => {
  let workDir;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), 'mandrel-cov-baseline-'));
    mkdirSync(path.join(workDir, 'baselines'), { recursive: true });
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('writes an envelope-shape baseline that passes assertEnvelope', () => {
    const baseline = {
      'src/a.js': {
        lines: 90,
        branches: 80,
        functions: 100,
        denominators: { lines: 10, branches: 5, functions: 2 },
      },
      'src/b.js': { lines: 50, branches: 50, functions: 50 },
    };
    writeBaseline(workDir, baseline);
    const parsed = JSON.parse(
      readFileSync(path.join(workDir, 'baselines', 'coverage.json'), 'utf8'),
    );
    assert.equal(
      parsed.$schema,
      '.agents/schemas/baselines/coverage.schema.json',
    );
    assert.equal(typeof parsed.kernelVersion, 'string');
    assert.equal(typeof parsed.generatedAt, 'string');
    assert.ok(Object.hasOwn(parsed.rollup, '*'));
    assert.doesNotThrow(() => assertEnvelope(parsed));
  });

  it('strips the runtime-only denominators field from rows', () => {
    const baseline = {
      'src/a.js': {
        lines: 90,
        branches: 80,
        functions: 100,
        denominators: { lines: 10, branches: 5, functions: 2 },
      },
    };
    writeBaseline(workDir, baseline);
    const parsed = JSON.parse(
      readFileSync(path.join(workDir, 'baselines', 'coverage.json'), 'utf8'),
    );
    for (const row of parsed.rows) {
      assert.equal('denominators' in row, false);
    }
  });

  it('sorts rows alphabetically by path', () => {
    const baseline = {
      'src/z.js': { lines: 90, branches: 80, functions: 100 },
      'src/a.js': { lines: 50, branches: 50, functions: 50 },
    };
    writeBaseline(workDir, baseline);
    const parsed = JSON.parse(
      readFileSync(path.join(workDir, 'baselines', 'coverage.json'), 'utf8'),
    );
    assert.deepEqual(
      parsed.rows.map((r) => r.path),
      ['src/a.js', 'src/z.js'],
    );
  });

  it('canonicalises worktree-prefixed paths', () => {
    const baseline = {
      '.worktrees/story-1/src/a.js': {
        lines: 90,
        branches: 80,
        functions: 100,
      },
    };
    writeBaseline(workDir, baseline);
    const parsed = JSON.parse(
      readFileSync(path.join(workDir, 'baselines', 'coverage.json'), 'utf8'),
    );
    assert.equal(parsed.rows[0].path, 'src/a.js');
  });
});

describe('update-maintainability-baseline.js — end-to-end smoke', () => {
  let workDir;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), 'mandrel-mi-update-'));
    mkdirSync(path.join(workDir, '.agents'), { recursive: true });
    mkdirSync(path.join(workDir, 'src'), { recursive: true });
    mkdirSync(path.join(workDir, 'baselines'), { recursive: true });
    // Synthetic fixture: minimal source so the scanner emits at least one row.
    writeFileSync(
      path.join(workDir, 'src', 'a.js'),
      'export function add(a, b) {\n  return a + b;\n}\n',
    );
    // Minimal .agentrc.json so resolveConfig finds the targetDirs/baseline path.
    writeFileSync(
      path.join(workDir, '.agentrc.json'),
      JSON.stringify(
        {
          project: { baseBranch: 'main' },
          delivery: {
            quality: {
              gates: {
                maintainability: {
                  enabled: true,
                  baselinePath: 'baselines/maintainability.json',
                  targetDirs: ['src'],
                },
              },
            },
          },
        },
        null,
        2,
      ),
    );
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('runs to completion and writes an envelope-shape baseline', () => {
    const cliPath = path.join(
      REPO_ROOT,
      '.agents',
      'scripts',
      'update-maintainability-baseline.js',
    );
    // The CLI inherits cwd, MANDREL_BASELINE_GENERATED_AT pin makes the
    // output deterministic so we can assert the timestamp.
    execFileSync(process.execPath, [cliPath], {
      cwd: workDir,
      env: {
        ...process.env,
        MANDREL_BASELINE_GENERATED_AT: '2026-05-15T00:00:00Z',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const baselinePath = path.join(
      workDir,
      'baselines',
      'maintainability.json',
    );
    const parsed = JSON.parse(readFileSync(baselinePath, 'utf8'));
    assert.equal(
      parsed.$schema,
      '.agents/schemas/baselines/maintainability.schema.json',
    );
    assert.equal(parsed.generatedAt, '2026-05-15T00:00:00Z');
    assert.ok(Object.hasOwn(parsed.rollup, '*'));
    assert.ok(Array.isArray(parsed.rows));
    assert.doesNotThrow(() => assertEnvelope(parsed));
  });
});

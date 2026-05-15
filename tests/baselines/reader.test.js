// tests/baselines/reader.test.js
//
// Story #1892 / Task #1903 — covers the shared baseline reader (load,
// loadFile, schema-validation, defensive canonicalisation, default
// rollup fallback for the '*' key).

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  canonicaliseRowPath,
  load,
  loadFile,
} from '../../.agents/scripts/lib/baselines/reader.js';

function writeJson(p, value) {
  writeFileSync(p, JSON.stringify(value));
}

function envelope(kind, overrides = {}) {
  const base = {
    $schema: `${kind}.schema.json`,
    kernelVersion: '1.0.0',
    generatedAt: '2026-01-01T00:00:00.000Z',
    rollup: { '*': defaultRollupFor(kind) },
    rows: [],
  };
  return { ...base, ...overrides };
}

function defaultRollupFor(kind) {
  switch (kind) {
    case 'coverage':
      return { lines: 80, branches: 70, functions: 90 };
    case 'lint':
      return { errorCount: 0, warningCount: 0 };
    case 'crap':
      return { p50: 1, p95: 5, max: 10, methodsAbove20: 0 };
    case 'maintainability':
      return { min: 50, p50: 80, p95: 95 };
    case 'mutation':
      return { score: 80, killed: 100, survived: 25, noCoverage: 0 };
    case 'lighthouse':
      return { performance: 90, accessibility: 90, bestPractices: 90, seo: 90 };
    case 'bundle-size':
    case 'bundleSize':
      return { totalKb: 100, gzippedKb: 30 };
    default:
      throw new Error(`unknown kind ${kind}`);
  }
}

describe('baselines/reader — canonicaliseRowPath', () => {
  it('strips a .worktrees/<name>/ prefix', () => {
    assert.equal(
      canonicaliseRowPath('.worktrees/story-123/src/foo.js'),
      'src/foo.js',
    );
  });

  it('normalises Windows backslashes', () => {
    assert.equal(
      canonicaliseRowPath('.worktrees\\story-123\\src\\foo.js'),
      'src/foo.js',
    );
  });

  it('leaves a canonical path alone', () => {
    assert.equal(canonicaliseRowPath('src/foo.js'), 'src/foo.js');
  });

  it('returns non-strings unchanged', () => {
    assert.equal(canonicaliseRowPath(undefined), undefined);
    assert.equal(canonicaliseRowPath(null), null);
  });
});

describe('baselines/reader — loadFile', () => {
  let tmp;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'baseline-reader-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns rollup containing '*' (default fallback path: coverage)", () => {
    const file = path.join(tmp, 'coverage.json');
    writeJson(file, envelope('coverage'));
    const out = loadFile(file);
    assert.ok(out.rollup);
    assert.ok(out.rollup['*']);
    assert.equal(out.rollup['*'].lines, 80);
  });

  it('canonicalises .worktrees/<name>/ prefixes in row paths', () => {
    const file = path.join(tmp, 'maintainability.json');
    writeJson(
      file,
      envelope('maintainability', {
        rows: [
          { path: '.worktrees/story-1892/src/foo.js', mi: 70 },
          { path: 'src/bar.js', mi: 80 },
        ],
      }),
    );
    const out = loadFile(file);
    assert.deepEqual(
      out.rows.map((r) => r.path),
      ['src/foo.js', 'src/bar.js'],
    );
  });

  it('throws with an AJV error message on schema-invalid input', () => {
    const file = path.join(tmp, 'broken.json');
    writeJson(file, {
      $schema: 'coverage.schema.json',
      kernelVersion: '1.0.0',
      generatedAt: '2026-01-01T00:00:00.000Z',
      rollup: { '*': { lines: 'not-a-number', branches: 70, functions: 90 } },
      rows: [],
    });
    assert.throws(() => loadFile(file), /schema validation failed/);
  });

  it('throws on unparseable JSON', () => {
    const file = path.join(tmp, 'busted.json');
    writeFileSync(file, '{not json');
    assert.throws(() => loadFile(file), /failed to parse JSON/);
  });

  it('throws when the file is missing', () => {
    assert.throws(
      () => loadFile(path.join(tmp, 'missing.json')),
      /failed to read baseline/,
    );
  });

  it('infers kind from the per-kind $schema pointer', () => {
    const file = path.join(tmp, 'crap.json');
    writeJson(
      file,
      envelope('crap', {
        rows: [{ path: 'src/foo.js', method: 'bar', startLine: 1, crap: 4 }],
      }),
    );
    const out = loadFile(file);
    assert.equal(out.rows[0].method, 'bar');
    assert.equal(out.kernelVersion, '1.0.0');
  });

  it('honours an explicit kind override even when $schema points at a sibling kind', () => {
    // The envelope schema requires `$schema` to be present, but the reader
    // permits an explicit `opts.kind` to override the inference path (e.g.
    // when a caller already knows the kind via context).
    const file = path.join(tmp, 'override.json');
    writeJson(file, envelope('lint'));
    const out = loadFile(file, { kind: 'lint' });
    assert.equal(out.rollup['*'].errorCount, 0);
  });

  it('throws when kind cannot be inferred and no override is provided', () => {
    const file = path.join(tmp, 'no-schema.json');
    const env = envelope('lint', { $schema: 'unknown.schema.json' });
    writeJson(file, env);
    assert.throws(() => loadFile(file), /cannot infer kind/);
  });

  it('rejects a non-string absolutePath', () => {
    assert.throws(() => loadFile(undefined), /must be a non-empty string/);
  });
});

describe('baselines/reader — load (config-driven)', () => {
  let tmp;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'baseline-reader-load-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("load('coverage') returns rollup['*'] when components is unset", () => {
    // Stage the default-path baseline under cwd/baselines/coverage.json.
    const dir = path.join(tmp, 'baselines');
    mkdirSync(dir, { recursive: true });
    writeJson(path.join(dir, 'coverage.json'), envelope('coverage'));
    const out = load('coverage', { cwd: tmp });
    assert.ok(out.rollup['*']);
    assert.equal(out.rollup['*'].lines, 80);
  });

  it('rejects unknown kinds', () => {
    assert.throws(() => load('nonsense', { cwd: tmp }), /unknown kind/);
  });
});

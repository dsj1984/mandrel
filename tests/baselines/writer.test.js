import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { assertEnvelope } from '../../.agents/scripts/lib/baselines/envelope.js';
import {
  write,
  writeFile,
} from '../../.agents/scripts/lib/baselines/writer.js';

// ---------------------------------------------------------------------------
// writer.test.js — round-trip and idempotency fixtures for the shared
// baseline writer (Story #1891). Acceptance:
//
//   1. write() emits an envelope that passes assertEnvelope for every kind.
//   2. Re-running write() on identical input is byte-identical.
//   3. Absolute paths in rows[] abort the write with a clear error.
//   4. rollup["*"] is always present even when components is undefined.
// ---------------------------------------------------------------------------

const FIXED_TIMESTAMP = '2026-05-15T00:00:00Z';

const FIXTURES = {
  lint: {
    kind: 'lint',
    rows: [
      { path: 'src/b.js', errorCount: 0, warningCount: 1 },
      { path: 'src/a.js', errorCount: 2, warningCount: 0 },
    ],
  },
  coverage: {
    kind: 'coverage',
    rows: [
      { path: 'src/a.js', lines: 91, branches: 80, functions: 100 },
      { path: 'src/b.js', lines: 70, branches: 50, functions: 80 },
    ],
  },
  crap: {
    kind: 'crap',
    rows: [
      { path: 'src/a.js', method: 'foo', startLine: 10, crap: 4.2 },
      { path: 'src/a.js', method: 'bar', startLine: 5, crap: 25 },
      { path: 'src/b.js', method: 'baz', startLine: 1, crap: 1 },
    ],
  },
  maintainability: {
    kind: 'maintainability',
    rows: [
      { path: 'src/a.js', mi: 72 },
      { path: 'src/b.js', mi: 88 },
    ],
  },
  mutation: {
    kind: 'mutation',
    rows: [{ path: 'src/a.js', score: 80, killed: 8, survived: 2 }],
  },
  lighthouse: {
    kind: 'lighthouse',
    rows: [
      {
        route: '/',
        performance: 90,
        accessibility: 95,
        bestPractices: 92,
        seo: 100,
      },
    ],
  },
  'bundle-size': {
    kind: 'bundle-size',
    rows: [{ bundle: 'main', rawKb: 250, gzippedKb: 80 }],
  },
};

function buildWithFixedClock(input) {
  return write({ ...input, generatedAt: FIXED_TIMESTAMP });
}

describe('write() — schema conformance per kind', () => {
  for (const [kind, fixture] of Object.entries(FIXTURES)) {
    it(`emits an assertEnvelope-passing envelope for ${kind}`, () => {
      const env = buildWithFixedClock(fixture);
      assert.doesNotThrow(() => assertEnvelope(env));
      assert.equal(
        env.$schema,
        `.agents/schemas/baselines/${kind}.schema.json`,
      );
      assert.equal(env.generatedAt, FIXED_TIMESTAMP);
      assert.ok(typeof env.kernelVersion === 'string');
      assert.ok(Object.hasOwn(env.rollup, '*'));
    });
  }
});

describe('write() — idempotency', () => {
  it('two writes with identical input produce byte-identical envelopes', () => {
    const a = JSON.stringify(buildWithFixedClock(FIXTURES.crap), null, 2);
    const b = JSON.stringify(buildWithFixedClock(FIXTURES.crap), null, 2);
    assert.equal(a, b);
  });

  it('row-order in the input does not affect the output', () => {
    const shuffled = {
      ...FIXTURES.lint,
      rows: [...FIXTURES.lint.rows].reverse(),
    };
    const a = JSON.stringify(buildWithFixedClock(FIXTURES.lint), null, 2);
    const b = JSON.stringify(buildWithFixedClock(shuffled), null, 2);
    assert.equal(a, b);
  });

  it('crap rows sort by (path, startLine, method)', () => {
    const env = buildWithFixedClock(FIXTURES.crap);
    // src/a.js bar (startLine 5) should come before src/a.js foo (startLine 10).
    assert.equal(env.rows[0].path, 'src/a.js');
    assert.equal(env.rows[0].method, 'bar');
    assert.equal(env.rows[1].method, 'foo');
    assert.equal(env.rows[2].path, 'src/b.js');
  });
});

describe('write() — canonicalisation at the boundary', () => {
  it('strips .worktrees/<workspace>/ prefix from row paths', () => {
    const env = buildWithFixedClock({
      kind: 'maintainability',
      rows: [{ path: '.worktrees/story-1/src/a.js', mi: 90 }],
    });
    assert.equal(env.rows[0].path, 'src/a.js');
  });

  it('normalises backslash separators', () => {
    const env = buildWithFixedClock({
      kind: 'maintainability',
      rows: [{ path: 'src\\nested\\a.js', mi: 85 }],
    });
    assert.equal(env.rows[0].path, 'src/nested/a.js');
  });

  it('aborts the write when a row carries an absolute path', () => {
    assert.throws(
      () =>
        buildWithFixedClock({
          kind: 'lint',
          rows: [{ path: '/abs/path', errorCount: 0, warningCount: 0 }],
        }),
      /absolute paths/,
    );
  });

  it('error message names the offending row index', () => {
    assert.throws(
      () =>
        buildWithFixedClock({
          kind: 'lint',
          rows: [
            { path: 'src/a.js', errorCount: 0, warningCount: 0 },
            { path: '/bad', errorCount: 0, warningCount: 0 },
          ],
        }),
      /index 1/,
    );
  });
});

describe('write() — rollup["*"] presence', () => {
  it('emits rollup["*"] even when components is undefined', () => {
    const env = buildWithFixedClock(FIXTURES.lint);
    assert.ok(Object.hasOwn(env.rollup, '*'));
  });

  it('emits rollup["*"] when components is an empty array', () => {
    const env = write({
      ...FIXTURES.lint,
      components: [],
      generatedAt: FIXED_TIMESTAMP,
    });
    assert.ok(Object.hasOwn(env.rollup, '*'));
  });

  it('emits a component bucket alongside "*" when components are supplied', () => {
    const env = write({
      ...FIXTURES.lint,
      components: [{ name: 'core', includes: 'src' }],
      generatedAt: FIXED_TIMESTAMP,
    });
    assert.ok(Object.hasOwn(env.rollup, '*'));
    assert.ok(Object.hasOwn(env.rollup, 'core'));
  });
});

describe('writeFile()', () => {
  let workDir;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), 'mandrel-writer-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('round-trips an envelope through disk byte-identically', () => {
    const env = buildWithFixedClock(FIXTURES.crap);
    const filePath = path.join(workDir, 'crap.json');
    writeFile(filePath, env);
    const onDisk = readFileSync(filePath, 'utf8');
    const expected = `${JSON.stringify(
      {
        $schema: env.$schema,
        kernelVersion: env.kernelVersion,
        generatedAt: env.generatedAt,
        rollup: env.rollup,
        rows: env.rows,
      },
      null,
      2,
    )}\n`;
    assert.equal(onDisk, expected);
  });

  it('terminates the file with a trailing newline', () => {
    const env = buildWithFixedClock(FIXTURES.lint);
    const filePath = path.join(workDir, 'lint.json');
    writeFile(filePath, env);
    const onDisk = readFileSync(filePath, 'utf8');
    assert.equal(onDisk.at(-1), '\n');
  });

  it('rejects a relative destination path', () => {
    const env = buildWithFixedClock(FIXTURES.lint);
    assert.throws(() => writeFile('baselines/lint.json', env), /absolute path/);
  });

  it('re-validates the envelope at the disk seam', () => {
    const env = buildWithFixedClock(FIXTURES.lint);
    env.kernelVersion = 'not-semver';
    const filePath = path.join(workDir, 'lint.json');
    assert.throws(() => writeFile(filePath, env), /schema validation/);
  });

  it('creates the parent directory when it does not yet exist', () => {
    const env = buildWithFixedClock(FIXTURES.lint);
    const filePath = path.join(workDir, 'nested', 'deep', 'lint.json');
    assert.doesNotThrow(() => writeFile(filePath, env));
    assert.ok(readFileSync(filePath, 'utf8').length > 0);
  });
});

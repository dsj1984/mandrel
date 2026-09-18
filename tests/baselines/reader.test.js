// tests/baselines/reader.test.js
//
// Story #1892 / Task #1903 — covers the shared baseline reader (load,
// loadFile, schema-validation, defensive canonicalisation). Story #5400:
// the loaded envelope carries neither `generatedAt` nor `rollup` — the
// committed file has neither, and the floors phase derives the rollup from
// the rows itself.

import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  canonicaliseRowPath,
  load,
  loadFile,
} from '../../.agents/scripts/lib/baselines/reader.js';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';

function writeJson(p, value) {
  writeFileSync(p, JSON.stringify(value));
}

function envelope(kind, overrides = {}) {
  const base = {
    $schema: `${kind}.schema.json`,
    kernelVersion: '1.0.0',
    rows: [],
  };
  return { ...base, ...overrides };
}

const COVERAGE_ROW = {
  path: 'src/a.js',
  lines: 80,
  branches: 70,
  functions: 90,
};

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
    tmp = makeTempDir('baseline-reader-');
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns rows and kernelVersion with no rollup or generatedAt key', () => {
    const file = path.join(tmp, 'coverage.json');
    writeJson(file, envelope('coverage', { rows: [COVERAGE_ROW] }));
    const out = loadFile(file);
    assert.deepEqual(out.rows, [COVERAGE_ROW]);
    assert.equal(out.kernelVersion, '1.0.0');
    assert.equal(Object.hasOwn(out, 'rollup'), false);
    assert.equal(Object.hasOwn(out, 'generatedAt'), false);
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
      rows: [{ ...COVERAGE_ROW, lines: 'not-a-number' }],
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
    writeJson(
      file,
      envelope('mutation', {
        $schema: 'unknown.schema.json',
        rows: [{ path: 'src/a.js', score: 80, killed: 8, survived: 2 }],
      }),
    );
    const out = loadFile(file, { kind: 'mutation' });
    assert.equal(out.rows[0].score, 80);
  });

  it('throws when kind cannot be inferred and no override is provided', () => {
    const file = path.join(tmp, 'no-schema.json');
    const env = envelope('mutation', { $schema: 'unknown.schema.json' });
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
    tmp = makeTempDir('baseline-reader-load-');
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("load('coverage') reads the default-path baseline without a rollup", () => {
    // Stage the default-path baseline under cwd/baselines/coverage.json.
    const dir = path.join(tmp, 'baselines');
    mkdirSync(dir, { recursive: true });
    writeJson(
      path.join(dir, 'coverage.json'),
      envelope('coverage', { rows: [COVERAGE_ROW] }),
    );
    const out = load('coverage', { cwd: tmp });
    assert.deepEqual(out.rows, [COVERAGE_ROW]);
    assert.equal(Object.hasOwn(out, 'rollup'), false);
    assert.equal(Object.hasOwn(out, 'generatedAt'), false);
  });

  it('rejects a committed file that still carries a retired rollup', () => {
    const dir = path.join(tmp, 'baselines');
    mkdirSync(dir, { recursive: true });
    writeJson(
      path.join(dir, 'coverage.json'),
      envelope('coverage', {
        rollup: { '*': { lines: 80, branches: 70, functions: 90 } },
      }),
    );
    assert.throws(
      () => load('coverage', { cwd: tmp }),
      /schema validation failed/,
    );
  });

  it('rejects unknown kinds', () => {
    assert.throws(() => load('nonsense', { cwd: tmp }), /unknown kind/);
  });
});

// The projection in `shapeEnvelope` is an ALLOW-LIST, so a stamp that is not
// named there is dropped silently — and the compat axes that read these stamps
// off the LOADED envelope fail closed when one reads `undefined`. That pairing
// turns a one-line omission into a gate that rejects every baseline in a repo
// for a stamp which is present on disk, and it is not hypothetical: it is what
// `provenanceStamped` did between Story #4901 (which added the marker and its
// `provenance-unstamped` axis) and the fix these tests land with.
//
// Nothing caught it because no test asserted carry-through for ANY stamp —
// `scoringSemantics` and `tsTranspilerVersion` were each added with a comment
// warning of this exact failure and no assertion behind it. So this block pins
// every stamp at BOTH exits rather than only the one that regressed: the bug
// was never about which stamp, it was about the projection being writable in
// two places with nothing checking they agree.
const ENVELOPE_STAMPS = [
  ['scoringSemantics', 'method-identity-v3'],
  ['tsTranspilerVersion', '5.9.3'],
  ['provenanceStamped', true],
];

describe('baselines/reader — envelope stamps survive the narrowing', () => {
  let tmp;
  beforeEach(() => {
    tmp = makeTempDir('baseline-reader-stamps-');
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  for (const [field, value] of ENVELOPE_STAMPS) {
    it(`loadFile carries ${field} through to the loaded envelope`, () => {
      const file = path.join(tmp, 'crap.json');
      writeJson(file, envelope('crap', { [field]: value }));
      assert.deepEqual(loadFile(file)[field], value);
    });

    it(`load carries ${field} through to the loaded envelope`, () => {
      const dir = path.join(tmp, 'baselines');
      mkdirSync(dir, { recursive: true });
      writeJson(
        path.join(dir, 'crap.json'),
        envelope('crap', { [field]: value }),
      );
      assert.deepEqual(load('crap', { cwd: tmp })[field], value);
    });
  }

  it('carries every stamp on one envelope, through both entry points alike', () => {
    // The parity assertion the duplicated projection needed and never had: the
    // two exits must hand back the same shape, so a stamp added to one and not
    // the other fails here rather than in a consumer's gate.
    const stamped = Object.fromEntries(ENVELOPE_STAMPS);
    const dir = path.join(tmp, 'baselines');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'crap.json');
    writeJson(file, envelope('crap', stamped));

    const viaFile = loadFile(file);
    const viaConfig = load('crap', { cwd: tmp });
    for (const [field, value] of ENVELOPE_STAMPS) {
      assert.deepEqual(viaFile[field], value, `loadFile dropped ${field}`);
      assert.deepEqual(viaConfig[field], value, `load dropped ${field}`);
    }
    assert.deepEqual(
      Object.keys(viaFile).sort(),
      Object.keys(viaConfig).sort(),
    );
  });

  it('leaves an unstamped envelope undefined rather than inventing a value', () => {
    // The other half of the contract. `provenance-unstamped` keys on
    // `!== true`, so a reader that defaulted a missing marker to `true` would
    // silence the axis on exactly the pre-#4901 baselines it exists to catch —
    // the opposite failure, and the quieter one.
    const file = path.join(tmp, 'crap.json');
    writeJson(file, envelope('crap'));
    const out = loadFile(file);
    for (const [field] of ENVELOPE_STAMPS) {
      assert.equal(out[field], undefined, `${field} was invented`);
    }
  });
});

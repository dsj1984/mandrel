import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  buildGraph,
  collectJsFiles,
  DEFAULT_ROOTS,
  diffCycles,
  findCycles,
  loadBaseline,
  normalizeCycle,
  parseArgv,
  renderDiff,
  runCli,
} from '../.agents/scripts/check-arch-cycles.js';

/**
 * Unit coverage for the arch-cycle ratchet gate (Story #3991).
 *
 * Modeled on the sibling `check-dead-exports.test.js`: exercise the pure
 * helpers directly, then drive `runCli` end-to-end against tmpdir fixture
 * graphs — acyclic passes, new cycle fails, allowlisted cycle passes, and
 * normalization is rotation-stable.
 */

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Materialize a fixture project under a fresh tmpdir.
 * `modules` maps relative module paths to arrays of relative import specs.
 * Returns `{ cwd, root }` where `root` is the scanned scripts dir.
 */
function makeFixture(modules, { cycles } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-cycles-'));
  const root = path.join(cwd, 'scripts');
  for (const [rel, imports] of Object.entries(modules)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const body = imports
      .map((spec, i) => `import { x${i} } from '${spec}';`)
      .join('\n');
    fs.writeFileSync(file, `${body}\nexport const y = 1;\n`);
  }
  if (cycles) {
    fs.mkdirSync(path.join(cwd, 'baselines'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, 'baselines', 'arch-cycles.json'),
      JSON.stringify({ cycles }),
    );
  }
  return { cwd, root };
}

function makeSink() {
  const chunks = [];
  return { write: (s) => chunks.push(s), text: () => chunks.join('') };
}

/**
 * Materialize a fixture spanning the project's default distributed roots
 * (`.agents/scripts`, `bin`, `lib`) under a fresh tmpdir. `modules` maps
 * repo-relative module paths (e.g. `bin/x.js`) to arrays of relative import
 * specs. Returns `{ cwd }`; the multi-root scan relativizes ids against
 * `cwd`, so a cross-root edge resolves into the single graph.
 */
function makeMultiRootFixture(modules, { cycles } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-multiroot-'));
  // Ensure every default root dir exists so the scan walks all of them.
  for (const dir of DEFAULT_ROOTS) {
    fs.mkdirSync(path.join(cwd, dir), { recursive: true });
  }
  for (const [rel, imports] of Object.entries(modules)) {
    const file = path.join(cwd, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const body = imports
      .map((spec, i) => `import { x${i} } from '${spec}';`)
      .join('\n');
    fs.writeFileSync(file, `${body}\nexport const y = 1;\n`);
  }
  if (cycles) {
    fs.mkdirSync(path.join(cwd, 'baselines'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, 'baselines', 'arch-cycles.json'),
      JSON.stringify({ cycles }),
    );
  }
  return { cwd };
}

// ---------------------------------------------------------------------------
// parseArgv
// ---------------------------------------------------------------------------

test('parseArgv: returns defaults when no flags supplied', () => {
  const out = parseArgv([]);
  assert.equal(out.baselinePath, null);
  assert.equal(out.rootPath, null);
  assert.equal(out.json, false);
});

test('parseArgv: --baseline/--root take the next non-flag token, --json flips', () => {
  const out = parseArgv(['--baseline', 'b.json', '--root', 'src', '--json']);
  assert.equal(out.baselinePath, 'b.json');
  assert.equal(out.rootPath, 'src');
  assert.equal(out.json, true);
});

test('parseArgv: --baseline without a value falls back to null', () => {
  const out = parseArgv(['--baseline', '--json']);
  assert.equal(out.baselinePath, null);
  assert.equal(out.json, true);
});

// ---------------------------------------------------------------------------
// normalizeCycle (rotation stability)
// ---------------------------------------------------------------------------

test('normalizeCycle: rotates to the lexicographically-smallest member', () => {
  assert.deepEqual(normalizeCycle(['c.js', 'a.js', 'b.js']), [
    'a.js',
    'b.js',
    'c.js',
  ]);
});

test('normalizeCycle: every rotation of the same cycle normalizes identically', () => {
  const cycle = ['m/b.js', 'm/c.js', 'm/a.js'];
  const rotations = cycle.map((_, i) => [
    ...cycle.slice(i),
    ...cycle.slice(0, i),
  ]);
  const normalized = rotations.map((r) => normalizeCycle(r).join(' -> '));
  assert.equal(new Set(normalized).size, 1);
});

test('normalizeCycle: empty cycle returns empty', () => {
  assert.deepEqual(normalizeCycle([]), []);
});

// ---------------------------------------------------------------------------
// collectJsFiles / buildGraph / findCycles
// ---------------------------------------------------------------------------

test('collectJsFiles: walks recursively, skips node_modules and non-js', () => {
  const { root } = makeFixture({
    'a.js': [],
    'lib/b.js': [],
  });
  fs.mkdirSync(path.join(root, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'dep', 'index.js'), '');
  fs.writeFileSync(path.join(root, 'README.md'), '# not js');
  const files = collectJsFiles(root).map((f) => path.relative(root, f));
  assert.deepEqual(files.sort(), ['a.js', path.join('lib', 'b.js')]);
});

test('buildGraph: resolves relative imports to posix ids, drops external edges', () => {
  const { root } = makeFixture({
    'a.js': ['./lib/b.js', '../outside.js'],
    'lib/b.js': ['../a.js'],
  });
  const graph = buildGraph(collectJsFiles(root), root);
  assert.deepEqual(graph.get('a.js'), ['lib/b.js']);
  assert.deepEqual(graph.get('lib/b.js'), ['a.js']);
});

test('findCycles: acyclic graph yields no cycles', () => {
  const graph = new Map([
    ['a.js', ['b.js']],
    ['b.js', ['c.js']],
    ['c.js', []],
  ]);
  assert.deepEqual(findCycles(graph), []);
});

test('findCycles: detects a two-node cycle in normalized form', () => {
  const graph = new Map([
    ['b.js', ['a.js']],
    ['a.js', ['b.js']],
  ]);
  assert.deepEqual(findCycles(graph), [['a.js', 'b.js']]);
});

test('findCycles: detects a longer cycle and dedupes by normalized identity', () => {
  const graph = new Map([
    ['a.js', ['b.js']],
    ['b.js', ['c.js']],
    ['c.js', ['a.js']],
    ['d.js', ['a.js']],
  ]);
  assert.deepEqual(findCycles(graph), [['a.js', 'b.js', 'c.js']]);
});

// ---------------------------------------------------------------------------
// loadBaseline / diffCycles / renderDiff
// ---------------------------------------------------------------------------

test('loadBaseline: returns null for missing or unparseable files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-base-'));
  assert.equal(loadBaseline(path.join(dir, 'nope.json')), null);
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{not json');
  assert.equal(loadBaseline(bad), null);
});

test('diffCycles: allowlisted cycle matches regardless of rotation', () => {
  const allow = [['b.js', 'a.js']];
  const detected = [['a.js', 'b.js']];
  const diff = diffCycles(allow, detected);
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, []);
});

test('diffCycles: surfaces added and removed cycles', () => {
  const allow = [['x.js', 'y.js']];
  const detected = [['a.js', 'b.js']];
  const diff = diffCycles(allow, detected);
  assert.deepEqual(diff.added, [['a.js', 'b.js']]);
  assert.deepEqual(diff.removed, [['x.js', 'y.js']]);
});

test('renderDiff: marks gate fail on added, warns on shrinkable allowlist', () => {
  const out = renderDiff({
    added: [['a.js', 'b.js']],
    removed: [['x.js', 'y.js']],
  });
  assert.match(out, /\+ a\.js -> b\.js -> a\.js/);
  assert.match(out, /- x\.js -> y\.js -> x\.js/);
  assert.match(out, /allowlist can shrink|shrink baselines/);
  assert.match(out, /\(gate fail\)/);
});

test('renderDiff: clean diff renders ok summary only', () => {
  const out = renderDiff({ added: [], removed: [] });
  assert.match(out, /added=0 removed=0 \(ok\)/);
});

// ---------------------------------------------------------------------------
// runCli end-to-end against tmpdir fixtures
// ---------------------------------------------------------------------------

test('runCli: acyclic fixture graph passes (exit 0)', async () => {
  const { cwd } = makeFixture(
    { 'a.js': ['./b.js'], 'b.js': [] },
    { cycles: [] },
  );
  const stdout = makeSink();
  const code = await runCli({
    argv: ['--root', 'scripts'],
    cwd,
    stdout,
    stderr: makeSink(),
  });
  assert.equal(code, 0);
  assert.match(stdout.text(), /added=0 removed=0 \(ok\)/);
});

test('runCli: synthetic new cycle exits 1 and names the cycle path', async () => {
  const { cwd } = makeFixture(
    { 'a.js': ['./lib/b.js'], 'lib/b.js': ['../a.js'] },
    { cycles: [] },
  );
  const stdout = makeSink();
  const code = await runCli({
    argv: ['--root', 'scripts'],
    cwd,
    stdout,
    stderr: makeSink(),
  });
  assert.equal(code, 1);
  assert.match(stdout.text(), /\+ a\.js -> lib\/b\.js -> a\.js/);
  assert.match(stdout.text(), /\(gate fail\)/);
});

test('runCli: allowlisted cycle passes even when listed in rotated form', async () => {
  const { cwd } = makeFixture(
    { 'a.js': ['./b.js'], 'b.js': ['./a.js'] },
    { cycles: [['b.js', 'a.js']] },
  );
  const code = await runCli({
    argv: ['--root', 'scripts'],
    cwd,
    stdout: makeSink(),
    stderr: makeSink(),
  });
  assert.equal(code, 0);
});

test('runCli: fixed cycle (allowlisted, no longer detected) exits 0 with shrink warning', async () => {
  const { cwd } = makeFixture(
    { 'a.js': [], 'b.js': [] },
    { cycles: [['a.js', 'b.js']] },
  );
  const stdout = makeSink();
  const code = await runCli({
    argv: ['--root', 'scripts'],
    cwd,
    stdout,
    stderr: makeSink(),
  });
  assert.equal(code, 0);
  assert.match(stdout.text(), /- a\.js -> b\.js -> a\.js/);
  assert.match(stdout.text(), /shrink/);
});

test('runCli: missing allowlist treated as empty with stderr warning', async () => {
  const { cwd } = makeFixture({ 'a.js': ['./b.js'], 'b.js': ['./a.js'] });
  const stderr = makeSink();
  const code = await runCli({
    argv: ['--root', 'scripts'],
    cwd,
    stdout: makeSink(),
    stderr,
  });
  assert.equal(code, 1);
  assert.match(stderr.text(), /allowlist not found/);
});

test('runCli: --json emits structured envelope and skips human summary', async () => {
  const { cwd } = makeFixture(
    { 'a.js': ['./b.js'], 'b.js': ['./a.js'] },
    { cycles: [['a.js', 'b.js']] },
  );
  const stdout = makeSink();
  const code = await runCli({
    argv: ['--root', 'scripts', '--json'],
    cwd,
    stdout,
    stderr: makeSink(),
  });
  assert.equal(code, 0);
  const envelope = JSON.parse(stdout.text());
  assert.equal(envelope.kind, 'arch-cycles-report');
  assert.deepEqual(envelope.detected, [['a.js', 'b.js']]);
  assert.deepEqual(envelope.added, []);
  assert.equal(envelope.exitCode, 0);
});

test('runCli: throws when the scan root does not exist', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-noroot-'));
  await assert.rejects(
    () =>
      runCli({
        argv: ['--root', 'missing'],
        cwd,
        stdout: makeSink(),
        stderr: makeSink(),
      }),
    /no scan root found/,
  );
});

// ---------------------------------------------------------------------------
// Multi-root (distributed-surface) scan — cross-root cycle detection (#4071)
// ---------------------------------------------------------------------------

test('DEFAULT_ROOTS spans the distributed surface (.agents/scripts, bin, lib)', () => {
  assert.deepEqual(DEFAULT_ROOTS, [path.join('.agents', 'scripts'), 'bin', 'lib']);
});

test('runCli: detects a cycle that crosses the bin <-> lib partition (exit 1)', async () => {
  // A `bin/` lifecycle script and a root-`lib/` runtime module importing each
  // other — invisible to any single-root scan, caught by the merged graph.
  const { cwd } = makeMultiRootFixture(
    {
      'bin/cli.js': ['../lib/sync.js'],
      'lib/sync.js': ['../bin/cli.js'],
    },
    { cycles: [] },
  );
  const stdout = makeSink();
  const code = await runCli({ cwd, stdout, stderr: makeSink() });
  assert.equal(code, 1);
  assert.match(stdout.text(), /\+ bin\/cli\.js -> lib\/sync\.js -> bin\/cli\.js/);
  assert.match(stdout.text(), /\(gate fail\)/);
});

test('runCli: cross-root cycle resolves with repo-relative ids in --json', async () => {
  const { cwd } = makeMultiRootFixture(
    {
      'bin/cli.js': ['../lib/sync.js'],
      'lib/sync.js': ['../bin/cli.js'],
    },
    { cycles: [] },
  );
  const stdout = makeSink();
  const code = await runCli({ argv: ['--json'], cwd, stdout, stderr: makeSink() });
  assert.equal(code, 1);
  const envelope = JSON.parse(stdout.text());
  assert.deepEqual(envelope.detected, [['bin/cli.js', 'lib/sync.js']]);
  assert.equal(envelope.root, cwd);
});

test('runCli: cross-root cycle passes when allowlisted', async () => {
  const { cwd } = makeMultiRootFixture(
    {
      'bin/cli.js': ['../lib/sync.js'],
      'lib/sync.js': ['../bin/cli.js'],
    },
    { cycles: [['bin/cli.js', 'lib/sync.js']] },
  );
  const code = await runCli({ cwd, stdout: makeSink(), stderr: makeSink() });
  assert.equal(code, 0);
});

test('runCli: explicit --root keeps the single-root contract (no cross-root edges)', async () => {
  // With --root bin, only `bin/` is scanned and ids are relativized against
  // it, so the import into `../lib/sync.js` resolves outside the scanned set
  // and is dropped — no cycle, no crash.
  const { cwd } = makeMultiRootFixture(
    {
      'bin/cli.js': ['../lib/sync.js'],
      'lib/sync.js': ['../bin/cli.js'],
    },
    { cycles: [] },
  );
  const stdout = makeSink();
  const code = await runCli({
    argv: ['--root', 'bin'],
    cwd,
    stdout,
    stderr: makeSink(),
  });
  assert.equal(code, 0);
  assert.match(stdout.text(), /added=0 removed=0 \(ok\)/);
});

test('runCli: default scan tolerates a missing optional root', async () => {
  // Only one of the default roots is materialized; the scan proceeds over the
  // present root(s) rather than throwing.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-partial-'));
  fs.mkdirSync(path.join(cwd, '.agents', 'scripts'), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, '.agents', 'scripts', 'a.js'),
    'export const y = 1;\n',
  );
  fs.mkdirSync(path.join(cwd, 'baselines'), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, 'baselines', 'arch-cycles.json'),
    JSON.stringify({ cycles: [] }),
  );
  const code = await runCli({ cwd, stdout: makeSink(), stderr: makeSink() });
  assert.equal(code, 0);
});

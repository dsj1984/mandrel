/**
 * update-dead-exports-baseline.test.js — unit coverage for the dead-export
 * baseline producer (Story #5011).
 *
 * Every case drives the CLI through its injected hooks — the `--knip-output`
 * seam, an injected knip runner, an injected clock and an injected writer — so
 * the suite never spawns knip and never touches a committed baseline.
 *
 * The load-bearing cases are the fail-closed ones. `check-dead-exports.js` is
 * deliberately advisory when knip cannot run, because it still holds a
 * committed snapshot; the producer must not mirror that, because an empty
 * baseline persisted from a failed run grandfathers every dead export in the
 * repository. Both failure shapes — an unreadable saved report and a knip
 * spawn failure — are pinned here as "exit 1, target byte-identical".
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { makeTempDir } from '../.agents/scripts/lib/test-temp.js';
import {
  buildEnvelope,
  collectKnipReport,
  DEAD_EXPORTS_SCHEMA_REF,
  describeUnusableReport,
  normalizeRows,
  parseArgv,
  resolveKnipKernelVersion,
  runCli,
} from '../scripts/update-dead-exports-baseline.js';

const KNIP_VERSION = '6.17.1';

/** A knip report naming one dead export and one whole-file death. */
const KNIP_REPORT = {
  issues: [
    {
      file: 'lib/b.js',
      exports: [{ name: 'beta' }, { name: 'alpha' }],
      files: [],
    },
    { file: 'lib/a.js', exports: [], files: [{ name: 'lib/a.js' }] },
  ],
};

/**
 * Build a throwaway repo root carrying an installed-knip manifest, a
 * `baselines/` directory seeded with both committed baselines, and an optional
 * saved knip report.
 *
 * @param {{ report?: unknown }} [opts]
 * @returns {{ cwd: string, defaultBaseline: string, productionBaseline: string, reportPath: string }}
 */
function makeRepo({ report = KNIP_REPORT } = {}) {
  const cwd = makeTempDir('dead-exports-producer-');
  fs.mkdirSync(path.join(cwd, 'node_modules', 'knip'), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, 'node_modules', 'knip', 'package.json'),
    JSON.stringify({ name: 'knip', version: KNIP_VERSION }),
  );
  fs.mkdirSync(path.join(cwd, 'baselines'), { recursive: true });
  const seed = `${JSON.stringify({ rows: [{ file: 'seed.js', symbol: 'seed' }] }, null, 2)}\n`;
  const defaultBaseline = path.join(cwd, 'baselines', 'dead-exports.json');
  const productionBaseline = path.join(
    cwd,
    'baselines',
    'dead-exports-production.json',
  );
  fs.writeFileSync(defaultBaseline, seed);
  fs.writeFileSync(productionBaseline, seed);
  const reportPath = path.join(cwd, 'knip-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report));
  return { cwd, defaultBaseline, productionBaseline, reportPath };
}

/** Discard writes the assertions do not read. */
const sink = { write: () => {} };

/**
 * Drive `runCli` with silenced streams and a pinned clock.
 *
 * @param {object} opts forwarded to `runCli`
 * @returns {Promise<{ code: number, err: string }>}
 */
async function run(opts) {
  let err = '';
  const code = await runCli({
    stdout: sink,
    stderr: { write: (s) => (err += s) },
    now: () => '2026-01-01T00:00:00.000Z',
    ...opts,
  });
  return { code, err };
}

test('parseArgv: defaults to the default pass with no overrides', () => {
  assert.deepEqual(parseArgv([]), {
    baselinePath: null,
    knipOutputPath: null,
    production: false,
  });
});

test('parseArgv: reads --production, --baseline and --knip-output', () => {
  assert.deepEqual(
    parseArgv([
      '--production',
      '--baseline',
      'b.json',
      '--knip-output',
      'k.json',
    ]),
    { baselinePath: 'b.json', knipOutputPath: 'k.json', production: true },
  );
});

test('parseArgv: a value flag with no value stays null rather than eating a flag', () => {
  assert.deepEqual(parseArgv(['--baseline', '--production']), {
    baselinePath: null,
    knipOutputPath: null,
    production: true,
  });
});

test('resolveKnipKernelVersion: reads the installed knip manifest', () => {
  const { cwd } = makeRepo();
  assert.equal(resolveKnipKernelVersion({ cwd }), KNIP_VERSION);
});

test('resolveKnipKernelVersion: null when knip is not installed', () => {
  assert.equal(
    resolveKnipKernelVersion({ cwd: makeTempDir('dead-exports-noknip-') }),
    null,
  );
});

test('resolveKnipKernelVersion: null when the manifest carries no version', () => {
  const cwd = makeTempDir('dead-exports-badknip-');
  fs.mkdirSync(path.join(cwd, 'node_modules', 'knip'), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, 'node_modules', 'knip', 'package.json'),
    JSON.stringify({ name: 'knip' }),
  );
  assert.equal(resolveKnipKernelVersion({ cwd }), null);
});

test('normalizeRows: sorts by (file, symbol) and drops duplicates', () => {
  const rows = normalizeRows([
    { file: 'b.js', symbol: 'z' },
    { file: 'a.js', symbol: 'b' },
    { file: 'a.js', symbol: 'a' },
    { file: 'a.js', symbol: 'a' },
  ]);
  assert.deepEqual(rows, [
    { file: 'a.js', symbol: 'a' },
    { file: 'a.js', symbol: 'b' },
    { file: 'b.js', symbol: 'z' },
  ]);
});

test('normalizeRows: skips rows missing a string file or symbol', () => {
  assert.deepEqual(
    normalizeRows([
      { file: 'a.js' },
      { symbol: 'x' },
      null,
      { file: 1, symbol: 2 },
    ]),
    [],
  );
});

test('buildEnvelope: default pass carries no mode key', () => {
  const envelope = buildEnvelope({
    kernelVersion: KNIP_VERSION,
    mode: 'default',
    rows: [],
    generatedAt: 'now',
  });
  assert.deepEqual(Object.keys(envelope), [
    '$schema',
    'kernelVersion',
    'generatedAt',
    'rows',
  ]);
  assert.equal(envelope.$schema, DEAD_EXPORTS_SCHEMA_REF);
});

test('buildEnvelope: production pass stamps mode', () => {
  const envelope = buildEnvelope({
    kernelVersion: KNIP_VERSION,
    mode: 'production',
    rows: [],
    generatedAt: 'now',
  });
  assert.equal(envelope.mode, 'production');
});

test('describeUnusableReport: accepts a report carrying an issues array', () => {
  assert.equal(describeUnusableReport({ issues: [] }), null);
});

test('describeUnusableReport: rejects a non-object and an issues-less object', () => {
  assert.match(String(describeUnusableReport(null)), /not a JSON object/);
  assert.match(String(describeUnusableReport({})), /issues/);
});

test('collectKnipReport: --knip-output bypasses the knip runner entirely', () => {
  const { cwd, reportPath } = makeRepo();
  const result = collectKnipReport({
    cwd,
    production: false,
    knipOutputPath: path.relative(cwd, reportPath),
    runKnipImpl: () => assert.fail('knip must not be spawned'),
    readKnipOutputImpl: (p) => JSON.parse(fs.readFileSync(p, 'utf-8')),
  });
  assert.equal(result.ok, true);
  assert.equal(result.envelope.issues.length, 2);
});

test('collectKnipReport: forwards the pass to the knip runner', () => {
  const seen = [];
  const result = collectKnipReport({
    cwd: '/repo',
    production: true,
    knipOutputPath: null,
    runKnipImpl: (opts) => {
      seen.push(opts);
      return { ok: true, envelope: { issues: [] } };
    },
    readKnipOutputImpl: () => assert.fail('the seam must not be read'),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(seen, [{ cwd: '/repo', production: true }]);
});

test('runCli: the default pass writes the envelope the checker reads', async () => {
  const { cwd, defaultBaseline, productionBaseline, reportPath } = makeRepo();
  const productionBefore = fs.readFileSync(productionBaseline);

  const { code } = await run({
    argv: ['--knip-output', path.relative(cwd, reportPath)],
    cwd,
  });

  assert.equal(code, 0);
  const written = JSON.parse(fs.readFileSync(defaultBaseline, 'utf-8'));
  assert.deepEqual(Object.keys(written), [
    '$schema',
    'kernelVersion',
    'generatedAt',
    'rows',
  ]);
  assert.equal(written.$schema, DEAD_EXPORTS_SCHEMA_REF);
  assert.equal(written.kernelVersion, KNIP_VERSION);
  assert.deepEqual(written.rows, [
    { file: 'lib/a.js', symbol: '*' },
    { file: 'lib/b.js', symbol: 'alpha' },
    { file: 'lib/b.js', symbol: 'beta' },
  ]);
  assert.deepEqual(fs.readFileSync(productionBaseline), productionBefore);
});

test('runCli: writes through a temp file and renames, never in place', async () => {
  const { cwd, defaultBaseline, reportPath } = makeRepo();
  const writes = [];
  const renames = [];

  const { code } = await run({
    argv: ['--knip-output', path.relative(cwd, reportPath)],
    cwd,
    writeFileImpl: (target, body, enc) => {
      writes.push(target);
      fs.writeFileSync(target, body, enc);
    },
    renameImpl: (from, to) => {
      renames.push([from, to]);
      fs.renameSync(from, to);
    },
  });

  assert.equal(code, 0);
  // A crash between the write and the rename must leave the committed
  // baseline untouched: an unparseable one reads as empty to
  // check-dead-exports.js, which then reports every existing row as added.
  assert.deepEqual(writes, [`${defaultBaseline}.tmp`]);
  assert.deepEqual(renames, [[`${defaultBaseline}.tmp`, defaultBaseline]]);
  assert.equal(fs.existsSync(`${defaultBaseline}.tmp`), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(defaultBaseline, 'utf-8')).rows, [
    { file: 'lib/a.js', symbol: '*' },
    { file: 'lib/b.js', symbol: 'alpha' },
    { file: 'lib/b.js', symbol: 'beta' },
  ]);
});

test('runCli: the production pass self-labels and leaves its sibling alone', async () => {
  const { cwd, defaultBaseline, productionBaseline, reportPath } = makeRepo();
  const defaultBefore = fs.readFileSync(defaultBaseline);

  const { code } = await run({
    argv: ['--production', '--knip-output', path.relative(cwd, reportPath)],
    cwd,
  });

  assert.equal(code, 0);
  const written = JSON.parse(fs.readFileSync(productionBaseline, 'utf-8'));
  assert.equal(written.mode, 'production');
  assert.deepEqual(fs.readFileSync(defaultBaseline), defaultBefore);
});

test('runCli: the default clock stamps a real ISO instant', async () => {
  const { cwd, defaultBaseline, reportPath } = makeRepo();

  const code = await runCli({
    argv: ['--knip-output', path.relative(cwd, reportPath)],
    cwd,
    stdout: sink,
    stderr: sink,
  });

  assert.equal(code, 0);
  const { generatedAt } = JSON.parse(fs.readFileSync(defaultBaseline, 'utf-8'));
  assert.equal(new Date(generatedAt).toISOString(), generatedAt);
});

test('runCli: --baseline redirects the write off the mode default', async () => {
  const { cwd, defaultBaseline, reportPath } = makeRepo();
  const before = fs.readFileSync(defaultBaseline);

  const { code } = await run({
    argv: [
      '--baseline',
      'elsewhere.json',
      '--knip-output',
      path.relative(cwd, reportPath),
    ],
    cwd,
  });

  assert.equal(code, 0);
  assert.ok(fs.existsSync(path.join(cwd, 'elsewhere.json')));
  assert.deepEqual(fs.readFileSync(defaultBaseline), before);
});

test('runCli: two runs of the same report differ only in generatedAt', async () => {
  const { cwd, defaultBaseline, reportPath } = makeRepo();
  const argv = ['--knip-output', path.relative(cwd, reportPath)];

  await run({ argv, cwd, now: () => '2026-01-01T00:00:00.000Z' });
  const first = fs.readFileSync(defaultBaseline, 'utf-8');
  await run({ argv, cwd, now: () => '2027-02-02T00:00:00.000Z' });
  const second = fs.readFileSync(defaultBaseline, 'utf-8');

  assert.notEqual(first, second);
  assert.equal(
    first.replace('2026-01-01T00:00:00.000Z', 'STAMP'),
    second.replace('2027-02-02T00:00:00.000Z', 'STAMP'),
  );
});

test('runCli: an unreadable saved report exits 1 and writes nothing', async () => {
  const { cwd, defaultBaseline } = makeRepo();
  const before = fs.readFileSync(defaultBaseline);

  const { code, err } = await run({
    argv: ['--knip-output', 'no/such/report.json'],
    cwd,
  });

  assert.equal(code, 1);
  assert.match(err, /refusing to write/);
  assert.deepEqual(fs.readFileSync(defaultBaseline), before);
});

test('runCli: a knip spawn failure exits 1 and writes nothing', async () => {
  const { cwd, defaultBaseline } = makeRepo();
  const before = fs.readFileSync(defaultBaseline);

  const { code, err } = await run({
    argv: [],
    cwd,
    runKnipImpl: () => ({ ok: false, error: 'spawn failed: ENOENT' }),
  });

  assert.equal(code, 1);
  assert.match(err, /spawn failed: ENOENT/);
  assert.deepEqual(fs.readFileSync(defaultBaseline), before);
});

test('runCli: a report knip never produced issues for exits 1 and writes nothing', async () => {
  const { cwd, defaultBaseline } = makeRepo({ report: { unexpected: true } });
  const before = fs.readFileSync(defaultBaseline);

  const { code, err } = await run({
    argv: ['--knip-output', 'knip-report.json'],
    cwd,
  });

  assert.equal(code, 1);
  assert.match(err, /issues/);
  assert.deepEqual(fs.readFileSync(defaultBaseline), before);
});

test('runCli: an unresolvable knip version exits 1 before any write', async () => {
  const cwd = makeTempDir('dead-exports-noversion-');
  fs.mkdirSync(path.join(cwd, 'baselines'), { recursive: true });
  const target = path.join(cwd, 'baselines', 'dead-exports.json');
  fs.writeFileSync(target, '{}\n');

  const { code, err } = await run({
    argv: [],
    cwd,
    runKnipImpl: () => ({ ok: true, envelope: { issues: [] } }),
  });

  assert.equal(code, 1);
  assert.match(err, /knip's version/);
  assert.equal(fs.readFileSync(target, 'utf-8'), '{}\n');
});

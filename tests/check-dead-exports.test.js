import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  diffRows,
  loadBaseline,
  parseArgv,
  renderDiff,
  runCli,
} from '../.agents/scripts/check-dead-exports.js';
import {
  extractRowsFromKnip,
  runKnip,
} from '../.agents/scripts/lib/dead-exports-knip.js';
import { makeTempDir } from '../.agents/scripts/lib/test-temp.js';

/**
 * Unit coverage for the advisory dead-export ratchet.
 *
 * Modeled on the sibling `check-crap*.test.js` files: exercise the pure
 * helpers (`diffRows`, `extractRowsFromKnip`, `parseArgv`, `renderDiff`)
 * directly, then drive `runCli` end-to-end with stubbed knip output and a
 * fixture baseline. The diff helper is the canonical surface called out in
 * the Task AC; the added/removed branches are both covered here.
 */

test('parseArgv: returns defaults when no flags supplied', () => {
  const out = parseArgv([]);
  assert.equal(out.baselinePath, null);
  assert.equal(out.json, false);
  assert.equal(out.knipOutputPath, null);
});

test('parseArgv: --baseline takes the next non-flag token', () => {
  const out = parseArgv(['--baseline', 'tmp/base.json', '--json']);
  assert.equal(out.baselinePath, 'tmp/base.json');
  assert.equal(out.json, true);
});

test('parseArgv: --baseline without a value falls back to null', () => {
  const out = parseArgv(['--baseline', '--json']);
  assert.equal(out.baselinePath, null);
  assert.equal(out.json, true);
});

test('loadBaseline: returns null when the file does not exist', () => {
  assert.equal(loadBaseline('does/not/exist.json'), null);
});

test('loadBaseline: returns parsed envelope on a well-formed file', () => {
  const tmp = makeTempDir('dead-exports-');
  const file = path.join(tmp, 'baseline.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      $schema: 's',
      kernelVersion: '6.14.0',
      generatedAt: '2026-01-01T00:00:00Z',
      rows: [{ file: 'a.js', symbol: 'foo' }],
    }),
  );
  const baseline = loadBaseline(file);
  assert.ok(baseline);
  assert.equal(baseline.kernelVersion, '6.14.0');
  assert.equal(baseline.rows.length, 1);
});

test('loadBaseline: returns null on malformed JSON', () => {
  const tmp = makeTempDir('dead-exports-');
  const file = path.join(tmp, 'bad.json');
  fs.writeFileSync(file, '{not json');
  assert.equal(loadBaseline(file), null);
});

// Story #5001 — whole-file death.
//
// Mapping only `issues[].exports[]` made the ratchet structurally blind to a
// module losing its last importer: knip reports that once under the `files`
// category and suppresses the module's per-export rows, so an export-only
// reading saw the row count go *down*. These tests pin the `files` leg.

test('extractRowsFromKnip: maps a files-category issue to a whole-file row', () => {
  const envelope = {
    issues: [
      {
        file: '.agents/scripts/lib/orphan.js',
        files: [{ name: '.agents/scripts/lib/orphan.js' }],
        exports: [],
        dependencies: [{ name: 'lodash' }],
      },
    ],
  };
  assert.deepEqual(extractRowsFromKnip(envelope), [
    { file: '.agents/scripts/lib/orphan.js', symbol: '*' },
  ]);
});

test('extractRowsFromKnip: whole-file and per-export rows coexist', () => {
  const envelope = {
    issues: [
      { file: 'a.js', files: [{ name: 'a.js' }], exports: [] },
      { file: 'b.js', exports: [{ name: 'bar' }, { symbol: 'baz' }] },
    ],
  };
  assert.deepEqual(extractRowsFromKnip(envelope), [
    { file: 'a.js', symbol: '*' },
    { file: 'b.js', symbol: 'bar' },
    { file: 'b.js', symbol: 'baz' },
  ]);
});

test('extractRowsFromKnip: emits one stable whole-file row per dead file', () => {
  // Two issue records naming the same dead file must not double-count, or the
  // row set would drift between runs purely on knip's grouping.
  const envelope = {
    issues: [
      { file: 'a.js', files: [{ name: 'a.js' }, 'a.js'] },
      { file: 'b.js', files: [{ name: 'a.js' }] },
    ],
  };
  assert.deepEqual(extractRowsFromKnip(envelope), [
    { file: 'a.js', symbol: '*' },
  ]);
});

test('extractRowsFromKnip: falls back to the issue file when a files entry is shapeless', () => {
  const envelope = { issues: [{ file: 'a.js', files: [{}] }] };
  assert.deepEqual(extractRowsFromKnip(envelope), [
    { file: 'a.js', symbol: '*' },
  ]);
});

test('extractRowsFromKnip: still ignores dependency-level issues', () => {
  const envelope = {
    issues: [
      { file: 'a.js', files: [], exports: [], dependencies: [{ name: 'x' }] },
    ],
  };
  assert.deepEqual(extractRowsFromKnip(envelope), []);
});

test('extractRowsFromKnip: returns empty array for null / non-object input', () => {
  assert.deepEqual(extractRowsFromKnip(null), []);
  assert.deepEqual(extractRowsFromKnip(undefined), []);
  assert.deepEqual(extractRowsFromKnip('not-an-object'), []);
  assert.deepEqual(extractRowsFromKnip({ issues: 'not-array' }), []);
});

test('diffRows: detects added rows (the "added" branch)', () => {
  const baseline = [{ file: 'a.js', symbol: 'foo' }];
  const current = [
    { file: 'a.js', symbol: 'foo' },
    { file: 'b.js', symbol: 'bar' },
  ];
  const diff = diffRows(baseline, current);
  assert.deepEqual(diff.added, [{ file: 'b.js', symbol: 'bar' }]);
  assert.deepEqual(diff.removed, []);
});

test('diffRows: detects removed rows (the "removed" branch)', () => {
  const baseline = [
    { file: 'a.js', symbol: 'foo' },
    { file: 'b.js', symbol: 'bar' },
  ];
  const current = [{ file: 'a.js', symbol: 'foo' }];
  const diff = diffRows(baseline, current);
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, [{ file: 'b.js', symbol: 'bar' }]);
});

test('diffRows: reports both added and removed on overlapping change', () => {
  const baseline = [
    { file: 'a.js', symbol: 'foo' },
    { file: 'b.js', symbol: 'bar' },
  ];
  const current = [
    { file: 'a.js', symbol: 'foo' },
    { file: 'c.js', symbol: 'baz' },
  ];
  const diff = diffRows(baseline, current);
  assert.deepEqual(diff.added, [{ file: 'c.js', symbol: 'baz' }]);
  assert.deepEqual(diff.removed, [{ file: 'b.js', symbol: 'bar' }]);
});

test('diffRows: sorts results deterministically by (file, symbol)', () => {
  const current = [
    { file: 'z.js', symbol: 'zz' },
    { file: 'a.js', symbol: 'bb' },
    { file: 'a.js', symbol: 'aa' },
  ];
  const diff = diffRows([], current);
  assert.deepEqual(diff.added, [
    { file: 'a.js', symbol: 'aa' },
    { file: 'a.js', symbol: 'bb' },
    { file: 'z.js', symbol: 'zz' },
  ]);
});

test('diffRows: handles null/undefined inputs without throwing', () => {
  assert.deepEqual(diffRows(null, null), { added: [], removed: [] });
  assert.deepEqual(diffRows(undefined, [{ file: 'a.js', symbol: 'x' }]), {
    added: [{ file: 'a.js', symbol: 'x' }],
    removed: [],
  });
});

test('renderDiff: lines + summary for added and removed', () => {
  const out = renderDiff({
    added: [{ file: 'a.js', symbol: 'foo' }],
    removed: [{ file: 'b.js', symbol: 'bar' }],
  });
  assert.match(out, /^\+ a\.js: foo$/m);
  assert.match(out, /^- b\.js: bar$/m);
  assert.match(out, /added=1 removed=1/);
});

test('renderDiff: summary includes (gate fail) when added rows present', () => {
  const out = renderDiff({
    added: [{ file: 'a.js', symbol: 'foo' }],
    removed: [],
  });
  assert.match(out, /\(gate fail\)/);
});

test('renderDiff: summary includes (ok) on empty diff', () => {
  const out = renderDiff({ added: [], removed: [] });
  assert.match(out, /added=0 removed=0 \(ok\)/);
});

test('renderDiff: summary includes (ok) when only removals (baseline shrinking)', () => {
  const out = renderDiff({
    added: [],
    removed: [{ file: 'b.js', symbol: 'bar' }],
  });
  assert.match(out, /\(ok\)/);
});

function captureStream() {
  const chunks = [];
  return {
    stream: { write: (s) => chunks.push(s) },
    text: () => chunks.join(''),
  };
}

test('runCli: exits 0 and emits JSON envelope on clean diff', async () => {
  const tmp = makeTempDir('dead-exports-cli-');
  const baselinePath = path.join(tmp, 'baselines', 'dead-exports.json');
  fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
  fs.writeFileSync(
    baselinePath,
    JSON.stringify({
      $schema: 's',
      kernelVersion: '6.14.0',
      generatedAt: '2026-01-01T00:00:00Z',
      rows: [{ file: 'a.js', symbol: 'foo' }],
    }),
  );
  const knipOutPath = path.join(tmp, 'knip.json');
  fs.writeFileSync(
    knipOutPath,
    JSON.stringify({
      issues: [
        {
          file: 'a.js',
          exports: [{ name: 'foo' }],
        },
      ],
    }),
  );

  const stdout = captureStream();
  const stderr = captureStream();
  const exit = await runCli({
    argv: ['--baseline', baselinePath, '--knip-output', knipOutPath, '--json'],
    cwd: tmp,
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  assert.equal(exit, 0);
  const envelope = JSON.parse(stdout.text());
  assert.equal(envelope.kind, 'dead-exports-report');
  assert.deepEqual(envelope.added, []);
  assert.deepEqual(envelope.removed, []);
});

test('runCli: exits 1 and includes exitCode in JSON envelope when added exports present', async () => {
  const tmp = makeTempDir('dead-exports-cli-');
  const baselinePath = path.join(tmp, 'baseline.json');
  fs.writeFileSync(
    baselinePath,
    JSON.stringify({
      kernelVersion: '6.14.0',
      generatedAt: '2026-01-01T00:00:00Z',
      rows: [
        { file: 'a.js', symbol: 'foo' },
        { file: 'b.js', symbol: 'bar' },
      ],
    }),
  );
  const knipOutPath = path.join(tmp, 'knip.json');
  fs.writeFileSync(
    knipOutPath,
    JSON.stringify({
      issues: [
        {
          file: 'a.js',
          exports: [{ name: 'foo' }],
        },
        {
          file: 'c.js',
          exports: [{ name: 'baz' }],
        },
      ],
    }),
  );

  const stdout = captureStream();
  const stderr = captureStream();
  const exit = await runCli({
    argv: ['--baseline', baselinePath, '--knip-output', knipOutPath, '--json'],
    cwd: tmp,
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  // Ratchet-down gate: added exports cause exit 1.
  assert.equal(exit, 1);
  const envelope = JSON.parse(stdout.text());
  assert.deepEqual(envelope.added, [{ file: 'c.js', symbol: 'baz' }]);
  assert.deepEqual(envelope.removed, [{ file: 'b.js', symbol: 'bar' }]);
  assert.equal(envelope.exitCode, 1);
});

test('runCli: exits 0 when only removals detected (baseline shrinking)', async () => {
  const tmp = makeTempDir('dead-exports-cli-');
  const baselinePath = path.join(tmp, 'baseline.json');
  fs.writeFileSync(
    baselinePath,
    JSON.stringify({
      kernelVersion: '6.14.0',
      generatedAt: '2026-01-01T00:00:00Z',
      rows: [
        { file: 'a.js', symbol: 'foo' },
        { file: 'b.js', symbol: 'bar' },
      ],
    }),
  );
  const knipOutPath = path.join(tmp, 'knip.json');
  fs.writeFileSync(
    knipOutPath,
    JSON.stringify({
      issues: [{ file: 'a.js', exports: [{ name: 'foo' }] }],
    }),
  );

  const stdout = captureStream();
  const stderr = captureStream();
  const exit = await runCli({
    argv: ['--baseline', baselinePath, '--knip-output', knipOutPath, '--json'],
    cwd: tmp,
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  // Removals-only is the success signal — baseline is shrinking.
  assert.equal(exit, 0);
  const envelope = JSON.parse(stdout.text());
  assert.deepEqual(envelope.added, []);
  assert.deepEqual(envelope.removed, [{ file: 'b.js', symbol: 'bar' }]);
  assert.equal(envelope.exitCode, 0);
});

test('runCli: human output prints + and - lines for drift and gate-fail marker', async () => {
  const tmp = makeTempDir('dead-exports-cli-');
  const baselinePath = path.join(tmp, 'baseline.json');
  fs.writeFileSync(
    baselinePath,
    JSON.stringify({
      kernelVersion: '6.14.0',
      rows: [{ file: 'b.js', symbol: 'bar' }],
    }),
  );
  const knipOutPath = path.join(tmp, 'knip.json');
  fs.writeFileSync(
    knipOutPath,
    JSON.stringify({
      issues: [
        {
          file: 'c.js',
          exports: [{ name: 'baz' }],
        },
      ],
    }),
  );

  const stdout = captureStream();
  const stderr = captureStream();
  const exit = await runCli({
    argv: ['--baseline', baselinePath, '--knip-output', knipOutPath],
    cwd: tmp,
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  // Added exports → gate fail → exit 1.
  assert.equal(exit, 1);
  const out = stdout.text();
  assert.match(out, /\+ c\.js: baz/);
  assert.match(out, /- b\.js: bar/);
  assert.match(out, /added=1 removed=1/);
  assert.match(out, /\(gate fail\)/);
});

test('runCli: exits 1 when baseline is missing and current rows are non-empty', async () => {
  const tmp = makeTempDir('dead-exports-cli-');
  const knipOutPath = path.join(tmp, 'knip.json');
  fs.writeFileSync(
    knipOutPath,
    JSON.stringify({
      issues: [{ file: 'a.js', exports: [{ name: 'foo' }] }],
    }),
  );
  const stdout = captureStream();
  const stderr = captureStream();
  const exit = await runCli({
    argv: [
      '--baseline',
      path.join(tmp, 'missing.json'),
      '--knip-output',
      knipOutPath,
    ],
    cwd: tmp,
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  // No baseline → every current row appears as added → gate fail.
  assert.equal(exit, 1);
  assert.match(stderr.text(), /baseline not found/);
  assert.match(stdout.text(), /\+ a\.js: foo/);
});

test('runCli: a newly dead file fails the gate (whole-file ratchet)', async () => {
  // AC-4 — the regression this Story exists to prevent. A file under
  // `.agents/scripts/lib` that nothing imports arrives from knip as a
  // files-category issue with an EMPTY `exports` array (knip suppresses
  // per-export rows for an unused file). Before Story #5001 that produced
  // zero rows and the gate stayed green.
  const tmp = makeTempDir('dead-exports-wholefile-');
  const baselinePath = path.join(tmp, 'baseline.json');
  fs.writeFileSync(
    baselinePath,
    JSON.stringify({
      kernelVersion: '6.17.1',
      rows: [{ file: '.agents/scripts/lib/known.js', symbol: '*' }],
    }),
  );
  const knipOutPath = path.join(tmp, 'knip.json');
  fs.writeFileSync(
    knipOutPath,
    JSON.stringify({
      issues: [
        {
          file: '.agents/scripts/lib/known.js',
          files: [{ name: '.agents/scripts/lib/known.js' }],
          exports: [],
        },
        {
          file: '.agents/scripts/lib/newly-orphaned.js',
          files: [{ name: '.agents/scripts/lib/newly-orphaned.js' }],
          exports: [],
        },
      ],
    }),
  );

  const stdout = captureStream();
  const exit = await runCli({
    argv: ['--baseline', baselinePath, '--knip-output', knipOutPath, '--json'],
    cwd: tmp,
    stdout: stdout.stream,
    stderr: captureStream().stream,
  });
  assert.equal(exit, 1);
  const envelope = JSON.parse(stdout.text());
  assert.deepEqual(envelope.added, [
    { file: '.agents/scripts/lib/newly-orphaned.js', symbol: '*' },
  ]);
  // The pre-existing whole-file row passes — the ratchet contract is unchanged.
  assert.deepEqual(envelope.removed, []);
});

test('runCli: renders a whole-file row with the * sentinel', async () => {
  const tmp = makeTempDir('dead-exports-wholefile-');
  const baselinePath = path.join(tmp, 'baseline.json');
  fs.writeFileSync(
    baselinePath,
    JSON.stringify({ kernelVersion: '6.17.1', rows: [] }),
  );
  const knipOutPath = path.join(tmp, 'knip.json');
  fs.writeFileSync(
    knipOutPath,
    JSON.stringify({
      issues: [{ file: 'lib/orphan.js', files: [{ name: 'lib/orphan.js' }] }],
    }),
  );

  const stdout = captureStream();
  const exit = await runCli({
    argv: ['--baseline', baselinePath, '--knip-output', knipOutPath],
    cwd: tmp,
    stdout: stdout.stream,
    stderr: captureStream().stream,
  });
  assert.equal(exit, 1);
  assert.match(stdout.text(), /^\+ lib\/orphan\.js: \*$/m);
});

test('runCli: a knip spawn failure fails the gate closed (exit 2)', async () => {
  const tmp = makeTempDir('dead-exports-cli-');
  const baselinePath = path.join(tmp, 'baseline.json');
  fs.writeFileSync(
    baselinePath,
    JSON.stringify({ kernelVersion: '6.14.0', rows: [] }),
  );
  const stdout = captureStream();
  const stderr = captureStream();
  const exit = await runCli({
    argv: ['--baseline', baselinePath],
    cwd: tmp,
    stdout: stdout.stream,
    stderr: stderr.stream,
    runKnipImpl: () => ({ ok: false, error: 'simulated spawn failure' }),
  });
  assert.equal(exit, 2);
  assert.match(stderr.text(), /simulated spawn failure/);
  assert.match(
    stdout.text(),
    /^! knip run failed: simulated spawn failure \(gate fail\)$/m,
  );
});

// Story #4575 — the production-mode (test-only-importer discount) pass.
//
// Default mode treats `tests/**` as knip entry points, so an export whose only
// remaining importer is a test reads as "used" and stays invisible. Production
// mode drops the test entries, surfacing exports that no production code
// reaches. The two passes ratchet against separate baselines so the default
// gate keeps its meaning and the production gate can carry its own (larger)
// starting set.

// Story #5001 — the knip entry configuration.
//
// A blanket `.agents/scripts/*.js!` entry glob declared every top-level CLI
// live by construction, so knip could never report one as unreachable however
// long nothing had invoked it. The entry set is now an explicit list; these
// tests keep it from regressing to a glob and from going stale.

const knipConfig = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, '..', 'knip.json'), 'utf-8'),
);

test('knip.json: no entry glob can reach a top-level .agents/scripts CLI', () => {
  // The only wildcards permitted under `.agents/scripts` are scoped to a
  // `__tests__` subtree — a colocated test can never be a top-level CLI, so
  // those globs cannot re-declare one live behind the maintainer's back.
  const blanket = knipConfig.entry.filter(
    (p) =>
      p.startsWith('.agents/scripts/') &&
      p.includes('*') &&
      !p.includes('__tests__/'),
  );
  assert.deepEqual(
    blanket,
    [],
    `entry must name .agents/scripts CLIs explicitly; found ${blanket.join(', ')}`,
  );
});

test('knip.json: the explicit entry list omits at least one top-level CLI', () => {
  // The list is only load-bearing if it is narrower than the directory —
  // an entry per file on disk would be the old blanket glob spelled out.
  const repoRoot = path.join(import.meta.dirname, '..');
  const onDisk = fs
    .readdirSync(path.join(repoRoot, '.agents', 'scripts'))
    .filter((f) => f.endsWith('.js'));
  const declared = new Set(
    knipConfig.entry
      .filter((p) => p.startsWith('.agents/scripts/') && !p.includes('*'))
      .map((p) => path.basename(p.replace(/!$/, ''))),
  );
  const omitted = onDisk.filter((f) => !declared.has(f));
  assert.ok(
    omitted.length > 0,
    'every top-level CLI is declared an entry — the ratchet cannot see an uninvoked one',
  );
});

test('knip.json: every explicit .agents/scripts entry exists on disk', () => {
  const repoRoot = path.join(import.meta.dirname, '..');
  const missing = knipConfig.entry
    .filter((p) => p.startsWith('.agents/scripts/') && !p.includes('*'))
    .map((p) => p.replace(/!$/, ''))
    .filter((p) => !fs.existsSync(path.join(repoRoot, p)));
  assert.deepEqual(
    missing,
    [],
    `stale knip entry paths: ${missing.join(', ')}`,
  );
});

test('knip.json: the files rule is enabled so whole-file death is reported', () => {
  assert.notEqual(knipConfig.rules.files, 'off');
});

test('parseArgv: production defaults to false', () => {
  assert.equal(parseArgv([]).production, false);
});

test('parseArgv: --production sets the flag', () => {
  assert.equal(parseArgv(['--production']).production, true);
});

test('parseArgv: --production composes with --baseline and --json', () => {
  const out = parseArgv(['--production', '--baseline', 'b.json', '--json']);
  assert.equal(out.production, true);
  assert.equal(out.baselinePath, 'b.json');
  assert.equal(out.json, true);
});

test('runKnip: omits --production by default', () => {
  let capturedArgs = null;
  runKnip({
    spawn: (_cmd, args) => {
      capturedArgs = args;
      return { stdout: '{"issues":[]}' };
    },
  });
  assert.ok(!capturedArgs.includes('--production'));
});

test('runKnip: passes --production when requested', () => {
  let capturedArgs = null;
  runKnip({
    production: true,
    spawn: (_cmd, args) => {
      capturedArgs = args;
      return { stdout: '{"issues":[]}' };
    },
  });
  assert.ok(capturedArgs.includes('--production'));
});

test('runCli: --production defaults to the production baseline path', async () => {
  const tmp = makeTempDir('dead-exports-prod-');
  const baselinePath = path.join(
    tmp,
    'baselines',
    'dead-exports-production.json',
  );
  fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
  fs.writeFileSync(
    baselinePath,
    JSON.stringify({ kernelVersion: '6.17.1', rows: [] }),
  );
  const knipOutPath = path.join(tmp, 'knip.json');
  fs.writeFileSync(knipOutPath, JSON.stringify({ issues: [] }));

  const stdout = captureStream();
  const exit = await runCli({
    argv: ['--production', '--knip-output', knipOutPath, '--json'],
    cwd: tmp,
    stdout: stdout.stream,
    stderr: captureStream().stream,
  });
  assert.equal(exit, 0);
  const envelope = JSON.parse(stdout.text());
  assert.equal(envelope.baselinePath, baselinePath);
  assert.equal(envelope.mode, 'production');
});

test('runCli: default mode keeps the original baseline path and mode tag', async () => {
  const tmp = makeTempDir('dead-exports-prod-');
  const baselinePath = path.join(tmp, 'baselines', 'dead-exports.json');
  fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
  fs.writeFileSync(
    baselinePath,
    JSON.stringify({ kernelVersion: '6.17.1', rows: [] }),
  );
  const knipOutPath = path.join(tmp, 'knip.json');
  fs.writeFileSync(knipOutPath, JSON.stringify({ issues: [] }));

  const stdout = captureStream();
  const exit = await runCli({
    argv: ['--knip-output', knipOutPath, '--json'],
    cwd: tmp,
    stdout: stdout.stream,
    stderr: captureStream().stream,
  });
  assert.equal(exit, 0);
  const envelope = JSON.parse(stdout.text());
  assert.equal(envelope.baselinePath, baselinePath);
  assert.equal(envelope.mode, 'default');
});

test('runCli: --baseline still overrides the production default', async () => {
  const tmp = makeTempDir('dead-exports-prod-');
  const baselinePath = path.join(tmp, 'custom.json');
  fs.writeFileSync(
    baselinePath,
    JSON.stringify({ kernelVersion: '6.17.1', rows: [] }),
  );
  const knipOutPath = path.join(tmp, 'knip.json');
  fs.writeFileSync(knipOutPath, JSON.stringify({ issues: [] }));

  const stdout = captureStream();
  const exit = await runCli({
    argv: [
      '--production',
      '--baseline',
      baselinePath,
      '--knip-output',
      knipOutPath,
      '--json',
    ],
    cwd: tmp,
    stdout: stdout.stream,
    stderr: captureStream().stream,
  });
  assert.equal(exit, 0);
  assert.equal(JSON.parse(stdout.text()).baselinePath, baselinePath);
});

test('runCli: --production ratchets independently (added row fails the gate)', async () => {
  const tmp = makeTempDir('dead-exports-prod-');
  const baselinePath = path.join(
    tmp,
    'baselines',
    'dead-exports-production.json',
  );
  fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
  fs.writeFileSync(
    baselinePath,
    JSON.stringify({
      kernelVersion: '6.17.1',
      rows: [{ file: 'a.js', symbol: 'seam' }],
    }),
  );
  const knipOutPath = path.join(tmp, 'knip.json');
  fs.writeFileSync(
    knipOutPath,
    JSON.stringify({
      issues: [
        { file: 'a.js', exports: [{ name: 'seam' }] },
        { file: 'b.js', exports: [{ name: 'newlyDead' }] },
      ],
    }),
  );

  const stdout = captureStream();
  const exit = await runCli({
    argv: ['--production', '--knip-output', knipOutPath, '--json'],
    cwd: tmp,
    stdout: stdout.stream,
    stderr: captureStream().stream,
  });
  assert.equal(exit, 1);
  assert.deepEqual(JSON.parse(stdout.text()).added, [
    { file: 'b.js', symbol: 'newlyDead' },
  ]);
});

test('runCli: --production labels its human output distinctly', async () => {
  const tmp = makeTempDir('dead-exports-prod-');
  const baselinePath = path.join(tmp, 'baseline.json');
  fs.writeFileSync(
    baselinePath,
    JSON.stringify({ kernelVersion: '6.17.1', rows: [] }),
  );
  const knipOutPath = path.join(tmp, 'knip.json');
  fs.writeFileSync(knipOutPath, JSON.stringify({ issues: [] }));

  const stdout = captureStream();
  await runCli({
    argv: [
      '--production',
      '--baseline',
      baselinePath,
      '--knip-output',
      knipOutPath,
    ],
    cwd: tmp,
    stdout: stdout.stream,
    stderr: captureStream().stream,
  });
  assert.match(stdout.text(), /dead-exports:production/);
});

// Story #5736 — a knip failure of any kind fails the gate closed (exit 2)
// instead of reporting a green run with zero rows. The fake runners below
// stand in for `spawnSync` *inside* the child-exec wrapper, so they see the
// real options (including `maxBuffer`) the wrapper passes.

const MIB = 1024 * 1024;

/** A baseline + cwd for a real-`runKnip` CLI run with an injected spawn. */
function knipCliFixture() {
  const tmp = makeTempDir('dead-exports-knip-fail-');
  const baselinePath = path.join(tmp, 'baseline.json');
  fs.writeFileSync(
    baselinePath,
    JSON.stringify({ kernelVersion: '6.14.0', rows: [] }),
  );
  return { tmp, baselinePath };
}

/** Drive `runCli --json` through the real `runKnip` with a fake spawn. */
async function runJsonWithSpawn(spawn) {
  const { tmp, baselinePath } = knipCliFixture();
  const stdout = captureStream();
  const exit = await runCli({
    argv: ['--baseline', baselinePath, '--json'],
    cwd: tmp,
    stdout: stdout.stream,
    stderr: captureStream().stream,
    runKnipImpl: (opts) => runKnip({ ...opts, spawn }),
  });
  return { exit, envelope: JSON.parse(stdout.text()) };
}

/** Behaves like real spawnSync: ENOBUFS when stdout outgrows `maxBuffer`. */
function bufferedSpawn(stdout) {
  return (_cmd, _args, opts = {}) => {
    const limit = opts.maxBuffer ?? MIB;
    if (Buffer.byteLength(stdout) > limit) {
      const error = Object.assign(new Error('spawnSync npx ENOBUFS'), {
        code: 'ENOBUFS',
      });
      return { status: null, signal: 'SIGTERM', stdout: '', stderr: '', error };
    }
    return { status: 1, signal: null, stdout, stderr: '' };
  };
}

for (const [name, spawn, pattern] of [
  [
    'knip exits with an error status',
    () => ({ status: 2, stdout: '', stderr: 'ERROR: bad config\nmore' }),
    /knip exited 2: ERROR: bad config/,
  ],
  [
    'knip writes empty stdout',
    () => ({ status: 0, stdout: '   \n', stderr: '' }),
    /empty stdout/,
  ],
  [
    'knip writes unparseable JSON',
    () => ({ status: 1, stdout: '{"issues": [', stderr: '' }),
    /JSON parse failed/,
  ],
]) {
  test(`runCli: exits 2 with a non-null knipError when ${name}`, async () => {
    const { exit, envelope } = await runJsonWithSpawn(spawn);
    assert.equal(exit, 2);
    assert.equal(envelope.exitCode, 2);
    assert.equal(typeof envelope.knipError, 'string');
    assert.match(envelope.knipError, pattern);
  });
}

test('runCli: a clean run carries knipError: null in the JSON envelope', async () => {
  const { exit, envelope } = await runJsonWithSpawn(() => ({
    status: 0,
    stdout: '{"issues":[]}',
    stderr: '',
  }));
  assert.equal(exit, 0);
  assert.equal(envelope.knipError, null);
});

test('runCli: an unreadable --knip-output fails closed (exit 2)', async () => {
  const { tmp, baselinePath } = knipCliFixture();
  const stdout = captureStream();
  const exit = await runCli({
    argv: [
      '--baseline',
      baselinePath,
      '--knip-output',
      'missing.json',
      '--json',
    ],
    cwd: tmp,
    stdout: stdout.stream,
    stderr: captureStream().stream,
  });
  assert.equal(exit, 2);
  assert.match(JSON.parse(stdout.text()).knipError, /missing\.json/);
});

test('runKnip: a report larger than 1 MiB is read in full and scored', async () => {
  const issues = Array.from({ length: 20000 }, (_, i) => ({
    file: `src/module-${String(i).padStart(6, '0')}.js`,
    exports: [{ name: `unusedExportNumber${i}` }],
  }));
  const report = JSON.stringify({ issues });
  assert.ok(Buffer.byteLength(report) > MIB, 'fixture must exceed 1 MiB');

  const { exit, envelope } = await runJsonWithSpawn(bufferedSpawn(report));
  assert.equal(envelope.knipError, null);
  assert.equal(envelope.currentRows.length, issues.length);
  assert.equal(envelope.added.length, issues.length);
  assert.equal(exit, 1);
});

test('runKnip: a report larger than the 64 MiB ceiling fails closed naming the overflow', async () => {
  let seenMaxBuffer = null;
  const huge = 'x'.repeat(64 * MIB + 1);
  const spawn = (cmd, args, opts) => {
    seenMaxBuffer = opts.maxBuffer;
    return bufferedSpawn(huge)(cmd, args, opts);
  };
  const { exit, envelope } = await runJsonWithSpawn(spawn);
  assert.equal(seenMaxBuffer, 64 * MIB);
  assert.equal(exit, 2);
  assert.match(envelope.knipError, /ENOBUFS/);
});

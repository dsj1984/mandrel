import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  diffRows,
  extractRowsFromKnip,
  loadBaseline,
  parseArgv,
  renderDiff,
  runCli,
} from '../.agents/scripts/check-dead-exports.js';

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dead-exports-'));
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dead-exports-'));
  const file = path.join(tmp, 'bad.json');
  fs.writeFileSync(file, '{not json');
  assert.equal(loadBaseline(file), null);
});

test('extractRowsFromKnip: ignores file-level / dependency-level issues', () => {
  const envelope = {
    issues: [
      {
        file: 'a.js',
        files: [{ name: 'a.js' }],
        exports: [],
        dependencies: [{ name: 'lodash' }],
      },
      {
        file: 'b.js',
        exports: [{ name: 'bar' }, { symbol: 'baz' }],
      },
    ],
  };
  const rows = extractRowsFromKnip(envelope);
  assert.deepEqual(rows, [
    { file: 'b.js', symbol: 'bar' },
    { file: 'b.js', symbol: 'baz' },
  ]);
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dead-exports-cli-'));
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dead-exports-cli-'));
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dead-exports-cli-'));
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dead-exports-cli-'));
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dead-exports-cli-'));
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

test('runCli: surfaces knip spawn failure as advisory warning', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dead-exports-cli-'));
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
  assert.equal(exit, 0);
  assert.match(stderr.text(), /simulated spawn failure/);
});

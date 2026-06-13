import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  isFirstParty,
  isFullSha,
  listWorkflowFiles,
  parseArgv,
  renderReport,
  runCli,
  scanWorkflowText,
} from '../.agents/scripts/check-action-pinning.js';

/**
 * Unit coverage for the third-party action-pinning gate (Story #4079).
 *
 * Modeled on the sibling `check-dead-exports.test.js`: exercise the pure
 * helpers directly, then drive `runCli` end-to-end against a fixture
 * workflows directory.
 */

test('parseArgv: returns defaults when no flags supplied', () => {
  const out = parseArgv([]);
  assert.equal(out.dir, null);
  assert.equal(out.json, false);
});

test('parseArgv: --dir takes the next non-flag token, --json sets json', () => {
  const out = parseArgv(['--dir', 'tmp/wf', '--json']);
  assert.equal(out.dir, 'tmp/wf');
  assert.equal(out.json, true);
});

test('parseArgv: --dir without a value falls back to null', () => {
  const out = parseArgv(['--dir', '--json']);
  assert.equal(out.dir, null);
  assert.equal(out.json, true);
});

test('isFullSha: accepts a 40-char hex SHA, rejects everything else', () => {
  assert.equal(isFullSha('37b77001d0174ebec2fcca2bd83ff83a6d45a3ab'), true);
  assert.equal(isFullSha('37B77001D0174EBEC2FCCA2BD83FF83A6D45A3AB'), true);
  assert.equal(isFullSha('v5'), false);
  assert.equal(isFullSha('v3.95.3'), false);
  assert.equal(isFullSha('main'), false);
  // 7-char short SHA is not a full pin.
  assert.equal(isFullSha('37b7700'), false);
  // 41 chars is not a valid SHA.
  assert.equal(isFullSha('37b77001d0174ebec2fcca2bd83ff83a6d45a3abc'), false);
});

test('isFirstParty: actions/* is first-party, others are not', () => {
  assert.equal(isFirstParty('actions/checkout'), true);
  assert.equal(isFirstParty('actions/setup-node'), true);
  assert.equal(isFirstParty('trufflesecurity/trufflehog'), false);
  assert.equal(isFirstParty('googleapis/release-please-action'), false);
});

test('scanWorkflowText: flags a third-party action pinned to @main', () => {
  const text = [
    'jobs:',
    '  x:',
    '    steps:',
    '      - uses: foo/bar@main',
  ].join('\n');
  const v = scanWorkflowText('ci.yml', text);
  assert.equal(v.length, 1);
  assert.equal(v[0].action, 'foo/bar');
  assert.equal(v[0].ref, 'main');
  assert.equal(v[0].line, 4);
  assert.match(v[0].reason, /branch head/);
});

test('scanWorkflowText: flags a third-party action pinned to a version tag', () => {
  const text = '      - uses: googleapis/release-please-action@v5';
  const v = scanWorkflowText('release.yml', text);
  assert.equal(v.length, 1);
  assert.equal(v[0].ref, 'v5');
  assert.match(v[0].reason, /not a full 40-char commit SHA/);
});

test('scanWorkflowText: allows a third-party action pinned to a full SHA', () => {
  const text =
    '      - uses: trufflesecurity/trufflehog@37b77001d0174ebec2fcca2bd83ff83a6d45a3ab # v3.95.3';
  const v = scanWorkflowText('ci.yml', text);
  assert.deepEqual(v, []);
});

test('scanWorkflowText: allows first-party actions/* on a major-version tag', () => {
  const text = [
    '      - uses: actions/checkout@v4',
    '      - uses: actions/setup-node@v4',
  ].join('\n');
  const v = scanWorkflowText('ci.yml', text);
  assert.deepEqual(v, []);
});

test('scanWorkflowText: skips local and docker refs', () => {
  const text = [
    '      - uses: ./.github/actions/local',
    '      - uses: docker://alpine:3.19',
  ].join('\n');
  const v = scanWorkflowText('ci.yml', text);
  assert.deepEqual(v, []);
});

test('scanWorkflowText: flags a third-party action with no ref (floats on default branch)', () => {
  const text = '      - uses: foo/bar';
  const v = scanWorkflowText('ci.yml', text);
  assert.equal(v.length, 1);
  assert.equal(v[0].ref, null);
  assert.match(v[0].reason, /no ref/);
});

test('scanWorkflowText: handles quoted uses values', () => {
  const text = "      - uses: 'foo/bar@master'";
  const v = scanWorkflowText('ci.yml', text);
  assert.equal(v.length, 1);
  assert.equal(v[0].ref, 'master');
});

test('listWorkflowFiles: returns empty list for a missing directory', () => {
  assert.deepEqual(listWorkflowFiles('/does/not/exist/anywhere'), []);
});

test('listWorkflowFiles: lists yml and yaml files sorted', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'action-pin-'));
  fs.writeFileSync(path.join(tmp, 'b.yml'), '');
  fs.writeFileSync(path.join(tmp, 'a.yaml'), '');
  fs.writeFileSync(path.join(tmp, 'ignore.txt'), '');
  const files = listWorkflowFiles(tmp).map((f) => path.basename(f));
  assert.deepEqual(files, ['a.yaml', 'b.yml']);
});

test('renderReport: lines + (gate fail) summary on violations', () => {
  const out = renderReport([
    { file: 'ci.yml', line: 4, action: 'foo/bar', ref: 'main', reason: 'r' },
  ]);
  assert.match(out, /ci\.yml:4 foo\/bar@main — r/);
  assert.match(out, /violations=1 \(gate fail\)/);
});

test('renderReport: (ok) summary on a clean scan', () => {
  const out = renderReport([]);
  assert.match(out, /violations=0 \(ok\)/);
});

function captureStream() {
  const chunks = [];
  return {
    stream: { write: (s) => chunks.push(s) },
    text: () => chunks.join(''),
  };
}

function seedWorkflowsDir(files) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'action-pin-cli-'));
  const wfDir = path.join(tmp, '.github', 'workflows');
  fs.mkdirSync(wfDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(wfDir, name), content);
  }
  return { cwd: tmp, wfDir };
}

test('runCli: exits 0 on a clean scan and emits JSON envelope', async () => {
  const { cwd } = seedWorkflowsDir({
    'ci.yml':
      '      - uses: actions/checkout@v4\n      - uses: foo/bar@37b77001d0174ebec2fcca2bd83ff83a6d45a3ab\n',
  });
  const stdout = captureStream();
  const stderr = captureStream();
  const exit = await runCli({
    argv: ['--json'],
    cwd,
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  assert.equal(exit, 0);
  const envelope = JSON.parse(stdout.text());
  assert.equal(envelope.kind, 'action-pinning-report');
  assert.equal(envelope.filesScanned, 1);
  assert.deepEqual(envelope.violations, []);
  assert.equal(envelope.exitCode, 0);
});

test('runCli: exits 1 when a third-party action floats on @main', async () => {
  const { cwd } = seedWorkflowsDir({
    'ci.yml': '      - uses: foo/bar@main\n',
  });
  const stdout = captureStream();
  const stderr = captureStream();
  const exit = await runCli({
    argv: ['--json'],
    cwd,
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  assert.equal(exit, 1);
  const envelope = JSON.parse(stdout.text());
  assert.equal(envelope.violations.length, 1);
  assert.equal(envelope.violations[0].ref, 'main');
  assert.equal(envelope.exitCode, 1);
});

test('runCli: human output prints violation rows and the gate-fail marker', async () => {
  const { cwd } = seedWorkflowsDir({
    'release.yml': '      - uses: googleapis/release-please-action@v5\n',
  });
  const stdout = captureStream();
  const stderr = captureStream();
  const exit = await runCli({
    argv: [],
    cwd,
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  assert.equal(exit, 1);
  const out = stdout.text();
  assert.match(out, /release\.yml:1 googleapis\/release-please-action@v5/);
  assert.match(out, /\(gate fail\)/);
});

test('runCli: exits 0 and warns when the workflows directory is missing', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'action-pin-empty-'));
  const stdout = captureStream();
  const stderr = captureStream();
  const exit = await runCli({
    argv: [],
    cwd: tmp,
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  assert.equal(exit, 0);
  assert.match(stderr.text(), /no workflow files found/);
});

test('runCli: scans the repo workflows and finds no violations (self-check)', async () => {
  // The repo's own .github/workflows must stay clean — this doubles as a
  // regression guard against a future @main reversion landing in-tree.
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const stdout = captureStream();
  const stderr = captureStream();
  const exit = await runCli({
    argv: ['--json'],
    cwd: repoRoot,
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  const envelope = JSON.parse(stdout.text());
  assert.equal(
    exit,
    0,
    `repo workflows have pinning violations: ${JSON.stringify(envelope.violations, null, 2)}`,
  );
});

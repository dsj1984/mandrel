// tests/scripts/check-workflow-timeouts.test.js
//
// Story #4936 — the check that would have caught an unbounded CI job.
//
// Every job in this repository inherited GitHub's 360-minute default because
// no workflow file set `timeout-minutes`. The cost was measured, not
// hypothetical: a deadlocked `Windows Smoke` job burned 44 minutes of a
// `windows-latest` runner, and while the run stayed `in_progress` GitHub
// withheld the logs of the *required* check that had already failed on the
// same run — so the real merge blocker was undiagnosable until a human
// cancelled it. The gap was found by incident and by no gate, which is the
// whole point of this suite.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';
import {
  countJobs,
  listWorkflowFiles,
  MAX_TIMEOUT_MINUTES,
  MIN_TIMEOUT_MINUTES,
  renderReport,
  runCli,
  scanWorkflowText,
} from '../../scripts/check-workflow-timeouts.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

/** Collect stdout writes so a CLI run can be asserted without a real tty. */
function captureStream() {
  const chunks = [];
  return { write: (s) => chunks.push(s), text: () => chunks.join('') };
}

describe('scanWorkflowText — per-job enumeration', () => {
  test('flags a job that declares no timeout-minutes', () => {
    const violations = scanWorkflowText(
      'wf.yml',
      ['jobs:', '  build:', '    runs-on: ubuntu-latest'].join('\n'),
    );
    assert.equal(violations.length, 1);
    assert.equal(violations[0].job, 'build');
    assert.equal(violations[0].timeout, null);
    assert.match(violations[0].reason, /360-minute default/);
  });

  test('flags only the unbounded job when a sibling is bounded', () => {
    const violations = scanWorkflowText(
      'wf.yml',
      [
        'jobs:',
        '  bounded:',
        '    runs-on: ubuntu-latest',
        '    timeout-minutes: 15',
        '  unbounded:',
        '    runs-on: windows-latest',
      ].join('\n'),
    );
    assert.deepEqual(
      violations.map((v) => v.job),
      ['unbounded'],
    );
  });

  test('flags a timeout above the ceiling', () => {
    const violations = scanWorkflowText(
      'wf.yml',
      [
        'jobs:',
        '  slow:',
        `    timeout-minutes: ${MAX_TIMEOUT_MINUTES + 1}`,
      ].join('\n'),
    );
    assert.equal(violations.length, 1);
    assert.equal(violations[0].timeout, MAX_TIMEOUT_MINUTES + 1);
    assert.match(violations[0].reason, /exceeds the .*ceiling/);
  });

  test('flags a timeout below the floor', () => {
    const violations = scanWorkflowText(
      'wf.yml',
      [
        'jobs:',
        '  twitchy:',
        `    timeout-minutes: ${MIN_TIMEOUT_MINUTES - 1}`,
      ].join('\n'),
    );
    assert.equal(violations.length, 1);
    assert.match(violations[0].reason, /below the .*floor/);
  });

  test('accepts both inclusive bounds', () => {
    const text = [
      'jobs:',
      '  low:',
      `    timeout-minutes: ${MIN_TIMEOUT_MINUTES}`,
      '  high:',
      `    timeout-minutes: ${MAX_TIMEOUT_MINUTES}`,
    ].join('\n');
    assert.deepEqual(scanWorkflowText('wf.yml', text), []);
  });

  test('flags a non-numeric timeout', () => {
    const violations = scanWorkflowText(
      'wf.yml',
      ['jobs:', '  odd:', "    timeout-minutes: 'soon'"].join('\n'),
    );
    assert.equal(violations.length, 1);
    assert.match(violations[0].reason, /not a number/);
  });

  test('exempts a reusable-workflow call, which cannot carry a timeout', () => {
    const violations = scanWorkflowText(
      'wf.yml',
      ['jobs:', '  delegated:', '    uses: ./.github/workflows/other.yml'].join(
        '\n',
      ),
    );
    assert.deepEqual(violations, []);
  });

  test('a workflow with no jobs key yields no violations', () => {
    assert.deepEqual(scanWorkflowText('wf.yml', 'name: nothing\n'), []);
  });

  test('an unparseable workflow fails closed rather than reading as clean', () => {
    const violations = scanWorkflowText('wf.yml', 'jobs:\n  a:\n   - "x\n');
    assert.equal(violations.length, 1);
    assert.equal(violations[0].job, '(document)');
    assert.match(violations[0].reason, /could not be parsed/);
  });

  test('a step-level timeout-minutes does not satisfy the job-level gate', () => {
    // The regression this guards: a `timeout-minutes` nested under a step
    // bounds that step only, leaving the job itself on the 360-minute
    // default. A text-matching gate would read this as bounded.
    const violations = scanWorkflowText(
      'wf.yml',
      [
        'jobs:',
        '  build:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: make',
        '        timeout-minutes: 12',
      ].join('\n'),
    );
    assert.deepEqual(
      violations.map((v) => v.job),
      ['build'],
    );
  });
});

describe('countJobs / renderReport / listWorkflowFiles', () => {
  test('countJobs counts every jobs.<id> key, exempt ones included', () => {
    const text = [
      'jobs:',
      '  a:',
      '    timeout-minutes: 10',
      '  b:',
      '    uses: ./.github/workflows/x.yml',
    ].join('\n');
    assert.equal(countJobs(text), 2);
  });

  test('countJobs returns 0 for unparseable or job-less documents', () => {
    assert.equal(countJobs('name: x\n'), 0);
    assert.equal(countJobs('jobs:\n  a:\n   - "x\n'), 0);
  });

  test('renderReport marks a clean scan ok and a dirty scan as a gate fail', () => {
    assert.match(renderReport([], 4), /jobs=4 violations=0 \(ok\)/);
    const dirty = renderReport(
      [{ file: 'wf.yml', job: 'build', timeout: null, reason: 'unbounded' }],
      4,
    );
    assert.match(dirty, /wf\.yml job build — unbounded/);
    assert.match(dirty, /violations=1 \(gate fail\)/);
  });

  test('listWorkflowFiles returns sorted yml/yaml files and tolerates a missing dir', () => {
    const dir = makeTempDir('wf-timeouts-list-');
    fs.writeFileSync(path.join(dir, 'b.yml'), 'jobs: {}\n');
    fs.writeFileSync(path.join(dir, 'a.yaml'), 'jobs: {}\n');
    fs.writeFileSync(path.join(dir, 'notes.md'), '# no\n');
    assert.deepEqual(
      listWorkflowFiles(dir).map((f) => path.basename(f)),
      ['a.yaml', 'b.yml'],
    );
    assert.deepEqual(listWorkflowFiles(path.join(dir, 'missing')), []);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('runCli — the gate as CI runs it', () => {
  test('exits 1 and names the offending job when one is unbounded', async () => {
    const cwd = makeTempDir('wf-timeouts-fail-');
    const dir = path.join(cwd, '.github', 'workflows');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'ci.yml'),
      [
        'jobs:',
        '  validate:',
        '    timeout-minutes: 20',
        '  smoke:',
        '    runs-on: windows-latest',
      ].join('\n'),
    );
    const stdout = captureStream();
    const code = await runCli({ argv: [], cwd, stdout, stderr: stdout });
    assert.equal(code, 1);
    assert.match(stdout.text(), /smoke/);
    assert.match(stdout.text(), /\(gate fail\)/);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  test('exits 0 on a fully bounded workflow set and reports the job count', async () => {
    const cwd = makeTempDir('wf-timeouts-ok-');
    const dir = path.join(cwd, '.github', 'workflows');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'ci.yml'),
      [
        'jobs:',
        '  a:',
        '    timeout-minutes: 10',
        '  b:',
        '    timeout-minutes: 30',
      ].join('\n'),
    );
    const stdout = captureStream();
    const code = await runCli({ argv: [], cwd, stdout, stderr: stdout });
    assert.equal(code, 0);
    assert.match(stdout.text(), /jobs=2 violations=0 \(ok\)/);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  test('--json emits a structured envelope and --dir retargets the scan', async () => {
    const cwd = makeTempDir('wf-timeouts-json-');
    const dir = path.join(cwd, 'elsewhere');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'ci.yml'),
      ['jobs:', '  hang:', '    runs-on: ubuntu-latest'].join('\n'),
    );
    const stdout = captureStream();
    const code = await runCli({
      argv: ['--dir', 'elsewhere', '--json'],
      cwd,
      stdout,
      stderr: stdout,
    });
    assert.equal(code, 1);
    const envelope = JSON.parse(stdout.text());
    assert.equal(envelope.kind, 'workflow-timeouts-report');
    assert.equal(envelope.jobsScanned, 1);
    assert.equal(envelope.minTimeoutMinutes, MIN_TIMEOUT_MINUTES);
    assert.equal(envelope.maxTimeoutMinutes, MAX_TIMEOUT_MINUTES);
    assert.deepEqual(
      envelope.violations.map((v) => v.job),
      ['hang'],
    );
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  test('an empty workflows directory exits 0 with a warning', async () => {
    const cwd = makeTempDir('wf-timeouts-empty-');
    fs.mkdirSync(path.join(cwd, '.github', 'workflows'), { recursive: true });
    const stdout = captureStream();
    const stderr = captureStream();
    assert.equal(await runCli({ argv: [], cwd, stdout, stderr }), 0);
    assert.match(stderr.text(), /no workflow files found/);
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

describe('this repository', () => {
  test('every job in every workflow file is bounded in range', async () => {
    const stdout = captureStream();
    const code = await runCli({
      argv: ['--json'],
      cwd: REPO_ROOT,
      stdout,
      stderr: stdout,
    });
    const envelope = JSON.parse(stdout.text());
    assert.deepEqual(
      envelope.violations,
      [],
      `unbounded or over-ceiling CI jobs: ${JSON.stringify(envelope.violations, null, 2)}`,
    );
    assert.equal(code, 0);
    // Sanity: the scan actually reached the real workflow set rather than
    // passing vacuously over an empty directory.
    assert.ok(envelope.filesScanned >= 4, 'expected the repo workflow files');
    assert.ok(
      envelope.jobsScanned >= 11,
      'expected every job to be enumerated',
    );
  });

  test('`npm run lint` runs the gate, so it is enforced and not merely present', () => {
    const runLint = fs.readFileSync(
      path.join(REPO_ROOT, 'scripts', 'run-lint.js'),
      'utf8',
    );
    assert.match(
      runLint,
      /check-workflow-timeouts\.js/,
      'check-workflow-timeouts.js must be a run-lint.js task — an unwired ' +
        'gate is exactly the failure mode Story #4936 exists to close',
    );
  });
});

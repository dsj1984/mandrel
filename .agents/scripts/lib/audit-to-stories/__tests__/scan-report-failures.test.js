/**
 * Story #5144 — the report cross-check gate.
 *
 * Every lens report must declare a machine-readable
 * `Severity tally: Critical <n> / High <n> / Medium <n> / Low <n>` line, and
 * `buildPlan` cross-checks it against the findings the parser actually
 * extracted. A missing line, a mismatch, or a finding whose severity did not
 * resolve is a named **report failure**: `--scan` reports it (stderr, so the
 * plan JSON on stdout stays clean) and carries it on
 * `summary.reportFailures[]`; `--auto` refuses to file anything at all.
 *
 * Driven as a real subprocess through the shipped CLI so the exit-code and
 * no-write halves of the contract are exercised end-to-end. Fixtures are
 * written to a temp dir rather than committed, because a committed broken
 * report would poison every other fixture-globbing test.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from '../../test-temp.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../../..');
const CLI = path.join(REPO_ROOT, '.agents/scripts/audit-to-stories.js');

const FINDINGS = `## Detailed Findings

### SQLi in login handler
- **Severity:** High
- **Location:** \`src/auth/login.js:42\`
- **Dimension:** security
- **Current State:** The login query concatenates user input.
- **Recommendation:** Parameterise the query.
`;

const MISMATCHED = `# Audit: Security

## Executive Summary

Severity tally: Critical 0 / High 3 / Medium 1 / Low 0

${FINDINGS}`;

const MISSING = `# Audit: Security

## Executive Summary

No tally line at all — an older, hand-written report.

${FINDINGS}`;

const UNRESOLVED_SEVERITY = `# Audit: Security

## Executive Summary

Severity tally: Critical 0 / High 1 / Medium 0 / Low 0

${FINDINGS}
### Something graded on a scale of its own
- **Severity:** Spicy
- **Location:** \`src/util/helper.js:8\`
- **Dimension:** clean-code
- **Current State:** The helper does something odd.
- **Recommendation:** Stop doing that.
`;

let workDir;

before(() => {
  workDir = makeTempDir('audit-report-failures-');
});

after(() => {
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
});

/**
 * Write one report into its own audits dir so each case globs in isolation.
 *
 * @param {string} name — case name (becomes the sub-directory).
 * @param {string} markdown — report body.
 * @returns {string} the case directory (the CLI's cwd).
 */
function plant(name, markdown) {
  const caseDir = path.join(workDir, name);
  fs.mkdirSync(path.join(caseDir, 'audits'), { recursive: true });
  fs.writeFileSync(
    path.join(caseDir, 'audits', 'audit-security-results.md'),
    markdown,
  );
  return caseDir;
}

/**
 * Run the CLI, capturing stdout, stderr and the exit status. `spawnSync` —
 * not `execFileSync` — because both halves of this contract are assertions
 * about a non-zero exit AND the stderr that came with it.
 *
 * @param {string} cwd
 * @param {string[]} args
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function run(cwd, args) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

const SCAN = ['--scan', '--severity', 'all', '--no-provider', '--glob'];

describe('report cross-check — mismatched tally', () => {
  it('AC-3: --scan names the report and both tallies and carries the failure', () => {
    const cwd = plant('mismatch-scan', MISMATCHED);
    const { status, stdout, stderr } = run(cwd, [...SCAN, 'audits/*.md']);

    assert.equal(status, 0, '--scan stays a diagnostic pass');
    // Separator-agnostic: the CLI prints the report path as the OS spells it,
    // so Windows emits `audits\\audit-security-results.md`.
    assert.match(stderr, /audits[\\/]audit-security-results\.md/);
    assert.match(stderr, /Critical 0 \/ High 3 \/ Medium 1 \/ Low 0/);
    assert.match(stderr, /Critical 0 \/ High 1 \/ Medium 0 \/ Low 0/);

    const plan = JSON.parse(stdout);
    assert.equal(plan.summary.reportFailures.length, 1);
    const [failure] = plan.summary.reportFailures;
    assert.equal(failure.kind, 'tally-mismatch');
    assert.match(failure.sourceReport, /audit-security-results\.md$/);
    assert.deepEqual(failure.reported, {
      critical: 0,
      high: 3,
      medium: 1,
      low: 0,
    });
    assert.deepEqual(failure.parsed, {
      critical: 0,
      high: 1,
      medium: 0,
      low: 0,
    });
  });

  it('AC-3: --auto exits non-zero, emitting no Issue payload', () => {
    const cwd = plant('mismatch-auto', MISMATCHED);
    const { status, stdout, stderr } = run(cwd, [
      '--auto',
      '--no-provider',
      '--glob',
      'audits/*.md',
    ]);

    assert.notEqual(status, 0, '--auto fails closed on a report failure');
    assert.equal(stdout.trim(), '', 'no Issue payload reaches stdout');
    assert.match(stderr, /audit report cross-check FAILED/);
  });
});

describe('report cross-check — missing tally line', () => {
  it('AC-4: --auto refuses a report that declares no tally', () => {
    const cwd = plant('missing-auto', MISSING);
    const { status, stderr } = run(cwd, [
      '--auto',
      '--no-provider',
      '--glob',
      'audits/*.md',
    ]);

    assert.notEqual(status, 0);
    assert.match(stderr, /missing-tally/);
  });

  it('AC-4: --auto ignores --allow-missing-tally', () => {
    const cwd = plant('missing-auto-flagged', MISSING);
    const { status, stderr } = run(cwd, [
      '--auto',
      '--no-provider',
      '--allow-missing-tally',
      '--glob',
      'audits/*.md',
    ]);

    assert.notEqual(status, 0, 'the flag is a --scan affordance only');
    assert.match(stderr, /missing-tally/);
  });

  it('AC-4: --scan --allow-missing-tally downgrades that one kind to a warning', () => {
    const cwd = plant('missing-scan', MISSING);
    const { status, stdout, stderr } = run(cwd, [
      ...SCAN,
      'audits/*.md',
      '--allow-missing-tally',
    ]);

    assert.equal(status, 0);
    assert.match(stderr, /declares no "Severity tally:" line/);
    assert.doesNotMatch(stderr, /cross-check FAILED/);
    const plan = JSON.parse(stdout);
    assert.deepEqual(plan.summary.reportFailures, []);
    assert.ok(plan.groups.length > 0, 'the plan is still usable');
  });

  it('AC-4: plain --scan reports the missing line as a failure', () => {
    const cwd = plant('missing-scan-strict', MISSING);
    const { status, stdout } = run(cwd, [...SCAN, 'audits/*.md']);

    assert.equal(status, 0);
    const plan = JSON.parse(stdout);
    assert.deepEqual(
      plan.summary.reportFailures.map((f) => f.kind),
      ['missing-tally'],
    );
    assert.equal(plan.summary.reportFailures[0].reported, null);
  });
});

describe('report cross-check — unresolvable severity', () => {
  it('AC-5: the finding is a report failure and never becomes an unknown group', () => {
    const cwd = plant('unresolved', UNRESOLVED_SEVERITY);
    const { status, stdout } = run(cwd, [...SCAN, 'audits/*.md']);

    assert.equal(status, 0);
    const plan = JSON.parse(stdout);
    const kinds = plan.summary.reportFailures.map((f) => f.kind);
    assert.ok(
      kinds.includes('unresolved-severity'),
      'the unparseable severity is named',
    );
    assert.equal(plan.summary.tally.unknown, 1, 'still visible in the tally');
    for (const finding of plan.findings) {
      assert.ok(finding.severity, 'no severity-less finding reaches the plan');
    }
    const grouped = plan.groups.flatMap((g) => g.findings ?? []);
    assert.equal(
      grouped.some((f) => !f.severity),
      false,
      'no severity-less finding reaches grouping',
    );
    assert.notEqual(
      run(cwd, ['--auto', '--no-provider', '--glob', 'audits/*.md']).status,
      0,
      '--auto refuses the report',
    );
  });
});

/**
 * AC-6 (Story #4626): unattended sweeps are possible.
 *
 * `node .agents/scripts/audit-to-stories.js --auto --dry-run` over a fixture
 * results dir exits 0 without prompting, applies the configured severity
 * floor, and reports a run summary. Driven as a real subprocess so the "no
 * interactive gate / clean exit code" contract is exercised end-to-end.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../../..');
const CLI = path.join(REPO_ROOT, '.agents/scripts/audit-to-stories.js');

let workDir;

const FIXTURE = `# Audit: Security

## Detailed Findings

### SQLi in login handler
- **Severity:** High
- **Location:** \`src/auth/login.js:42\`
- **Dimension:** security
- **Current State:** The login query concatenates user input.
- **Recommendation:** Parameterise the query.

### Minor style nit in helper
- **Severity:** Low
- **Location:** \`src/util/helper.js:8\`
- **Dimension:** clean-code
- **Current State:** Inconsistent spacing.
- **Recommendation:** Reformat.
`;

before(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-auto-'));
  const auditsDir = path.join(workDir, 'audits');
  fs.mkdirSync(auditsDir, { recursive: true });
  fs.writeFileSync(path.join(auditsDir, 'audit-security-results.md'), FIXTURE);
});

after(() => {
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
});

function runAuto(extraArgs) {
  const out = execFileSync(
    process.execPath,
    [
      CLI,
      '--auto',
      '--dry-run',
      '--no-provider',
      '--glob',
      'audits/*.md',
      ...extraArgs,
    ],
    { cwd: workDir, encoding: 'utf8' },
  );
  // The summary is the last JSON object printed to stdout.
  const start = out.indexOf('{');
  return JSON.parse(out.slice(start));
}

test('AC-6: --auto --dry-run exits 0 and reports a run summary', () => {
  // execFileSync throws on a non-zero exit; reaching the assertions IS the
  // exit-0 proof.
  const summary = runAuto([]);
  assert.equal(summary.mode, 'auto');
  assert.equal(summary.dryRun, true);
  assert.ok(summary.totals, 'summary reports totals');
  assert.equal(typeof summary.totals.findings, 'number');
  assert.ok(summary.totals.findings >= 2, 'both fixture findings parsed');
});

test('AC-6: the default severity floor (high) filters out the Low finding', () => {
  const summary = runAuto([]);
  assert.equal(summary.severityFloor, 'high');
  // Only the High finding clears the floor.
  assert.equal(summary.totals.filtered, 1);
});

test('AC-6: an explicit --severity floor overrides the default', () => {
  const summary = runAuto(['--severity', 'all']);
  assert.equal(summary.severityFloor, 'all');
  assert.equal(summary.totals.filtered, 2);
});

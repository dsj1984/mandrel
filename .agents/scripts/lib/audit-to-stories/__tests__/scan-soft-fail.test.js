/**
 * AC-8 (Story #4678): `audit-to-stories.js --scan` exits 0 on a fixture set
 * whose search port fails for a subset of groups.
 *
 * Driven as a real subprocess so the "soft-fail, never fatal" contract is
 * exercised end-to-end through the CLI. A failing-subset provider is injected
 * via the `AUDIT_TO_STORIES_PROVIDER_FIXTURE` seam. The scan must exit 0, keep
 * stdout as parseable JSON, carry `summary.dedupDegraded`, and route the
 * operator warning to stderr.
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
const FIXTURE_PROVIDER = path.join(HERE, 'fixtures/failing-subset-provider.js');

const FIXTURE = `# Audit: Security

## Detailed Findings

### SQLi in login handler
- **Severity:** High
- **Location:** \`src/auth/login.js:42\`
- **Dimension:** security
- **Current State:** The login query concatenates user input.
- **Recommendation:** Parameterise the query.

### Missing authz check on report export
- **Severity:** High
- **Location:** \`src/report/export.js:19\`
- **Dimension:** security
- **Current State:** No ownership check before export.
- **Recommendation:** Verify ownership server-side.

### Unbounded fan-out in scheduler
- **Severity:** High
- **Location:** \`src/sched/core.js:88\`
- **Dimension:** performance
- **Current State:** The scheduler issues one call per item with no budget.
- **Recommendation:** Add a budget.

### Non-atomic write in ledger
- **Severity:** High
- **Location:** \`src/ledger/write.js:5\`
- **Dimension:** performance
- **Current State:** Write is not atomic.
- **Recommendation:** Write-then-rename.
`;

let workDir;

before(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-scan-softfail-'));
  const auditsDir = path.join(workDir, 'audits');
  fs.mkdirSync(auditsDir, { recursive: true });
  fs.writeFileSync(path.join(auditsDir, 'audit-security-results.md'), FIXTURE);
});

after(() => {
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
});

test('AC-8: --scan exits 0 and soft-fails the degraded subset', () => {
  // execFileSync throws on a non-zero exit, so reaching the assertions IS the
  // exit-0 proof. stderr is captured separately so we can confirm stdout stays
  // pure JSON.
  const stdout = execFileSync(
    process.execPath,
    [CLI, '--scan', '--severity', 'all', '--glob', 'audits/*.md'],
    {
      cwd: workDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        AUDIT_TO_STORIES_PROVIDER_FIXTURE: FIXTURE_PROVIDER,
      },
    },
  );

  // stdout is parseable JSON (the warning went to stderr).
  const plan = JSON.parse(stdout);
  assert.ok(plan.summary, 'plan carries a summary');
  assert.ok(
    plan.summary.dedupApplied,
    'dedup ran against the fixture provider',
  );
  assert.ok(
    plan.summary.dedupDegraded.count >= 1,
    'at least one group degraded to create',
  );
  assert.ok(
    Array.isArray(plan.summary.dedupDegraded.groups) &&
      plan.summary.dedupDegraded.groups.every((g) => g.group && g.reason),
    'each degraded entry names a group and a reason',
  );
});

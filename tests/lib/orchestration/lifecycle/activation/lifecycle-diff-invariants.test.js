// tests/lib/orchestration/lifecycle/activation/lifecycle-diff-invariants.test.js
/**
 * Lifecycle-diff invariant gate for the activation suite
 * (Story #2343 / Task #2347, Epic #2306).
 *
 * Shells out to `node .agents/scripts/lifecycle-diff.js --assert <mode>`
 * against the clean-sprint fixture's ledger and confirms both
 * reliability invariants exit 0:
 *
 *   - `--assert reconcile-ordering` — `pr.created` is preceded by
 *     `acceptance.reconcile.ok` in the same run, with a strictly
 *     greater seqId. Prevents a future refactor from re-wiring the
 *     Finalizer to a non-`.ok` subscription.
 *
 *   - `--assert merge-gate-ordering` — `epic.merge.armed` is preceded
 *     by `epic.merge.ready` in the same run, with a strictly greater
 *     seqId. Prevents a future refactor from arming auto-merge before
 *     the AutomergePredicate's clean verdict.
 *
 * The test shells out via `node` rather than calling the assertion
 * helpers in-process so the gate exercises the CLI surface operators
 * use during incident response (the same one `/epic-deliver`'s wave
 * close-tail validation can invoke). The in-process helpers are also
 * pinned by `clean-sprint.test.js`; this file is the cross-process
 * dimension of the AC.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildCleanSprintFixture } from './fixtures/clean-sprint.fixture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const LIFECYCLE_DIFF_CLI = path.join(
  REPO_ROOT,
  '.agents',
  'scripts',
  'lifecycle-diff.js',
);

/**
 * Drive `node lifecycle-diff.js --assert <mode> <ledger>` and return
 * the spawn result. Run with `shell: false` so the assertion is robust
 * across PowerShell / bash on Windows.
 */
function runDiff(mode, ledgerPath) {
  return spawnSync(
    process.execPath,
    [LIFECYCLE_DIFF_CLI, '--assert', mode, ledgerPath],
    {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      shell: false,
    },
  );
}

describe('lifecycle-diff --assert against the clean-sprint ledger', () => {
  let fixture;

  before(async () => {
    fixture = buildCleanSprintFixture();
    await fixture.bus.emit('epic.close.end', { epicId: fixture.epicId });
    // Sanity: the fixture must have produced a ledger before the CLI
    // can assert anything against it.
    assert.ok(
      existsSync(fixture.ledgerPath),
      `expected ledger at ${fixture.ledgerPath} — fixture failed to write?`,
    );
  });

  after(() => {
    fixture.cleanup();
  });

  it('--assert reconcile-ordering exits 0 against the clean-sprint ledger', () => {
    const result = runDiff('reconcile-ordering', fixture.ledgerPath);
    assert.equal(
      result.status,
      0,
      `lifecycle-diff --assert reconcile-ordering MUST exit 0; got status=${result.status}\nstdout=${result.stdout}\nstderr=${result.stderr}`,
    );
    assert.match(result.stdout, /\[lifecycle-diff\] PASS reconcile-ordering/);
  });

  it('--assert merge-gate-ordering exits 0 against the clean-sprint ledger', () => {
    const result = runDiff('merge-gate-ordering', fixture.ledgerPath);
    assert.equal(
      result.status,
      0,
      `lifecycle-diff --assert merge-gate-ordering MUST exit 0; got status=${result.status}\nstdout=${result.stdout}\nstderr=${result.stderr}`,
    );
    assert.match(result.stdout, /\[lifecycle-diff\] PASS merge-gate-ordering/);
  });
});

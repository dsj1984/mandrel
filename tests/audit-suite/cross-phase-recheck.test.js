/**
 * tests/audit-suite/cross-phase-recheck.test.js
 *
 * Contract test for Story #2619 / Task #2629: `epic-audit-recheck.js`
 * must restrict its `selectedAudits` output to lenses whose
 * `triggers.filePatterns` overlap the caller-supplied file list. It is
 * also required to fail-closed when `--epic` or `--files` is missing.
 *
 * Tier: contract. Asserts CLI envelope shape + exit codes — the wire
 * contract `helpers/epic-code-review.md` Step 4.6 reads from stdout.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..');
const CLI_PATH = path.join(
  REPO_ROOT,
  '.agents',
  'scripts',
  'epic-audit-recheck.js',
);

function runCli(args) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
}

test('epic-audit-recheck: overlapping file list returns selectedAudits including audit-security', () => {
  // `audit-security` declares `filePatterns: ["**/auth/*.js", ...]` in
  // `.agents/schemas/audit-rules.json`. A touched file under that glob
  // MUST surface the lens.
  const res = runCli([
    '--epic',
    '2586',
    '--files',
    'src/auth/login.js,src/api/users.ts',
  ]);

  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  const envelope = JSON.parse(res.stdout);
  assert.equal(envelope.epicId, 2586);
  assert.ok(
    Array.isArray(envelope.selectedAudits),
    'selectedAudits must be an array',
  );
  assert.ok(
    envelope.selectedAudits.length > 0,
    'overlapping file list must yield non-empty selectedAudits',
  );
  assert.ok(
    envelope.selectedAudits.includes('audit-security'),
    `expected audit-security in selectedAudits, got ${JSON.stringify(envelope.selectedAudits)}`,
  );
  assert.deepEqual(envelope.context.changedFiles, [
    'src/auth/login.js',
    'src/api/users.ts',
  ]);
  assert.equal(envelope.context.changedFilesCount, 2);
});

test('epic-audit-recheck: non-overlapping file list returns empty selectedAudits', () => {
  // `.rs` is not in any lens's filePatterns, and `src/billing/` is not
  // either. The CLI MUST emit an envelope with selectedAudits=[] rather
  // than fall back to keyword/alwaysRun behaviour.
  const res = runCli([
    '--epic',
    '2586',
    '--files',
    'src/billing/totals.rs,src/billing/invoice.rs',
  ]);

  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  const envelope = JSON.parse(res.stdout);
  assert.deepEqual(
    envelope.selectedAudits,
    [],
    `non-overlapping input must yield empty selectedAudits, got ${JSON.stringify(envelope.selectedAudits)}`,
  );
  assert.equal(envelope.context.changedFilesCount, 2);
});

test('epic-audit-recheck: missing --epic exits non-zero', () => {
  const res = runCli(['--files', 'src/auth/login.js']);
  assert.notEqual(res.status, 0, 'missing --epic must fail');
  assert.match(res.stderr, /--epic/);
});

test('epic-audit-recheck: missing --files exits non-zero', () => {
  const res = runCli(['--epic', '2586']);
  assert.notEqual(res.status, 0, 'missing --files must fail');
  assert.match(res.stderr, /--files/);
});

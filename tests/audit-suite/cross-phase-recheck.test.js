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

import { selectOverlappingAudits } from '../../.agents/scripts/epic-audit-recheck.js';

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

test('epic-audit-recheck: overlapping file list surfaces cumulative lenses only', () => {
  // `audit-devops` (cumulative) declares `filePatterns: [".github/workflows/**",
  // ...]`. A touched workflow file MUST surface that lens at Epic close. The
  // universal `audit-clean-code` (local, `**/*`) also matches every path but
  // is a `local`-tier lens, so the Epic-close tier gate drops it.
  const res = runCli(['--epic', '2586', '--files', '.github/workflows/ci.yml']);

  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  const envelope = JSON.parse(res.stdout);
  assert.equal(envelope.epicId, 2586);
  assert.ok(
    Array.isArray(envelope.selectedAudits),
    'selectedAudits must be an array',
  );
  assert.ok(
    envelope.selectedAudits.includes('audit-devops'),
    `expected audit-devops in selectedAudits, got ${JSON.stringify(envelope.selectedAudits)}`,
  );
  assert.ok(
    !envelope.selectedAudits.includes('audit-clean-code'),
    `local lens audit-clean-code must NOT re-run at Epic close, got ${JSON.stringify(envelope.selectedAudits)}`,
  );
  assert.equal(envelope.context.changedFilesCount, 1);
});

test('epic-audit-recheck: a local-lens overlap is filtered out at Epic close', () => {
  // `src/auth/login.js` overlaps only local lenses: audit-security
  // (`**/auth/*.js`), audit-performance (`src/**/*.{ts,js}`), and the
  // universal audit-clean-code. Every one is `local`-tier, so the Epic-close
  // tier gate drops them all — the re-check re-runs nothing.
  const res = runCli(['--epic', '2586', '--files', 'src/auth/login.js']);

  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  const envelope = JSON.parse(res.stdout);
  assert.deepEqual(
    envelope.selectedAudits,
    [],
    `a local-only overlap must yield empty selectedAudits, got ${JSON.stringify(envelope.selectedAudits)}`,
  );
});

test('epic-audit-recheck: non-overlapping file list returns empty selectedAudits', () => {
  // `.rs` matches no cumulative/global lens's filePatterns. It DOES match the
  // universal `audit-clean-code` (`**/*`), but that lens is `local`-tier and
  // dropped by the Epic-close tier gate — so the envelope is still empty.
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

test('selectOverlappingAudits: tier gate drops local lenses, keeps cumulative/global (pure)', () => {
  const rules = {
    audits: {
      'lens-local': { triggers: { filePatterns: ['**/*'] } },
      'lens-cumulative': { triggers: { filePatterns: ['**/*'] } },
      'lens-global': { triggers: { filePatterns: ['**/*'] } },
      'lens-no-patterns': { triggers: {} },
    },
  };
  const fakeTierResolver = (lens) => {
    if (lens.includes('cumulative')) return 'cumulative';
    if (lens.includes('global')) return 'global';
    return 'local';
  };
  const selected = selectOverlappingAudits(
    rules,
    ['any/path.js'],
    fakeTierResolver,
  );
  // The local lens overlaps but is dropped by the tier gate; the pattern-less
  // lens is dropped by the pattern gate.
  assert.deepEqual(selected, ['lens-cumulative', 'lens-global']);
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

// tests/audit-strategy.test.js
//
// Unit tier (Story #3610 — Epic #3597): `audit-strategy.js` is the deterministic
// decision surface that wires `selectAuditStrategy` into a real entry point.
// These tests pin two layers:
//   1. `resolveAuditStrategy` / `formatDecisionLine` / `parseArgs` as pure
//      functions of an injected env bag (no live runtime).
//   2. The CLI itself, spawned with a controlled `env`, to prove it prints the
//      chosen strategy + reason on stdout and exits 0 (Acceptance #1, #2, #3).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_LENS,
  formatDecisionLine,
  parseArgs,
  resolveAuditStrategy,
} from '../.agents/scripts/audit-strategy.js';
import {
  AUDIT_STRATEGY,
  DECISION_REASON,
} from '../.agents/scripts/lib/dynamic-workflow/capability.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUDIT_STRATEGY_SCRIPT = path.resolve(
  __dirname,
  '..',
  '.agents',
  'scripts',
  'audit-strategy.js',
);

// A clean env with none of the capability/force keys set. Spreading process.env
// would leak whatever the host runtime exported (e.g. CLAUDE_CODE_RUNTIME),
// making the CLI decision non-deterministic; we control every relevant key.
const CLEAN_ENV = Object.freeze({
  MANDREL_AUDIT_STRATEGY: undefined,
  CLAUDE_CODE_RUNTIME: undefined,
  CLAUDE_CODE_VERSION: undefined,
  CLAUDE_CODE_PLAN: undefined,
  CLAUDE_CODE_DISABLE_WORKFLOWS: undefined,
});

// --- resolveAuditStrategy (pure) -----------------------------------------

test('resolveAuditStrategy: empty env degrades to sequential (not-claude-runtime)', () => {
  const decision = resolveAuditStrategy({ env: {} });
  assert.equal(decision.strategy, AUDIT_STRATEGY.SEQUENTIAL);
  assert.equal(decision.reason, DECISION_REASON.NOT_CLAUDE_RUNTIME);
  assert.equal(decision.forced, false);
  assert.equal(decision.lens, DEFAULT_LENS);
});

test('resolveAuditStrategy: MANDREL_AUDIT_STRATEGY=sequential forces sequential', () => {
  const decision = resolveAuditStrategy({
    env: { MANDREL_AUDIT_STRATEGY: 'sequential' },
  });
  assert.equal(decision.strategy, AUDIT_STRATEGY.SEQUENTIAL);
  assert.equal(decision.reason, DECISION_REASON.FORCED_SEQUENTIAL);
  assert.equal(decision.forced, true);
});

test('resolveAuditStrategy: MANDREL_AUDIT_STRATEGY=orchestrated forces orchestrated', () => {
  const decision = resolveAuditStrategy({
    env: { MANDREL_AUDIT_STRATEGY: 'orchestrated' },
  });
  assert.equal(decision.strategy, AUDIT_STRATEGY.ORCHESTRATED);
  assert.equal(decision.reason, DECISION_REASON.FORCED_ORCHESTRATED);
  assert.equal(decision.forced, true);
});

test('resolveAuditStrategy: capable Claude runtime selects orchestrated', () => {
  const decision = resolveAuditStrategy({
    env: {
      CLAUDE_CODE_RUNTIME: 'claude-code',
      CLAUDE_CODE_VERSION: '2.2.0',
      CLAUDE_CODE_PLAN: 'max',
    },
  });
  assert.equal(decision.strategy, AUDIT_STRATEGY.ORCHESTRATED);
  assert.equal(decision.reason, DECISION_REASON.CAPABILITY_PRESENT);
  assert.equal(decision.forced, false);
});

test('resolveAuditStrategy: lens label is echoed through', () => {
  const decision = resolveAuditStrategy({ env: {}, lens: 'audit-performance' });
  assert.equal(decision.lens, 'audit-performance');
});

// --- formatDecisionLine ---------------------------------------------------

test('formatDecisionLine: includes lens, strategy, reason, and forced', () => {
  const line = formatDecisionLine({
    lens: 'audit-clean-code',
    strategy: 'sequential',
    reason: 'not-claude-runtime',
    forced: false,
  });
  assert.equal(
    line,
    'audit-strategy: lens=audit-clean-code strategy=sequential reason=not-claude-runtime forced=false',
  );
});

// --- parseArgs ------------------------------------------------------------

test('parseArgs: defaults to clean-code lens, non-JSON', () => {
  assert.deepEqual(parseArgs([]), { lens: DEFAULT_LENS, json: false });
});

test('parseArgs: --json toggles JSON output', () => {
  assert.equal(parseArgs(['--json']).json, true);
});

test('parseArgs: --lens <name> sets the lens', () => {
  assert.equal(parseArgs(['--lens', 'audit-security']).lens, 'audit-security');
});

test('parseArgs: --lens without a value throws', () => {
  assert.throws(() => parseArgs(['--lens']), /--lens requires a value/);
});

test('parseArgs: unrecognised argument throws', () => {
  assert.throws(() => parseArgs(['--bogus']), /unrecognised argument/);
});

// --- CLI smoke tests (spawned) -------------------------------------------

test('CLI: prints strategy + reason and exits 0 (Acceptance #1)', () => {
  const res = spawnSync(process.execPath, [AUDIT_STRATEGY_SCRIPT], {
    env: { ...CLEAN_ENV },
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.match(res.stdout, /strategy=/);
  assert.match(res.stdout, /reason=/);
});

test('CLI: MANDREL_AUDIT_STRATEGY=sequential reports sequential (Acceptance #2)', () => {
  const res = spawnSync(process.execPath, [AUDIT_STRATEGY_SCRIPT], {
    env: { ...CLEAN_ENV, MANDREL_AUDIT_STRATEGY: 'sequential' },
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.match(res.stdout, /strategy=sequential/);
  assert.match(res.stdout, /reason=forced-sequential/);
});

test('CLI: --json emits a parseable decision envelope on stdout', () => {
  const res = spawnSync(
    process.execPath,
    [AUDIT_STRATEGY_SCRIPT, '--json', '--lens', 'audit-performance'],
    {
      env: { ...CLEAN_ENV, MANDREL_AUDIT_STRATEGY: 'orchestrated' },
      encoding: 'utf8',
    },
  );
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  const decision = JSON.parse(res.stdout);
  assert.equal(decision.lens, 'audit-performance');
  assert.equal(decision.strategy, 'orchestrated');
  assert.equal(decision.reason, 'forced-orchestrated');
  assert.equal(decision.forced, true);
});

test('CLI: unrecognised flag exits non-zero with an error', () => {
  const res = spawnSync(process.execPath, [AUDIT_STRATEGY_SCRIPT, '--bogus'], {
    env: { ...CLEAN_ENV },
    encoding: 'utf8',
  });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /audit-strategy/);
});

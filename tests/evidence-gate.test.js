import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseWrapperArgs,
  splitOnDashDash,
} from '../.agents/scripts/evidence-gate.js';

test('splitOnDashDash() partitions argv at the first --', () => {
  const { wrapperArgs, runnerArgs } = splitOnDashDash([
    '--scope-id',
    '817',
    '--gate',
    'lint',
    '--',
    'npm',
    'run',
    'lint',
  ]);
  assert.deepEqual(wrapperArgs, ['--scope-id', '817', '--gate', 'lint']);
  assert.deepEqual(runnerArgs, ['npm', 'run', 'lint']);
});

test('splitOnDashDash() returns empty runner side when -- is missing', () => {
  const { wrapperArgs, runnerArgs } = splitOnDashDash(['--gate', 'lint']);
  assert.deepEqual(wrapperArgs, ['--gate', 'lint']);
  assert.deepEqual(runnerArgs, []);
});

test('parseWrapperArgs() coerces --scope-id and toggles --no-evidence', () => {
  const args = parseWrapperArgs([
    '--standalone',
    '--scope-id',
    '817',
    '--gate',
    'lint',
    '--no-evidence',
  ]);
  assert.equal(args.scopeId, 817);
  assert.equal(args.gate, 'lint');
  assert.equal(args.useEvidence, false);
});

test('parseWrapperArgs() defaults --no-evidence to false (evidence ON)', () => {
  const args = parseWrapperArgs([
    '--standalone',
    '--scope-id',
    '817',
    '--gate',
    'test',
  ]);
  assert.equal(args.useEvidence, true);
});

test('parseWrapperArgs() yields scopeId=null on non-positive input', () => {
  assert.equal(parseWrapperArgs(['--scope-id', '0']).scopeId, null);
  assert.equal(parseWrapperArgs(['--scope-id', 'abc']).scopeId, null);
  assert.equal(parseWrapperArgs([]).scopeId, null);
});

test('parseWrapperArgs() parses --standalone (Story #4250)', () => {
  const args = parseWrapperArgs([
    '--standalone',
    '--scope-id',
    '4250',
    '--gate',
    'lint',
  ]);
  assert.equal(args.standalone, true);
  assert.equal(args.scopeId, 4250);
});

test('parseWrapperArgs() defaults --standalone to false', () => {
  assert.equal(parseWrapperArgs(['--scope-id', '4250']).standalone, false);
});

/**
 * Story #5278 — the credit survives close's own base-sync.
 *
 * The worker deposits `lint` / `typecheck` evidence before the push. Close
 * then fast-forwards the Story branch from `origin/main` and runs the gates.
 * Keyed on `commitSha` alone, every one of those deposits is discarded as
 * `sha-mismatch` and paid for again — including when the sync brought in
 * nothing this branch did not already have, i.e. when the tree the gates read
 * is byte-identical to the one the worker checked.
 */
test('AC-8: a HEAD move that changed no content keeps the gate credited', async () => {
  const { runEvidenceGate } = await import(
    '../.agents/scripts/evidence-gate.js'
  );
  const TREE = 'b'.repeat(40);
  const store = [];
  // HEAD moves between the deposit and the read; the tree does not.
  let head = 'c'.repeat(40);
  const gitSpawnFn = (_cwd, ...args) =>
    args[1] === 'HEAD^{tree}'
      ? { status: 0, stdout: `${TREE}\n` }
      : { status: 0, stdout: `${head}\n` };

  const params = {
    scopeId: 5278,
    standalone: true,
    gate: 'lint',
    useEvidence: true,
    cwd: '/repo',
    worktreePath: '/repo/.worktrees/story-5278',
    runnerArgs: ['npm', 'run', 'lint'],
  };
  const deps = {
    gitSpawnFn,
    spawnFn: () => ({ status: 0 }),
    shouldSkipFn: (input) => {
      const match = store.find((r) => r.gateName === input.gateName);
      if (!match) return { skip: false, reason: 'no-record' };
      if (match.sha === input.currentSha) {
        return { skip: true, reason: 'evidence-match', record: match };
      }
      return match.inputFingerprint &&
        match.inputFingerprint === input.inputFingerprint
        ? { skip: true, reason: 'fingerprint-match', record: match }
        : { skip: false, reason: 'sha-mismatch', record: match };
    },
    recordPassFn: (record) => store.push(record),
    logger: { info() {}, warn() {}, error() {}, fatal() {} },
  };

  const deposit = await runEvidenceGate(params, deps);
  assert.equal(deposit.status, 0);
  assert.equal(
    store[0].inputFingerprint,
    `tree:${TREE}`,
    'the deposit must carry the tree hash, or there is nothing to match on',
  );

  head = 'd'.repeat(40); // base-sync fast-forwards HEAD
  let spawned = 0;
  const afterSync = await runEvidenceGate(params, {
    ...deps,
    spawnFn: () => {
      spawned += 1;
      return { status: 0 };
    },
  });
  assert.equal(afterSync.skipped, true, 'reported skipped, not sha-mismatch');
  assert.equal(spawned, 0, 'and the gate is not paid for a second time');
});

test('AC-8: a HEAD move that DID change content re-runs the gate', async () => {
  const { runEvidenceGate } = await import(
    '../.agents/scripts/evidence-gate.js'
  );
  const store = [];
  let tree = 'b'.repeat(40);
  let head = 'c'.repeat(40);
  const gitSpawnFn = (_cwd, ...args) =>
    args[1] === 'HEAD^{tree}'
      ? { status: 0, stdout: `${tree}\n` }
      : { status: 0, stdout: `${head}\n` };
  const params = {
    scopeId: 5278,
    standalone: true,
    gate: 'lint',
    useEvidence: true,
    cwd: '/repo',
    runnerArgs: ['npm', 'run', 'lint'],
  };
  let spawned = 0;
  const deps = {
    gitSpawnFn,
    spawnFn: () => {
      spawned += 1;
      return { status: 0 };
    },
    shouldSkipFn: (input) => {
      const match = store.find((r) => r.gateName === input.gateName);
      if (!match) return { skip: false, reason: 'no-record' };
      if (match.sha === input.currentSha) {
        return { skip: true, reason: 'evidence-match', record: match };
      }
      return match.inputFingerprint === input.inputFingerprint
        ? { skip: true, reason: 'fingerprint-match', record: match }
        : { skip: false, reason: 'sha-mismatch', record: match };
    },
    recordPassFn: (record) => store.push(record),
    logger: { info() {}, warn() {}, error() {}, fatal() {} },
  };

  await runEvidenceGate(params, deps);
  head = 'd'.repeat(40);
  tree = 'e'.repeat(40); // the merge actually landed content
  const afterSync = await runEvidenceGate(params, deps);
  assert.equal(afterSync.skipped, false);
  assert.equal(spawned, 2, 'a real content change must not be credited');
});

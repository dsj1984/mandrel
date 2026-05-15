// tests/check-baselines-branch-protection.test.js
//
// Story #1912 / Task #1914 — branch-protection wiring contract.
//
// Per the Task body re-scope (2026-05-15), the `baselines` runtime gate
// is ADDED to `github.branchProtection.requiredChecks` alongside the
// existing per-kind names (`coverage`, `crap`, `maintainability`,
// `mutation`). The per-kind names MUST NOT be removed in this Story —
// Epic #1943 collapses the list to `["baselines"]` later.
//
// This test pins the invariant against the repo's root `.agentrc.json`
// and the framework's `full-agentrc.json` so a future edit that drops
// either the unified gate OR any of the per-kind regression checks fails
// loudly at CI time.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');

function readJson(rel) {
  return JSON.parse(readFileSync(path.join(repoRoot, rel), 'utf8'));
}

function requiredCheckNames(config) {
  return (config?.github?.branchProtection?.requiredChecks ?? []).map(
    (r) => r.name,
  );
}

describe('branchProtection.requiredChecks — Task #1914 invariant', () => {
  it('root .agentrc.json includes the unified baselines gate', () => {
    const names = requiredCheckNames(readJson('.agentrc.json'));
    assert.ok(
      names.includes('baselines'),
      `expected "baselines" in requiredChecks; got ${JSON.stringify(names)}`,
    );
  });

  it('root .agentrc.json keeps every per-kind regression check (no removal in #1912)', () => {
    const names = requiredCheckNames(readJson('.agentrc.json'));
    for (const kind of ['coverage', 'crap', 'maintainability', 'mutation']) {
      assert.ok(
        names.includes(kind),
        `expected "${kind}" still in requiredChecks alongside "baselines"; got ${JSON.stringify(names)}`,
      );
    }
  });

  it('full-agentrc.json carries the same combined contract', () => {
    const names = requiredCheckNames(readJson('.agents/full-agentrc.json'));
    assert.ok(names.includes('baselines'));
    for (const kind of ['coverage', 'crap', 'maintainability', 'mutation']) {
      assert.ok(
        names.includes(kind),
        `expected "${kind}" in full-agentrc; got ${JSON.stringify(names)}`,
      );
    }
  });

  it('the baselines entry shells out to the new CLI', () => {
    const checks =
      readJson('.agentrc.json').github?.branchProtection?.requiredChecks ?? [];
    const baselines = checks.find((r) => r.name === 'baselines');
    assert.ok(baselines, 'missing baselines requiredCheck');
    assert.deepEqual(baselines.cmd, [
      'node',
      '.agents/scripts/check-baselines.js',
    ]);
  });
});

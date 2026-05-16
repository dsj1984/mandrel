// tests/check-baselines-branch-protection.test.js
//
// Story #1912 / Task #1914 — branch-protection wiring contract.
// Story #1981 / Task #2005 (Epic #1943) — collapsed the list to drop
// the per-kind regression checks once the unified `baselines` gate
// became authoritative; the per-kind names MUST NOT reappear.
//
// This test pins the invariant against the repo's root `.agentrc.json`
// and the framework's `full-agentrc.json` so a future edit that
// resurrects the per-kind names (or drops the unified gate) fails
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

  it('root .agentrc.json drops every per-kind regression check (Story #1981 collapse)', () => {
    const names = requiredCheckNames(readJson('.agentrc.json'));
    for (const kind of ['coverage', 'crap', 'maintainability', 'mutation']) {
      assert.ok(
        !names.includes(kind),
        `unexpected per-kind requiredCheck "${kind}" in collapsed list; got ${JSON.stringify(names)}`,
      );
    }
  });

  it('full-agentrc.json carries the same collapsed contract', () => {
    const names = requiredCheckNames(readJson('.agents/full-agentrc.json'));
    assert.ok(names.includes('baselines'));
    for (const kind of ['coverage', 'crap', 'maintainability', 'mutation']) {
      assert.ok(
        !names.includes(kind),
        `unexpected per-kind requiredCheck "${kind}" in full-agentrc; got ${JSON.stringify(names)}`,
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

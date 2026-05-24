// tests/agentrc-required-checks.test.js
//
// Story #1990 / Task #1992 (Epic #1943) — pins the exact shape of
// `github.branchProtection.requiredChecks` in the root `.agentrc.json`
// to the canonical set: lint, test, baselines, lifecycle-doc-drift.
//
// Story #1981 / Task #2005 deleted the four per-kind regression CLIs
// (check-coverage-baseline, check-crap, check-maintainability,
// check-mutation). This snapshot guards against drift that would
// resurrect those entries.
//
// Epic #2880 / Task #2916 added `lifecycle-doc-drift` as a fourth
// required check so listener subscriptions and docs/LIFECYCLE.md stay
// in sync. The snapshot grew from three to four entries to match.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');

function readAgentrc() {
  return JSON.parse(readFileSync(path.join(repoRoot, '.agentrc.json'), 'utf8'));
}

const EXPECTED_CHECKS = [
  { name: 'lint', cmd: ['npm', 'run', 'lint'] },
  { name: 'test', cmd: ['npm', 'test'] },
  {
    name: 'baselines',
    cmd: ['node', '.agents/scripts/check-baselines.js'],
  },
  {
    name: 'lifecycle-doc-drift',
    cmd: ['node', '.agents/scripts/check-lifecycle-doc-drift.js'],
  },
];

const FORBIDDEN_NAMES = new Set([
  'coverage',
  'crap',
  'maintainability',
  'mutation',
]);

describe('.agentrc.json — collapsed requiredChecks snapshot (Task #1992)', () => {
  it('requiredChecks contains exactly four entries', () => {
    const checks = readAgentrc().github.branchProtection.requiredChecks;
    assert.equal(
      checks.length,
      4,
      `expected exactly 4 requiredChecks; got ${checks.length}: ${JSON.stringify(
        checks.map((c) => c.name),
      )}`,
    );
  });

  it('requiredChecks shape matches the canonical [lint, test, baselines, lifecycle-doc-drift] snapshot', () => {
    const checks = readAgentrc().github.branchProtection.requiredChecks;
    assert.deepEqual(checks, EXPECTED_CHECKS);
  });

  it('requiredChecks does not include any of the four deleted per-kind CLIs', () => {
    const names = readAgentrc().github.branchProtection.requiredChecks.map(
      (c) => c.name,
    );
    const leaks = names.filter((n) => FORBIDDEN_NAMES.has(n));
    assert.deepEqual(
      leaks,
      [],
      `forbidden per-kind check names resurfaced: ${JSON.stringify(leaks)}`,
    );
  });
});

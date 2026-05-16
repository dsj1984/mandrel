// tests/agentrc-required-checks.test.js
//
// Story #1990 / Task #1992 (Epic #1943) — pins the exact shape of
// `github.branchProtection.requiredChecks` in the root `.agentrc.json`
// to the three-entry collapsed set: lint, test, baselines.
//
// Story #1981 / Task #2005 deleted the four per-kind regression CLIs
// (check-coverage-baseline, check-crap, check-maintainability,
// check-mutation). This snapshot guards against drift that would
// either resurrect those entries or drop one of the three survivors.

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
];

const FORBIDDEN_NAMES = new Set([
  'coverage',
  'crap',
  'maintainability',
  'mutation',
]);

describe('.agentrc.json — collapsed requiredChecks snapshot (Task #1992)', () => {
  it('requiredChecks contains exactly three entries', () => {
    const checks = readAgentrc().github.branchProtection.requiredChecks;
    assert.equal(
      checks.length,
      3,
      `expected exactly 3 requiredChecks; got ${checks.length}: ${JSON.stringify(
        checks.map((c) => c.name),
      )}`,
    );
  });

  it('requiredChecks shape matches the canonical [lint, test, baselines] snapshot', () => {
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

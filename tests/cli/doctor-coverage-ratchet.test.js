/**
 * Story #5955 — `mandrel doctor`'s `coverage-ratchet` check fails when
 * coverage can be deferred to CI with no `ciRatchetCheck` to ratchet it,
 * reading `.agentrc.json` with `.agentrc.local.json` merged over it.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { makeTempDir } from '../../.agents/scripts/lib/test-temp.js';
import { runCoverageRatchet } from '../../lib/cli/doctor-checks/coverage-ratchet.js';

/** A project root holding `.agentrc.json` and, optionally, a local overlay. */
function project(coverage, localCoverage) {
  const root = fs.realpathSync(makeTempDir('doctor-coverage-ratchet-'));
  const write = (name, gate) =>
    fs.writeFileSync(
      path.join(root, name),
      JSON.stringify({ delivery: { quality: { gates: { coverage: gate } } } }),
    );
  write('.agentrc.json', coverage);
  if (localCoverage) write('.agentrc.local.json', localCoverage);
  return root;
}

const check = (coverage, localCoverage) =>
  runCoverageRatchet({ projectRoot: project(coverage, localCoverage) });

describe('coverage-ratchet doctor check', () => {
  it('passes when nothing defers coverage to CI', async () => {
    const result = await check({});
    assert.equal(result.ok, true);
  });

  for (const [label, gate] of [
    ['suiteOfRecord: ci', { suiteOfRecord: 'ci' }],
    ['onOverBudget: defer-to-ci', { onOverBudget: 'defer-to-ci' }],
  ]) {
    it(`fails ${label} without ciRatchetCheck, naming the key`, async () => {
      const result = await check(gate);
      assert.equal(result.ok, false);
      assert.match(
        result.remedy,
        /delivery\.quality\.gates\.coverage\.ciRatchetCheck/,
      );
    });

    it(`passes ${label} with ciRatchetCheck`, async () => {
      const result = await check({ ...gate, ciRatchetCheck: 'ratchet' });
      assert.equal(result.ok, true);
      assert.match(result.detail, /ratchet/);
    });
  }

  it('reads the posture from .agentrc.local.json', async () => {
    const result = await check({}, { suiteOfRecord: 'ci' });
    assert.equal(result.ok, false);
  });

  it('reads the ratchet check from .agentrc.local.json too', async () => {
    const result = await check(
      { onOverBudget: 'defer-to-ci' },
      { ciRatchetCheck: 'ratchet' },
    );
    assert.equal(result.ok, true);
  });
});

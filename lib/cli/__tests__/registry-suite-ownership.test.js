// lib/cli/__tests__/registry-suite-ownership.test.js
/**
 * Story #6061 — the `suite-ownership` doctor advisory: a suite owned by both
 * the handoff and CI, and a `ci` posture with no changed-tests guard.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { makeTempDir } from '../../../.agents/scripts/lib/test-temp.js';
import { registry } from '../registry.js';

const check = registry.find((entry) => entry.name === 'suite-ownership');

/** A project root holding `.agentrc.json` and, optionally, a local overlay. */
function project(agentrc, local) {
  const root = fs.realpathSync(makeTempDir('doctor-suite-ownership-'));
  fs.writeFileSync(path.join(root, '.agentrc.json'), JSON.stringify(agentrc));
  if (local) {
    fs.writeFileSync(
      path.join(root, '.agentrc.local.json'),
      JSON.stringify(local),
    );
  }
  return root;
}

const agentrcWith = (coverage, testChanged) => ({
  ...(testChanged ? { project: { commands: { testChanged } } } : {}),
  delivery: { quality: { gates: { coverage } } },
});

const run = (agentrc, local) =>
  check.run({ projectRoot: project(agentrc, local) });

describe('doctor check: suite-ownership', () => {
  it('is registered as an advisory check', () => {
    assert.ok(check, 'the registry must carry a suite-ownership entry');
    assert.equal(check.advisory, true);
  });

  it('AC-6: a local posture with a CI ratchet check names both settings that move the suite to CI', async () => {
    const result = await run(agentrcWith({ ciRatchetCheck: 'ratchet' }));
    assert.equal(result.ok, true, 'advisory: never fails doctor');
    assert.match(result.detail, /owned by both the handoff and CI/);
    assert.match(result.detail, /suiteOfRecord: "ci"/);
    assert.match(result.detail, /project\.commands\.testChanged/);
  });

  it('the ci posture without testChanged reports no test before the PR', async () => {
    const result = await run(
      agentrcWith({ suiteOfRecord: 'ci', ciRatchetCheck: 'ratchet' }),
    );
    assert.equal(result.ok, true);
    assert.match(result.detail, /no test runs before the PR/);
  });

  it('the ci posture with testChanged reports the guard, read through the local overlay', async () => {
    const result = await run(
      agentrcWith({ ciRatchetCheck: 'ratchet' }, 'npm run test:changed'),
      agentrcWith({ suiteOfRecord: 'ci' }),
    );
    assert.equal(result.ok, true);
    assert.match(result.detail, /`npm run test:changed`/);
    assert.match(result.detail, /changed-tests guard/);
  });

  it('no CI ratchet check reports the handoff as owner with no advice', async () => {
    const result = await run(agentrcWith({}));
    assert.deepEqual(result, {
      ok: true,
      detail: 'the handoff owns the suite',
    });
  });
});

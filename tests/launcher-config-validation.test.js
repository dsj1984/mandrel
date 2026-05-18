import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

const SCRIPTS = [
  // Story #2259 / Task #2264 (Epic #2172) — the legacy
  // deliver-runner CLI wrapper was retired with the listener-chain
  // conversion. The remaining launcher-shaped CLIs continue to enforce
  // the same orchestration schema contract.
  {
    name: 'epic-plan',
    relPath: '.agents/scripts/epic-plan.js',
    args: ['--epic', '1', '--prd', 'x', '--techspec', 'y', '--tickets', 'z'],
  },
  {
    name: 'epic-plan-spec',
    relPath: '.agents/scripts/epic-plan-spec.js',
    args: ['--epic', '1', '--emit-context'],
  },
  {
    name: 'epic-plan-decompose',
    relPath: '.agents/scripts/epic-plan-decompose.js',
    args: ['--epic', '1', '--emit-context'],
  },
];

function buildInvalidFixture() {
  const raw = JSON.parse(
    fs.readFileSync(path.join(PROJECT_ROOT, '.agentrc.json'), 'utf8'),
  );
  // Post-reshape: force a validation failure by adding an unknown top-level
  // key (additionalProperties: false on the new schema rejects this).
  raw.unknownTopLevel = true;
  return raw;
}

describe('launcher-level orchestration config validation', () => {
  let fixtureDir;

  before(() => {
    fixtureDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'launcher-config-validation-'),
    );
    fs.writeFileSync(
      path.join(fixtureDir, '.agentrc.json'),
      JSON.stringify(buildInvalidFixture(), null, 2),
    );
  });

  after(() => {
    if (fixtureDir) {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  for (const s of SCRIPTS) {
    test(`${s.name} exits non-zero with schema error on top-level typo`, () => {
      const res = spawnSync(
        process.execPath,
        [path.join(PROJECT_ROOT, s.relPath), ...s.args],
        {
          encoding: 'utf8',
          cwd: PROJECT_ROOT,
          env: { ...process.env, AP_AGENTRC_CWD: fixtureDir, CI: '1' },
          timeout: 20_000,
        },
      );

      assert.notStrictEqual(
        res.status,
        0,
        `${s.name} should exit non-zero on schema drift. stdout=${res.stdout} stderr=${res.stderr}`,
      );

      const combined = `${res.stdout}\n${res.stderr}`;
      assert.match(
        combined,
        /Invalid \.agentrc\.json|additional properties|required property/i,
        `${s.name} should surface a schema error before any provider call. Got: ${combined}`,
      );
    });
  }
});
